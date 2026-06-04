import path from 'node:path';
import type { AnalyzeOptions } from '../core/run-analyze.js';
import { BadRequestError } from './validation.js';

export interface ReindexTarget {
  id?: string;
  name: string;
  path: string;
  storagePath: string;
}

export interface ReindexTargetRequest {
  repo?: string;
  path?: string;
}

export interface ReindexRequestOptions {
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
}

export interface ReindexRequestBody {
  repo?: string;
  path?: string;
  force?: boolean;
  embeddings?: boolean;
  dropEmbeddings?: boolean;
}

export type ReindexWorkerOptions = AnalyzeOptions & {
  indexOnly: true;
};

export type ReindexQueueAction =
  | { action: 'start' }
  | { action: 'dedupe-active' }
  | { action: 'dedupe-pending-rerun' }
  | { action: 'reject-active-other-repo'; activeRepoKey: string };

export type ReindexCompletionAction = { action: 'start-pending-rerun' } | { action: 'idle' };

export interface ReindexQueueStatus {
  active: boolean;
  pendingRerun: boolean;
  lastError?: string;
  lastFailureAt?: number;
}

export interface ReindexGraphReadGateState {
  queueStatus: ReindexQueueStatus;
  activeTrigger?: string;
}

/**
 * Returns true only for the unstable overlap window we have evidence for:
 * - a coalesced request has been recorded for the active parent job
 *   (`pendingRerun === true` while the direct job is still active), or
 * - the active job is itself the pending-rerun child.
 *
 * Plain direct reindex activity should remain readable unless stronger
 * evidence says otherwise.
 */
export const isGraphReadBlockedDuringReindex = (state: ReindexGraphReadGateState): boolean =>
  state.queueStatus.pendingRerun ||
  (state.queueStatus.active && state.activeTrigger === 'pending-rerun');

const normalizeComparablePath = (value: string): string =>
  path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();

export const parseReindexRequestBody = (body: unknown): ReindexRequestBody => {
  if (!body || typeof body !== 'object') {
    throw new BadRequestError('Provide a registered repo name/id or path.');
  }

  const value = body as Record<string, unknown>;
  if (value.repo !== undefined && typeof value.repo !== 'string') {
    throw new BadRequestError('"repo" must be a string');
  }
  if (value.path !== undefined && typeof value.path !== 'string') {
    throw new BadRequestError('"path" must be a string');
  }
  for (const key of ['force', 'embeddings', 'dropEmbeddings'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new BadRequestError(`"${key}" must be a boolean`);
    }
  }

  const repo = value.repo as string | undefined;
  const requestedPath = value.path as string | undefined;
  if (!repo?.trim() && !requestedPath?.trim()) {
    throw new BadRequestError('Provide a registered repo name/id or path.');
  }

  return {
    repo,
    path: requestedPath,
    force: value.force === true,
    embeddings: value.embeddings === true,
    dropEmbeddings: value.dropEmbeddings === true,
  };
};

export const resolveRegisteredReindexTarget = (
  repos: readonly ReindexTarget[],
  request: ReindexTargetRequest,
): ReindexTarget => {
  const repo = request.repo?.trim();
  const requestedPath = request.path?.trim();

  if (!repo && !requestedPath) {
    throw new BadRequestError('Provide a registered repo name/id or path.');
  }

  if (repo) {
    const repoLower = repo.toLowerCase();
    const match = repos.find(
      (entry) => entry.name.toLowerCase() === repoLower || entry.id?.toLowerCase() === repoLower,
    );
    if (match) return match;
    throw new BadRequestError(`Repository is not registered: ${repo}`);
  }

  const normalizedRequest = normalizeComparablePath(requestedPath!);
  const match = repos.find((entry) => normalizeComparablePath(entry.path) === normalizedRequest);
  if (match) return match;

  throw new BadRequestError(`Reindex path is not registered: ${requestedPath}`);
};

export const buildReindexWorkerOptions = (options: ReindexRequestOptions = {}): ReindexWorkerOptions => ({
  force: !!options.force,
  embeddings: !!options.embeddings,
  dropEmbeddings: !!options.dropEmbeddings,
  skipAgentsMd: true,
  skipSkills: true,
  indexOnly: true,
});

interface QueueEntry {
  active: boolean;
  pendingRerun: boolean;
  lastError?: string;
  lastFailureAt?: number;
}

export class ReindexQueue {
  private readonly entries = new Map<string, QueueEntry>();
  private activeRepoKey: string | null = null;

  request(repoKey: string): ReindexQueueAction {
    const current = this.entries.get(repoKey);

    if (current?.active) {
      current.pendingRerun = true;
      return { action: 'dedupe-pending-rerun' };
    }

    if (this.activeRepoKey && this.activeRepoKey !== repoKey) {
      return { action: 'reject-active-other-repo', activeRepoKey: this.activeRepoKey };
    }

    this.entries.set(repoKey, { active: true, pendingRerun: false });
    this.activeRepoKey = repoKey;
    return { action: 'start' };
  }

  complete(repoKey: string): ReindexCompletionAction {
    const current = this.entries.get(repoKey);
    if (!current?.active) return { action: 'idle' };

    if (current.pendingRerun) {
      current.pendingRerun = false;
      current.active = true;
      this.activeRepoKey = repoKey;
      return { action: 'start-pending-rerun' };
    }

    current.active = false;
    this.activeRepoKey = null;
    return { action: 'idle' };
  }

  fail(repoKey: string, error: string, failedAt = Date.now()): void {
    const current = this.entries.get(repoKey);
    if (!current) {
      this.entries.set(repoKey, {
        active: false,
        pendingRerun: false,
        lastError: error,
        lastFailureAt: failedAt,
      });
      return;
    }
    current.active = false;
    current.pendingRerun = false;
    current.lastError = error;
    current.lastFailureAt = failedAt;
    this.activeRepoKey = null;
  }

  status(repoKey: string): ReindexQueueStatus {
    const current = this.entries.get(repoKey);
    return {
      active: !!current?.active,
      pendingRerun: !!current?.pendingRerun,
      lastError: current?.lastError,
      lastFailureAt: current?.lastFailureAt,
    };
  }
}
