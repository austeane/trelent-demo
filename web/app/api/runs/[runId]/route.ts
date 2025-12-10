import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  try {
    const run = await db.run.findUnique({
      where: { id: params.runId },
    });

    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Get guide counts by status
    const guideCounts = await db.guide.groupBy({
      by: ['status'],
      where: { runId: params.runId },
      _count: true,
    });

    // Get file counts by status
    const fileCounts = await db.file.groupBy({
      by: ['status'],
      where: { runId: params.runId },
      _count: true,
    });

    return NextResponse.json({
      run,
      guideCounts: Object.fromEntries(guideCounts.map((g) => [g.status, g._count])),
      fileCounts: Object.fromEntries(fileCounts.map((f) => [f.status, f._count])),
    });
  } catch (error) {
    console.error('Failed to fetch run:', error);
    return NextResponse.json({ error: 'Failed to fetch run' }, { status: 500 });
  }
}
