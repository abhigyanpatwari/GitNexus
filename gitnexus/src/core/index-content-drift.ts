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
 * the coverage set the same way `analyze` does — the shared
 * `walkRepositoryPaths` scan, so ignore rules, dotfile handling, and the
 * large-file cap cannot drift apart — hashes it with the same helpers, and
 * diffs it against what was recorded. `status` and `analyze` therefore agree
 * on what "changed" means by construction rather than by convention.
 */

import { walkRepositoryPaths } from './ingestion/filesystem-walker.js';
import { computeFileHashes, diffFileHashes } from '../storage/file-hash.js';
import { isGitNexusManagedPath } from '../storage/gitnexus-managed-paths.js';

/** Why the recorded coverage set could not be compared against disk at all. */
export type IndexContentUnmeasurableReason =
  /** Metadata predates per-file hashes, or the run recorded none (non-git). */
  | 'no-file-hashes'
  /** The repository scan or hashing pass threw. */
  | 'scan-failed';

/**
 * A three-way verdict. `'unmeasurable'` is kept apart from `'current'` on
 * purpose: it means the comparison never ran, which is not evidence the index
 * is fresh, and the caller falls back to the conservative working-tree check
 * rather than certifying an index nobody inspected.
 */
export type IndexContentDrift =
  | { kind: 'current'; coveredFileCount: number }
  | { kind: 'drifted'; changed: string[]; added: string[]; deleted: string[] }
  | { kind: 'unmeasurable'; reason: IndexContentUnmeasurableReason };

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
    const scanned = await walkRepositoryPaths(repoPath, undefined, { quiet: true });
    const currentHashes = await computeFileHashes(
      repoPath,
      scanned.map((file) => file.path).filter((rel) => !isGitNexusManagedPath(rel)),
    );
    const diff = diffFileHashes(currentHashes, recorded);
    if (diff.changed.length === 0 && diff.added.length === 0 && diff.deleted.length === 0) {
      return { kind: 'current', coveredFileCount: currentHashes.size };
    }
    return { kind: 'drifted', changed: diff.changed, added: diff.added, deleted: diff.deleted };
  } catch {
    // A scan that throws has measured nothing. Reporting it as clean would
    // manufacture exactly the false certainty this check exists to remove.
    return { kind: 'unmeasurable', reason: 'scan-failed' };
  }
};
