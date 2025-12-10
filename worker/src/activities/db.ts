import { db } from '../lib/db';

export async function updateRunStage(
  runId: string,
  stage: string
): Promise<void> {
  await db.run.update({
    where: { id: runId },
    data: { stage },
  });
}

export async function updateRunProgress(
  runId: string,
  progress: {
    convertedFiles?: number;
    completedGuides?: number;
    failedGuides?: number;
  }
): Promise<void> {
  await db.run.update({
    where: { id: runId },
    data: progress,
  });
}

export async function finalizeRun(
  runId: string,
  stats: { completed: number; failed: number }
): Promise<void> {
  const status = stats.failed > 0 ? 'completed_with_errors' : 'completed';

  await db.run.update({
    where: { id: runId },
    data: {
      status,
      stage: 'complete',
      completedAt: new Date(),
    },
  });
}
