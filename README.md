# Trelent Guide Generation Pipeline

> **The Challenge:** "You're a founding engineer at Trelent. What do you build in your first 24 hours to prove value? Focus on architecture, how you orchestrate slow/unreliable APIs, and specific technologies you'd use."

This repository is my answer—a working demo, not a slide deck.

**Live Demo:** https://web-production-dc150.up.railway.app
**Temporal UI:** https://temporal-ui-production-04cb.up.railway.app

> **Note on Temporal UI:** The Temporal UI is intentionally public for this demo so reviewers can inspect workflow execution history, activity retries, and event replay. In production, Temporal UI should be internal-only or behind authentication, as Temporal OSS has no built-in auth. The web app acts as the authenticated boundary—users interact with progress via the control plane, never directly with Temporal.

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Why Temporal](#why-temporal)
3. [Architecture Overview](#architecture-overview)
4. [Scaling to 5000 Documents](#scaling-to-5000-documents)
5. [Technical Decisions](#technical-decisions)
6. [The Workflow](#the-workflow)
7. [Failure Handling Strategy](#failure-handling-strategy)
8. [What This Demo Shows](#what-this-demo-shows)
9. [Running Locally](#running-locally)
10. [Deployment](#deployment)
11. [What I'd Build Next](#what-id-build-next)

---

## The Problem

Trelent converts enterprise documents into user-facing guides. This involves:

1. **Document Ingestion** - Accept uploads (PDF, DOCX, HTML, etc.)
2. **Content Extraction** - Convert documents to searchable text
3. **Semantic Search** - Find relevant content for each guide topic
4. **LLM Generation** - Generate HTML guides from source material
5. **Human Review** - Flag guides that need manual attention

Each step involves external services that are **slow** (seconds to minutes) and **unreliable** (rate limits, timeouts, transient failures). A naive implementation would lose work on any failure, leave users confused about progress, and create debugging nightmares.

---

## Why Temporal

I chose [Temporal](https://temporal.io) over alternatives (Bull/BullMQ, AWS Step Functions, Inngest, etc.) for specific reasons:

### vs. Redis-based Queues (Bull, BullMQ, Celery)

| Aspect | Redis Queues | Temporal |
|--------|--------------|----------|
| State persistence | Lost on worker crash | Durable by design |
| Complex workflows | Manual orchestration | Native workflow code |
| Retries | Per-job only | Per-activity with backoff |
| Visibility | Limited | Full execution history |
| Long-running jobs | Timeout issues | Heartbeats + continue-as-new |

### vs. AWS Step Functions

| Aspect | Step Functions | Temporal |
|--------|----------------|----------|
| Vendor lock-in | AWS only | Self-hosted or Cloud |
| Workflow definition | JSON/YAML state machines | TypeScript code |
| Local development | LocalStack (limited) | Native local server |
| Debugging | CloudWatch logs | Temporal UI with replay |
| Cost | Per-transition pricing | Predictable (self-hosted free) |

### vs. Inngest / Trigger.dev

| Aspect | Inngest | Temporal |
|--------|---------|----------|
| Maturity | Newer | Battle-tested (Uber scale) |
| Self-hosting | Limited | Full control |
| Complex orchestration | Event-driven | Explicit workflow code |
| Enterprise adoption | Growing | Proven (Stripe, Netflix, etc.) |

### The Killer Feature: Workflows as Code

With Temporal, I write workflows in TypeScript:

```typescript
// This looks like normal async code, but it's durable
export async function guideGenerationWorkflow(runId: string, fileIds: string[], guideIds: string[]) {
  // Stage 1: Convert files via child workflows (100 files per child)
  await processFileChunks(runId, fileIds);

  // Stage 2: Generate guides via child workflows (100 guides per child)
  await processGuideChunks(runId, guideIds);

  // Stage 3: Finalize (derives counts from ground truth)
  await finalizeRun(runId);
}
```

If the worker crashes mid-execution, Temporal replays the workflow from its event history. Completed activities aren't re-run. This is **not possible** with traditional job queues.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Railway                                    │
│                                                                      │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐   │
│  │   Web    │────▶│ Temporal │◀────│  Worker  │────▶│ Postgres │   │
│  │ (Next.js)│     │  Server  │     │ (Node.js)│     │          │   │
│  └──────────┘     └──────────┘     └──────────┘     └──────────┘   │
│       │                │                                   ▲        │
│       │                │                                   │        │
│       │                ▼                                   │        │
│       │          ┌──────────┐                              │        │
│       │          │ Temporal │                              │        │
│       │          │    UI    │                              │        │
│       │          └──────────┘                              │        │
│       │                                                    │        │
│       └────────────────────────────────────────────────────┘        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Services

| Service | Purpose | Technology |
|---------|---------|------------|
| **Web** | UI + API routes | Next.js 14 (App Router) |
| **Worker** | Execute Temporal activities | Node.js + Temporal SDK |
| **Temporal** | Workflow orchestration | temporalio/auto-setup |
| **Temporal UI** | Debugging dashboard | temporalio/ui |
| **Postgres** | Application data + Temporal persistence | PostgreSQL 15 |

### Why Monorepo?

```
temporal-app/
├── web/                 # Next.js frontend + API
│   ├── app/            # App Router pages/routes
│   ├── components/     # React components
│   ├── lib/            # Shared utilities
│   └── prisma/         # Database schema
├── worker/             # Temporal worker
│   ├── src/
│   │   ├── activities/ # Temporal activities
│   │   └── workflows/  # Temporal workflows
│   └── prisma/         # Same schema (generated separately)
└── package.json        # Workspace root
```

**Decision:** Separate packages for web and worker because:
1. Different deployment targets (Railpack vs Dockerfile)
2. Worker needs native Temporal SDK bindings (glibc requirement)
3. Independent scaling (can add more workers without touching web)
4. Clear separation of concerns

**Tradeoff:** Prisma schema is duplicated. Each service generates its own client. This avoids symlink complexity in Docker builds.

---

## Scaling to 5000 Documents

A naive workflow processing 5,000 files would generate ~50,000 events (10 events per file), hitting Temporal's recommended history limits. This demo implements a **parent-child workflow architecture** to handle scale.

### The Architecture

```
Parent Workflow (orchestrator)
    │
    ├── fileChunkWorkflow[0] (files 0-99)
    ├── fileChunkWorkflow[1] (files 100-199)
    ├── ... (50 total file chunks)
    │
    └── guideChunkWorkflow[0] (guides 0-99)
    └── guideChunkWorkflow[1] (guides 100-199)
    └── ...
```

Each child workflow processes up to 100 items, keeping its history well under limits (~1,000 events per child). The parent workflow has only ~165 events (child executions + setup).

### Throttled Execution

Starting 50 child workflows simultaneously would flood the Temporal task queue. Instead, we throttle to 10 concurrent children:

```typescript
const MAX_CONCURRENT_CHILDREN = 10;

async function executeChildrenThrottled<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];

  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    results.push(...batchResults);
  }

  return results;
}
```

### Verified at Scale

The 5,000 document test run completed successfully:
- **5,000 files** → 4,739 converted (261 failed at designed 5% rate)
- **100 guides** → 48 completed, 2 needs_attention
- **Throughput:** ~760-800 files/minute
- **No history limit issues** - distributed across 51 workflows

---

## Technical Decisions

### Database Schema with Type-Safe Enums

Status fields use Prisma enums for compile-time safety:

```prisma
enum RunStatus {
  pending
  processing
  completed
  completed_with_errors
  failed
}

enum RunStage {
  initializing
  converting_documents
  writing_guides
  complete
}

enum FileStatus {
  pending
  converting
  converted
  failed
}

enum GuideStatus {
  pending
  searching
  generating
  completed
  needs_attention
}

model Run {
  id              String    @id @default(uuid())
  name            String
  status          RunStatus @default(pending)
  stage           RunStage  @default(initializing)
  totalFiles      Int       @default(0)
  convertedFiles  Int       @default(0)
  // ...
}
```

**Why enums over strings?**
- Database-level constraint on valid values
- TypeScript union types in generated client
- Prevents drift between code and schema
- UI can't silently break on rename

### Idempotency Guards in Activities

Activities can be retried on worker crash, network failure, or timeout. Without guards, this causes double-counting and state corruption:

```typescript
export async function convertFile(runId: string, fileId: string) {
  const file = await db.file.findUnique({ where: { id: fileId } });

  // Guard: already in terminal state? Return early.
  if (file.status === 'converted' && file.markdownContent) {
    return { success: true };
  }
  if (file.status === 'failed') {
    return { success: false };
  }

  // Conditional update: only transition if in expected state
  const updateResult = await db.file.updateMany({
    where: {
      id: fileId,
      status: { in: ['pending', 'converting'] }
    },
    data: { status: 'converting' },
  });

  // If no rows updated, another worker already processed this
  if (updateResult.count === 0) {
    const currentFile = await db.file.findUnique({ where: { id: fileId } });
    return { success: currentFile?.status === 'converted' };
  }

  // ... actual conversion logic
}
```

This pattern handles:
- Worker crash after DB write but before Temporal acknowledgment
- Concurrent retries from multiple workers
- Activity replay during workflow recovery

### Ground Truth for Progress Counts

Counter increments (`completedGuides++`) are not retry-safe. Instead, finalization derives counts from actual database state:

```typescript
export async function refinalizeRun(runId: string) {
  const guideCounts = await db.guide.groupBy({
    by: ['status'],
    where: { runId },
    _count: true,
  });

  const completed = guideCounts.find(g => g.status === 'completed')?._count ?? 0;
  const needsAttention = guideCounts.find(g => g.status === 'needs_attention')?._count ?? 0;

  await db.run.update({
    where: { id: runId },
    data: {
      completedGuides: completed,
      failedGuides: needsAttention,
      status: needsAttention > 0 ? 'completed_with_errors' : 'completed',
      // ...
    },
  });
}
```

### Bounded Concurrency Within Activities

```typescript
// In workflow
const FILE_CONCURRENCY = 5;
const GUIDE_CONCURRENCY = 10;

// Process files in batches of 5
for (let i = 0; i < fileIds.length; i += FILE_CONCURRENCY) {
  const batch = fileIds.slice(i, i + FILE_CONCURRENCY);
  await Promise.all(batch.map(id => convertFile(runId, id)));
}
```

**Why these numbers?**
- File conversion: CPU/memory intensive → lower concurrency (5)
- Guide generation: I/O bound (API calls) → higher concurrency (10)
- Both respect typical API rate limits while maximizing throughput

### Activity Retry Configuration

```typescript
const activityOptions = {
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 4,
  },
};
```

**Rationale:**
- 5 minute timeout: LLM generation can be slow
- 30 second heartbeat: Detect stuck workers quickly
- Exponential backoff: 2s → 4s → 8s → 16s (respects rate limits)
- 4 attempts: Fail fast, let application handle degraded output

### Real-time Progress (Polling vs WebSockets)

**Decision:** Polling with 2-3 second intervals.

**Why not WebSockets?**
1. Added infrastructure complexity (need sticky sessions or Redis pub/sub)
2. Railway's load balancer handles HTTP better than WS
3. 2-3 second polling is indistinguishable from real-time for this UX
4. Simpler debugging (just HTTP requests)

```typescript
// RunProgress.tsx
useEffect(() => {
  const interval = setInterval(fetchProgress, 2000);
  return () => clearInterval(interval);
}, []);
```

### XSS Protection in HTML Preview

User-generated HTML is displayed in an iframe with sandbox restrictions:

```tsx
<iframe
  srcDoc={guide.htmlContent}
  sandbox="allow-same-origin"
  title={guide.name}
/>
```

The `sandbox` attribute prevents script execution while still allowing CSS to render. This blocks XSS even if malicious HTML were somehow generated.

### Docker Base Image

```dockerfile
# worker/Dockerfile
FROM node:20-slim  # NOT alpine!

# Temporal SDK has native bindings requiring glibc
RUN apt-get update && apt-get install -y openssl
```

**Lesson learned:** Alpine uses musl, but Temporal's Rust-based core bridge requires glibc. This caused `ERR_DLOPEN_FAILED` errors until switched to `node:20-slim`.

---

## The Workflow

### Stage 1: File Conversion (Child Workflows)

```typescript
// Parent spawns throttled child workflows
const fileChunks = chunkArray(fileIds, 100);
const fileResults = await executeChildrenThrottled(
  fileChunks.map((chunk, index) => () =>
    executeChild('fileChunkWorkflow', {
      workflowId: `${runId}-file-chunk-${index}`,
      args: [runId, chunk, index],
    })
  ),
  MAX_CONCURRENT_CHILDREN
);
```

Each child workflow processes its chunk with idempotent activities:

```typescript
async function convertFile(runId: string, fileId: string) {
  // Idempotency guard (see Technical Decisions)
  // ...

  // Simulate document conversion (real: Unstructured, AWS Textract, etc.)
  await simulateLatency({ min: 1500, max: 6000 });

  // 5% failure rate for realism
  if (Math.random() < 0.05) {
    await db.file.update({
      where: { id: fileId },
      data: { status: 'failed', errorMessage: 'Document conversion failed' }
    });
    return { success: false };
  }

  // Store extracted markdown
  await db.file.update({
    where: { id: fileId },
    data: { status: 'converted', markdownContent: extractedContent }
  });
  return { success: true };
}
```

### Stage 2: Guide Generation (Child Workflows)

```typescript
async function processGuide(runId: string, guideId: string, isManualRetry = false) {
  const guide = await db.guide.findUnique({ where: { id: guideId } });

  // Idempotency guards
  if (guide.status === 'completed' && guide.htmlContent) {
    return { success: true };
  }
  if (guide.status === 'needs_attention' && !isManualRetry) {
    return { success: false };
  }

  // Check for forced failure (demo mode)
  if (guide.forceFailure) {
    return handleForcedFailure(guide);
  }

  // Step 1: Semantic search
  const searchResults = await mockSearch(runId, guide.description);

  if (searchResults.length === 0) {
    return markNeedsAttention(guide, "We couldn't find relevant content");
  }

  // Step 2: Generate HTML (with degrading retry)
  const html = await generateGuideHTML(guide, searchResults, guide.attempts);

  await db.guide.update({
    where: { id: guideId },
    data: { status: 'completed', htmlContent: html }
  });
  return { success: true };
}
```

### Degrading Retry Strategy

```typescript
function generateGuideHTML(guide: Guide, sources: SearchResult[], attempt: number) {
  if (attempt === 1) {
    // Full generation with all sources
    return generateFullHTML(guide, sources);
  } else if (attempt === 2) {
    // Simplified: fewer sources, shorter content
    return generateSimplifiedHTML(guide, sources.slice(0, 2));
  } else {
    // Skeleton: just structure, mark for human review
    return generateSkeletonHTML(guide);
  }
}
```

**Why degrade instead of just failing?**
- Partial output is more valuable than no output
- Users can review and complete skeleton guides
- Demonstrates graceful degradation philosophy

---

## Failure Handling Strategy

### User-Friendly Error Messages

```typescript
const failureReasons = [
  "We couldn't find relevant content in your documents for this guide.",
  "Search service returned no matching documents for this topic.",
  "The source documents do not contain sufficient information for this guide.",
];
```

**Philosophy:** Users don't need stack traces. They need actionable information.

### The "Needs Attention" State

Guides don't just "fail"—they enter a `needs_attention` state with:
1. Clear explanation of what went wrong
2. Skeleton HTML they can complete manually
3. Attempt count for debugging
4. "Try again" button to retry with fresh attempt

This aligns with Trelent's model: AI does the heavy lifting, humans handle edge cases.

### Manual Retry Workflow

When a user clicks "Try again," a separate `retryGuideWorkflow` runs:

```typescript
export async function retryGuideWorkflow(runId: string, guideId: string) {
  // Process with isManualRetry=true to bypass needs_attention guard
  await acts.processGuide(runId, guideId, true);

  // Re-finalize to recalculate status from ground truth
  await acts.refinalizeRun(runId);
}
```

The retry workflow:
- Uses a separate workflow ID (isolated history)
- Passes `isManualRetry=true` to allow re-processing
- Derives final counts from database state, not counters

### Demo Mode

The "Demo with Failures" button:
1. Randomly selects 2-4 guides
2. Marks them with `forceFailure: true`
3. Worker checks this flag and simulates failure

This lets interviewers see the error handling without relying on random chance.

---

## What This Demo Shows

### 1. **I can ship production-quality code quickly**
- Deployed to Railway with proper service architecture
- Real database, real workflow engine, real networking
- Not a localhost demo

### 2. **I understand distributed systems at scale**
- Child workflow architecture handles 5,000+ documents
- Idempotency guards handle activity retries correctly
- Throttled execution prevents task queue flooding
- Bounded concurrency prevents resource exhaustion

### 3. **I think about the user experience**
- Real-time progress without page refresh
- Clear failure messages, not stack traces
- "Try again" button for failed guides
- Fuzzy search for filtering guides
- Degraded output is better than no output

### 4. **I make pragmatic technology choices**
- Temporal over simpler queues (justified above)
- Polling over WebSockets (simpler, sufficient)
- Monorepo structure (clear boundaries, independent deployment)
- Prisma enums over strings (type safety)

### 5. **I document my decisions**
- [DECISIONS.md](./DECISIONS.md) tracks choices, concerns, and tech debt
- [INTERVIEW_QA.md](./INTERVIEW_QA.md) has detailed Q&A for reviewers
- This README explains the "why" behind the "what"

---

## Running Locally

### Prerequisites

- Node.js 20+
- Docker (for Temporal)
- PostgreSQL (or use Docker)

### Setup

```bash
# Start Temporal (uses docker-compose)
docker-compose up -d

# Install dependencies
npm install

# Setup database
cd web && npx prisma db push && cd ..
cd worker && npx prisma generate && cd ..

# Start services (in separate terminals)
cd web && npm run dev      # http://localhost:3000
cd worker && npm run dev   # Connects to Temporal
```

### Environment Variables

```bash
# web/.env
DATABASE_URL="postgresql://..."
TEMPORAL_ADDRESS="localhost:7233"

# worker/.env
DATABASE_URL="postgresql://..."
TEMPORAL_ADDRESS="localhost:7233"
```

---

## Deployment

Deployed on [Railway](https://railway.app) with 5 services:

| Service | Build | Notes |
|---------|-------|-------|
| Postgres | Railway template | Shared by Temporal + app |
| Temporal | Docker image | `temporalio/auto-setup:1.24.2` |
| Temporal UI | Docker image | `temporalio/ui:2.31.2` |
| Web | Railpack (auto) | Next.js standalone |
| Worker | Dockerfile | Needs glibc for Temporal SDK |

### Key Configuration

- **Temporal:** `DB=postgres12` (not `postgresql`!)
- **Worker:** `node:20-slim` base image (not Alpine)
- **Monorepo:** Set `Root Directory` in Railway dashboard
- **Worker concurrency:** 50 activities, 20 workflows

---

## What I'd Build Next

### Immediate (Week 1-2)
- [ ] Real file upload to S3/R2
- [ ] Real document conversion (Unstructured API)
- [ ] Real vector search (Pinecone, Weaviate)
- [ ] Real LLM generation (OpenAI, Anthropic)

### Short-term (Month 1)
- [ ] Authentication (Clerk, NextAuth)
- [ ] Rate limiting on API routes
- [ ] Worker auto-scaling based on queue depth
- [ ] Observability (Datadog, Honeycomb)
- [ ] Background ZIP generation (currently in web tier)

### Medium-term (Quarter 1)
- [ ] Worker Versioning for safe deployments
- [ ] Continue-As-New for very long-running batches
- [ ] Multi-tenant isolation
- [ ] Guide versioning and diff view

---

## Files of Interest

| File | Description |
|------|-------------|
| `worker/src/workflows/guideGeneration.ts` | Parent workflow with child orchestration |
| `worker/src/workflows/fileChunkWorkflow.ts` | Child workflow for file batch processing |
| `worker/src/activities/generate.ts` | Guide generation with idempotency guards |
| `worker/src/activities/convert.ts` | File conversion with idempotency guards |
| `web/app/api/runs/route.ts` | API endpoint with sample data generation |
| `web/components/RunProgress.tsx` | Real-time progress polling |
| `web/components/GuideList.tsx` | Filterable guide list with search |
| `DECISIONS.md` | Running log of technical decisions |
| `INTERVIEW_QA.md` | Detailed interview Q&A |

---

## Questions?

This demo represents focused work building a production-ready pipeline demo. I'm happy to discuss any technical decision in depth.

**Austin Eaton**
[GitHub](https://github.com/austeane)
