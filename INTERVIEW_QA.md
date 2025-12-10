# Interview Questions & Answers

## The Problem Statement

> Trelent helps customers turn messy internal procedures into reliable AI-driven workflows. A customer uploads a large folder of mixed PDFs and Word docs plus a short description for each new HTML "guide" they want (some guides combine several sources). You have two internal APIs: one that converts any file into Markdown, and one that searches across that Markdown; both are accurate but slow (seconds to minutes per call). You also have OpenAI for rewriting, which occasionally fails. Each run might process 5 to 5,000 guides, and must run as a background pipeline.

---

## Question 1: First 24 Hours — Architecture & Orchestration

> What do you build in your first 24 hours to prove value? Focus on architecture, how you orchestrate slow/unreliable APIs, and specific technologies you'd use if implementing tomorrow.

### Answer

**I built a Temporal-based workflow pipeline with Postgres as the system of record.**

#### Why Temporal over alternatives

| Option | Problem |
|--------|---------|
| Bull/Redis queues | No built-in retry policies, manual state management, lose visibility into "why did this fail 3 times?" |
| AWS Step Functions | Vendor lock-in, JSON DSL is painful, expensive at scale |
| Inngest/Trigger.dev | Simpler but less control over retry backoff, weaker durability guarantees |
| **Temporal** | Durable execution, automatic retries with configurable backoff, time-travel debugging, workflow-as-code |

#### Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Next.js API   │────▶│   Temporal   │────▶│  Worker (Node)  │
│  (Control Plane)│     │   Server     │     │                 │
└────────┬────────┘     └──────────────┘     └────────┬────────┘
         │                                            │
         │              ┌──────────────┐              │
         └─────────────▶│   Postgres   │◀─────────────┘
                        │ (State + UI) │
                        └──────────────┘
```

**Key decision:** Postgres is the source of truth for UI, not Temporal. The workflow updates the database after each step, so:
- UI can poll simple REST endpoints
- Progress survives worker restarts
- No need to query Temporal from the frontend

#### Orchestrating slow/unreliable APIs

```typescript
const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',    // Conversion can be slow
  heartbeatTimeout: '30 seconds',       // Detect stuck workers
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 4,                 // Don't retry forever
  },
});
```

**Bounded concurrency** to avoid overwhelming the slow APIs:
```typescript
const CONVERT_CONCURRENCY = 5;   // 5 files at a time
const GENERATE_CONCURRENCY = 10; // 10 guides at a time
```

#### Handling OpenAI failures

Three failure modes, each handled differently:

1. **Transient failures** (rate limits, timeouts) → Temporal retries automatically
2. **Search returns nothing** → Mark guide as `needs_attention`, continue pipeline
3. **Generation produces garbage** → Degrading retry: full prompt → simplified → skeleton HTML

```typescript
// Degrading retry example
for (let attempt = 1; attempt <= 3; attempt++) {
  const result = await generateWithOpenAI(prompt, attempt);
  if (result.quality > 0.7) return result;
  // Simplify prompt for next attempt
}
// Final fallback: generate skeleton HTML from search results
return generateSkeletonGuide(searchResults);
```

#### Idempotency (Principal-level concern)

Activities can retry on worker crash. Each activity guards against double-execution:

```typescript
// Idempotency guard at start of each activity
if (guide.status === 'completed' && guide.htmlContent) {
  return { success: true }; // Already done
}

// Conditional update: only transition if in expected state
const updateResult = await db.guide.updateMany({
  where: { id: guideId, status: { in: ['pending', 'searching'] } },
  data: { status: 'searching' },
});
if (updateResult.count === 0) {
  // Another worker already processed this
  return { success: currentGuide?.status === 'completed' };
}
```

#### Tech stack

- **Temporal OSS** (self-hosted) — not Temporal Cloud for cost control at scale
- **Next.js 14** — API routes as control plane, React for UI
- **Prisma + Postgres** — type-safe DB access, enums for status validation
- **Railway** — one-click deploys, private networking between services

---

## Question 2: User-Facing Web App (Next 24 Hours)

> Your pipeline works. Now a user needs to run it without you. What web app do you build in the next 24 hours so they can start runs, see progress, and get results—without ever thinking about "jobs," "queues," or "retries"? Pick one architectural reality and explain how you'd surface it in the UI in terms they'd naturally understand.

### Answer

**The goal:** Users should never see infrastructure concepts. No "jobs," "queues," "retries."

#### What I built

A dashboard where users:
1. Click "New Run" → see a progress page immediately
2. Watch real-time progress bars (polling every 3 seconds)
3. Get results with clear status: ✓ Completed, ⚠ Needs attention

#### Surfacing "why things take time"

**Architectural reality I chose:** Document conversion is slow (seconds to minutes per file).

**How I surface it:**

Instead of a spinner with "Processing...", I show:
```
┌─────────────────────────────────────────────────┐
│  📖 Reading documents                           │
│  Converting PDFs and Word docs into searchable  │
│  text                                           │
│                                                 │
│  Documents read: ████████░░░░░░░░ 847/5000     │
│  Guides written: ░░░░░░░░░░░░░░░░   0/100      │
└─────────────────────────────────────────────────┘
```

**Why this works:**
- "Reading documents" → familiar metaphor, not "converting to markdown"
- Dual progress bars → users see the pipeline has stages
- Numbers update in real-time → system feels alive, not stuck

#### Handling failures in user terms

When a guide fails after retries, I don't show:
> ❌ Error: Activity timeout after 4 attempts

I show:
> ⚠ **Needs attention**
> We couldn't find relevant content in your documents for this guide.
> *Attempted 3 times*
> [Try again]

The "Try again" button starts a fresh workflow for just that guide—users don't know they're invoking `retryGuideWorkflow`.

#### Evidence for user debugging

```
⚠ Needs more source content

