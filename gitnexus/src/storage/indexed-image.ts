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

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { promisify } from 'util';
import { mapConcurrent } from '../lib/utils.js';
import { computeFileHash } from './file-hash.js';
import type { DiffHunk, FileDiff, FileDiffPreImage } from './git.js';
import { loadMeta } from './repo-meta.js';
import { metadataMatchesGraph } from './vector-generation.js';

const execFileAsync = promisify(execFile);
const NULL_BLOB = /^0+$/;
/** Hash checks in flight at once: each is a file read or one `git` process. */
const HASH_CONCURRENCY = 8;

/**
 * The bytes a checkout of `blob` at `filePath` writes (smudge and EOL filters
 * applied, as `analyze` read them from disk), hashed. `null` when git cannot
 * produce them.
 */
async function hashCheckedOutBlob(
  cwd: string,
  blob: string,
  filePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['cat-file', '--filters', `--path=${filePath}`, blob],
      { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 30_000, windowsHide: true },
    );
    return createHash('sha256').update(stdout).digest('hex');
  } catch {
    return null;
  }
}

/** Which side of its diff the index holds for each modified, indexed file. */
export interface IndexedImages {
  /** Files indexed as their diff's OLD side, with their old-side hunks. */
  preImage: Map<FileDiff, DiffHunk[]>;
  /**
   * Indexed files whose recorded hash matches neither side (a third revision,
   * a branch switch without re-analyzing) or could not be checked. Neither
   * side's ranges fit their graph rows, so no verdict on them can be trusted.
   */
  neither: FileDiff[];
}

/**
 * Compare each modified file's recorded hash with its diff's new side, then its
 * old side. A post-image match keeps the post-image mapping `detect_changes`
 * has always used, as does a file with no recorded hash. Added and deleted
 * files are not considered: deleted files already map with their old side.
 *
 * `scope` is the `detect_changes` scope: for `staged` the new side is the
 * index blob, for every other scope it is the working-tree file in `cwd`.
 */
export async function classifyIndexedImages(
  cwd: string,
  scope: string,
  fileHashes: Readonly<Record<string, string>>,
  files: readonly FileDiff[],
  preImages: ReadonlyMap<FileDiff, FileDiffPreImage>,
): Promise<IndexedImages> {
  const result: IndexedImages = { preImage: new Map(), neither: [] };
  const candidates: { file: FileDiff; hunks: DiffHunk[]; oldBlob: string; newBlob: string }[] = [];
  for (const file of files) {
    const { hunks, oldBlob, newBlob } = preImages.get(file) ?? {};
    if (!hunks || !oldBlob || !newBlob || file.hunks.length === 0) continue;
    if (NULL_BLOB.test(oldBlob) || NULL_BLOB.test(newBlob)) continue;
    const oldPath = file.oldFilePath ?? file.filePath;
    if (fileHashes[file.filePath] === undefined && fileHashes[oldPath] === undefined) continue;
    candidates.push({ file, hunks, oldBlob, newBlob });
  }

  const sides = await mapConcurrent(
    candidates,
    async ({ file, oldBlob, newBlob }): Promise<'post' | 'pre' | 'neither'> => {
      const indexedNew = fileHashes[file.filePath];
      if (indexedNew !== undefined) {
        const newHash =
          scope === 'staged'
            ? await hashCheckedOutBlob(cwd, newBlob, file.filePath)
            : await computeFileHash(path.join(cwd, file.filePath));
        if (newHash === indexedNew) return 'post';
      }
      const oldPath = file.oldFilePath ?? file.filePath;
      const indexedOld = fileHashes[oldPath];
      if (
        indexedOld !== undefined &&
        (await hashCheckedOutBlob(cwd, oldBlob, oldPath)) === indexedOld
      ) {
        return 'pre';
      }
      return 'neither';
    },
    { concurrency: HASH_CONCURRENCY },
  );

  candidates.forEach(({ file, hunks }, i) => {
    const side = sides[i] ?? 'neither';
    if (side === 'pre') result.preImage.set(file, hunks);
    else if (side === 'neither') result.neither.push(file);
  });
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
