# Decisions, Concerns & Tech Debt

## Decisions Made

### 2024-12-09: Project Setup
- **Railway project name**: `trelent-demo` (user choice)
- **Temporal UI**: Included as public service for debugging (user choice)
- **Monorepo structure**: web/ + worker/ with npm workspaces
- **Node version**: 20 (LTS, required for Temporal SDK)

### Architecture Decisions
- **Prisma shared between web/worker**: Each has own copy of schema, generates client locally. Avoids symlink complexity in Docker builds.
- **Next.js standalone output**: Required for Railway Docker deployment
- **Temporal SDK version**: 1.11.3 (latest stable)

## Concerns

### Potential Issues
1. **Temporal auto-setup image**: Using `temporalio/auto-setup:1.24.2` which creates its own DB. May need separate Postgres DB for Temporal vs app data.
2. **Railway internal networking**: Need to verify `*.railway.internal` DNS resolution works between services.
3. **Prisma migrations on Railway**: May need to run migrations manually or via deploy command.

## Tech Debt

### Known Shortcuts
1. **No authentication**: Demo app has no auth - anyone with URL can create runs
2. **No rate limiting**: Could be abused if URL shared widely
3. **Hardcoded sample data**: Files/guides are mocked, no real upload
4. **No real file storage**: Mock conversion doesn't persist actual files
5. **TypeScript strict mode**: Using `as any` for Prisma JSON fields in worker/src/activities/generate.ts:208
6. **No input validation**: API routes don't validate request bodies

### Future Improvements (out of scope for demo)
- Add proper auth (NextAuth, Clerk, etc.)
- Real file upload to S3/R2
- Real document conversion (Unstructured, AWS Textract)
- Real vector search (Pinecone, Weaviate)
- Real LLM generation (OpenAI, Anthropic)
- Worker auto-scaling based on queue depth
- Proper observability (Datadog, Honeycomb)

## Questions for Later
- Should Temporal have its own Postgres database separate from app?
- Do we need health checks on Railway services?
- What's the best way to handle Prisma migrations in Railway?

## Railway Deployment Notes

**Issue encountered:** Railway CLI cannot create services from Docker Hub images directly. The `railway deploy -t` command only works with Railway templates, not arbitrary Docker images.

**Workaround options:**
1. Create Temporal and Temporal-UI services via Railway dashboard manually
2. Use Railway API directly
3. Create a Dockerfile that pulls and runs the Temporal image

**Chosen approach:** Will need user to create via Railway dashboard:
- Temporal service: Docker image `temporalio/auto-setup:1.24.2`
- Temporal UI service: Docker image `temporalio/ui:2.31.2`

**Services that CAN be deployed via CLI:**
- web (using `railway up` from web/ directory)
- worker (using `railway up` from worker/ directory)

---

## Deployment Complete - 2024-12-09

**Public URLs:**
- Web App: https://web-production-dc150.up.railway.app
- Temporal UI: https://temporal-ui-production-04cb.up.railway.app

**Key fixes during deployment:**
1. `DB=postgresql` → `DB=postgres12` for Temporal auto-setup image
2. Root Directory must be set in Railway dashboard for monorepo services (not just railway.json)
3. Railpack auto-detects start commands from package.json - no Dockerfile needed once root dir is set

**Final architecture:**
- 5 services on Railway (Postgres, Temporal, Temporal-UI, Worker, Web)
- All internal except Web (public) and Temporal-UI (public for debugging)
- Worker connects to Temporal via `temporal.railway.internal:7233`

---

## Next Steps

### Immediate Cleanup
- [x] Remove unnecessary Dockerfile and railway.json workaround files
- [ ] Delete extra Postgres instances (Postgres-E735, Postgres-3KGN) via Railway dashboard

### Demo Polish
- [ ] Tune mock latencies for better demo pacing (currently completes in ~37s, may want slower)
- [ ] Add loading skeletons to UI components
- [ ] Add error boundary components
- [ ] Style the "needs attention" guide cards more prominently

### Production Readiness (Future)
- [ ] Add authentication (NextAuth, Clerk)
- [ ] Add rate limiting on API routes
- [ ] Replace mock file conversion with real service (Unstructured, AWS Textract)
- [ ] Replace mock search with vector DB (Pinecone, Weaviate)
- [ ] Replace mock generation with LLM (OpenAI, Anthropic)
- [ ] Add real file upload to S3/R2
- [ ] Add observability (Datadog, Honeycomb)
- [ ] Add Worker Versioning for safe deployments
- [ ] Add Continue-As-New for long-running batches
- [ ] Configure health checks on Railway services

### Code Quality
- [ ] Add proper TypeScript types (remove `as any` casts)
- [ ] Add input validation on API routes (zod)
- [ ] Add error handling for edge cases
- [ ] Add unit tests for activities
- [ ] Add integration tests for workflows

---
*Updated as implementation progresses*
