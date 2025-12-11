'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GuideList } from '@/components/GuideList';
import { RunProgress } from '@/components/RunProgress';

export default function RunDetail() {
  const params = useParams();
  const runId = params.runId as string;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <Link href="/" className="text-blue-600 hover:text-blue-700 text-sm mb-4 inline-block">
        ← Back to Dashboard
      </Link>

      <div className="bg-white rounded-lg border p-6 mb-8">
        <RunProgress runId={runId} />
      </div>

      <div className="bg-white rounded-lg border p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Guides</h2>
          <a
            href={`/api/runs/${runId}/download`}
            className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700"
          >
            Download all (ZIP)
          </a>
        </div>
        <GuideList runId={runId} />
      </div>
    </div>
  );
}
