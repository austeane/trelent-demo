# Trelent Guide Generation Pipeline — Final Build Plan

## Executive Summary

Build a working demo of a durable document-to-guide pipeline using Temporal OSS, deployed to Railway with a shareable URL. External APIs are mocked with realistic latency and failure modes. The orchestration, data model, failure handling, and UI are production-quality.

**Key architectural insight:** Keep Temporal private. Expose only an HTTP control plane API. This avoids security risks (Temporal OSS has no auth) and serverless compatibility issues.

---

## Architecture (Final Decision)

### Why "Everything on Railway"

After analyzing both deployment approaches, **deploying everything to Railway** is the right choice:

| Approach | Pros | Cons |
|----------|------|------|
| **Vercel UI + Railway Backend** | Vercel DX | Cross-provider networking; must expose Temporal or build API gateway |
| **Everything on Railway** | Private networking; Temporal stays internal; simpler | Not "Vercel" but reviewers won't care |

**Decision:** All services on Railway. This gives you:
- A shareable public URL (what reviewers actually want)
- Temporal stays private (no auth foot-gun)
- Worker ↔ Temporal ↔ Postgres all communicate internally
- One deployment target, one set of env vars

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              RAILWAY                                     │
│                                                                         │
│  ┌─────────────────────┐      ┌─────────────────────┐                  │
│  │     Next.js App     │      │   Temporal Server   │                  │
│  │   (public HTTPS)    │      │ (internal only)     │                  │
│  │                     │      │                     │                  │
│  │  - UI pages         │      │  temporal.railway   │                  │
│  │  - API routes       │      │  .internal:7233     │                  │
│  │    (control plane)  │      │                     │                  │
│  └──────────┬──────────┘      └──────────▲──────────┘                  │
│             │                            │                              │
│             │ SQL                        │ gRPC (internal)              │
│             ▼                            │                              │
│  ┌─────────────────────┐      ┌──────────┴──────────┐                  │
│  │     PostgreSQL      │◄────►│      Worker         │                  │
│  │  (internal only)    │      │   (Node.js)         │                  │
│  │                     │      │                     │                  │
│  │  postgres.railway   │      │  - Workflows        │                  │
│  │  .internal:5432     │      │  - Activities       │                  │
│  └─────────────────────┘      │  - Mock APIs        │                  │
│                               └─────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
                    │
                    │ HTTPS (public)
                    ▼
              ┌───────────┐
              │  Browser  │
              └───────────┘
```

**Key insight:** Next.js API routes become your "control plane API." They run on Railway (not Vercel serverless), so they can maintain gRPC connections to Temporal.

---

## What Makes This "Principal Engineer Level"

### 1. Durable Orchestration That Actually Works
- Workflows survive restarts
- Activities have timeouts and heartbeats
- Retries are intelligent (degrading strategy, not blind)

### 2. Failure Modes Are First-Class
- Partial success is the default
- Failures surface in user terms, not infra terms
- "Needs attention" vs "failed" distinction

### 3. Security Model Is Sane
- Temporal is not publicly exposed
- Only your authenticated API is reachable
- No "anyone can cancel your workflows" risk

### 4. Scale Patterns Are Demonstrated
- Bounded concurrency (not "spawn 5000 parallel tasks")
- Progress writes to DB (not polling Temporal for 5000 statuses)
- Pagination in UI (don't render everything)

---

## Data Model

```sql
-- Runs: batch jobs
CREATE TABLE runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
                    -- pending | processing | completed | completed_with_errors | failed
    stage           TEXT NOT NULL DEFAULT 'initializing',
                    -- initializing | converting_documents | finding_content | 
                    -- writing_guides | finalizing | complete
    total_files     INTEGER NOT NULL DEFAULT 0,
    converted_files INTEGER NOT NULL DEFAULT 0,
    total_guides    INTEGER NOT NULL DEFAULT 0,
    completed_guides INTEGER NOT NULL DEFAULT 0,
    failed_guides   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    workflow_id     TEXT UNIQUE,
    error_message   TEXT
);

-- Files: source documents
CREATE TABLE files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    filename        TEXT NOT NULL,
    file_hash       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
                    -- pending | converting | converted | failed
    markdown_content TEXT,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(run_id, file_hash)
);

