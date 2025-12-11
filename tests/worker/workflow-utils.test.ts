/**
 * Tests for workflow utility functions
 */

import { describe, it, expect } from 'vitest';

describe('Workflow Utilities', () => {
  describe('chunkArray', () => {
    function chunkArray<T>(array: T[], size: number): T[][] {
      const chunks: T[][] = [];
      for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
      }
      return chunks;
    }

    it('should handle empty array', () => {
      expect(chunkArray([], 10)).toEqual([]);
    });

    it('should return single chunk when array smaller than size', () => {
      expect(chunkArray([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
    });

    it('should split array into equal chunks', () => {
      expect(chunkArray([1, 2, 3, 4, 5, 6], 2)).toEqual([
        [1, 2],
        [3, 4],
        [5, 6],
      ]);
    });

    it('should handle last chunk being smaller', () => {
      expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('should handle chunk size of 1', () => {
      expect(chunkArray([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
    });

    it('should work with CHUNK_SIZE of 100', () => {
      const CHUNK_SIZE = 100;
      const items = Array.from({ length: 250 }, (_, i) => i);
      const chunks = chunkArray(items, CHUNK_SIZE);

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(100);
      expect(chunks[1]).toHaveLength(100);
      expect(chunks[2]).toHaveLength(50);
    });

    it('should preserve item order', () => {
      const items = ['a', 'b', 'c', 'd', 'e'];
      const chunks = chunkArray(items, 2);

      expect(chunks.flat()).toEqual(items);
    });
  });

  describe('Throttled execution logic', () => {
    it('should process in batches respecting concurrency limit', async () => {
      const MAX_CONCURRENT = 3;
      const executionOrder: number[] = [];
      let concurrent = 0;
      let maxConcurrent = 0;

      async function executeChildrenThrottled<T>(
        tasks: Array<() => Promise<T>>,
        maxConcurrent: number
      ): Promise<PromiseSettledResult<T>[]> {
        const results: PromiseSettledResult<T>[] = [];

        for (let i = 0; i < tasks.length; i += maxConcurrent) {
          const batch = tasks.slice(i, i + maxConcurrent);
          const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
          results.push(...batchResults);
        }

        return results;
      }

      const tasks = Array.from({ length: 10 }, (_, i) => async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        executionOrder.push(i);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return i;
      });

      const results = await executeChildrenThrottled(tasks, MAX_CONCURRENT);

      expect(results).toHaveLength(10);
      expect(maxConcurrent).toBeLessThanOrEqual(MAX_CONCURRENT);
      // All tasks should have been executed
      expect(executionOrder).toHaveLength(10);
    });

    it('should handle task failures without stopping other tasks', async () => {
      async function executeChildrenThrottled<T>(
        tasks: Array<() => Promise<T>>,
        maxConcurrent: number
      ): Promise<PromiseSettledResult<T>[]> {
        const results: PromiseSettledResult<T>[] = [];

        for (let i = 0; i < tasks.length; i += maxConcurrent) {
          const batch = tasks.slice(i, i + maxConcurrent);
          const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
          results.push(...batchResults);
        }

        return results;
      }

      const tasks = [
        () => Promise.resolve('success1'),
        () => Promise.reject(new Error('failure')),
        () => Promise.resolve('success2'),
      ];

      const results = await executeChildrenThrottled(tasks, 2);

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');
    });
  });

  describe('Progress tracking', () => {
    interface Progress {
      stage: string;
      totalFiles: number;
      convertedFiles: number;
      totalGuides: number;
      completedGuides: number;
      failedGuides: number;
    }

    it('should initialize progress correctly', () => {
      const fileIds = Array.from({ length: 100 }, (_, i) => `file-${i}`);
      const guideIds = Array.from({ length: 50 }, (_, i) => `guide-${i}`);

      const progress: Progress = {
        stage: 'initializing',
        totalFiles: fileIds.length,
        convertedFiles: 0,
        totalGuides: guideIds.length,
        completedGuides: 0,
        failedGuides: 0,
      };

      expect(progress.totalFiles).toBe(100);
      expect(progress.totalGuides).toBe(50);
      expect(progress.convertedFiles).toBe(0);
      expect(progress.completedGuides).toBe(0);
      expect(progress.failedGuides).toBe(0);
    });

    it('should track progress through stages', () => {
      const progress: Progress = {
        stage: 'initializing',
        totalFiles: 100,
        convertedFiles: 0,
        totalGuides: 50,
        completedGuides: 0,
        failedGuides: 0,
      };

      // Stage 1: Converting
      progress.stage = 'converting_documents';
      progress.convertedFiles = 100;

      expect(progress.stage).toBe('converting_documents');
      expect(progress.convertedFiles).toBe(100);

      // Stage 2: Writing guides
      progress.stage = 'writing_guides';
      progress.completedGuides = 45;
      progress.failedGuides = 5;

      expect(progress.stage).toBe('writing_guides');
      expect(progress.completedGuides + progress.failedGuides).toBe(50);

      // Stage 3: Complete
      progress.stage = 'complete';
      expect(progress.stage).toBe('complete');
    });
  });
});

describe('Lease Token Generation', () => {
  it('should generate unique tokens for different activities', () => {
    function generateProcessingToken(
      workflowId: string,
      activityId: string,
      attempt: number
    ): string {
      return `${workflowId}:${activityId}:${attempt}`;
    }

    const token1 = generateProcessingToken('wf-1', 'act-1', 1);
    const token2 = generateProcessingToken('wf-1', 'act-2', 1);
    const token3 = generateProcessingToken('wf-2', 'act-1', 1);
    const token4 = generateProcessingToken('wf-1', 'act-1', 2);

    expect(token1).not.toBe(token2);
    expect(token1).not.toBe(token3);
    expect(token1).not.toBe(token4);
  });

  it('should include all identifying information', () => {
    function generateProcessingToken(
      workflowId: string,
      activityId: string,
      attempt: number
    ): string {
      return `${workflowId}:${activityId}:${attempt}`;
    }

    const token = generateProcessingToken('run-abc123', 'convert-file', 3);

    expect(token).toContain('run-abc123');
    expect(token).toContain('convert-file');
    expect(token).toContain('3');
  });
});

describe('Lease Expiry Logic', () => {
  const LEASE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

  it('should consider lease expired after threshold', () => {
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() - LEASE_EXPIRY_MS);

    // A lease started 6 minutes ago should be expired
    const oldLease = new Date(now.getTime() - 6 * 60 * 1000);
    expect(oldLease < leaseExpiry).toBe(true);

    // A lease started 4 minutes ago should not be expired
    const newLease = new Date(now.getTime() - 4 * 60 * 1000);
    expect(newLease < leaseExpiry).toBe(false);
  });

  it('should allow takeover of expired leases', () => {
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() - LEASE_EXPIRY_MS);

    // Simulate lease check
    const processingStartedAt = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago

    // This would match the WHERE clause: processingStartedAt < leaseExpiry
    const canTakeover = processingStartedAt < leaseExpiry;
    expect(canTakeover).toBe(true);
  });
});
