# Trelent Guide Generation Pipeline (Temporal + Next.js Demo)

This repo is my answer to:
**"How would you build a durable pipeline that turns messy docs into AI-generated guides, with slow/unreliable dependencies, at 5–5,000 guide scale?"**

I built a working app (not a design doc).

**Live Demo:** https://web-production-dc150.up.railway.app
**Temporal UI (demo-only):** https://temporal-ui-production-04cb.up.railway.app

> **Note on Temporal UI:** Intentionally public *only for this demo* so reviewers can inspect workflow history, retries, and child workflows. In production, Temporal UI/Server should be private or behind auth (Temporal OSS has no built-in auth).

---

## What to do as a reviewer (2 minutes)

1. Open the **Live Demo**
2. Click **"Demo with Failures"**
3. Watch the run move through:
   - **Reading documents** (mock conversion)
   - **Writing guides** (mock search + mock generation)
4. Filter to **Needs attention** guides and click **Try again**
5. (Optional) Open **Temporal UI** and inspect:
   - Parent workflow → child chunk workflows
   - Activity retries + heartbeats

---

## What's mocked vs real

**Real**
- Temporal orchestration (workflows + retries + durable execution)
- Postgres-backed run/file/guide state
- UI progress + pagination + search + retry flow
- Chunked child workflow architecture to control workflow history growth
- Idempotent activities with conditional state transitions

**Mocked**
- Document conversion API (simulated latency + failure rate)
- Search API (simulated latency + "no results" cases)
- LLM generation (simulated latency + failure rate + degrade-to-skeleton)

Mocks live in:
- `worker/src/activities/convert.ts`
- `worker/src/activities/generate.ts`

---

## Architecture

All services are deployed on Railway (simplifies networking; Temporal stays private).

```
Browser
    │
    ▼
Next.js Web (UI + API routes) ──── Postgres (runs/files/guides)
    │                                   ▲
    │ gRPC                              │ SQL
    ▼                                   │
Temporal Server  ◀──────── Worker (Temporal TS SDK)
    ▲
    │
Temporal UI (demo only)
```

**Key principle:**
Temporal orchestrates. Postgres is the queryable product state for the UI.

---

## Why Temporal (short version)

I used Temporal because the core problem is **durable orchestration over slow/unreliable dependencies**:
- Automatic retries with backoff per activity
- Heartbeats for stuck/long activities
- Workflow execution history for debugging
- Survives worker restarts without losing progress

---

## Scale strategy: chunked child workflows + bounded concurrency

A single workflow processing thousands of items can hit Temporal history limits (~50K events). This demo uses:

- **Parent workflow**: orchestration only (~165 events)
- **Child workflow per chunk**: 100 files/guides per child (~1K events each)
- **Throttled child concurrency**: 10 children at a time
- **Bounded activity concurrency**: 5 files or 10 guides per batch

**Verified at scale:** 5,000 files processed at ~760-800 files/minute.

Relevant files:
- `worker/src/workflows/guideGeneration.ts` (parent + retry workflow)
- `worker/src/workflows/fileChunkWorkflow.ts`
- `worker/src/workflows/guideChunkWorkflow.ts`

---

## Idempotency (principal-level detail)

Activities can be retried on worker crash, network failure, or timeout. Each activity implements:

1. **Terminal state short-circuit**: If already completed/failed, return early
2. **Conditional state transitions**: `updateMany(where: status in [expected states])`
3. **"Someone else did it" fallback**: Check current state if no rows updated

This prevents double-counting and state corruption during retries.

---

## Failure model: partial success by default

A run completes even if some guides need manual attention.

Guide statuses:
- `completed`
- `needs_attention` (actionable failures, not stack traces)

The UI surfaces failures in user terms:
- "We couldn't find relevant content for this guide"
- "Search service unavailable after multiple attempts"

And includes evidence (closest matches/snippets) + **Try again** button.

---

## Repo layout

```
├── web/                  # Next.js UI + API routes (control plane)
├── worker/               # Temporal worker (workflows + activities)
├── docker-compose.yml    # Local Temporal/Postgres setup
├── DECISIONS.md          # Design tradeoffs + known tech debt
└── INTERVIEW_QA.md       # Written answers mapped to the prompt
```

---

## Run locally

Prereqs:
- Node 20+
- Docker

```bash
# Start Postgres + Temporal + Temporal UI
docker-compose up -d

npm install

# DB schema (dev shortcut)
cd web && npx prisma db push && cd ..
cd worker && npx prisma generate && cd ..

# Start web + worker
npm run dev
```

Open:
- Web: http://localhost:3000
- Temporal UI: http://localhost:8080
- Temporal gRPC: localhost:7233

---

## API knobs (optional)

Create a run (defaults: 8 files, 12 guides):

```bash
curl -X POST http://localhost:3000/api/runs \
  -H "Content-Type: application/json" \
  -d '{"withFailures": true, "fileCount": 2000, "guideCount": 200}'
```

---

## What I'd do next (if this were production)

- Real file upload + object storage (S3/R2) + claim-check pattern
- Real conversion + vector search + real LLM integration
- Auth + rate limiting
- Run cancellation + "retry all failed"
- Background ZIP export (don't generate ZIP in the web request path)
- Observability: structured logs + metrics (schedule-to-start latency, activity durations, failure rates)

---

## Files of interest

| File | What it demonstrates |
|------|---------------------|
| `worker/src/workflows/guideGeneration.ts` | Parent workflow + throttled child execution |
| `worker/src/activities/generate.ts` | Idempotent activities + degrading retry |
| `worker/src/activities/convert.ts` | Heartbeats + conditional state transitions |
| `web/app/api/runs/route.ts` | Failure-atomic run creation with compensation |
| `web/components/RunProgress.tsx` | Real-time polling + stage-based UX |

---

## Questions?

Happy to discuss any technical decision in depth.

**Austin Eaton**
[GitHub](https://github.com/austeane)
