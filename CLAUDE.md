# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Temporal + Next.js demo that converts documents into AI-generated guides through a durable workflow pipeline. It demonstrates handling slow/unreliable dependencies at scale (5-5,000 guides).

**Live:** https://web-production-dc150.up.railway.app

## Commands

```bash
# Local development (starts Docker services + web + worker)
npm run dev

# Or start services individually
docker-compose up -d                    # Postgres, Temporal, Temporal UI
npm run dev -w web                      # Next.js on :3000
npm run dev -w worker                   # Temporal worker

# Database
cd web && npx prisma db push            # Push schema changes (dev)
cd web && npx prisma generate           # Generate client after schema change
cd worker && npx prisma generate        # Worker needs its own generated client

# Quality checks
npm run typecheck                       # TypeScript check (both workspaces)
npm run format                          # Prettier format
npm run format:check                    # Prettier check

# Build
npm run build                           # Build both web and worker
```

## Architecture

```
Browser → Next.js (web/) → Postgres
              ↓ gRPC
         Temporal Server ← Worker (worker/)
```

**Key principle:** Temporal orchestrates workflows. Postgres is the queryable state for UI.

### Workspaces

- **web/** - Next.js 14 app with API routes that act as control plane for Temporal
- **worker/** - Temporal worker with workflows and activities

Both workspaces share the same Prisma schema but generate clients independently (avoids Docker build complexity).

### Workflow Architecture

Parent workflow (`guideGeneration.ts`) orchestrates child workflows to stay under Temporal's 50K event history limit:

- `fileChunkWorkflow` - processes 100 files per chunk
- `guideChunkWorkflow` - processes 100 guides per chunk
- Bounded concurrency: 10 children × 5/10 activities = controlled load

### Database Models

- `Run` - overall job status/stage and counters
- `File` - document conversion state (pending → converting → converted/failed)
- `Guide` - guide generation state (pending → searching → generating → completed/needs_attention)

Status enums are defined in `web/prisma/schema.prisma` and imported from `@prisma/client`.

## Key Implementation Details

### Idempotency Pattern

Activities implement three-part idempotency:
1. Terminal state short-circuit (return early if already done)
2. Conditional transitions (`updateMany WHERE status IN [expected]`)
3. Fallback check if no rows updated (another worker completed it)

See `worker/src/activities/convert.ts` and `worker/src/activities/generate.ts`.

### Task Queue

Both web and worker use task queue `guide-generation`. The constant is duplicated (tech debt) - defined in:
- `web/lib/temporal.ts`
- `worker/src/worker.ts`

### Mock Services

Document conversion and guide generation are mocked with configurable latency/failure rates:
- `worker/src/activities/convert.ts` - MOCK_CONFIG for conversion
- `worker/src/activities/generate.ts` - SEARCH_CONFIG, GENERATION_CONFIG

### API Routes

All Prisma routes need `export const runtime = 'nodejs'` for Railway deployment.

Key routes:
- `POST /api/runs` - creates run, starts Temporal workflow
- `GET /api/runs/[runId]/guides` - paginated guides with status filter
- `POST /api/guides/[guideId]/retry` - triggers retry workflow

## Railway Deployment

5 services on Railway:
1. postgres (internal)
2. temporal - `temporalio/auto-setup:1.24.2` (internal, DB=postgres12)
3. temporal-ui - `temporalio/ui:2.31.2` (public for demo)
4. worker - connects to `temporal.railway.internal:7233`
5. web - public Next.js app

**Important:** For monorepo, set Root Directory in Railway dashboard per-service (web/ or worker/).

## Local URLs

- Web: http://localhost:3000
- Temporal UI: http://localhost:8080
- Temporal gRPC: localhost:7233
- Postgres: localhost:5432 (user: trelent, pass: trelent)
