/**
 * CLI `--stale-policy` (#3127). Keys off `staleness.status` (not `isStale`):
 * behind/diverged violate under `error`; `ignore` strips the field; `unknown` never fails.
 */

import { Option } from 'commander';
import type { StalenessStatus } from '../core/staleness-status.js';

export const STALE_POLICIES = ['warn', 'ignore', 'error'] as const;
export type StalePolicy = (typeof STALE_POLICIES)[number];
export const DEFAULT_STALE_POLICY: StalePolicy = 'warn';

export type BlockingStaleStatus = Extract<StalenessStatus, 'behind' | 'diverged'>;

export function createStalePolicyOption(): Option {
  return new Option(
    '--stale-policy <policy>',
    'How to handle a stale index: warn, ignore, or error',
  )
    .choices([...STALE_POLICIES])
    .default(DEFAULT_STALE_POLICY);
}

/** Commander validates CLI input; this covers direct `*Command` callers (tests). */
export function parseStalePolicy(raw: unknown): StalePolicy {
  if (raw === 'warn' || raw === 'ignore' || raw === 'error') return raw;
  return DEFAULT_STALE_POLICY;
}

export function isBlockingStaleStatus(status: string): status is BlockingStaleStatus {
  return status === 'behind' || status === 'diverged';
}

function statusOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'string' ? status : undefined;
}

function collectStaleStatuses(data: unknown): string[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];

  const obj = data as Record<string, unknown>;
  const statuses: string[] = [];
  const top = statusOf(obj.staleness);
  if (top) statuses.push(top);

  if (Array.isArray(obj.per_repo)) {
    for (const entry of obj.per_repo) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const nested = statusOf((entry as { staleness?: unknown }).staleness);
      if (nested) statuses.push(nested);
    }
  }

  return statuses;
}

function firstBlockingStatus(data: unknown): BlockingStaleStatus | undefined {
  for (const status of collectStaleStatuses(data)) {
    if (isBlockingStaleStatus(status)) return status;
  }
  return undefined;
}

function stripStaleness<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

  const obj = { ...(data as Record<string, unknown>) };
  delete obj.staleness;

  if (Array.isArray(obj.per_repo)) {
    obj.per_repo = obj.per_repo.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const { staleness: _removed, ...rest } = entry as Record<string, unknown>;
      return rest;
    });
  }

  return obj as T;
}

export function applyStalePolicy<T>(
  data: T,
  policy: StalePolicy,
): {
  result: T;
  staleViolation: boolean;
  blockingStatus?: BlockingStaleStatus;
} {
  const blockingStatus = firstBlockingStatus(data);

  if (policy === 'ignore') {
    return { result: stripStaleness(data), staleViolation: false };
  }

  return {
    result: data,
    staleViolation: policy === 'error' && blockingStatus !== undefined,
    blockingStatus,
  };
}
