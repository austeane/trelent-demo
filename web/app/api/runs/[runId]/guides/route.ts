import { GuideStatus } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// Valid GuideStatus values for validation
const VALID_GUIDE_STATUSES = Object.values(GuideStatus);

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  try {
    const { searchParams } = new URL(request.url);
    const rawStatus = searchParams.get('status');
    const search = searchParams.get('search');

    // Validate status parameter against enum
    let status: GuideStatus | null = null;
    if (rawStatus) {
      if (!VALID_GUIDE_STATUSES.includes(rawStatus as GuideStatus)) {
        return NextResponse.json(
          { error: `Invalid status. Must be one of: ${VALID_GUIDE_STATUSES.join(', ')}` },
          { status: 400 }
        );
      }
      status = rawStatus as GuideStatus;
    }

    // Validate and clamp pagination parameters
    const rawPage = parseInt(searchParams.get('page') || '1');
    const rawPageSize = parseInt(searchParams.get('pageSize') || '20');
    const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
    const pageSize = Math.min(100, Math.max(1, isNaN(rawPageSize) ? 20 : rawPageSize));

    const where = {
      runId: params.runId,
      ...(status ? { status } : {}),
      ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
    };

    const [guides, total] = await Promise.all([
      db.guide.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.guide.count({ where }),
    ]);

    return NextResponse.json({
      guides,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error('Failed to fetch guides:', error);
    return NextResponse.json({ error: 'Failed to fetch guides' }, { status: 500 });
  }
}
