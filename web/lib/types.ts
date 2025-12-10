// Shared types for the web application

export interface SearchResult {
  fileId: string;
  filename: string;
  snippet: string;
  relevance: number;
}

export interface GuideDTO {
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

export interface GuidesResponse {
  guides: GuideDTO[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface RunStatus {
  run: {
    status: string;
  };
  guideCounts: {
    needs_attention?: number;
    completed?: number;
    pending?: number;
    searching?: number;
    generating?: number;
  };
}

// Shared constants
export const TASK_QUEUE = 'guide-generation';

export const FINISHED_RUN_STATUSES = ['completed', 'completed_with_errors', 'failed'];
