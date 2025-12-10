'use client';

import { useEffect, useState } from 'react';
import { GuideCard } from './GuideCard';

interface Guide {
  id: string;
  name: string;
  description: string;
  status: string;
  searchResults: unknown[] | null;
  htmlContent: string | null;
  failureReason: string | null;
  failureDetails: Record<string, unknown> | null;
  attempts: number;
}

interface GuidesResponse {
  guides: Guide[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'needs_attention', label: 'Needs attention' },
  { value: 'pending', label: 'Pending' },
  { value: 'generating', label: 'In progress' },
];

export function GuideList({ runId }: { runId: string }) {
  const [data, setData] = useState<GuidesResponse | null>(null);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [retryTrigger, setRetryTrigger] = useState(0);

  const handleRetry = async (guideId: string) => {
    try {
      const res = await fetch(`/api/guides/${guideId}/retry`, {
        method: 'POST',
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to retry');
      }
      // Trigger a refresh of the guide list
      setRetryTrigger((t) => t + 1);
    } catch (err) {
      console.error('Failed to retry guide:', err);
      alert('Failed to retry guide. Please try again.');
    }
  };

  // Debounce search input
  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    let active = true;

    const fetchGuides = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ page: String(page) });
        if (filter) params.set('status', filter);
        if (search) params.set('search', search);

        const res = await fetch(`/api/runs/${runId}/guides?${params}`);
        const json = await res.json();
        if (active) setData(json);
      } catch (err) {
        console.error('Failed to fetch guides:', err);
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchGuides();

    // Poll while there are pending/in-progress guides
    const interval = setInterval(fetchGuides, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [runId, filter, search, page, retryTrigger]);

  return (
    <div className="space-y-4">
      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Search guides..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full px-4 py-2 pl-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => {
                setFilter(f.value);
                setPage(1);
              }}
              className={`px-3 py-1.5 text-sm rounded-full ${
                filter === f.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Guide list */}
      {loading && !data ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse border rounded-lg p-4">
              <div className="h-5 bg-gray-200 rounded w-1/3 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-2/3"></div>
            </div>
          ))}
        </div>
      ) : data?.guides.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No guides found</p>
      ) : (
        <div className="space-y-4">
          {data?.guides.map((guide) => (
            <GuideCard key={guide.id} guide={guide as any} onRetry={handleRetry} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {data && data.pagination.totalPages > 1 && (
        <div className="flex justify-center gap-2 pt-4">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 text-sm border rounded disabled:opacity-50"
          >
            Previous
          </button>
          <span className="px-3 py-1.5 text-sm text-gray-600">
            Page {page} of {data.pagination.totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(data.pagination.totalPages, p + 1))}
            disabled={page === data.pagination.totalPages}
            className="px-3 py-1.5 text-sm border rounded disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
