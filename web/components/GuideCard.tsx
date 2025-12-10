'use client';

import { useState } from 'react';

interface SearchResult {
  fileId: string;
  filename: string;
  snippet: string;
  relevance: number;
}

interface Guide {
  id: string;
  name: string;
  description: string;
  status: string;
  searchResults: SearchResult[] | null;
  htmlContent: string | null;
  failureReason: string | null;
  failureDetails: Record<string, unknown> | null;
  attempts: number;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-gray-100 text-gray-700',
    searching: 'bg-blue-100 text-blue-700',
    generating: 'bg-purple-100 text-purple-700',
    completed: 'bg-green-100 text-green-700',
    needs_attention: 'bg-amber-100 text-amber-700',
    failed: 'bg-red-100 text-red-700',
  };

  const labels: Record<string, string> = {
    pending: 'Pending',
    searching: 'Searching...',
    generating: 'Generating...',
    completed: 'Completed',
    needs_attention: 'Needs attention',
    failed: 'Failed',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${styles[status] || styles.pending}`}
    >
      {labels[status] || status}
    </span>
  );
}

export function GuideCard({
  guide,
  onRetry,
}: {
  guide: Guide;
  onRetry?: (guideId: string) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const [retrying, setRetrying] = useState(false);

  return (
    <div className="border rounded-lg p-4 bg-white shadow-sm">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <h3 className="font-medium text-gray-900">{guide.name}</h3>
          <p className="text-sm text-gray-500 mt-1">{guide.description}</p>
        </div>
        <StatusBadge status={guide.status} />
      </div>

      {guide.status === 'completed' && guide.htmlContent && (
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="px-3 py-1.5 text-sm bg-blue-50 text-blue-600 rounded hover:bg-blue-100"
          >
            {showPreview ? 'Hide preview' : 'Preview'}
          </button>
          <a
            href={`data:text/html;charset=utf-8,${encodeURIComponent(guide.htmlContent)}`}
            download={`${guide.name.toLowerCase().replace(/\s+/g, '-')}.html`}
            className="px-3 py-1.5 text-sm bg-gray-50 text-gray-600 rounded hover:bg-gray-100"
          >
            Download
          </a>
        </div>
      )}

      {showPreview && guide.htmlContent && (
        <div className="mt-4 border rounded overflow-hidden">
          <iframe
            srcDoc={guide.htmlContent}
            className="w-full h-96 bg-white"
            title={guide.name}
            // Sandbox to prevent XSS - only allow styles, no scripts or forms
            sandbox="allow-same-origin"
          />
        </div>
      )}

      {guide.status === 'needs_attention' && (
        <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded">
          <p className="text-sm text-amber-800 font-medium">{guide.failureReason}</p>

          {guide.searchResults && guide.searchResults.length > 0 && (
            <div className="mt-2 text-xs text-amber-700">
              <p className="font-medium">Closest matches we found:</p>
              <ul className="mt-1 space-y-1">
                {guide.searchResults.slice(0, 3).map((r, i) => (
                  <li key={i}>
                    • {r.filename}: &quot;{r.snippet.slice(0, 60)}...&quot;
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            {guide.attempts > 0 && (
              <p className="text-xs text-amber-600">Attempted {guide.attempts} time(s)</p>
            )}
            {onRetry && (
              <button
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await onRetry(guide.id);
                  } finally {
                    setRetrying(false);
                  }
                }}
                disabled={retrying}
                className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {retrying ? 'Retrying...' : 'Try again'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
