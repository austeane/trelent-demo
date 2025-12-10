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

interface RunConfig {
  fileCount: number;
  guideCount: number;
  failureRate: number;
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

function ConfigureRunModal({
  isOpen,
  onClose,
  onSubmit,
  creating,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (config: RunConfig) => void;
  creating: boolean;
}) {
  const [config, setConfig] = useState<RunConfig>({
    fileCount: 8,
    guideCount: 12,
    failureRate: 0,
  });

  if (!isOpen) return null;

  const presets = [
    { label: 'Quick Demo', fileCount: 8, guideCount: 12, failureRate: 0 },
    { label: 'With Failures', fileCount: 8, guideCount: 12, failureRate: 25 },
    { label: 'Scale Test', fileCount: 1000, guideCount: 100, failureRate: 5 },
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex justify-between items-center p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">Configure Run</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            disabled={creating}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-5">
          {/* Presets */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Quick Presets</label>
            <div className="flex gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() =>
                    setConfig({
                      fileCount: preset.fileCount,
                      guideCount: preset.guideCount,
                      failureRate: preset.failureRate,
                    })
                  }
                  className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50 text-gray-700"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Documents */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Documents <span className="text-gray-400 font-normal">(1 - 10,000)</span>
            </label>
            <input
              type="number"
              min={1}
              max={10000}
              value={config.fileCount}
              onChange={(e) =>
                setConfig({ ...config, fileCount: Math.max(1, parseInt(e.target.value) || 1) })
              }
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Guides */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Guides <span className="text-gray-400 font-normal">(1 - 500)</span>
            </label>
            <input
              type="number"
              min={1}
              max={500}
              value={config.guideCount}
              onChange={(e) =>
                setConfig({ ...config, guideCount: Math.max(1, parseInt(e.target.value) || 1) })
              }
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Failure Rate */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Failure Rate{' '}
              <span className="text-blue-600 font-semibold">{config.failureRate}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={config.failureRate}
              onChange={(e) => setConfig({ ...config, failureRate: parseInt(e.target.value) })}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>
        </div>

        <div className="p-4 border-t bg-gray-50 rounded-b-lg">
          <button
            onClick={() => onSubmit(config)}
            disabled={creating}
            className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            {creating ? 'Starting...' : 'Start Run'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showModal, setShowModal] = useState(false);

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

  async function createRun(config: RunConfig) {
    setCreating(true);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
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
      setShowModal(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Trelent Guide Generator</h1>
          <p className="text-gray-500">Durable document-to-guide pipeline demo</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          disabled={creating}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Configure Run
        </button>
      </div>

      <ConfigureRunModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onSubmit={createRun}
        creating={creating}
      />

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse border rounded-lg p-4 bg-white">
              <div className="h-5 bg-gray-200 rounded w-1/3 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-1/2"></div>
            </div>
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border">
          <h2 className="text-lg font-medium text-gray-900 mb-2">No runs yet</h2>
          <p className="text-gray-500 mb-4">
            Start your first guide generation run to see it here.
          </p>
          <button
            onClick={() => setShowModal(true)}
            disabled={creating}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            Create First Run
          </button>
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
                  <span className="text-amber-600">{run.failedGuides} need attention</span>
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
          <strong>Temporal</strong> for workflow orchestration. Configure your run with custom
          document counts, guide counts, and failure rates to see retry handling and partial success
          states in action.
        </p>
        <p className="text-sm text-gray-600 mt-2">
          <strong>Features:</strong> Bounded concurrency, progress tracking, degrading retry
          strategies, and user-friendly failure explanations.
        </p>
      </div>
    </div>
  );
}