We scanned your uploaded documents, but couldn't find
instructions that match this guide description.

Closest matches we found:
• Employee Handbook.pdf: "Section 4.2 covers..."
• IT Security Policy.docx: "Remote access requires..."

[Edit description] [Upload another document] [Try again]
```

This surfaces *the reason* without mentioning "vector search," "queues," or "retries."

#### Search for scale

With 100 guides, pagination isn't enough. Added a **fuzzy search** input:
- Debounced (300ms) to avoid hammering the API
- Case-insensitive on guide names
- Clear button to reset

---

## Question 3: The Long Game (3 Months, 50x Volume)

> Three months from now, this system handles 50x the volume and has a richer UX. What's different? Where did your early shortcuts become bottlenecks, and what would you rebuild?

### Answer

#### What changes at scale

| Early Shortcut | Why It Breaks | What I'd Rebuild |
|----------------|---------------|------------------|
| Single workflow per run | 5000 guides × 10 events = 50K+ events, hits Temporal limits | **Child workflows**: chunk into batches of 100, each child has isolated history |
| Sync DB updates after each activity | 5000 writes → DB contention | **Atomic increments**: `UPDATE runs SET completed = completed + 1` |
| Unbounded child workflow fan-out | Floods task queue at scale | **Throttled execution**: start 10 child workflows at a time |
| File content in Postgres | 50K files × avg 100KB = 5GB | **Claim-check pattern**: store files in S3, DB holds only metadata/IDs |
| Single worker | CPU-bound on one machine | **Horizontal scaling**: 5+ workers, each pulling from same task queue |
| Polling at 3 seconds | 1000 concurrent users = 300 req/s | **WebSockets or SSE**: push updates instead of pull |
| ZIP generation in web tier | Memory blowup at 5K guides | **Background export job**: generate ZIP via workflow, store in S3 |

#### What I actually built proactively

**Child workflow architecture** to stay under Temporal's 50K event limit:

```typescript
// Parent spawns throttled child workflows for 5000 files
const fileChunks = chunkArray(fileIds, 100);
await executeChildrenThrottled(
  fileChunks.map((chunk, i) => () =>
    executeChild('fileChunkWorkflow', {
      workflowId: `${runId}-file-chunk-${i}`,
      args: [runId, chunk, i],
    })
  ),
  MAX_CONCURRENT_CHILDREN  // 10 at a time
);
```

**Event count analysis:**
- Parent: ~165 events (child starts + setup)
- Each child: ~1,000 events (100 items)
- Total: distributed across 51 workflows, all under 10K

**Idempotency guards** to handle activity retries safely:
- Check terminal state before processing
- Conditional DB updates with WHERE clauses
- Derive counts from ground truth via `groupBy`

#### Richer UX at 3 months

1. **Bulk operations** — "Retry all failed guides" button
2. **Guide templates** — save successful guide configs to reuse
3. **Source highlighting** — click a guide section, see which document it came from
4. **Scheduling** — "Run every Monday with new docs from SharePoint"
5. **Audit log** — who ran what, when, what changed
6. **RBAC** — viewers vs editors vs admins

#### Pipeline becomes 3-layer system

Today: "convert inside each run"

At 50x:

1. **Ingest & convert once** — Files are content-addressed (`sha256`), conversion cached
2. **Index once** — Embeddings stored in vector DB, search becomes fast
3. **Generate many** — Runs mostly do retrieval + generation, not conversion

This is the fundamental scale lever: **stop repeating conversion and indexing**.

#### The real bottleneck I'd watch

**Database write contention.** With 50 concurrent child workflows all doing atomic increments, you hit row-level lock contention. Solutions:

1. **Batch updates** — children write to temp table, parent aggregates
2. **Redis counters** — atomic increments, periodic flush to Postgres
3. **Event sourcing** — log events, compute counts on read

---

## Summary for Application

> "In about 3 hours of focused work, I built a working demo that handles 5,000 documents through a durable workflow pipeline. The key insight was making Temporal invisible to users—they see 'Reading documents' and 'Needs attention', not 'ActivityTaskTimedOut'. I built the child workflow architecture proactively because I knew a naive approach would hit Temporal's history limits around 5K guides. I also implemented idempotency guards in activities to handle worker crashes gracefully—this is the difference between 'works in happy path' and 'I've shipped pipelines under load.'"

---

## Live Demo

- **Web App**: https://web-production-dc150.up.railway.app
- **Temporal UI**: https://temporal-ui-production-04cb.up.railway.app (intentionally public for reviewer inspection)
- **GitHub**: https://github.com/austeane/trelent-demo

---

## Key Technical Decisions

### Why Temporal is internal-only

Temporal OSS has no built-in auth. Exposing it publicly would be a security footgun. The web app acts as the authenticated boundary—users interact with progress via REST API, never directly with Temporal.

### Why DB as source of truth for UI

Temporal is optimized for durability, not queries. Complex UI requirements (filtering, pagination, search) belong in Postgres. Temporal orchestrates; Postgres serves product needs.

### Why status enums in Prisma

```prisma
enum GuideStatus {
  pending
  searching
  generating
  completed
  needs_attention
}
```

Stringly-typed status is a drift magnet. Enums give:
- DB-level constraint on valid values
- TypeScript union types
- UI can't silently break on rename

### Why sandbox on iframe

```tsx
<iframe srcDoc={guide.htmlContent} sandbox="allow-same-origin" />
```

User-generated HTML in an iframe without sandbox = XSS vulnerability. The sandbox restricts script execution while still allowing styles to render.
