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

/**
 * Re-finalize a run after a guide retry.
 * Reads current counts from DB and updates run status accordingly.
 */
export async function refinalizeRun(runId: string): Promise<void> {
  // Get actual counts from database
  const guides = await db.guide.groupBy({
    by: ['status'],
    where: { runId },
    _count: { status: true },
  });

  const counts = guides.reduce(
    (acc, g) => {
      acc[g.status] = g._count.status;
      return acc;
    },
    {} as Record<string, number>
  );

  const completed = counts['completed'] || 0;
  const needsAttention = counts['needs_attention'] || 0;
  const pending = counts['pending'] || 0;
  const inProgress =
    (counts['searching'] || 0) + (counts['generating'] || 0);

  // Determine status
  let status: string;
  let stage: string;

  if (pending > 0 || inProgress > 0) {
    // Still processing
    status = 'processing';
    stage = 'writing_guides';
  } else if (needsAttention > 0) {
    status = 'completed_with_errors';
    stage = 'complete';
  } else {
    status = 'completed';
    stage = 'complete';
  }

  await db.run.update({
    where: { id: runId },
    data: {
      status,
      stage,
      completedGuides: completed,
      failedGuides: needsAttention,
      completedAt: stage === 'complete' ? new Date() : null,
    },
  });
}
