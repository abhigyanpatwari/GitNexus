/**
 * Which side of a diff does the graph hold for each modified file?
 *
 * `detect_changes` overlaps diff hunks with the `startLine`/`endLine` the graph
 * recorded for each symbol, and those come from the bytes `analyze` read. In
 * the documented pre-commit flow (analyze, edit, detect_changes) that is the
 * PRE-image, while the `+` side of `@@ -a,b +c,d @@` is the post-image: once an
 * edit adds or removes lines, every later hunk lands on the wrong symbols, and
 * a deleted function is never reported at all.
 *
 * `meta.fileHashes` records the SHA-256 of the exact bytes `analyze` indexed per
 * file, so the question has a checkable answer: hash each side and compare. A
 * work-tree side is the file on disk. A blob side matches if either its stored
 * bytes or its checked-out bytes (`git cat-file --filters`: smudge and EOL
 * conversion, so `core.autocrlf` and filter drivers reproduce what `analyze`
 * read) hash to the recorded value. Either way the indexed text has that
 * side's line structure, which is all the hunk mapping needs.
 */

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { mapConcurrent } from '../lib/utils.js';
import { computeFileHash } from './file-hash.js';
import type { FileDiff } from './git.js';

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
/** Concurrent `git cat-file --filters` processes for blobs whose raw bytes missed. */
const FILTERED_READ_CONCURRENCY = 8;
/** Largest checked-out blob read back for hashing. */
const FILTERED_READ_MAX_BYTES = 256 * 1024 * 1024;

/** `pre` / `post`: the indexed bytes are that side. `neither`: no side matched. */
export type IndexedDiffImage = 'pre' | 'post' | 'neither';

const isNullOid = (oid: string | undefined): oid is undefined =>
  oid === undefined || /^0+$/.test(oid);

/**
 * Classify every modified file whose indexed hash is known.
 *
 * Files with no hunks, no {@link FileDiff.preImage} (the diff was parsed
 * without it) or no recorded hash (not indexed, or a legacy index) are left
 * out: the caller keeps its existing post-image mapping for them.
 *
 * @param cwd   directory the diff ran in (any directory inside the work tree)
 * @param scope `detect_changes` scope; only `staged` has a blob post-image —
 *              every other scope diffs against the work tree.
 */
export async function matchIndexedDiffImages(params: {
  cwd: string;
  scope: string;
  files: readonly FileDiff[];
  fileHashes: Readonly<Record<string, string>>;
}): Promise<Map<FileDiff, IndexedDiffImage>> {
  const { cwd, scope, files, fileHashes } = params;
  const result = new Map<FileDiff, IndexedDiffImage>();
  const candidates = files.flatMap((file) => {
    if (!file.preImage || file.hunks.length === 0) return [];
    const recorded =
      fileHashes[file.filePath] ??
      (file.oldFilePath !== undefined ? fileHashes[file.oldFilePath] : undefined);
    return recorded === undefined ? [] : [{ file, preImage: file.preImage, recorded }];
  });
  if (candidates.length === 0) return result;

  const blobPost = scope === 'staged';
  const rawOids = new Set<string>();
  for (const { preImage } of candidates) {
    const { oldBlob, newBlob } = preImage;
    if (!isNullOid(oldBlob)) rawOids.add(oldBlob);
    if (blobPost && !isNullOid(newBlob)) rawOids.add(newBlob);
  }
  const [rawHashes, workTree] = await Promise.all([
    hashRawBlobs(cwd, [...rawOids]),
    blobPost ? Promise.resolve(undefined) : workTreeRoot(cwd),
  ]);

  const blobMatches = async (
    oid: string | undefined,
    filePath: string,
    recorded: string,
  ): Promise<boolean> => {
    if (isNullOid(oid)) return false;
    if (rawHashes.get(oid) === recorded) return true;
    return (await hashFilteredBlob(cwd, oid, filePath)) === recorded;
  };

  await mapConcurrent(
    candidates,
    async ({ file, preImage, recorded }) => {
      const { oldBlob, newBlob } = preImage;
      const postMatches = blobPost
        ? await blobMatches(newBlob, file.filePath, recorded)
        : workTree !== undefined &&
          (await computeFileHash(path.join(workTree, file.filePath))) === recorded;
      if (postMatches) {
        result.set(file, 'post');
        return;
      }
      const preMatches = await blobMatches(oldBlob, file.oldFilePath ?? file.filePath, recorded);
      result.set(file, preMatches ? 'pre' : 'neither');
    },
    { concurrency: FILTERED_READ_CONCURRENCY },
  );
  // A candidate whose check threw was never classified: fail closed.
  for (const { file } of candidates) if (!result.has(file)) result.set(file, 'neither');
  return result;
}

