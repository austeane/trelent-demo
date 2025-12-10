import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { db } from '@/lib/db';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal';

const SAMPLE_FILES = [
  { filename: 'Employee Handbook.pdf', hash: 'eh001' },
  { filename: 'IT Security Policy.docx', hash: 'it001' },
  { filename: 'Travel Expense Guidelines.pdf', hash: 'te001' },
  { filename: 'Code of Conduct.pdf', hash: 'cc001' },
  { filename: 'Remote Work Policy.docx', hash: 'rw001' },
  { filename: 'Benefits Overview.pdf', hash: 'bo001' },
  { filename: 'Onboarding Checklist.docx', hash: 'oc001' },
  { filename: 'Performance Review Process.pdf', hash: 'pr001' },
];

const SAMPLE_GUIDES = [
  {
    name: 'New Employee Onboarding',
    description:
      'Step-by-step guide for onboarding new employees including system access, training requirements, and first-week checklist.',
  },
  {
    name: 'Password Reset Procedure',
    description:
      'Instructions for resetting passwords across company systems including SSO, email, and VPN.',
  },
  {
    name: 'Expense Report Submission',
    description:
      'How to submit expense reports including required documentation, approval workflow, and reimbursement timeline.',
  },
  {
    name: 'Remote Work Setup',
    description:
      'Guide for setting up a remote work environment including VPN configuration, communication tools, and security requirements.',
  },
  {
    name: 'Time Off Request Process',
    description:
      'Procedure for requesting vacation, sick leave, and other time off including approval requirements and blackout dates.',
  },
  {
    name: 'IT Equipment Request',
    description:
      'How to request new IT equipment including laptops, monitors, and peripherals with approval workflow.',
  },
  {
    name: 'Security Incident Reporting',
    description:
      'Procedure for reporting security incidents including phishing attempts, data breaches, and suspicious activity.',
  },
  {
    name: 'Performance Review Preparation',
    description:
      'Guide for preparing for annual performance reviews including self-assessment templates and goal-setting frameworks.',
  },
  {
    name: 'Benefits Enrollment',
    description:
      'Instructions for enrolling in company benefits including health insurance, 401k, and wellness programs.',
  },
  {
    name: 'Conference Room Booking',
    description:
      'How to book conference rooms including available resources, catering options, and video conferencing setup.',
  },
  {
    name: 'Software Installation Request',
    description:
      'Process for requesting software installation including approved software list and security review requirements.',
  },
  {
    name: 'Travel Booking Guidelines',
    description:
      'Company travel policy including preferred vendors, booking procedures, and expense limits.',
  },
];

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = body.name || `Guide Generation Run - ${new Date().toLocaleDateString()}`;
    const withFailures = body.withFailures === true;

    const runId = uuid();

    // Create run record
    await db.run.create({
      data: {
        id: runId,
        name,
        status: 'pending',
        totalFiles: SAMPLE_FILES.length,
        totalGuides: SAMPLE_GUIDES.length,
      },
    });

    // Create file records
    await db.file.createMany({
      data: SAMPLE_FILES.map((f) => ({
        runId,
        filename: f.filename,
        fileHash: f.hash,
        status: 'pending',
      })),
    });

    // Create guide records
    await db.guide.createMany({
      data: SAMPLE_GUIDES.map((g) => ({
        runId,
        name: g.name,
        description: g.description,
        status: 'pending',
      })),
    });

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

    // Start Temporal workflow
    const client = await getTemporalClient();
    const workflowId = `run-${runId}`;

    await client.workflow.start('guideGenerationWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [runId, fileIds, guideIds],
    });

    await db.run.update({
      where: { id: runId },
      data: {
        status: 'processing',
        workflowId,
        startedAt: new Date(),
      },
    });

    return NextResponse.json({ runId, workflowId });
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
    return NextResponse.json(
      { error: 'Failed to fetch runs' },
      { status: 500 }
    );
  }
}
