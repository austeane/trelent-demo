import { db } from '../lib/db';
import { RunStatus, RunStage } from '@prisma/client';

export async function updateRunStage(
  runId: string,
  stage: RunStage
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

/**
 * Atomically increment file conversion count.
 * Used by child workflows to safely update progress concurrently.
 */
export async function incrementConvertedFiles(
  runId: string,
  count: number
): Promise<void> {
  await db.run.update({
    where: { id: runId },
    data: {
      convertedFiles: {
        increment: count,
      },
    },
  });
}

/**
 * Atomically increment guide progress counts.
 * Used by child workflows to safely update progress concurrently.
 */
export async function incrementGuideProgress(
  runId: string,
  progress: { completed: number; failed: number }
): Promise<void> {
  await db.run.update({
    where: { id: runId },
    data: {
      completedGuides: {
        increment: progress.completed,
      },
      failedGuides: {
        increment: progress.failed,
      },
    },
  });
}

export async function finalizeRun(
  runId: string,
  stats: { completed: number; failed: number }
): Promise<void> {
  const status: RunStatus = stats.failed > 0 ? 'completed_with_errors' : 'completed';

  await db.run.update({
    where: { id: runId },
    data: {
      status,
      stage: 'complete' as RunStage,
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
  let status: RunStatus;
  let stage: RunStage;

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
