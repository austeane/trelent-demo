# Temporal docs context for Trelent demo

This pulls the most relevant guidance from the Temporal docs repo and notes how it should adjust the existing plan. Paths point into the docs repo for quick lookup.

## Key references

- `../documentation/docs/develop/typescript/core-application.mdx`: Workflows run in a deterministic sandbox (no Node/DOM APIs, `Math.random` replaced), side effects must stay in Activities, and non-deterministic libs must be excluded via `ignoreModules`. Activities live outside Workflow bundles and return serializable payloads.
- `../documentation/docs/develop/typescript/failure-detection.mdx`: Prefer `ApplicationFailure` (with `nonRetryable` when needed); Workflows only fail when you throw from Workflow code. Set `startToCloseTimeout` on Activities, use retry policies deliberately, and heartbeat long Activities to surface cancellations.
- `../documentation/docs/develop/typescript/continue-as-new.mdx` (see also `self-hosted-guide/defaults.mdx`): Use Continue-As-New to keep histories below warn/error limits (10 MB/50 MB or ~10,240/51,200 events). Default payload limits are 256 KB warn/2 MB error (per payload) and 4 MB gRPC message cap—use a claim-check pattern for big docs.
- `../documentation/docs/develop/typescript/versioning.mdx` and `docs/best-practices/worker.mdx`: Use Worker Versioning (build IDs) to roll out new Workflow code; keep Task Queue names as shared constants; run ≥2 pollers per queue; separate queues per workload. Manage sticky cache size and do graceful shutdown when `worker_task_slots_available` is low.
- `../documentation/docs/develop/worker-performance.mdx`: Watch `workflow_task_schedule_to_start_latency`, `activity_task_schedule_to_start_latency`, `worker_task_slots_available`, and request latency metrics. Scale pollers/concurrency before saturating CPUs.
- `../documentation/docs/production-deployment/self-hosted-guide/checklist.mdx`: Load test and validate availability; shard count is fixed at cluster build time. Keep Temporal upgraded sequentially.
- `../documentation/docs/production-deployment/self-hosted-guide/defaults.mdx`: 2,000 pending Activities/Child Workflows/Signals default cap; identifier length defaults to 1000 chars; history and payload limits as above.
- `../documentation/docs/develop/typescript/converters-and-encryption.mdx`: For sensitive data, use payload codecs/data converters (can pair with a codec server for UI/CLI decode).
- `../documentation/docs/develop/typescript/continue-as-new.mdx`: Use `continueAsNew()` to reset history; `workflowInfo().continueAsNewSuggested` signals when to roll. Avoid calling from signal/update handlers; let main workflow drain handlers first.
- `../documentation/docs/develop/typescript/versioning.mdx` and `../documentation/docs/production-deployment/worker-deployments/worker-versioning.mdx`: Patching for replay-safe code changes; Worker Versioning (build IDs) for pinned vs auto-upgrade workflows and rainbow/blue-green rollouts. Versioning requires TS SDK ≥1.12 and server ≥1.28.
- `../documentation/docs/develop/worker-performance.mdx`: Poller autoscaling recommended; key metrics: `workflow_task_schedule_to_start_latency`, `activity_task_schedule_to_start_latency`, `worker_task_slots_available/used`, `sticky_cache_size`. Task slots can be fixed or resource-based; eager Activity/Workflow start is a latency optimization when starter+worker share a process.

## Suggested updates to `trelent-final-plan.md`

- Add explicit payload/history guardrails: enforce claim-check pattern for large files, keep per-payload <2 MB, watch history growth and call Continue-As-New when runs near 10k events/10 MB.
- Codify Activity options: set `startToCloseTimeout`, `heartbeatTimeout`, and retry policy on all Activities; mark non-retryable failures with `ApplicationFailure` types; heartbeat long mocks.
- Worker ops: define Task Queue names as shared constants; run ≥2 pollers per queue; include graceful shutdown and sticky cache sizing; add Worker Versioning rollout (build IDs) for safe upgrades with pinned vs auto-upgrade workflows.
- Observability: surface `schedule_to_start` and request latency metrics plus `worker_task_slots_available` in dashboards; alert on latency spikes (tune pollers/slots) and on sticky cache growth; keep Temporal private and add codec/data-converter for sensitive blobs.
- Security/privacy: keep Temporal private (already in plan) and, when needed, use payload codec/data converter to avoid storing sensitive doc content in histories.

## Notes for implementation

- Keep Workflow bundle deterministic; push all randomness/time and I/O into Activities. If you must use non-deterministic third-party modules, add them to `ignoreModules` only when safe.
- For long batches, consider Continue-As-New per run to avoid history bloat; also cap concurrent commands (<500 recommended) to stay well under the 2,000 pending default.
- Integrate claim-check pattern for converted documents and generated HTML: store blobs externally (DB/file store) and return references in histories.
- Prefer Worker Versioning (deploymentName+buildId) with rainbow/blue-green rollout; patching is the fallback for auto-upgrade workflows. Pin long-lived workflows; use auto-upgrade for short-lived ones that can replay with patches.
- Keep poller autoscaling on; watch `schedule_to_start` latency to decide when to add pollers vs slots. Use graceful shutdown if `worker_task_slots_available` is low to avoid retries on long Activities.
