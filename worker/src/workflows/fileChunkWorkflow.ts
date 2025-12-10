import { proxyActivities } from '@temporalio/workflow';
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

export interface FileChunkResult {
  success: number;
  failed: number;
}

/**
 * Process a chunk of files (up to 100).
 * Each chunk is a separate workflow to keep history size bounded.
 */
export async function fileChunkWorkflow(
  runId: string,
  fileIds: string[],
  chunkIndex: number
): Promise<FileChunkResult> {
  let successCount = 0;
  let failedCount = 0;

  const BATCH_SIZE = 5; // Process 5 files concurrently within chunk

  for (let i = 0; i < fileIds.length; i += BATCH_SIZE) {
    const batch = fileIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((id) => acts.convertFile(runId, id))
    );

    let batchSuccess = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) {
        successCount++;
        batchSuccess++;
      } else {
        failedCount++;
      }
    }

    // Update run progress atomically after each batch
    if (batchSuccess > 0) {
      await acts.incrementConvertedFiles(runId, batchSuccess);
    }
  }

  return { success: successCount, failed: failedCount };
}
