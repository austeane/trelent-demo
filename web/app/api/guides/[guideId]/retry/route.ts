import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal';
import { Prisma } from '@prisma/client';

// Force Node.js runtime (Temporal gRPC client doesn't work in Edge)
export const runtime = 'nodejs';

export async function POST(request: NextRequest, { params }: { params: { guideId: string } }) {
  const { guideId } = params;

  try {
    // Get the guide and verify it exists and needs retry
    const guide = await db.guide.findUnique({
      where: { id: guideId },
      include: { run: true },
    });

    if (!guide) {
      return NextResponse.json({ error: 'Guide not found' }, { status: 404 });
    }

    if (guide.status !== 'needs_attention') {
      return NextResponse.json({ error: 'Guide is not in a retryable state' }, { status: 400 });
    }

    // Reset guide to pending state
    await db.guide.update({
      where: { id: guideId },
      data: {
        status: 'pending',
        failureReason: null,
        failureDetails: Prisma.JsonNull,
        searchResults: Prisma.JsonNull,
        htmlContent: null,
        forceFailure: false, // Clear forced failure for retry
        // Keep attempts count for degrading strategy
      },
    });

    // Set run back to processing state (don't mutate counters - refinalizeRun derives them)
    await db.run.update({
      where: { id: guide.runId },
      data: {
        status: 'processing',
        stage: 'writing_guides',
      },
    });

    // Start a simple retry workflow for just this guide
    const client = await getTemporalClient();
    const workflowId = `retry-guide-${guideId}-${Date.now()}`;

    await client.workflow.start('retryGuideWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [guide.runId, guideId],
    });

    return NextResponse.json({
      success: true,
      guideId,
      workflowId,
      message: 'Guide retry started',
    });
  } catch (error) {
    console.error('Failed to retry guide:', error);
    return NextResponse.json(
      { error: 'Failed to retry guide', details: (error as Error).message },
      { status: 500 }
    );
  }
}
