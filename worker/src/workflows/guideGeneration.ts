import {
  proxyActivities,
  defineQuery,
  setHandler,
  executeChild,
  ParentClosePolicy,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type { FileChunkResult } from './fileChunkWorkflow';
import type { GuideChunkResult } from './guideChunkWorkflow';

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

// Chunk size for child workflows - keeps history under Temporal's limits
const CHUNK_SIZE = 100;

// Max concurrent child workflows to avoid flooding the task queue
const MAX_CONCURRENT_CHILDREN = 10;

export interface Progress {
  stage: string;
  totalFiles: number;
  convertedFiles: number;
  totalGuides: number;
  completedGuides: number;
  failedGuides: number;
}

export const getProgress = defineQuery<Progress>('getProgress');

// Helper to chunk an array
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Throttled execution of child workflows to prevent task queue flooding
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

  // === Stage 1: Convert files using child workflows ===
  progress.stage = 'converting_documents';
  await acts.updateRunStage(runId, 'converting_documents');

  const fileChunks = chunkArray(fileIds, CHUNK_SIZE);

  // Execute file chunks with throttling to avoid flooding the task queue
  // Process MAX_CONCURRENT_CHILDREN chunks at a time
  const fileResults = await executeChildrenThrottled(
    fileChunks.map((chunk, index) => () =>
      executeChild<typeof import('./fileChunkWorkflow').fileChunkWorkflow>(
        'fileChunkWorkflow',
        {
          workflowId: `${runId}-file-chunk-${index}`,
          args: [runId, chunk, index],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE,
        }
      )
    ),
    MAX_CONCURRENT_CHILDREN
  );

  // Aggregate file results for progress tracking
  for (const result of fileResults) {
    if (result.status === 'fulfilled') {
      progress.convertedFiles += result.value.success;
    }
  }

  // === Stage 2: Generate guides using child workflows ===
  progress.stage = 'writing_guides';
  await acts.updateRunStage(runId, 'writing_guides');

  const guideChunks = chunkArray(guideIds, CHUNK_SIZE);

  // Execute guide chunks with throttling to avoid flooding the task queue
  const guideResults = await executeChildrenThrottled(
    guideChunks.map((chunk, index) => () =>
      executeChild<typeof import('./guideChunkWorkflow').guideChunkWorkflow>(
        'guideChunkWorkflow',
        {
          workflowId: `${runId}-guide-chunk-${index}`,
          args: [runId, chunk, index],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE,
        }
      )
    ),
    MAX_CONCURRENT_CHILDREN
  );

  // Aggregate guide results for progress tracking
  for (const result of guideResults) {
    if (result.status === 'fulfilled') {
      progress.completedGuides += result.value.success;
      progress.failedGuides += result.value.failed;
    }
  }

  // === Stage 3: Finalize ===
  progress.stage = 'complete';
  await acts.finalizeRun(runId, {
    completed: progress.completedGuides,
    failed: progress.failedGuides,
  });
}

/**
 * Retry a single guide that previously failed.
 * This is a separate workflow to keep history isolated and simple.
 */
export async function retryGuideWorkflow(
  runId: string,
  guideId: string
): Promise<void> {
  // Process the single guide with isManualRetry=true
  // This bypasses the idempotency guard for needs_attention status
  await acts.processGuide(runId, guideId, true);

  // Re-finalize the run to recalculate status from ground truth
  // This derives counts from actual guide statuses, not counters
  await acts.refinalizeRun(runId);
}
