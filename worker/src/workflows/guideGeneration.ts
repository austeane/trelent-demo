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
      batch.map((id) => acts.convertFile(runId, id))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.success) {
        progress.convertedFiles++;
      }
    }

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
      batch.map((id) => acts.processGuide(runId, id))
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
