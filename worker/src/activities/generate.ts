import { Context } from '@temporalio/activity';
import { db } from '../lib/db';
import { GuideStatus } from '@prisma/client';

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

interface SearchResult {
  fileId: string;
  filename: string;
  snippet: string;
  relevance: number;
}

async function simulateLatency(
  config: { minLatencyMs: number; maxLatencyMs: number },
  label: string
): Promise<void> {
  const duration =
    config.minLatencyMs + Math.random() * (config.maxLatencyMs - config.minLatencyMs);

  const chunks = Math.ceil(duration / 1000);
  for (let i = 0; i < chunks; i++) {
    Context.current().heartbeat(`${label} ${i + 1}/${chunks}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function mockSearch(runId: string, query: string): Promise<SearchResult[]> {
  await simulateLatency(SEARCH_CONFIG, 'Searching');

  if (Math.random() < SEARCH_CONFIG.failureRate) {
    throw new Error('Search service temporarily unavailable');
  }

  if (Math.random() < SEARCH_CONFIG.noResultsRate) {
    return [];
  }

  const files = await db.file.findMany({
    where: { runId, status: 'converted' },
    select: { id: true, filename: true, markdownContent: true },
  });

  if (files.length === 0) {
    return [];
  }

  const numResults = Math.min(files.length, 2 + Math.floor(Math.random() * 3));
  const shuffled = files.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, numResults);

  return selected.map((f, i) => ({
    fileId: f.id,
    filename: f.filename,
    snippet: f.markdownContent?.slice(0, 200) || 'Content preview...',
    relevance: 0.95 - i * 0.1,
  }));
}

function generateMockHTML(guideName: string, description: string, sources: SearchResult[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${guideName}</title>
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
  <h1>${guideName}</h1>
  <p class="description">${description}</p>

  <div class="content">
    <h2>Overview</h2>
    <p>This guide provides step-by-step instructions for ${guideName.toLowerCase()}. Follow these procedures to ensure compliance with company policies and best practices.</p>

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
      ${sources.map((s) => `<li>${s.filename} (${Math.round(s.relevance * 100)}% relevant)</li>`).join('\n      ')}
    </ul>
  </div>
</body>
</html>`;
}

function generateSkeletonHTML(guideName: string, description: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${guideName} - Needs Review</title>
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
  <h1>${guideName}</h1>
  <p>${description}</p>
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

  // Conditional update: only transition if in expected state
  const validFromStates: GuideStatus[] = isManualRetry
    ? ['pending', 'needs_attention', 'searching', 'generating']
    : ['pending', 'searching', 'generating'];

  const updateResult = await db.guide.updateMany({
    where: {
      id: guideId,
      status: { in: validFromStates },
    },
    data: { status: 'searching', attempts: attempt },
  });

  // If no rows updated, another worker already processed this
  if (updateResult.count === 0) {
    const currentGuide = await db.guide.findUnique({ where: { id: guideId } });
    return { success: currentGuide?.status === 'completed' };
  }

  // Check if this guide is marked for forced failure (demo mode)
  if (guide.forceFailure) {
    // Simulate some work before failing
    await simulateLatency({ minLatencyMs: 1000, maxLatencyMs: 2000 }, 'Searching');

    const failureReasons = [
      "We couldn't find relevant content in your documents for this guide.",
      'Search service returned no matching documents for this topic.',
      'The source documents do not contain sufficient information for this guide.',
    ];
    const reason = failureReasons[Math.floor(Math.random() * failureReasons.length)];

    await db.guide.update({
      where: { id: guideId },
      data: {
        status: 'needs_attention',
        failureReason: reason,
        searchResults: [],
        htmlContent: generateSkeletonHTML(guide.name, guide.description),
      },
    });
    return { success: false };
  }

  // Step 1: Search
  let searchResults: SearchResult[];
  try {
    searchResults = await mockSearch(runId, guide.description);
  } catch (error) {
    if (attempt < 3) {
      throw error; // Let Temporal retry
    }
    await db.guide.update({
      where: { id: guideId },
      data: {
        status: 'needs_attention',
        failureReason: 'Search service unavailable after multiple attempts.',
        failureDetails: { error: (error as Error).message, attempts: attempt },
      },
    });
    return { success: false };
  }

  if (searchResults.length === 0) {
    await db.guide.update({
      where: { id: guideId },
      data: {
        status: 'needs_attention',
        failureReason: "We couldn't find relevant content in your documents for this guide.",
        searchResults: [],
      },
    });
    return { success: false };
  }

  await db.guide.update({
    where: { id: guideId },
    data: {
      status: 'generating',
      // Prisma JSON fields accept plain objects - spread to ensure serializable
      searchResults: searchResults.map((r) => ({ ...r })),
    },
  });

  // Step 2: Generate
  try {
    await simulateLatency(GENERATION_CONFIG, 'Generating');

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

    await db.guide.update({
      where: { id: guideId },
      data: { status: 'completed', htmlContent: html },
    });

    return { success: true };
  } catch (error) {
    if (attempt < 3) {
      throw error; // Let Temporal retry
    }

    await db.guide.update({
      where: { id: guideId },
      data: {
        status: 'needs_attention',
        failureReason:
          'Generation failed after multiple attempts. The content may need manual review.',
        failureDetails: { error: (error as Error).message, attempts: attempt },
        htmlContent: generateSkeletonHTML(guide.name, guide.description),
      },
    });

    return { success: false };
  }
}
