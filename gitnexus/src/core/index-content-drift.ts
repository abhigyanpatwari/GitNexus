/**
 * Does the index still reflect the files it actually covers?
 *
 * `status` used to answer this with a repo-wide `git status --porcelain`
 * boolean, which says something different: whether the working tree differs
 * from HEAD. Those two questions diverge in both directions. A scratch file,
 * a build artifact, or a tracked file under a tool directory the indexer
 * never reads makes the tree dirty while every indexed file is byte-current —
 * and because `analyze` cannot commit or delete that file, the resulting
 * "stale (re-run gitnexus analyze)" verdict was unclearable (#3077). It also
 * misses the reverse case: reverting a file that was indexed while dirty
 * leaves a clean tree over an index holding the pre-revert content.
 *
 * `meta.fileHashes` already records the exact set of files the last run
 * covered, so the question can be answered directly. This module recomputes
 * the coverage set with the same `walkRepositoryPaths` scan (ignore rules and
 * dotfile handling stay shared) and the large-file cap recorded in
 * `meta.indexCoverage`, hashes only the paths that can actually have changed
 * since that run, and diffs against what was recorded.
 */

import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { walkRepositoryPaths } from './ingestion/filesystem-walker.js';
import { computeFileHashesDetailed } from '../storage/file-hash.js';
import { listWorkingTreeDirtyPaths } from '../storage/git.js';
import { isGitNexusManagedPath } from '../storage/gitnexus-managed-paths.js';
import { chunk } from '../lib/utils.js';
import { logger } from './logger.js';
import type { RepoMeta } from '../storage/repo-meta.js';

/** Why the recorded coverage set could not be compared against disk at all. */
export type IndexContentUnmeasurableReason =
  /** Metadata predates per-file hashes, or the run recorded none (non-git). */
  | 'no-file-hashes'
  /** The repository scan or hashing pass threw. */
  | 'scan-failed';

/**
 * A three-way verdict. `'unmeasurable'` is kept apart from `'current'` on
 * purpose: it means the comparison never ran, which is not evidence the index
 * is fresh. Legacy metadata without hashes still falls back to the working-tree
 * check; a failed scan must not.
 */
export type IndexContentDrift =
  | { kind: 'current'; coveredFileCount: number }
  | { kind: 'drifted'; changed: string[]; added: string[]; deleted: string[] }
  | { kind: 'unmeasurable'; reason: IndexContentUnmeasurableReason };

export type IndexCoveragePolicy = NonNullable<RepoMeta['indexCoverage']>;

const HASH_BATCH = 100;

const collectUnreadablePaths = async (
  repoPath: string,
  relPaths: readonly string[],
): Promise<string[]> => {
  const unreadable: string[] = [];
  for (const batch of chunk(relPaths, HASH_BATCH)) {
    await Promise.all(
      batch.map(async (rel) => {
        try {
          await access(path.join(repoPath, rel), fsConstants.R_OK);
        } catch {
          unreadable.push(rel);
        }
      }),
    );
  }
  unreadable.sort();
  return unreadable;
};

/**
 * Compare the files recorded in `fileHashes` against the current working tree.
 *
 * `added` covers files the index would pick up but has never seen, so a new
 * source file still reports stale — the index is genuinely incomplete then,
 * and comparing only the recorded entries would wave that through.
 */
export const detectIndexContentDrift = async (
  repoPath: string,
  fileHashes: Readonly<Record<string, string>> | undefined,
  coverage?: IndexCoveragePolicy,
): Promise<IndexContentDrift> => {
  if (!fileHashes || Object.keys(fileHashes).length === 0) {
    return { kind: 'unmeasurable', reason: 'no-file-hashes' };
  }

  // Excluded from BOTH sides, or GitNexus's own output guarantees a mismatch:
  // analyze rewrites AGENTS.md/CLAUDE.md after recording hashes, so they read
  // as `added` on a first run and `changed` on every run after that — a fresh
  // index would report itself stale forever.
  const recorded = Object.fromEntries(
    Object.entries(fileHashes).filter(([rel]) => !isGitNexusManagedPath(rel)),
  );
  if (Object.keys(recorded).length === 0) {
    return { kind: 'unmeasurable', reason: 'no-file-hashes' };
  }

  try {
    const scanned = await walkRepositoryPaths(repoPath, undefined, {
      quiet: true,
      maxFileSizeBytes: coverage?.maxFileSizeBytes,
    });
    const scannedPaths = scanned.map((file) => file.path).filter((p) => !isGitNexusManagedPath(p));
    const scannedSet = new Set(scannedPaths);
    const recordedSet = new Set(Object.keys(recorded));

    const added = scannedPaths.filter((p) => !recordedSet.has(p)).sort();
    const deleted = [...recordedSet].filter((p) => !scannedSet.has(p)).sort();
    const intersection = scannedPaths.filter((p) => recordedSet.has(p));

    const dirtyNow = listWorkingTreeDirtyPaths(repoPath);
    const dirtyAtIndex = coverage?.dirtyPaths;
    const dirtyNowSet = dirtyNow === null ? null : new Set(dirtyNow);
    const dirtyAtIndexSet = dirtyAtIndex === undefined ? undefined : new Set(dirtyAtIndex);
    const hashCandidates =
      dirtyNowSet === null || dirtyAtIndexSet === undefined
        ? intersection
        : intersection.filter((p) => dirtyAtIndexSet.has(p) || dirtyNowSet.has(p));

    const hashCandidateSet = new Set(hashCandidates);
    const skipHash = intersection.filter((p) => !hashCandidateSet.has(p));
    const unreadableFromAccess = await collectUnreadablePaths(repoPath, skipHash);
    const unreadableSet = new Set(unreadableFromAccess);
    const { hashes: hashed, unreadable: unreadableFromHash } = await computeFileHashesDetailed(
      repoPath,
      hashCandidates,
    );
    for (const p of unreadableFromHash) unreadableSet.add(p);
    const changed: string[] = [];
    for (const p of intersection) {
      if (unreadableSet.has(p)) {
        changed.push(p);
        continue;
      }
      const currentHash = hashed.get(p) ?? recorded[p];
      if (currentHash !== recorded[p]) changed.push(p);
    }
    changed.sort();

    if (changed.length === 0 && added.length === 0 && deleted.length === 0) {
      return { kind: 'current', coveredFileCount: scannedPaths.length };
    }
    return { kind: 'drifted', changed, added, deleted };
  } catch (err) {
    logger.warn({ err, repoPath }, 'index content drift scan failed');
    return { kind: 'unmeasurable', reason: 'scan-failed' };
  }
};
