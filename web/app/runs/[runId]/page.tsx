'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { RunProgress } from '@/components/RunProgress';
import { GuideList } from '@/components/GuideList';

export default function RunDetail() {
  const params = useParams();
  const runId = params.runId as string;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <Link
        href="/"
        className="text-blue-600 hover:text-blue-700 text-sm mb-4 inline-block"
      >
        ← Back to Dashboard
      </Link>

      <div className="bg-white rounded-lg border p-6 mb-8">
        <RunProgress runId={runId} />
      </div>

      <div className="bg-white rounded-lg border p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Guides</h2>
        <GuideList runId={runId} />
      </div>
    </div>
  );
}
