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
import type { StalenessInfo } from '../core/git-staleness.js';
import type { RegistryEntry } from '../storage/repo-manager.js';
import type { RepoMeta } from '../storage/repo-meta.js';

/**
 * Staleness in the shape MCP `list_repos` already returns
 * (`mcp/local/local-backend.ts`): the key is present only when the index is
 * actually behind, so "fresh" stays the absence of a field rather than a second
 * thing for a client to interpret. Deliberately identical across the two
 * surfaces — the same fact should not have two shapes.
 *
 * `checkStalenessAsync` self-catches and reports 0 commits behind when the
 * commit cannot be resolved, so an unanswerable check degrades to "not stale"
 * rather than failing the request that carries it.
 *
 * That makes the field meaningful mainly for `path`-registered repositories,
 * where an operator commits into the working tree the index was built from.
 * A `url` repository is cloned `--depth 1` and is re-analyzed by the same run
 * that pulls it, so its recorded commit is HEAD; and were the two ever to
 * diverge, `git rev-list <old>..HEAD` cannot walk a shallow history and fails
 * closed to "not stale". Reporting fresh there is not a claim that the remote
 * has not moved — this measures the index against the local working tree, the
 * same thing `gitnexus status` and MCP `list_repos` measure.
 */
export const stalenessField = (
  info: StalenessInfo,
): { staleness?: { commitsBehind: number; hint?: string } } =>
  info.isStale ? { staleness: { commitsBehind: info.commitsBehind, hint: info.hint } } : {};

/** One entry of `GET /api/repos`. */
export const projectRepoListEntry = (entry: RegistryEntry, staleness: StalenessInfo) => ({
  name: entry.name,
  path: entry.path,
  repoPath: entry.path,
  indexedAt: entry.indexedAt,
  lastCommit: entry.lastCommit,
  stats: entry.stats,
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
) => ({
  name: entry.name,
  repoPath: entry.path,
  indexedAt: meta?.indexedAt ?? entry.indexedAt,
  stats: meta?.stats ?? entry.stats ?? {},
  lastCommit: meta?.lastCommit ?? entry.lastCommit,
  branch: meta?.branch ?? entry.branch,
  ...stalenessField(staleness),
});

/** The commit a `/api/repo` staleness check should be measured against. */
export const resolveLastCommit = (
  entry: RegistryEntry,
  meta: RepoMeta | null | undefined,
): string => meta?.lastCommit ?? entry.lastCommit;
