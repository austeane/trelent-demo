import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';

// Use environment variable for task queue name to stay in sync with web
// Default matches the constant in web/lib/types.ts
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE || 'guide-generation';

async function run() {
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  console.log(`Connecting to Temporal at ${address}...`);

  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    // Load all workflows from index (parent + child workflows)
    workflowsPath: require.resolve('./workflows'),
    activities,
    // Increased concurrency for large-scale runs (5000+ files)
    maxConcurrentActivityTaskExecutions: 50,
    maxConcurrentWorkflowTaskExecutions: 20,
  });

  console.log(`Worker started, listening on task queue: ${TASK_QUEUE}`);

  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
