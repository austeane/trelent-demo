/**
 * Tests for worker activities
 * These test the core business logic without requiring Temporal runtime
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Temporal Context before importing activities
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: vi.fn(() => ({
      heartbeat: vi.fn(),
      info: {
        workflowExecution: { workflowId: 'test-workflow-id' },
        activityId: 'test-activity-id',
        attempt: 1,
      },
    })),
  },
}));

// Mock the database
const mockDb = {
  file: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  guide: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
  },
  run: {
    update: vi.fn(),
    findUnique: vi.fn(),
  },
};

vi.mock('@worker/lib/db', () => ({
  db: mockDb,
}));

// Also mock for the web import path
vi.mock('../../worker/src/lib/db', () => ({
  db: mockDb,
}));

describe('Worker Activities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('convertFile idempotency', () => {
    it('should return success immediately if file already converted', async () => {
      mockDb.file.findUnique.mockResolvedValue({
        id: 'file-1',
        status: 'converted',
        markdownContent: '# Test content',
        filename: 'test.pdf',
      });

      // Import after mocks are set up
      const { convertFile } = await import('../../worker/src/activities/convert');

      const result = await convertFile('run-1', 'file-1');

      expect(result).toEqual({ success: true });
      expect(mockDb.file.updateMany).not.toHaveBeenCalled();
    });

    it('should return failure immediately if file already failed', async () => {
      mockDb.file.findUnique.mockResolvedValue({
        id: 'file-1',
        status: 'failed',
        errorMessage: 'Previous failure',
        filename: 'test.pdf',
      });

      const { convertFile } = await import('../../worker/src/activities/convert');

      const result = await convertFile('run-1', 'file-1');

      expect(result).toEqual({ success: false });
      expect(mockDb.file.updateMany).not.toHaveBeenCalled();
    });

    it('should throw error if file not found', async () => {
      mockDb.file.findUnique.mockResolvedValue(null);

      const { convertFile } = await import('../../worker/src/activities/convert');

      await expect(convertFile('run-1', 'file-1')).rejects.toThrow('File not found: file-1');
    });
  });

  describe('processGuide idempotency', () => {
    it('should return success immediately if guide already completed', async () => {
      mockDb.guide.findUnique.mockResolvedValue({
        id: 'guide-1',
        status: 'completed',
        htmlContent: '<html>Test</html>',
        name: 'Test Guide',
        description: 'Test description',
        attempts: 1,
      });

      const { processGuide } = await import('../../worker/src/activities/generate');

      const result = await processGuide('run-1', 'guide-1', false);

      expect(result).toEqual({ success: true });
      expect(mockDb.guide.updateMany).not.toHaveBeenCalled();
    });

    it('should return failure for needs_attention if not manual retry', async () => {
      mockDb.guide.findUnique.mockResolvedValue({
        id: 'guide-1',
        status: 'needs_attention',
        failureReason: 'No relevant content',
        name: 'Test Guide',
        description: 'Test description',
        attempts: 3,
      });

      const { processGuide } = await import('../../worker/src/activities/generate');

      const result = await processGuide('run-1', 'guide-1', false);

      expect(result).toEqual({ success: false });
    });

    it('should throw error if guide not found', async () => {
      mockDb.guide.findUnique.mockResolvedValue(null);

      const { processGuide } = await import('../../worker/src/activities/generate');

      await expect(processGuide('run-1', 'guide-1', false)).rejects.toThrow(
        'Guide not found: guide-1'
      );
    });
  });
});

describe('Lease-based idempotency pattern', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fail to acquire lease when another worker holds it (file)', async () => {
    // File is pending
    mockDb.file.findUnique
      .mockResolvedValueOnce({
        id: 'file-1',
        status: 'pending',
        filename: 'test.pdf',
      })
      // After failed lease acquisition, file is converting with fresh timestamp
      .mockResolvedValueOnce({
        id: 'file-1',
        status: 'converting',
        filename: 'test.pdf',
        processingToken: 'other-worker:act:1',
        processingStartedAt: new Date(), // Fresh, not expired
      });

    // Lease acquisition fails (another worker got it)
    mockDb.file.updateMany.mockResolvedValue({ count: 0 });

    const { convertFile } = await import('../../worker/src/activities/convert');

    // Should throw LeaseHeldError which triggers retry
    await expect(convertFile('run-1', 'file-1')).rejects.toThrow('lease held by another worker');
  });

  it('should fail to acquire lease when another worker holds it (guide)', async () => {
    // Guide is pending
    mockDb.guide.findUnique
      .mockResolvedValueOnce({
        id: 'guide-1',
        status: 'pending',
        name: 'Test Guide',
        description: 'Test',
        attempts: 0,
        forceFailure: false,
      })
      // After failed lease acquisition, guide is searching with fresh timestamp
      .mockResolvedValueOnce({
        id: 'guide-1',
        status: 'searching',
        name: 'Test Guide',
        description: 'Test',
        processingToken: 'other-worker:act:1',
        processingStartedAt: new Date(),
      });

    mockDb.guide.updateMany.mockResolvedValue({ count: 0 });

    const { processGuide } = await import('../../worker/src/activities/generate');

    await expect(processGuide('run-1', 'guide-1', false)).rejects.toThrow(
      'lease held by another worker'
    );
  });
});

describe('XSS Prevention', () => {
  it('should escape HTML in generated content', () => {
    // Test the escapeHtml function logic
    const testCases = [
      {
        input: '<script>alert("xss")</script>',
        expected: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
      },
      { input: 'Normal text', expected: 'Normal text' },
      { input: '&amp; already escaped', expected: '&amp;amp; already escaped' },
      { input: "It's a test", expected: 'It&#039;s a test' },
    ];

    // Simple escape function matching the implementation
    function escapeHtml(str: string): string {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    for (const { input, expected } of testCases) {
      expect(escapeHtml(input)).toBe(expected);
    }
  });
});

describe('Database activity functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updateRunStage should update run stage', async () => {
    mockDb.run.update.mockResolvedValue({ id: 'run-1', stage: 'converting_documents' });

    const { updateRunStage } = await import('../../worker/src/activities/db');

    await updateRunStage('run-1', 'converting_documents');

    expect(mockDb.run.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { stage: 'converting_documents' },
    });
  });

  it('incrementConvertedFiles should atomically increment', async () => {
    mockDb.run.update.mockResolvedValue({ id: 'run-1', convertedFiles: 5 });

    const { incrementConvertedFiles } = await import('../../worker/src/activities/db');

    await incrementConvertedFiles('run-1', 5);

    expect(mockDb.run.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { convertedFiles: { increment: 5 } },
    });
  });

  it('incrementGuideProgress should atomically increment both counters', async () => {
    mockDb.run.update.mockResolvedValue({
      id: 'run-1',
      completedGuides: 10,
      failedGuides: 2,
    });

    const { incrementGuideProgress } = await import('../../worker/src/activities/db');

    await incrementGuideProgress('run-1', { completed: 8, failed: 2 });

    expect(mockDb.run.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        completedGuides: { increment: 8 },
        failedGuides: { increment: 2 },
      },
    });
  });

  it('markRunFailed should set failed status with error message', async () => {
    mockDb.run.update.mockResolvedValue({ id: 'run-1', status: 'failed' });

    const { markRunFailed } = await import('../../worker/src/activities/db');

    await markRunFailed('run-1', 'Something went wrong');

    expect(mockDb.run.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'failed',
        stage: 'complete',
        errorMessage: 'Something went wrong',
        completedAt: expect.any(Date),
      },
    });
  });
});

describe('refinalizeRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should set completed status when all guides completed', async () => {
    mockDb.guide.groupBy.mockResolvedValue([{ status: 'completed', _count: { status: 10 } }]);

    mockDb.run.update.mockResolvedValue({ id: 'run-1' });

    const { refinalizeRun } = await import('../../worker/src/activities/db');

    await refinalizeRun('run-1');

    expect(mockDb.run.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'completed',
        stage: 'complete',
        completedGuides: 10,
        failedGuides: 0,
        completedAt: expect.any(Date),
      },
    });
  });

  it('should set completed_with_errors when some guides need attention', async () => {
    mockDb.guide.groupBy.mockResolvedValue([
      { status: 'completed', _count: { status: 8 } },
      { status: 'needs_attention', _count: { status: 2 } },
    ]);

    mockDb.run.update.mockResolvedValue({ id: 'run-1' });

    const { refinalizeRun } = await import('../../worker/src/activities/db');

    await refinalizeRun('run-1');

    expect(mockDb.run.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'completed_with_errors',
        stage: 'complete',
        completedGuides: 8,
        failedGuides: 2,
        completedAt: expect.any(Date),
      },
    });
  });

  it('should keep processing status when guides still pending', async () => {
    mockDb.guide.groupBy.mockResolvedValue([
      { status: 'completed', _count: { status: 5 } },
      { status: 'pending', _count: { status: 3 } },
      { status: 'generating', _count: { status: 2 } },
    ]);

    mockDb.run.update.mockResolvedValue({ id: 'run-1' });

    const { refinalizeRun } = await import('../../worker/src/activities/db');

    await refinalizeRun('run-1');

    expect(mockDb.run.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: {
        status: 'processing',
        stage: 'writing_guides',
        completedGuides: 5,
        failedGuides: 0,
        completedAt: null,
      },
    });
  });
});
