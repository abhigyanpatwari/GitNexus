/**
 * Response projections for the `serve` repo routes.
 *
 * Extracted from the route bodies so the field list is assertable. Inline, the
 * projections were only reachable by booting a server and indexing a real
 * repository, which is how `branch` came to sit on `RegistryEntry` unexposed
 * over HTTP while `gitnexus list` printed it, with no test to notice (#3226).
 *
 * These are pure: the caller resolves the registry entry, the on-disk metadata
 * and the staleness check, and passes the results in.
 */
import {
  stalenessPayload,
  type StalenessInfo,
  type StalenessPayload,
} from '../core/staleness-status.js';
import type { ContentRetention, RepoMeta } from '../storage/repo-meta.js';
import type { RegistryEntry } from '../storage/repo-manager.js';

/** Retention + checkout facts computed by the route (see getSourceAvailability). */
export interface RepoProjectionSource {
  contentRetention: ContentRetention;
  sourceAvailable: boolean;
}

/**
 * Staleness through the shared {@link stalenessPayload} builder, so this route
 * and MCP `list_repos` emit one shape for one fact (#3232 review, #3256).
 *
 * Absent when the index is current. Otherwise `staleness.status` says what git
 * could establish: `behind` with the counted `commitsBehind`; `diverged` when
 * HEAD has provably moved off the indexed commit but the history needed to
 * count the gap is gone — the state a branch-pinned `url` clone reaches once
 * git prunes the commit a failed re-index left behind; or `unknown` when the
 * repository could not be measured at all. This is a listing a monitor reads,
 * so `unknown` is included here, unlike on the hot read tools.
 *
 * All of it measures the index against the local working tree — the same thing
 * `gitnexus status` and MCP `list_repos` measure — not against the remote.
 */
export const stalenessField = (info: StalenessInfo): { staleness?: StalenessPayload } => {
  const staleness = stalenessPayload(info, { includeUnknown: true });
  return staleness ? { staleness } : {};
};

/** One entry of `GET /api/repos`. */
export const projectRepoListEntry = (
  entry: RegistryEntry,
  staleness: StalenessInfo,
  source: RepoProjectionSource,
) => ({
  name: entry.name,
  path: entry.path,
  repoPath: entry.path,
  storagePath: entry.storagePath,
  indexedAt: entry.indexedAt,
  lastCommit: entry.lastCommit,
  stats: entry.stats,
  contentRetention: source.contentRetention,
  sourceAvailable: source.sourceAvailable,
  // The registry has carried these since #2106; #3199 made them load-bearing
  // over HTTP, because a branch-pinned analyze now gets its own entry and the
  // only other way to tell two entries apart is to parse the clone-directory
  // slug — a layout detail, not an API contract.
  branch: entry.branch,
  branches: entry.branches,
  ...stalenessField(staleness),
});

/**
 * `GET /api/repo`. `meta ?? entry` throughout, for the reason `indexedAt`
 * already did it: the on-disk metadata is the fresher record when the two
 * disagree, and the entry is the fallback for a repo whose meta cannot be read.
 */
export const projectRepoDetail = (
  entry: RegistryEntry,
  meta: RepoMeta | null | undefined,
  staleness: StalenessInfo,
  source: RepoProjectionSource,
) => ({
  name: entry.name,
  repoPath: entry.path,
  storagePath: entry.storagePath,
  indexedAt: meta?.indexedAt ?? entry.indexedAt,
  stats: meta?.stats ?? entry.stats ?? {},
  lastCommit: meta?.lastCommit ?? entry.lastCommit,
  branch: meta?.branch ?? entry.branch,
  contentRetention: source.contentRetention,
  sourceAvailable: source.sourceAvailable,
  ...stalenessField(staleness),
});

/** The commit a `/api/repo` staleness check should be measured against. */
export const resolveLastCommit = (
  entry: RegistryEntry,
  meta: RepoMeta | null | undefined,
): string => meta?.lastCommit ?? entry.lastCommit;
