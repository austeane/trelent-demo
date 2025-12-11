import JSZip from 'jszip';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// Force Node.js runtime (JSZip + Prisma need Node APIs)
export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  const { runId } = params;

  try {
    // Get the run
    const run = await db.run.findUnique({
      where: { id: runId },
    });

    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    // Get all completed guides with HTML content
    const guides = await db.guide.findMany({
      where: {
        runId,
        status: 'completed',
        htmlContent: { not: null },
      },
      select: {
        id: true,
        name: true,
        htmlContent: true,
      },
    });

    if (guides.length === 0) {
      return NextResponse.json({ error: 'No completed guides to download' }, { status: 400 });
    }

    // Create zip file
    const zip = new JSZip();
    const usedFilenames = new Set<string>();

    for (const guide of guides) {
      // Create a safe filename
      let filename = guide.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      // Handle duplicate filenames by appending guide ID suffix
      if (usedFilenames.has(filename)) {
        filename = `${filename}-${guide.id.slice(0, 8)}`;
      }
      usedFilenames.add(filename);

      zip.file(`${filename}.html`, guide.htmlContent || '');
    }

    // Generate zip buffer
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    // Create a safe run name for the zip filename
    const zipFilename = run.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Return zip file - convert Buffer to Uint8Array for NextResponse
    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename}-guides.zip"`,
        'Content-Length': String(zipBuffer.length),
      },
    });
  } catch (error) {
    console.error('Failed to create zip:', error);
    return NextResponse.json(
      { error: 'Failed to create zip', details: (error as Error).message },
      { status: 500 }
    );
  }
}