/** Top of the work tree: diff paths are relative to it, not to `cwd`. */
async function workTreeRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const top = stdout.trim();
    return top.length > 0 ? top : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SHA-256 of a blob as checked out at `filePath`, or `undefined` when git
 * cannot produce it.
 *
 * One process per blob on purpose: `cat-file --batch --filters` prints the
 * UNFILTERED size in its header while streaming the filtered bytes (observed
 * with `core.autocrlf=true`: `blob 4` followed by six CRLF bytes), so the
 * batch output cannot be split reliably once a filter changes the length.
 */
async function hashFilteredBlob(
  cwd: string,
  oid: string,
  filePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['cat-file', '--filters', `--path=${filePath}`, oid], {
      cwd,
      encoding: 'buffer',
      maxBuffer: FILTERED_READ_MAX_BYTES,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return createHash('sha256').update(stdout).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * SHA-256 of each blob's stored bytes, keyed by object id.
 *
 * One `git cat-file --batch` process for the whole list (no filters, so the
 * header size is exact), hashed as the output streams so a wide diff never
 * buffers every file at once. An object git cannot produce, or a failed
 * process, simply has no entry.
 */
export function hashRawBlobs(cwd: string, oids: readonly string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (oids.length === 0) return Promise.resolve(hashes);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(hashes);
    };
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn('git', ['cat-file', '--batch'], {
        cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      finish();
      return;
    }

    // Output per request: `<oid> <type> <size>\n<bytes>\n`, or one line such
    // as `<oid> missing\n`. Output order follows input order.
    let next = 0;
    let pending: Buffer = Buffer.alloc(0);
    let state: 'header' | 'body' | 'terminator' = 'header';
    let remaining = 0;
    let isBlob = false;
    let hash = createHash('sha256');
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      while (next < oids.length) {
        if (state === 'header') {
          const nl = pending.indexOf(0x0a);
          if (nl === -1) break;
          const header = pending.subarray(0, nl).toString('utf8');
          pending = pending.subarray(nl + 1);
          // Any object with a size carries a body; only a blob is a file image.
          const object = /^[0-9a-f]+ ([a-z]+) (\d+)$/.exec(header);
          if (!object) {
            next++;
            continue;
          }
          isBlob = object[1] === 'blob';
          remaining = Number(object[2]);
          hash = createHash('sha256');
          state = 'body';
        } else if (state === 'body') {
          const take = Math.min(remaining, pending.length);
          hash.update(pending.subarray(0, take));
          pending = pending.subarray(take);
          remaining -= take;
          if (remaining > 0) break;
          state = 'terminator';
        } else {
          if (pending.length === 0) break;
          pending = pending.subarray(1);
          const digest = hash.digest('hex');
          if (isBlob) hashes.set(oids[next], digest);
          next++;
          state = 'header';
        }
      }
    });
    child.on('error', finish);
    child.on('close', finish);
    child.stdin.on('error', () => {
      // The process exited early; whatever was hashed so far stands.
    });
    child.stdin.end(oids.map((oid) => `${oid}\n`).join(''));
  });
}
