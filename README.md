# Trelent Guide Generation Pipeline

> **The Challenge:** "You're a founding engineer at Trelent. What do you build in your first 24 hours to prove value? Focus on architecture, how you orchestrate slow/unreliable APIs, and specific technologies you'd use."

This repository is my answer—a working demo, not a slide deck.

**Live Demo:** https://web-production-dc150.up.railway.app
**Temporal UI:** https://temporal-ui-production-04cb.up.railway.app

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Why Temporal](#why-temporal)
3. [Architecture Overview](#architecture-overview)
4. [Technical Decisions](#technical-decisions)
5. [The Workflow](#the-workflow)
6. [Failure Handling Strategy](#failure-handling-strategy)
7. [What This Demo Shows](#what-this-demo-shows)
8. [Running Locally](#running-locally)
9. [Deployment](#deployment)
10. [What I'd Build Next](#what-id-build-next)

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
  // Stage 1: Convert files (5 concurrent)
  await convertFiles(runId, fileIds);

  // Stage 2: Generate guides (10 concurrent)
  await generateGuides(runId, guideIds);

  // Stage 3: Finalize
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

## Technical Decisions

### Database Schema

```prisma
model Run {
  id              String    @id @default(uuid())
  name            String
  status          String    @default("pending")  // pending|processing|completed|completed_with_errors|failed
  stage           String    @default("initializing")  // initializing|converting|generating|finalizing|done
  totalFiles      Int       @default(0)
  convertedFiles  Int       @default(0)
  totalGuides     Int       @default(0)
  completedGuides Int       @default(0)
  failedGuides    Int       @default(0)
  workflowId      String?   @unique
  // ... timestamps, relations
}

model File {
  id              String   @id @default(uuid())
  runId           String
  filename        String
  fileHash        String
  status          String   @default("pending")  // pending|converting|converted|failed
  markdownContent String?  @db.Text
  // ... relations
}

model Guide {
  id             String   @id @default(uuid())
  runId          String
  name           String
  description    String   @db.Text
  status         String   @default("pending")  // pending|searching|generating|completed|needs_attention
  searchResults  Json?
  htmlContent    String?  @db.Text
  failureReason  String?  // User-friendly explanation
  failureDetails Json?    // Technical details for debugging
  forceFailure   Boolean  @default(false)  // Demo mode
  attempts       Int      @default(0)
  // ... relations
}
```

**Key decisions:**

1. **`stage` vs `status`**: Status is the final outcome, stage is current progress. Users see "Reading documents" (stage) while status remains "processing".

2. **`failureReason` vs `failureDetails`**: User-friendly message ("We couldn't find relevant content") separate from technical details (stack traces, API responses).

3. **`forceFailure` flag**: Enables demo mode without changing failure logic. Clean separation of concerns.

4. **`attempts` counter**: Tracks retry attempts for degrading strategy (full generation → simplified → skeleton).

### Bounded Concurrency

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
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '30 seconds',
    maximumAttempts: 3,
  },
};
```

**Rationale:**
- 5 minute timeout: LLM generation can be slow
- 30 second heartbeat: Detect stuck workers quickly
- Exponential backoff: 1s → 2s → 4s (respects rate limits)
- 3 attempts: Fail fast, let application handle degraded output

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

### Stage 1: File Conversion

```typescript
async function convertFile(runId: string, fileId: string) {
  // Update status to 'converting'
  await db.file.update({ where: { id: fileId }, data: { status: 'converting' } });

  // Simulate document conversion (real: Unstructured, AWS Textract, etc.)
  await simulateLatency({ min: 500, max: 2000 });

  // 5% failure rate for realism
  if (Math.random() < 0.05) {
    throw new Error('Conversion service temporarily unavailable');
  }

  // Store extracted markdown
  await db.file.update({
    where: { id: fileId },
    data: { status: 'converted', markdownContent: extractedContent }
  });
}
```

### Stage 2: Guide Generation

```typescript
async function processGuide(runId: string, guideId: string) {
  const guide = await db.guide.findUnique({ where: { id: guideId } });
  const attempt = guide.attempts + 1;

  // Check for forced failure (demo mode)
  if (guide.forceFailure) {
    return handleForcedFailure(guide);
  }

  // Step 1: Semantic search
  const searchResults = await mockSearch(runId, guide.description);

  if (searchResults.length === 0) {
    // No relevant content found - needs human attention
    return markNeedsAttention(guide, "We couldn't find relevant content");
  }

  // Step 2: Generate HTML
  const html = await generateGuideHTML(guide, searchResults, attempt);

  await db.guide.update({
    where: { id: guideId },
    data: { status: 'completed', htmlContent: html }
  });
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

This aligns with Trelent's model: AI does the heavy lifting, humans handle edge cases.

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

### 2. **I understand distributed systems**
- Durable workflows survive crashes
- Bounded concurrency prevents resource exhaustion
- Retry strategies handle transient failures

### 3. **I think about the user experience**
- Real-time progress without page refresh
- Clear failure messages, not stack traces
- Degraded output is better than no output

### 4. **I make pragmatic technology choices**
- Temporal over simpler queues (justified above)
- Polling over WebSockets (simpler, sufficient)
- Monorepo structure (clear boundaries, independent deployment)

### 5. **I document my decisions**
- [DECISIONS.md](./DECISIONS.md) tracks choices, concerns, and tech debt
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

### Medium-term (Quarter 1)
- [ ] Worker Versioning for safe deployments
- [ ] Continue-As-New for long-running batches
- [ ] Multi-tenant isolation
- [ ] Guide versioning and diff view

---

## Files of Interest

| File | Description |
|------|-------------|
| `worker/src/workflows/guideGeneration.ts` | Main Temporal workflow |
| `worker/src/activities/generate.ts` | Guide generation with retry logic |
| `web/app/api/runs/route.ts` | API endpoint that starts workflows |
| `web/components/RunProgress.tsx` | Real-time progress polling |
| `DECISIONS.md` | Running log of technical decisions |

---

## Questions?

This demo represents roughly 8 hours of focused work, from empty directory to deployed application. I'm happy to discuss any technical decision in depth.

**Austin Eaton**
[GitHub](https://github.com/austeane)
