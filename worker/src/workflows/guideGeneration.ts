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

  // Execute all file chunks in parallel via child workflows
  const fileResults = await Promise.allSettled(
    fileChunks.map((chunk, index) =>
      executeChild<typeof import('./fileChunkWorkflow').fileChunkWorkflow>(
        'fileChunkWorkflow',
        {
          workflowId: `${runId}-file-chunk-${index}`,
          args: [runId, chunk, index],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE,
        }
      )
    )
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

  // Execute all guide chunks in parallel via child workflows
  const guideResults = await Promise.allSettled(
    guideChunks.map((chunk, index) =>
      executeChild<typeof import('./guideChunkWorkflow').guideChunkWorkflow>(
        'guideChunkWorkflow',
        {
          workflowId: `${runId}-guide-chunk-${index}`,
          args: [runId, chunk, index],
          parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE,
        }
      )
    )
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
  // Process the single guide
  const result = await acts.processGuide(runId, guideId);

  // Update run based on result
  if (result.success) {
    await acts.updateRunProgress(runId, {
      completedGuides: 1, // Increment by 1
    });
  } else {
    await acts.updateRunProgress(runId, {
      failedGuides: 1, // Increment by 1
    });
  }

  // Re-finalize the run to update status
  // Get current counts from DB via activity
  await acts.refinalizeRun(runId);
}
