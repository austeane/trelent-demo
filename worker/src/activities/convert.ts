import { Context } from '@temporalio/activity';
import { db } from '../lib/db';

const MOCK_CONFIG = {
  minLatencyMs: 1500,
  maxLatencyMs: 6000,
  failureRate: 0.05,
};

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

export async function convertFile(
  runId: string,
  fileId: string
): Promise<{ success: boolean }> {
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

  // Conditional update: only transition if still pending/converting
  // This prevents race conditions with concurrent retries
  const updateResult = await db.file.updateMany({
    where: {
      id: fileId,
      status: { in: ['pending', 'converting'] }
    },
    data: { status: 'converting' },
  });

  // If no rows updated, another worker already processed this
  if (updateResult.count === 0) {
    const currentFile = await db.file.findUnique({ where: { id: fileId } });
    return { success: currentFile?.status === 'converted' };
  }

  await simulateLatency();

  if (shouldFail()) {
    await db.file.update({
      where: { id: fileId },
      data: {
        status: 'failed',
        errorMessage: 'Document conversion failed: Unable to parse file format',
      },
    });
    return { success: false };
  }

  const markdown = generateMockMarkdown(file.filename);

  await db.file.update({
    where: { id: fileId },
    data: {
      status: 'converted',
      markdownContent: markdown,
    },
  });

  return { success: true };
}
