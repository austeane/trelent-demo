'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Run {
  id: string;
  name: string;
  status: string;
  stage: string;
  totalGuides: number;
  completedGuides: number;
  failedGuides: number;
  createdAt: string;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-gray-100 text-gray-700',
    processing: 'bg-blue-100 text-blue-700',
    completed: 'bg-green-100 text-green-700',
    completed_with_errors: 'bg-amber-100 text-amber-700',
    failed: 'bg-red-100 text-red-700',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${styles[status] || styles.pending}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchRuns();
  }, []);

  async function fetchRuns() {
    try {
      const res = await fetch('/api/runs');
      const data = await res.json();
      setRuns(data);
    } catch (err) {
      console.error('Failed to fetch runs:', err);
    } finally {
      setLoading(false);
    }
  }

  async function createRun(withFailures = false) {
    setCreating(true);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withFailures }),
      });
      const data = await res.json();
      if (data.runId) {
        router.push(`/runs/${data.runId}`);
      }
    } catch (err) {
      console.error('Failed to create run:', err);
      alert('Failed to create run. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Trelent Guide Generator
          </h1>
          <p className="text-gray-500">
            Durable document-to-guide pipeline demo
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => createRun(false)}
            disabled={creating}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? 'Starting...' : 'New Run'}
          </button>
          <button
            onClick={() => createRun(true)}
            disabled={creating}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? 'Starting...' : 'Demo with Failures'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="animate-pulse border rounded-lg p-4 bg-white"
            >
              <div className="h-5 bg-gray-200 rounded w-1/3 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-1/2"></div>
            </div>
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border">
          <h2 className="text-lg font-medium text-gray-900 mb-2">
            No runs yet
          </h2>
          <p className="text-gray-500 mb-4">
            Start your first guide generation run to see it here.
          </p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => createRun(false)}
              disabled={creating}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? 'Starting...' : 'Create First Run'}
            </button>
            <button
              onClick={() => createRun(true)}
              disabled={creating}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50"
            >
              {creating ? 'Starting...' : 'Demo with Failures'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {runs.map((run) => (
            <div
              key={run.id}
              onClick={() => router.push(`/runs/${run.id}`)}
              className="border rounded-lg p-4 bg-white hover:border-blue-300 cursor-pointer transition-colors"
            >
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="font-medium text-gray-900">{run.name}</h2>
                  <p className="text-sm text-gray-500">
                    {new Date(run.createdAt).toLocaleString()}
                  </p>
                </div>
                <StatusBadge status={run.status} />
              </div>
              <div className="mt-3 flex gap-4 text-sm text-gray-600">
                <span>
                  {run.completedGuides}/{run.totalGuides} guides completed
                </span>
                {run.failedGuides > 0 && (
                  <span className="text-amber-600">
                    {run.failedGuides} need attention
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-12 p-6 bg-gray-50 rounded-lg">
        <h2 className="font-medium text-gray-900 mb-2">About this demo</h2>
        <p className="text-sm text-gray-600">
          This demo showcases a durable document-to-guide pipeline built with{' '}
          <strong>Temporal</strong> for workflow orchestration. Each run
          converts 8 sample documents and generates 12 guides, with realistic
          latency and failure modes to demonstrate retry handling and partial
          success states.
        </p>
        <p className="text-sm text-gray-600 mt-2">
          <strong>Features:</strong> Bounded concurrency, progress tracking,
          degrading retry strategies, and user-friendly failure explanations.
        </p>
      </div>
    </div>
  );
}
