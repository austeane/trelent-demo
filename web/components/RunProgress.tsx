'use client';

import { useEffect, useState } from 'react';

// Stage labels match exactly what the worker sets in guideGenerationWorkflow.ts
const STAGE_LABELS: Record<string, { label: string; description: string }> = {
  initializing: {
    label: 'Setting up',
    description: 'Preparing your documents for processing',
  },
  converting_documents: {
    label: 'Reading documents',
    description: 'Converting PDFs and Word docs into searchable text',
  },
  writing_guides: {
    label: 'Writing guides',
    description: 'Searching for content and generating HTML guides',
  },
  complete: {
    label: 'Done',
    description: 'Your guides are ready',
  },
};

interface RunData {
  run: {
    id: string;
    name: string;
    status: string;
    stage: string;
    totalFiles: number;
    convertedFiles: number;
    totalGuides: number;
    completedGuides: number;
    failedGuides: number;
  };
  guideCounts: Record<string, number>;
  fileCounts: Record<string, number>;
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 bg-gray-200 rounded w-1/3" />
      <div className="h-4 bg-gray-200 rounded w-1/2" />
      <div className="h-3 bg-gray-200 rounded-full w-full" />
      <div className="grid grid-cols-3 gap-4">
        <div className="h-16 bg-gray-200 rounded" />
        <div className="h-16 bg-gray-200 rounded" />
        <div className="h-16 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color: 'green' | 'blue' | 'amber' | 'gray';
}) {
  const colors = {
    green: 'text-green-600',
    blue: 'text-blue-600',
    amber: 'text-amber-600',
    gray: 'text-gray-600',
  };

  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${colors[color]}`}>{value}</div>
      <div className="text-sm text-gray-500">{label}</div>
    </div>
  );
}

export function RunProgress({ runId }: { runId: string }) {
  const [data, setData] = useState<RunData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`);
        if (!res.ok) {
          throw new Error('Failed to fetch');
        }
        const json = await res.json();
        if (active) {
          setData(json);
          setError(null);
        }

        if (active && !['completed', 'completed_with_errors', 'failed'].includes(json.run.status)) {
          setTimeout(poll, 2000);
        }
      } catch {
        if (active) {
          setError('Failed to load run status');
        }
      }
    };

    poll();
    return () => {
      active = false;
    };
  }, [runId]);

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
    );
  }

  if (!data) {
    return <LoadingSkeleton />;
  }

  const { run, guideCounts, fileCounts } = data;
  const stage = STAGE_LABELS[run.stage] || STAGE_LABELS.initializing;

  const completed = guideCounts.completed || 0;
  const needsAttention = guideCounts.needs_attention || 0;
  const inProgress = run.totalGuides - completed - needsAttention - (guideCounts.pending || 0);

  // Document conversion progress - include both converted AND failed as "processed"
  const filesConverted = fileCounts.converted || 0;
  const filesFailed = fileCounts.failed || 0;
  const filesProcessed = filesConverted + filesFailed;
  const docsProgress = run.totalFiles > 0 ? Math.round((filesProcessed / run.totalFiles) * 100) : 0;

  // Guide generation progress
  const guidesProgress =
    run.totalGuides > 0 ? Math.round(((completed + needsAttention) / run.totalGuides) * 100) : 0;

  const isFinished = ['completed', 'completed_with_errors', 'failed'].includes(run.status);

  return (
    <div className="space-y-6">
      {/* Stage */}
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-semibold text-gray-900">{stage.label}</h2>
          {!isFinished && <div className="h-2 w-2 bg-blue-500 rounded-full animate-pulse" />}
        </div>
        <p className="text-gray-500">{stage.description}</p>
      </div>

      {/* Progress bars */}
      <div className="space-y-3">
        {/* Documents progress */}
        <div>
          <div className="flex justify-between text-sm text-gray-500 mb-1">
            <span>Documents processed</span>
            <span>
              {filesProcessed}/{run.totalFiles}
              {filesFailed > 0 && (
                <span className="text-amber-600 ml-1">({filesFailed} failed)</span>
              )}
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-indigo-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${docsProgress}%` }}
            />
          </div>
        </div>

        {/* Guides progress */}
        <div>
          <div className="flex justify-between text-sm text-gray-500 mb-1">
            <span>Guides written</span>
            <span>
              {completed + needsAttention}/{run.totalGuides} ({guidesProgress}%)
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-500"
              style={{ width: `${guidesProgress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 text-center p-4 bg-gray-50 rounded-lg">
        <Stat value={completed} label="Completed" color="green" />
        <Stat value={inProgress} label="In progress" color="blue" />
        <Stat value={needsAttention} label="Needs attention" color="amber" />
        <Stat value={guideCounts.pending || 0} label="Pending" color="gray" />
      </div>

      {/* Status badge */}
      {isFinished && (
        <div
          className={`p-4 rounded-lg ${
            run.status === 'completed'
              ? 'bg-green-50 border border-green-200'
              : run.status === 'completed_with_errors'
                ? 'bg-amber-50 border border-amber-200'
                : 'bg-red-50 border border-red-200'
          }`}
        >
          <p
            className={`font-medium ${
              run.status === 'completed'
                ? 'text-green-700'
                : run.status === 'completed_with_errors'
                  ? 'text-amber-700'
                  : 'text-red-700'
            }`}
          >
            {run.status === 'completed'
              ? 'All guides generated successfully!'
              : run.status === 'completed_with_errors'
                ? `Completed with ${needsAttention} guide(s) needing attention`
                : 'Run failed'}
          </p>
        </div>
      )}
    </div>
  );
}
