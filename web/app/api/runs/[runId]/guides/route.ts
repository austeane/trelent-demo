import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { GuideStatus } from '@prisma/client';

export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as GuideStatus | null;
    const search = searchParams.get('search');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');

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