-- Guides: outputs to generate
CREATE TABLE guides (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
                    -- pending | searching | generating | completed | needs_attention
    search_results  JSONB,
    html_content    TEXT,
    failure_reason  TEXT,           -- Human-readable
    failure_details JSONB,          -- Technical details
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_files_run_status ON files(run_id, status);
CREATE INDEX idx_guides_run_status ON guides(run_id, status);
```

---

## Temporal Workflow Design

### Critical Constraint: Determinism

Temporal workflows must be deterministic. This means:

```typescript
// ❌ WRONG - non-deterministic in workflow
const delay = Math.random() * 5000;
await sleep(delay);

// ✅ RIGHT - randomness in activity
export async function simulateWork(): Promise<void> {
  const delay = Math.random() * 5000;  // OK in activity
  await sleep(delay);
}
```

All `Math.random()`, `Date.now()`, and I/O must happen in **activities**, not workflows.

### Workflow Structure

```typescript
// workflows/guideGeneration.ts
import {
  proxyActivities,
  defineQuery,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type * as activities from '../activities';

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 4,
  },
});

export interface Progress {
  stage: string;
  totalFiles: number;
  convertedFiles: number;
  totalGuides: number;
  completedGuides: number;
  failedGuides: number;
}

export const getProgress = defineQuery<Progress>('getProgress');

export async function guideGenerationWorkflow(
  runId: string,
  fileIds: string[],
  guideIds: string[]
): Promise<void> {
  
  let progress: Progress = {
    stage: 'initializing',
    totalFiles: fileIds.length,
    convertedFiles: 0,
    totalGuides: guideIds.length,
    completedGuides: 0,
    failedGuides: 0,
  };
  
  setHandler(getProgress, () => progress);

  // === Stage 1: Convert files ===
  progress.stage = 'converting_documents';
  await acts.updateRunStage(runId, 'converting_documents');

  const CONVERT_CONCURRENCY = 5;
  for (let i = 0; i < fileIds.length; i += CONVERT_CONCURRENCY) {
    const batch = fileIds.slice(i, i + CONVERT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(id => acts.convertFile(runId, id))
    );
    
    progress.convertedFiles += results.filter(
      r => r.status === 'fulfilled' && r.value.success
    ).length;
    
    await acts.updateRunProgress(runId, {
      convertedFiles: progress.convertedFiles,
    });
  }

  // === Stage 2: Generate guides ===
  progress.stage = 'writing_guides';
  await acts.updateRunStage(runId, 'writing_guides');

  const GENERATE_CONCURRENCY = 10;
  for (let i = 0; i < guideIds.length; i += GENERATE_CONCURRENCY) {
    const batch = guideIds.slice(i, i + GENERATE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(id => acts.processGuide(runId, id))
    );
    
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) {
        progress.completedGuides++;
      } else {
        progress.failedGuides++;
      }
    }
    
    await acts.updateRunProgress(runId, {
      completedGuides: progress.completedGuides,
      failedGuides: progress.failedGuides,
    });
  }

  // === Stage 3: Finalize ===
  progress.stage = 'complete';
  await acts.finalizeRun(runId, {
    completed: progress.completedGuides,
    failed: progress.failedGuides,
  });
}
```

### Degrading Retry Strategy (Generation)

```typescript
// activities/generateGuide.ts
export async function processGuide(
  runId: string,
  guideId: string
): Promise<{ success: boolean }> {
  
  const guide = await db.guide.findUnique({ where: { id: guideId } });
  const attempt = guide.attempts + 1;
  
  await db.guide.update({
    where: { id: guideId },
    data: { status: 'searching', attempts: attempt },
  });

  // Step 1: Search
  const searchResults = await searchCorpus(runId, guide.description);
  
  if (searchResults.length === 0) {
    await db.guide.update({
      where: { id: guideId },
      data: {
        status: 'needs_attention',
        failureReason: "We couldn't find relevant content in your documents for this guide.",
        searchResults: [],
      },
    });
    return { success: false };
  }

  await db.guide.update({
    where: { id: guideId },
    data: { status: 'generating', searchResults },
  });

  // Step 2: Generate with degrading strategy
  try {
    let html: string;
    
    if (attempt === 1) {
      // Full context, best quality
      html = await generateWithFullContext(guide, searchResults);
    } else if (attempt === 2) {
      // Reduced context
      html = await generateWithReducedContext(guide, searchResults.slice(0, 2));
    } else {
      // Skeleton with "needs review" markers
      html = generateSkeletonOutput(guide, searchResults);
    }
    
    await db.guide.update({
      where: { id: guideId },
      data: { status: 'completed', htmlContent: html },
    });
    
    return { success: true };
    
  } catch (error) {
    if (isRetryable(error) && attempt < 3) {
      throw error; // Let Temporal retry
    }
    
    await db.guide.update({
      where: { id: guideId },
      data: {
        status: 'needs_attention',
        failureReason: 'Generation failed after multiple attempts. The content may need manual review.',
        failureDetails: { error: error.message, attempts: attempt },
      },
    });
    
    return { success: false };
  }
}
```

---

## Mock External Services

```typescript
// activities/mocks.ts
import { Context } from '@temporalio/activity';

