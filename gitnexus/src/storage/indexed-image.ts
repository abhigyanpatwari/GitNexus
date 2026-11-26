/**
 * Which side of a diff does the index hold for each modified file? (#4136)
 *
 * `detect_changes` maps hunks onto indexed symbols by line. The documented
 * pre-commit flow is analyze, edit, then `detect_changes`, so the graph still
 * holds the PRE-image of an edited file, while a branch review against an
 * older base runs on an index of the POST-image. Mapping the wrong side lands
 * every hunk after an inserted or removed line on the wrong symbol and never
 * reports a deleted function.
 *
 * `meta.fileHashes` records the SHA-256 of the exact bytes `analyze` read, so
 * the side is checked rather than assumed: hash the diff's new side, then its
 * old side, and compare each with the recorded hash.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { computeFileHash } from './file-hash.js';
import type { DiffHunk, FileDiff, FileDiffPreImage } from './git.js';
import { loadMeta } from './repo-meta.js';
import { metadataMatchesGraph } from './vector-generation.js';

const NULL_BLOB = /^0+$/;

/**
 * The bytes a checkout of `blob` at `filePath` writes (smudge and EOL filters
 * applied, as `analyze` read them from disk), hashed. `null` when git cannot
 * produce them.
 */
function hashCheckedOutBlob(cwd: string, blob: string, filePath: string): string | null {
  try {
    const bytes = execFileSync('git', ['cat-file', '--filters', `--path=${filePath}`, blob], {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

/**
 * The modified files whose indexed content is their diff's OLD side, each with
 * its old-side hunks.
 *
 * A file is listed only when the recorded hash matches the old side and not
 * the new one, so an index of the post-image, an unknown image, or a missing
 * hash keeps the post-image mapping `detect_changes` has always used. Deleted
 * files already map with their old side and are not considered.
 *
 * `scope` is the `detect_changes` scope: for `staged` the new side is the
 * index blob, for every other scope it is the working-tree file in `cwd`.
 */
export async function filesIndexedAsPreImage(
  cwd: string,
  scope: string,
  fileHashes: Readonly<Record<string, string>>,
  files: readonly FileDiff[],
  preImages: ReadonlyMap<FileDiff, FileDiffPreImage>,
): Promise<Map<FileDiff, DiffHunk[]>> {
  const result = new Map<FileDiff, DiffHunk[]>();
  for (const file of files) {
    const preImage = preImages.get(file);
    if (!preImage?.oldBlob || !preImage.newBlob || file.hunks.length === 0) continue;
    if (NULL_BLOB.test(preImage.oldBlob) || NULL_BLOB.test(preImage.newBlob)) continue;
    const oldPath = file.oldFilePath ?? file.filePath;
    const indexedOld = fileHashes[oldPath];
    if (indexedOld === undefined) continue;

    const indexedNew = fileHashes[file.filePath];
    if (indexedNew !== undefined) {
      const newHash =
        scope === 'staged'
          ? hashCheckedOutBlob(cwd, preImage.newBlob, file.filePath)
          : await computeFileHash(path.join(cwd, file.filePath));
      if (newHash === indexedNew) continue;
    }
    if (hashCheckedOutBlob(cwd, preImage.oldBlob, oldPath) === indexedOld) {
      result.set(file, preImage.hunks);
    }
  }
  return result;
}

/**
 * The per-file hashes recorded for the graph at `lbugPath`, or `undefined` when
 * there are none or they belong to a different graph generation.
 */
export async function loadIndexedFileHashes(
  lbugPath: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  const metaDir = path.dirname(lbugPath);
  let meta: Awaited<ReturnType<typeof loadMeta>>;
  try {
    meta = await loadMeta(metaDir);
  } catch {
    return undefined;
  }
  if (!meta?.fileHashes) return undefined;
  if (
    (meta.graphPath !== undefined || meta.graphGeneration) &&
    !metadataMatchesGraph(metaDir, meta, lbugPath)
  ) {
    return undefined;
  }
  return meta.fileHashes;
}
