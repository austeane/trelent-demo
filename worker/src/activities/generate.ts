import { GuideStatus } from '@prisma/client';
import { Context } from '@temporalio/activity';
import { db } from '../lib/db';

const SEARCH_CONFIG = {
  minLatencyMs: 800,
  maxLatencyMs: 3000,
  failureRate: 0.02,
  noResultsRate: 0.08,
};

const GENERATION_CONFIG = {
  minLatencyMs: 2000,
  maxLatencyMs: 12000,
  failureRate: 0.04,
};

// Lease expiry threshold - allow takeover after this duration
const LEASE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const LEASE_REFRESH_INTERVAL_MS = 30 * 1000; // Refresh lease roughly every 30s

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

// Escape HTML to prevent XSS
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

interface SearchResult {
  fileId: string;
  filename: string;
  snippet: string;
  relevance: number;
}

function hasNonEmptySearchResults(value: unknown): value is SearchResult[] {
  return Array.isArray(value) && value.length > 0;
}

async function simulateLatency(
  config: { minLatencyMs: number; maxLatencyMs: number },
  label: string,
  refreshLease?: () => Promise<void>
): Promise<void> {
  const duration =
    config.minLatencyMs + Math.random() * (config.maxLatencyMs - config.minLatencyMs);

  const chunks = Math.ceil(duration / 1000);
  let lastRefresh = Date.now();
  for (let i = 0; i < chunks; i++) {
    Context.current().heartbeat(`${label} ${i + 1}/${chunks}`);
    await new Promise((r) => setTimeout(r, 1000));
    if (refreshLease && Date.now() - lastRefresh >= LEASE_REFRESH_INTERVAL_MS) {
      await refreshLease();
      lastRefresh = Date.now();
    }
  }
}

async function mockSearch(
  runId: string,
  _query: string,
  refreshLease?: () => Promise<void>
): Promise<SearchResult[]> {
  await simulateLatency(SEARCH_CONFIG, 'Searching', refreshLease);

  if (Math.random() < SEARCH_CONFIG.failureRate) {
    throw new Error('Search service temporarily unavailable');
  }

  if (Math.random() < SEARCH_CONFIG.noResultsRate) {
    return [];
  }

  // Only fetch id and filename - avoid pulling all markdown content
  // This prevents O(files * guides) DB I/O at scale
  const files = await db.file.findMany({
    where: { runId, status: 'converted' },
    select: { id: true, filename: true },
  });

  if (files.length === 0) {
    return [];
  }

  const numResults = Math.min(files.length, 2 + Math.floor(Math.random() * 3));
  const shuffled = files.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, numResults);

  // Fetch markdown only for the selected files (2-4 files, not all)
  const selectedWithContent = await db.file.findMany({
    where: { id: { in: selected.map((f) => f.id) } },
    select: { id: true, filename: true, markdownContent: true },
  });

  return selectedWithContent.map((f, i) => ({
    fileId: f.id,
    filename: f.filename,
    snippet: f.markdownContent?.slice(0, 200) || 'Content preview...',
    relevance: 0.95 - i * 0.1,
  }));
}

