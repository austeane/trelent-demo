import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { db } from '@/lib/db';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal';

// Force Node.js runtime (Temporal gRPC client doesn't work in Edge)
export const runtime = 'nodejs';

// Document categories for realistic variety
const DOC_CATEGORIES = [
  {
    prefix: 'HR',
    types: [
      'Policy',
      'Handbook',
      'Guidelines',
      'Procedure',
      'Form',
      'Template',
      'Checklist',
      'Manual',
    ],
  },
  {
    prefix: 'IT',
    types: [
      'Security',
      'Setup',
      'Troubleshooting',
      'Access',
      'Configuration',
      'Standards',
      'Protocol',
      'Guide',
    ],
  },
  {
    prefix: 'Finance',
    types: [
      'Expense',
      'Budget',
      'Approval',
      'Reimbursement',
      'Audit',
      'Report',
      'Policy',
      'Procedure',
    ],
  },
  {
    prefix: 'Operations',
    types: [
      'Process',
      'Workflow',
      'Checklist',
      'Standards',
      'Compliance',
      'SOP',
      'Manual',
      'Guide',
    ],
  },
  {
    prefix: 'Sales',
    types: [
      'Proposal',
      'Contract',
      'Pricing',
      'Commission',
      'Territory',
      'Pipeline',
      'Forecast',
      'Report',
    ],
  },
  {
    prefix: 'Legal',
    types: ['Agreement', 'Terms', 'Privacy', 'Compliance', 'NDA', 'Contract', 'Policy', 'Review'],
  },
  {
    prefix: 'Engineering',
    types: [
      'Architecture',
      'Review',
      'Standards',
      'Testing',
      'Deployment',
      'Design',
      'Spec',
      'RFC',
    ],
  },
  {
    prefix: 'Marketing',
    types: [
      'Brand',
      'Campaign',
      'Guidelines',
      'Assets',
      'Messaging',
      'Strategy',
      'Analytics',
      'Report',
    ],
  },
];

const FILE_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt', '.md'];

const GUIDE_ACTIONS = [
  'How to',
  'Guide for',
  'Process for',
  'Steps to',
  'Understanding',
  'Managing',
  'Implementing',
  'Configuring',
];

function generateSampleFiles(count: number): Array<{ filename: string; hash: string }> {
  const files: Array<{ filename: string; hash: string }> = [];
  const totalCategories = DOC_CATEGORIES.length;
  const totalTypes = DOC_CATEGORIES[0].types.length;

  for (let i = 0; i < count; i++) {
    const category = DOC_CATEGORIES[i % totalCategories];
    const docType = category.types[Math.floor(i / totalCategories) % totalTypes];
    const version = Math.floor(i / (totalCategories * totalTypes)) + 1;
    const ext = FILE_EXTENSIONS[i % FILE_EXTENSIONS.length];

    files.push({
      filename: `${category.prefix} ${docType} v${version}${ext}`,
      hash: `${category.prefix.toLowerCase()}-${docType.toLowerCase()}-v${version}-${i}`,
    });
  }

  return files;
}

function generateSampleGuides(count: number): Array<{ name: string; description: string }> {
  const guides: Array<{ name: string; description: string }> = [];
  const totalCategories = DOC_CATEGORIES.length;
  const totalActions = GUIDE_ACTIONS.length;

  for (let i = 0; i < count; i++) {
    const category = DOC_CATEGORIES[i % totalCategories];
    const action = GUIDE_ACTIONS[Math.floor(i / totalCategories) % totalActions];
    const docType =
      category.types[Math.floor(i / (totalCategories * totalActions)) % category.types.length];

    guides.push({
      name: `${action} ${category.prefix} ${docType}`,
      description: `Comprehensive guide covering ${category.prefix.toLowerCase()} ${docType.toLowerCase()} procedures, best practices, and compliance requirements.`,
    });
  }

  return guides;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = body.name || `Guide Generation Run - ${new Date().toLocaleDateString()}`;
    const withFailures = body.withFailures === true;

    // Configurable scale - defaults to demo size (8 files, 12 guides)
    // Can scale up to 10K files, 500 guides
    const fileCount = Math.min(Math.max(body.fileCount || 8, 1), 10000);
    const guideCount = Math.min(Math.max(body.guideCount || 12, 1), 500);

    const sampleFiles = generateSampleFiles(fileCount);
    const sampleGuides = generateSampleGuides(guideCount);

    const runId = uuid();

    // Create run record
    await db.run.create({
      data: {
        id: runId,
        name,
        status: 'pending',
        totalFiles: sampleFiles.length,
        totalGuides: sampleGuides.length,
      },
    });

    // Create file records in batches for large counts
    const FILE_BATCH_SIZE = 1000;
    for (let i = 0; i < sampleFiles.length; i += FILE_BATCH_SIZE) {
      const batch = sampleFiles.slice(i, i + FILE_BATCH_SIZE);
      await db.file.createMany({
        data: batch.map((f) => ({
          runId,
          filename: f.filename,
          fileHash: f.hash,
          status: 'pending',
        })),
      });
    }

    // Create guide records in batches
    const GUIDE_BATCH_SIZE = 100;
    for (let i = 0; i < sampleGuides.length; i += GUIDE_BATCH_SIZE) {
      const batch = sampleGuides.slice(i, i + GUIDE_BATCH_SIZE);
      await db.guide.createMany({
        data: batch.map((g) => ({
          runId,
          name: g.name,
          description: g.description,
          status: 'pending',
        })),
      });
    }

    // Get IDs for workflow
    const fileIds = await db.file
      .findMany({
        where: { runId },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));

    const guideIds = await db.guide
      .findMany({
        where: { runId },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id));

    // If withFailures, randomly mark 2-4 guides to force failure
    if (withFailures) {
      const numFailures = 2 + Math.floor(Math.random() * 3); // 2-4 failures
      const shuffled = [...guideIds].sort(() => Math.random() - 0.5);
      const failureIds = shuffled.slice(0, numFailures);

      await db.guide.updateMany({
        where: { id: { in: failureIds } },
        data: { forceFailure: true },
      });
    }

    // Start Temporal workflow with compensation on failure
    const workflowId = `run-${runId}`;

    try {
      const client = await getTemporalClient();
      await client.workflow.start('guideGenerationWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [runId, fileIds, guideIds],
      });

      // Workflow started successfully - mark as processing
      await db.run.update({
        where: { id: runId },
        data: {
          status: 'processing',
          workflowId,
          startedAt: new Date(),
        },
      });

      return NextResponse.json({ runId, workflowId });
    } catch (workflowError) {
      // Compensation: mark run as failed if workflow couldn't start
      console.error('Failed to start workflow:', workflowError);

      await db.run.update({
        where: { id: runId },
        data: {
          status: 'failed',
          errorMessage: `Failed to start workflow: ${(workflowError as Error).message}`,
        },
      });

      return NextResponse.json(
        {
          error: 'Failed to start workflow',
          details: (workflowError as Error).message,
          runId, // Return runId so user can see the failed run
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Failed to create run:', error);
    return NextResponse.json(
      { error: 'Failed to create run', details: (error as Error).message },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const runs = await db.run.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return NextResponse.json(runs);
  } catch (error) {
    console.error('Failed to fetch runs:', error);
    return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 });
  }
}
