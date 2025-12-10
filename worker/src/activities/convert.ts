import { Context } from '@temporalio/activity';
import { db } from '../lib/db';

const MOCK_CONFIG = {
  minLatencyMs: 1500,
  maxLatencyMs: 6000,
  failureRate: 0.05,
};

// Lease expiry threshold - allow takeover after this duration
const LEASE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Custom error for lease conflicts - always retryable regardless of attempt count
class LeaseHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseHeldError';
  }
}

function generateProcessingToken(): string {
  const ctx = Context.current();
  const info = ctx.info;
  return `${info.workflowExecution.workflowId}:${info.activityId}:${info.attempt}`;
}

async function simulateLatency(): Promise<void> {
  const duration =
    MOCK_CONFIG.minLatencyMs +
    Math.random() * (MOCK_CONFIG.maxLatencyMs - MOCK_CONFIG.minLatencyMs);

  const chunks = Math.ceil(duration / 1000);
  for (let i = 0; i < chunks; i++) {
    Context.current().heartbeat(`Converting ${i + 1}/${chunks}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function shouldFail(): boolean {
  return Math.random() < MOCK_CONFIG.failureRate;
}

function generateMockMarkdown(filename: string): string {
  const baseName = filename.replace(/\.(pdf|docx|doc|txt)$/i, '');
  return `# ${baseName}

## Overview

This document contains important information about ${baseName.toLowerCase()}.

## Key Points

- Point 1: Lorem ipsum dolor sit amet, consectetur adipiscing elit.
- Point 2: Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
- Point 3: Ut enim ad minim veniam, quis nostrud exercitation ullamco.

## Details

### Section 1

Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

### Section 2

Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.

## Conclusion

This document provides comprehensive guidance on ${baseName.toLowerCase()} procedures and policies.
`;
}

export async function convertFile(runId: string, fileId: string): Promise<{ success: boolean }> {
  const file = await db.file.findUnique({ where: { id: fileId } });
  if (!file) {
    throw new Error(`File not found: ${fileId}`);
  }

  // Idempotency guard: if already in terminal state, return early
  // This handles retries after worker crash post-DB-write
  if (file.status === 'converted' && file.markdownContent) {
    return { success: true };
  }
  if (file.status === 'failed') {
    return { success: false };
  }

  const token = generateProcessingToken();
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() - LEASE_EXPIRY_MS);

  // Acquire lease: only from pending, OR from converting with expired lease
  // This prevents concurrent execution while allowing recovery from stuck workers
  const updateResult = await db.file.updateMany({
    where: {
      id: fileId,
      OR: [
        { status: 'pending' },
        {
          status: 'converting',
          processingStartedAt: { lt: leaseExpiry },
        },
      ],
    },
    data: {
      status: 'converting',
      processingToken: token,
      processingStartedAt: now,
    },
  });

  // If no rows updated, either already completed or another worker has the lease
  if (updateResult.count === 0) {
    const currentFile = await db.file.findUnique({ where: { id: fileId } });

    // If terminal state, return appropriate result
    if (currentFile?.status === 'converted') return { success: true };
    if (currentFile?.status === 'failed') return { success: false };

    // Still in progress - another worker has the lease. Throw LeaseHeldError to always retry.
    throw new LeaseHeldError(
      `File ${fileId} is in progress (status: ${currentFile?.status}), lease held by another worker`
    );
  }

  await simulateLatency();

  if (shouldFail()) {
    // Only finalize if we still hold the lease
    await db.file.updateMany({
      where: { id: fileId, processingToken: token },
      data: {
        status: 'failed',
        errorMessage: 'Document conversion failed: Unable to parse file format',
        processingToken: null,
      },
    });
    return { success: false };
  }

  const markdown = generateMockMarkdown(file.filename);

  // Only finalize if we still hold the lease
  const finalizeResult = await db.file.updateMany({
    where: { id: fileId, processingToken: token },
    data: {
      status: 'converted',
      markdownContent: markdown,
      processingToken: null,
    },
  });

  // If we didn't update, another worker took over - check if it succeeded
  if (finalizeResult.count === 0) {
    const currentFile = await db.file.findUnique({ where: { id: fileId } });
    return { success: currentFile?.status === 'converted' };
  }

  return { success: true };
}