function generateMockHTML(guideName: string, description: string, sources: SearchResult[]): string {
  // Escape user inputs to prevent XSS
  const safeName = escapeHtml(guideName);
  const safeDesc = escapeHtml(description);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #e5e5e5; padding-bottom: 0.5rem; }
    h2 { color: #333; margin-top: 2rem; }
    .description { color: #666; font-style: italic; margin-bottom: 2rem; }
    .content { line-height: 1.6; }
    .sources { background: #f5f5f5; padding: 1rem; border-radius: 8px; margin-top: 2rem; }
    .sources h3 { margin-top: 0; }
    .sources ul { margin: 0; padding-left: 1.5rem; }
  </style>
</head>
<body>
  <h1>${safeName}</h1>
  <p class="description">${safeDesc}</p>

  <div class="content">
    <h2>Overview</h2>
    <p>This guide provides step-by-step instructions for ${safeName.toLowerCase()}. Follow these procedures to ensure compliance with company policies and best practices.</p>

    <h2>Prerequisites</h2>
    <ul>
      <li>Access to the company intranet</li>
      <li>Valid employee credentials</li>
      <li>Completion of required training modules</li>
    </ul>

    <h2>Step-by-Step Instructions</h2>
    <ol>
      <li><strong>Step 1:</strong> Review the relevant documentation and policies.</li>
      <li><strong>Step 2:</strong> Gather all necessary information and materials.</li>
      <li><strong>Step 3:</strong> Follow the standard operating procedure.</li>
      <li><strong>Step 4:</strong> Document your actions and outcomes.</li>
      <li><strong>Step 5:</strong> Submit for review if required.</li>
    </ol>

    <h2>Important Notes</h2>
    <p>Always ensure you have the latest version of relevant policies before proceeding. Contact your supervisor if you have any questions or concerns.</p>
  </div>

  <div class="sources">
    <h3>Source Documents</h3>
    <ul>
      ${sources.map((s) => `<li>${escapeHtml(s.filename)} (${Math.round(s.relevance * 100)}% relevant)</li>`).join('\n      ')}
    </ul>
  </div>
</body>
</html>`;
}

function generateSkeletonHTML(guideName: string, description: string): string {
  // Escape user inputs to prevent XSS
  const safeName = escapeHtml(guideName);
  const safeDesc = escapeHtml(description);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeName} - Needs Review</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 1rem; border-radius: 8px; margin-bottom: 2rem; }
  </style>
</head>
<body>
  <div class="warning">
    <strong>⚠️ This guide requires manual review</strong>
    <p>Automatic generation encountered issues. Please review and complete this guide manually.</p>
  </div>
  <h1>${safeName}</h1>
  <p>${safeDesc}</p>
  <h2>Content</h2>
  <p><em>[Content generation incomplete - manual input required]</em></p>
</body>
</html>`;
}

export async function processGuide(
  runId: string,
  guideId: string,
  isManualRetry: boolean = false
): Promise<{ success: boolean }> {
  const guide = await db.guide.findUnique({ where: { id: guideId } });
  if (!guide) {
    throw new Error(`Guide not found: ${guideId}`);
  }

  // Idempotency guard: if already in terminal state, return early
  // This handles retries after worker crash post-DB-write
  if (guide.status === 'completed' && guide.htmlContent) {
    return { success: true };
  }
  // Only skip needs_attention if this is NOT a manual retry
  if (guide.status === 'needs_attention' && !isManualRetry) {
    return { success: false };
  }

  const attempt = guide.attempts + 1;

  // Wrap everything in try/catch to ensure guide reaches terminal state
  // even if activity fails after max Temporal retries
  try {
    return await processGuideInternal(runId, guideId, guide, attempt, isManualRetry);
  } catch (error) {
    // LeaseHeldError is always retryable - another worker is actively processing
    // Don't degrade to needs_attention just because we hit attempt limit during overlap
    if (error instanceof LeaseHeldError) {
      throw error;
    }

    // If this is a retryable error (attempt < 3), let Temporal retry
    if (attempt < 3) {
      throw error;
    }
    // Otherwise, ensure guide is in terminal state before failing
    try {
      const token = generateProcessingToken();
      const data = {
        status: 'needs_attention' as GuideStatus,
        failureReason: 'Processing failed unexpectedly. Please try again.',
        failureDetails: { error: (error as Error).message, attempts: attempt },
        htmlContent: generateSkeletonHTML(guide.name, guide.description),
        processingToken: null,
        processingStartedAt: null,
        processingHeartbeatAt: null,
      };

      const cleaned = await db.guide.updateMany({
        where: { id: guideId, processingToken: token },
        data,
      });

      // If we no longer hold the lease, only write if the guide is in an in-progress
      // state without an active lease. Avoid clobbering terminal needs_attention.
      if (cleaned.count === 0) {
        await db.guide.updateMany({
          where: {
            id: guideId,
            processingToken: null,
            status: { in: ['pending', 'searching', 'generating'] as GuideStatus[] },
          },
          data,
        });
      }
    } catch {
      // Ignore DB errors in cleanup - guide may already be in terminal state
    }
    return { success: false };
  }
}

async function processGuideInternal(
  runId: string,
  guideId: string,
  guide: {
    name: string;
    description: string;
    forceFailure: boolean;
    searchResults?: unknown | null;
  },
  attempt: number,
  isManualRetry: boolean
): Promise<{ success: boolean }> {
  const token = generateProcessingToken();
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() - LEASE_EXPIRY_MS);

  // Build the lease acquisition conditions
  // For manual retry: also allow from needs_attention
  // For normal processing: only from pending or expired in-progress states
  const baseConditions = isManualRetry
    ? [
        { status: 'pending' as GuideStatus },
        { status: 'needs_attention' as GuideStatus },
        {
          status: { in: ['searching', 'generating'] as GuideStatus[] },
          OR: [
            { processingHeartbeatAt: { lt: leaseExpiry } },
            { processingHeartbeatAt: null, processingStartedAt: { lt: leaseExpiry } },
          ],
        },
      ]
    : [
        { status: 'pending' as GuideStatus },
        {
          status: { in: ['searching', 'generating'] as GuideStatus[] },
          OR: [
            { processingHeartbeatAt: { lt: leaseExpiry } },
            { processingHeartbeatAt: null, processingStartedAt: { lt: leaseExpiry } },
          ],
        },
      ];

  const updateResult = await db.guide.updateMany({
    where: {
      id: guideId,
      OR: baseConditions,
    },
    data: {
      status: 'searching',
      attempts: attempt,
      processingToken: token,
      processingStartedAt: now,
      processingHeartbeatAt: now,
    },
  });

  // If no rows updated, either completed or another worker has the lease
  if (updateResult.count === 0) {
    const currentGuide = await db.guide.findUnique({ where: { id: guideId } });

    // If terminal state, return appropriate result
    if (currentGuide?.status === 'completed') {
      return { success: true };
    }
    if (currentGuide?.status === 'needs_attention') {
      return { success: false };
    }

    // Still in progress - another worker has the lease. Throw LeaseHeldError to always retry.
    // This prevents "false failure" that causes incorrect run counters.
    throw new LeaseHeldError(
      `Guide ${guideId} is in progress (status: ${currentGuide?.status}), lease held by another worker`
    );
  }

  const refreshLease = async () => {
    const refreshed = await db.guide.updateMany({
      where: { id: guideId, processingToken: token },
      data: { processingHeartbeatAt: new Date() },
    });
    if (refreshed.count === 0) {
      throw new LeaseHeldError(`Guide ${guideId} lease lost during processing`);
    }
  };

  // Check if this guide is marked for forced failure (demo mode)
  if (guide.forceFailure) {
    // Simulate some work before failing
    await simulateLatency({ minLatencyMs: 1000, maxLatencyMs: 2000 }, 'Searching', refreshLease);

    const failureReasons = [
      "We couldn't find relevant content in your documents for this guide.",
      'Search service returned no matching documents for this topic.',
      'The source documents do not contain sufficient information for this guide.',
    ];
    const reason = failureReasons[Math.floor(Math.random() * failureReasons.length)];

    // Only finalize if we still hold the lease
    await db.guide.updateMany({
      where: { id: guideId, processingToken: token },
      data: {
        status: 'needs_attention',
        failureReason: reason,
        searchResults: [],
        htmlContent: generateSkeletonHTML(guide.name, guide.description),
        processingToken: null,
        processingStartedAt: null,
        processingHeartbeatAt: null,
      },
    });
    return { success: false };
  }

  // Step 1: Search
  let searchResults: SearchResult[];
  const canReuseSearch = attempt > 1 && hasNonEmptySearchResults(guide.searchResults);
  if (canReuseSearch) {
    searchResults = guide.searchResults as SearchResult[];
  } else {
    try {
      searchResults = await mockSearch(runId, guide.description, refreshLease);
    } catch (error) {
      if (attempt < 3) {
        // Release lease and reset to pending before throwing so Temporal retry can reacquire
        await db.guide.updateMany({
          where: { id: guideId, processingToken: token },
          data: {
            status: 'pending',
            processingToken: null,
            processingStartedAt: null,
            processingHeartbeatAt: null,
            searchResults: [],
            failureDetails: { lastError: (error as Error).message, attempt },
          },
        });
        throw error; // Let Temporal retry
      }
      // Only finalize if we still hold the lease
      await db.guide.updateMany({
        where: { id: guideId, processingToken: token },
        data: {
          status: 'needs_attention',
          failureReason: 'Search service unavailable after multiple attempts.',
          failureDetails: { error: (error as Error).message, attempts: attempt },
          processingToken: null,
          processingStartedAt: null,
          processingHeartbeatAt: null,
        },
      });
      return { success: false };
    }
  }

  if (searchResults.length === 0) {
    // Only finalize if we still hold the lease
    await db.guide.updateMany({
      where: { id: guideId, processingToken: token },
      data: {
        status: 'needs_attention',
        failureReason: "We couldn't find relevant content in your documents for this guide.",
        searchResults: [],
        processingToken: null,
        processingStartedAt: null,
        processingHeartbeatAt: null,
      },
    });
    return { success: false };
  }

  // Transition to generating - keep the lease.
  // If we reused cached search results, don't overwrite them.
  await db.guide.updateMany({
    where: { id: guideId, processingToken: token },
    data: canReuseSearch
      ? { status: 'generating' }
      : {
          status: 'generating',
          // Prisma JSON fields accept plain objects - spread to ensure serializable
          searchResults: searchResults.map((r) => ({ ...r })),
        },
  });

  // Step 2: Generate
  try {
    await simulateLatency(GENERATION_CONFIG, 'Generating', refreshLease);

    if (Math.random() < GENERATION_CONFIG.failureRate) {
      throw new Error('Generation service temporarily unavailable');
    }

    let html: string;
    if (attempt === 1) {
      html = generateMockHTML(guide.name, guide.description, searchResults);
    } else if (attempt === 2) {
      html = generateMockHTML(guide.name, guide.description, searchResults.slice(0, 2));
    } else {
      html = generateSkeletonHTML(guide.name, guide.description);
    }

    // Only finalize if we still hold the lease
    const finalizeResult = await db.guide.updateMany({
      where: { id: guideId, processingToken: token },
      data: {
        status: 'completed',
        htmlContent: html,
        processingToken: null,
        processingStartedAt: null,
        processingHeartbeatAt: null,
      },
    });

    // If we didn't update, another worker took over - check if it succeeded
    if (finalizeResult.count === 0) {
      const currentGuide = await db.guide.findUnique({ where: { id: guideId } });
      return { success: currentGuide?.status === 'completed' };
    }

    return { success: true };
  } catch (error) {
    if (attempt < 3) {
      // Release lease and reset to pending before throwing so Temporal retry can reacquire
      await db.guide.updateMany({
        where: { id: guideId, processingToken: token },
        data: {
          status: 'pending',
          processingToken: null,
          processingStartedAt: null,
          processingHeartbeatAt: null,
          failureDetails: { lastError: (error as Error).message, attempt },
        },
      });
      throw error; // Let Temporal retry
    }

    // Only finalize if we still hold the lease
    await db.guide.updateMany({
      where: { id: guideId, processingToken: token },
      data: {
        status: 'needs_attention',
        failureReason:
          'Generation failed after multiple attempts. The content may need manual review.',
        failureDetails: { error: (error as Error).message, attempts: attempt },
        htmlContent: generateSkeletonHTML(guide.name, guide.description),
        processingToken: null,
        processingStartedAt: null,
        processingHeartbeatAt: null,
      },
    });

    return { success: false };
  }
}