interface MockConfig {
  minLatencyMs: number;
  maxLatencyMs: number;
  failureRate: number;
}

const MOCK_CONFIG = {
  conversion: {
    minLatencyMs: 1500,
    maxLatencyMs: 6000,
    failureRate: 0.05,
  },
  search: {
    minLatencyMs: 800,
    maxLatencyMs: 3000,
    failureRate: 0.02,
    noResultsRate: 0.08,
  },
  generation: {
    minLatencyMs: 2000,
    maxLatencyMs: 12000,
    failureRate: 0.04,
  },
};

async function simulateLatency(config: MockConfig): Promise<void> {
  const duration = config.minLatencyMs + 
    Math.random() * (config.maxLatencyMs - config.minLatencyMs);
  
  const chunks = Math.ceil(duration / 1000);
  for (let i = 0; i < chunks; i++) {
    Context.current().heartbeat(`Processing ${i + 1}/${chunks}`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

function shouldFail(rate: number): boolean {
  return Math.random() < rate;
}

// Deterministic mock content based on inputs (for reproducible demos)
function generateMockMarkdown(filename: string, seed: string): string {
  // Use filename + seed to generate consistent content
  return `# ${filename}\n\n## Overview\n\nThis document covers policies and procedures...\n`;
}

function generateMockHTML(
  guideName: string,
  description: string,
  sources: SearchResult[]
): string {
  return `<!DOCTYPE html>
<html>
<head><title>${guideName}</title></head>
<body>
  <h1>${guideName}</h1>
  <p>${description}</p>
  <h2>Content</h2>
  <p>Based on ${sources.length} source documents...</p>
  <h2>Sources</h2>
  <ul>
    ${sources.map(s => `<li>${s.filename}</li>`).join('\n')}
  </ul>
</body>
</html>`;
}
```

---

## API Routes (Control Plane)

Since we're on Railway (not Vercel serverless), Next.js API routes can maintain persistent connections to Temporal.

```typescript
// app/api/runs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getTemporalClient } from '@/lib/temporal';
import { db } from '@/lib/db';
import { v4 as uuid } from 'uuid';

export async function POST(request: NextRequest) {
  const { name, files, guides } = await request.json();
  
  const runId = uuid();
  
  // Create database records
  const run = await db.run.create({
    data: {
      id: runId,
      name,
      status: 'pending',
      totalFiles: files.length,
      totalGuides: guides.length,
    },
  });
  
  const fileRecords = await db.file.createMany({
    data: files.map((f: any) => ({
      runId,
      filename: f.filename,
      fileHash: f.hash,
      status: 'pending',
    })),
  });
  
  const guideRecords = await db.guide.createMany({
    data: guides.map((g: any) => ({
      runId,
      name: g.name,
      description: g.description,
      status: 'pending',
    })),
  });
  
  // Get IDs for workflow
  const fileIds = await db.file.findMany({
    where: { runId },
    select: { id: true },
  }).then(rows => rows.map(r => r.id));
  
  const guideIds = await db.guide.findMany({
    where: { runId },
    select: { id: true },
  }).then(rows => rows.map(r => r.id));
  
  // Start Temporal workflow
  const client = await getTemporalClient();
  await client.workflow.start('guideGenerationWorkflow', {
    taskQueue: 'guide-generation',
    workflowId: `run-${runId}`,
    args: [runId, fileIds, guideIds],
  });
  
  await db.run.update({
    where: { id: runId },
    data: { 
      status: 'processing',
      workflowId: `run-${runId}`,
      startedAt: new Date(),
    },
  });
  
  return NextResponse.json({ runId });
}

export async function GET() {
  const runs = await db.run.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return NextResponse.json(runs);
}
```

```typescript
// app/api/runs/[runId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { runId: string } }
) {
  const run = await db.run.findUnique({
    where: { id: params.runId },
  });
  
  if (!run) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  
  // Get guide counts by status
  const guideCounts = await db.guide.groupBy({
    by: ['status'],
    where: { runId: params.runId },
    _count: true,
  });
  
  return NextResponse.json({
    run,
    guideCounts: Object.fromEntries(
      guideCounts.map(g => [g.status, g._count])
    ),
  });
}
```

```typescript
// app/api/runs/[runId]/guides/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: { runId: string } }
) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const page = parseInt(searchParams.get('page') || '1');
  const pageSize = 20;
  
  const where = {
    runId: params.runId,
    ...(status ? { status } : {}),
  };
  
  const [guides, total] = await Promise.all([
    db.guide.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.guide.count({ where }),
  ]);
  
  return NextResponse.json({
    guides,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}
```

---

## Temporal Client Configuration

```typescript
// lib/temporal.ts
import { Client, Connection } from '@temporalio/client';

let client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (client) return client;
  
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  
  const connection = await Connection.connect({ address });
  client = new Client({ connection });
  
  return client;
}
```

---

## Railway Deployment

### Project Structure

```
trelent-demo/
├── web/                      # Next.js app (UI + API routes)
│   ├── app/
│   │   ├── page.tsx
│   │   ├── runs/[runId]/page.tsx
│   │   └── api/
│   │       ├── runs/route.ts
│   │       └── runs/[runId]/route.ts
│   ├── lib/
│   │   ├── temporal.ts
│   │   └── db.ts
│   ├── Dockerfile
│   └── package.json
├── worker/                   # Temporal worker
│   ├── src/
│   │   ├── worker.ts
│   │   ├── workflows/
│   │   └── activities/
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml        # Local development
├── railway.toml              # Railway config
└── README.md
```

### Dockerfiles

```dockerfile
# web/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

```dockerfile
# worker/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/worker.js"]
```

### Railway Services (4 total)

| Service | Type | Networking |
|---------|------|------------|
| **postgres** | Railway Postgres plugin | Internal only |
| **temporal** | Docker (temporalio/auto-setup) | Internal only |
| **worker** | Docker (your worker) | Internal only |
| **web** | Docker (Next.js) | **Public** (generates URL) |

### Environment Variables

**temporal service:**
```
DB=postgresql
DB_PORT=5432
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PWD=${POSTGRES_PASSWORD}
POSTGRES_SEEDS=postgres.railway.internal
```

**worker service:**
```
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres.railway.internal:5432/railway
TEMPORAL_ADDRESS=temporal.railway.internal:7233
```

**web service:**
```
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres.railway.internal:5432/railway
TEMPORAL_ADDRESS=temporal.railway.internal:7233
```

### Railway Deployment Commands

```bash
# 1. Install Railway CLI
npm install -g @railway/cli
railway login

# 2. Create project
railway init

# 3. Add Postgres
railway add --plugin postgresql

# 4. Create services (from Railway dashboard or CLI)
# - temporal (Docker, use temporalio/auto-setup:1.22 image)
# - worker (Docker, point to worker/ directory)
# - web (Docker, point to web/ directory)

# 5. Set environment variables in Railway dashboard

# 6. Deploy
railway up
```

### Local Development (Docker Compose)

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: trelent
      POSTGRES_PASSWORD: trelent
      POSTGRES_DB: trelent
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data

  temporal:
    image: temporalio/auto-setup:1.22
    depends_on:
      - postgres
    environment:
      - DB=postgresql
      - DB_PORT=5432
      - POSTGRES_USER=trelent
      - POSTGRES_PWD=trelent
      - POSTGRES_SEEDS=postgres
    ports:
      - '7233:7233'

  temporal-ui:
    image: temporalio/ui:2.22.0
    depends_on:
      - temporal
    environment:
      - TEMPORAL_ADDRESS=temporal:7233
    ports:
      - '8080:8080'

volumes:
  pgdata:
```

---

## UI Components (Key Pieces)

### Run Progress

```typescript
// components/RunProgress.tsx
'use client';

import { useEffect, useState } from 'react';

const STAGE_LABELS: Record<string, { label: string; description: string }> = {
  initializing: {
    label: 'Setting up',
    description: 'Preparing your documents for processing',
  },
  converting_documents: {
    label: 'Reading your documents',
    description: 'Converting PDFs and Word docs into a consistent format',
  },
  finding_content: {
    label: 'Finding relevant content',
    description: 'Searching across your documents for each guide',
  },
  writing_guides: {
    label: 'Writing guides',
    description: 'Generating HTML guides from your source content',
  },
  finalizing: {
    label: 'Finishing up',
    description: 'Preparing your results',
  },
  complete: {
    label: 'Done',
    description: 'Your guides are ready',
  },
};

export function RunProgress({ runId }: { runId: string }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    let active = true;
    
    const poll = async () => {
      const res = await fetch(`/api/runs/${runId}`);
      const json = await res.json();
      if (active) setData(json);
      
      if (active && !['completed', 'completed_with_errors', 'failed'].includes(json.run.status)) {
        setTimeout(poll, 2000);
      }
    };
    
    poll();
    return () => { active = false; };
  }, [runId]);

  if (!data) return <LoadingSkeleton />;

  const { run, guideCounts } = data;
  const stage = STAGE_LABELS[run.stage] || STAGE_LABELS.initializing;
  
  const completed = guideCounts.completed || 0;
  const needsAttention = guideCounts.needs_attention || 0;
  const inProgress = run.totalGuides - completed - needsAttention;
  const progress = run.totalGuides > 0 
    ? Math.round(((completed + needsAttention) / run.totalGuides) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Stage */}
      <div>
        <h2 className="text-xl font-semibold text-gray-900">{stage.label}</h2>
        <p className="text-gray-500">{stage.description}</p>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 rounded-full h-3">
        <div
          className="bg-blue-600 h-3 rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 text-center">
        <Stat value={completed} label="Ready" color="green" />
        <Stat value={inProgress} label="In progress" color="blue" />
        <Stat value={needsAttention} label="Need attention" color="amber" />
      </div>
    </div>
  );
}
```

### Guide Card with Failure Explanation

```typescript
// components/GuideCard.tsx
export function GuideCard({ guide }: { guide: Guide }) {
  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="flex justify-between">
        <div>
          <h3 className="font-medium">{guide.name}</h3>
          <StatusBadge status={guide.status} />
        </div>
        {guide.status === 'completed' && (
          <a href={`/api/guides/${guide.id}/download`} className="text-blue-600">
            Download
          </a>
        )}
      </div>

      {guide.status === 'needs_attention' && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded">
          <p className="text-sm text-amber-800 font-medium">
            {guide.failureReason}
          </p>
          
          {guide.searchResults?.length > 0 && (
            <div className="mt-2 text-xs text-amber-700">
              <p className="font-medium">Closest matches we found:</p>
              <ul className="mt-1 space-y-1">
                {guide.searchResults.slice(0, 3).map((r, i) => (
                  <li key={i}>• {r.filename}: "{r.snippet.slice(0, 60)}..."</li>
                ))}
              </ul>
            </div>
          )}
          
          <div className="mt-3 flex gap-2">
            <button className="px-3 py-1 text-xs bg-amber-600 text-white rounded">
              Edit description
            </button>
            <button className="px-3 py-1 text-xs border border-amber-600 text-amber-600 rounded">
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Implementation Schedule (24 Hours)

### Hours 0-2: Setup
- [ ] Create monorepo structure
- [ ] Docker Compose for local dev
- [ ] Verify Temporal + Temporal UI running
- [ ] Initialize Prisma schema

### Hours 2-5: Temporal Worker
- [ ] Worker entry point connecting to Temporal
- [ ] Workflow implementation (convert → generate loop)
- [ ] Activities with mock latency and failures
- [ ] Test via Temporal UI

### Hours 5-8: Database + API
- [ ] Run Prisma migrations
- [ ] `POST /api/runs` (create run + start workflow)
- [ ] `GET /api/runs/:id` (status + counts)
- [ ] `GET /api/runs/:id/guides` (paginated list)
- [ ] Test API with curl

### Hours 8-14: Frontend
- [ ] Dashboard page (list runs, "New Run" button)
- [ ] Sample dataset (hardcoded for demo)
- [ ] Run detail page with polling progress
- [ ] Guide list with status filters
- [ ] Guide detail with HTML preview

### Hours 14-18: Polish
- [ ] Failure explanations with evidence
- [ ] Loading skeletons
- [ ] Error states
- [ ] Tune mock latencies for demo pacing (not too fast, not too slow)

### Hours 18-22: Deploy
- [ ] Create Railway project
- [ ] Deploy Postgres, Temporal, Worker, Web
- [ ] Configure environment variables
- [ ] Test full flow on deployed URL

### Hours 22-24: Documentation
- [ ] README with architecture diagram
- [ ] Local setup instructions
- [ ] Record 2-3 minute demo video
- [ ] Final test

---

## What Success Looks Like

A reviewer can:

1. **Open the public URL** (no local setup required)
2. **Start a run** with sample data
3. **Watch progress** update in real-time
4. **See a mix** of completed and needs-attention guides
5. **Click into a guide** and see:
   - Rendered HTML preview
   - Source documents that contributed
   - Human-readable failure explanation (if applicable)
6. **Optionally** open Temporal UI to see workflow execution details

This demonstrates:
- Durable orchestration that handles failures
- Production-quality data modeling
- User-focused failure handling
- Full-stack implementation capability
- Deployment competence

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| Temporal OSS exposed publicly | Keep it internal; only web service is public |
| Workflow history bloat at scale | Bounded concurrency; progress writes to DB not workflow events |
| 24h isn't enough time | Cut to 10-20 guides for demo; mocks make testing fast |
| Railway networking issues | Test locally first; use internal hostnames |
| Prisma + Temporal worker issues | Share db client code between web and worker packages |

---

## Files to Create (Minimum Viable)

```
trelent-demo/
├── web/
│   ├── app/
│   │   ├── page.tsx                 # Dashboard
│   │   ├── runs/
│   │   │   └── [runId]/
│   │   │       └── page.tsx         # Run detail
│   │   └── api/
│   │       ├── runs/
│   │       │   ├── route.ts         # POST, GET
│   │       │   └── [runId]/
│   │       │       ├── route.ts     # GET run
│   │       │       └── guides/
│   │       │           └── route.ts # GET guides
│   │       └── guides/
│   │           └── [guideId]/
│   │               └── route.ts     # GET guide detail
│   ├── components/
│   │   ├── RunProgress.tsx
│   │   ├── GuideCard.tsx
│   │   └── GuidePreview.tsx
│   ├── lib/
│   │   ├── db.ts                    # Prisma client
│   │   └── temporal.ts              # Temporal client
│   ├── prisma/
│   │   └── schema.prisma
│   ├── Dockerfile
│   ├── next.config.js
│   └── package.json
├── worker/
│   ├── src/
│   │   ├── worker.ts                # Entry point
│   │   ├── workflows/
│   │   │   └── guideGeneration.ts
│   │   ├── activities/
│   │   │   ├── index.ts
│   │   │   ├── convert.ts
│   │   │   ├── search.ts
│   │   │   ├── generate.ts
│   │   │   └── db.ts
│   │   └── lib/
│   │       └── db.ts                # Shared Prisma client
│   ├── Dockerfile
│   ├── tsconfig.json
│   └── package.json
├── docker-compose.yml
└── README.md
```

Total: ~25-30 files. Very achievable in 24 hours with focused execution.
