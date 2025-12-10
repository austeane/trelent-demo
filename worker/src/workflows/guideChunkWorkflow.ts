import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes', // Guides take longer (search + generation)
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 4,
  },
});

export interface GuideChunkResult {
  success: number;
  failed: number;
}

/**
 * Process a chunk of guides (up to 100).
 * Each chunk is a separate workflow to keep history size bounded.
 */
export async function guideChunkWorkflow(
  runId: string,
  guideIds: string[],
  chunkIndex: number
): Promise<GuideChunkResult> {
  let successCount = 0;
  let failedCount = 0;

  const BATCH_SIZE = 10; // Process 10 guides concurrently within chunk

  for (let i = 0; i < guideIds.length; i += BATCH_SIZE) {
    const batch = guideIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((id) => acts.processGuide(runId, id)));

    let batchSuccess = 0;
    let batchFailed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) {
        successCount++;
        batchSuccess++;
      } else {
        failedCount++;
        batchFailed++;
      }
    }

    // Update run progress atomically after each batch
    if (batchSuccess > 0 || batchFailed > 0) {
      await acts.incrementGuideProgress(runId, {
        completed: batchSuccess,
        failed: batchFailed,
      });
    }
  }

  return { success: successCount, failed: failedCount };
}
