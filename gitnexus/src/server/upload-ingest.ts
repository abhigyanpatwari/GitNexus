/**
 * Secure ingestion of a browser folder upload (multipart/form-data).
 *
 * Replaces the path-injection-prone GET /api/fs/list directory listing. The
 * client streams the selected files plus a JSON `manifest` of their
 * webkitRelativePaths; we write each into an mkdtemp staging dir under
 * UPLOAD_ROOT with PROVABLE containment (resolve-then-contain), hard resource
 * caps, and guaranteed cleanup on every failure/abort path. No client value
 * ever reaches a filesystem READ — the server only writes into a sandbox it
 * created, then hands that sandbox to the analysis pipeline.
 *
 * Security references: CodeQL js/path-injection (resolve + startsWith(root+sep)),
 * OWASP File Upload / Path Traversal.
 */

import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import type { IncomingMessage } from 'http';
import busboy from 'busboy';
import { UPLOAD_ROOT, STAGING_PREFIX } from './upload-paths.js';
import { BadRequestError } from './validation.js';

export interface IngestLimits {
  /** Aggregate bytes across all files (busboy has no aggregate limit). */
  maxTotalBytes: number;
  /** Per-file byte cap. */
  maxFileBytes: number;
  /** Maximum number of files. */
  maxFiles: number;
  /** Maximum multipart parts (files + fields). */
  maxParts: number;
  /** Maximum directories created (inode-exhaustion guard). */
  maxDirs: number;
  /** Maximum size of the manifest field. */
  maxFieldBytes: number;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  maxTotalBytes: 250 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 20000,
  maxParts: 20100,
  maxDirs: 50000,
  maxFieldBytes: 2 * 1024 * 1024,
};

const MAX_PATH_DEPTH = 64;
const MAX_PATH_LENGTH = 4096;

export interface IngestResult {
  /** Absolute path to the populated staging directory (realpath-canonical). */
  stageRoot: string;
  fileCount: number;
  totalBytes: number;
  /** First path segment shared by the uploaded tree (the picked folder). */
  topLevelName: string;
}

/**
 * Resolve a client-provided relative path to an absolute destination PROVABLY
 * contained within `stageRoot`. Throws BadRequestError on any unsafe input.
 * This is the load-bearing path-traversal-on-write control; keep it pure and
 * unit-tested.
 */
export function resolveContainedDest(stageRoot: string, rel: unknown): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new BadRequestError('Invalid upload path');
  }
  if (rel.length > MAX_PATH_LENGTH) {
    throw new BadRequestError('Upload path too long');
  }
  // webkitRelativePath is always relative; a leading slash is absolute/hostile.
  if (rel.startsWith('/')) {
    throw new BadRequestError('Invalid upload path');
  }
  // Browsers emit forward slashes only; a NUL byte or backslash is hostile.
  if (rel.includes('\u0000') || rel.includes('\\')) {
    throw new BadRequestError('Invalid upload path');
  }
  const rawSegments = rel.split('/').filter((s) => s.length > 0);
  if (rawSegments.length === 0 || rawSegments.length > MAX_PATH_DEPTH) {
    throw new BadRequestError('Invalid upload path');
  }
  const segments: string[] = [];
  for (const seg of rawSegments) {
    // Normalize so NFC/NFD variants don't collide silently on case/unicode
    // -folding filesystems (macOS/Windows).
    const s = seg.normalize('NFC');
    if (s === '.' || s === '..') {
      throw new BadRequestError('Upload path must not contain traversal segments');
    }
    segments.push(s);
  }
  const dest = path.resolve(stageRoot, segments.join(path.sep));
  // Suffix path.sep so a sibling prefix (/sandbox-evil vs /sandbox) can't pass.
  if (dest !== stageRoot && !dest.startsWith(stageRoot + path.sep)) {
    throw new BadRequestError('Upload path escapes the sandbox');
  }
  return dest;
}

interface DirState {
  dirCount: number;
  limits: IngestLimits;
}

/**
 * Create the parent directories of `destFile` one segment at a time, asserting
 * after each `mkdir` that the segment is a real directory (not a symlink
 * swapped in mid-stream) still inside `stageRoot`. Counts created dirs against
 * the inode-exhaustion cap.
 */
function mkdirContained(stageRoot: string, destFile: string, state: DirState): void {
  const parent = path.dirname(destFile);
  const relParent = path.relative(stageRoot, parent);
  if (relParent === '' || relParent === '.') return;
  const segs = relParent.split(path.sep).filter(Boolean);
  let cur = stageRoot;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let made = false;
    try {
      fs.mkdirSync(cur);
      made = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = fs.lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new BadRequestError('Upload path escapes the sandbox');
    }
    if (made) {
      state.dirCount++;
      if (state.dirCount > state.limits.maxDirs) {
        throw new BadRequestError('Too many directories in upload', 413);
      }
    }
  }
}

export interface IngestOptions {
  /** Override the staging parent dir (defaults to UPLOAD_ROOT; for tests). */
  root?: string;
}

/**
 * Parse and securely write a multipart folder upload into a fresh staging
 * directory under UPLOAD_ROOT. Resolves with the populated staging dir, or
 * rejects with a BadRequestError (status 400/413) after removing the staging
 * dir. The caller owns promotion + cleanup of the returned `stageRoot`.
 */
export async function ingestUpload(
  req: IncomingMessage,
  limitsOverride?: Partial<IngestLimits>,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const limits = { ...DEFAULT_INGEST_LIMITS, ...limitsOverride };
  const uploadRoot = opts.root ?? UPLOAD_ROOT;
  await fsp.mkdir(uploadRoot, { recursive: true });
  // mkdtemp creates the dir mode 0o700 (owner-only); realpath canonicalizes
  // the root so the containment prefix check is exact.
  const stageRoot = await fsp.realpath(await fsp.mkdtemp(path.join(uploadRoot, STAGING_PREFIX)));

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  };

  return new Promise<IngestResult>((resolve, reject) => {
    let settled = false;
    let manifest: string[] | null = null;
    let fileIndex = 0;
    let fileCount = 0;
    let totalBytes = 0;
    let topLevelName = '';
    const dirState: DirState = { dirCount: 0, limits };
    const writePromises: Promise<void>[] = [];

    const bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: limits.maxFileBytes,
        files: limits.maxFiles,
        parts: limits.maxParts,
        fields: 10,
        fieldNameSize: 200,
        fieldSize: limits.maxFieldBytes,
        headerPairs: 2000,
      },
    });

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      try {
        req.unpipe(bb);
      } catch {
        /* ignore */
      }
      try {
        req.resume(); // drain remaining body so the socket isn't left hanging
      } catch {
        /* ignore */
      }
      void cleanup().finally(() => reject(err));
    };

    bb.on('field', (name: string, val: string) => {
      if (name !== 'manifest') return;
      try {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
          return fail(new BadRequestError('Invalid manifest'));
        }
        manifest = parsed as string[];
      } catch {
        fail(new BadRequestError('Invalid manifest'));
      }
    });

    bb.on('file', (_name: string, stream: NodeJS.ReadableStream, _info: unknown) => {
      if (settled) {
        stream.resume();
        return;
      }
      if (manifest === null) {
        // The manifest field MUST arrive before any file part.
        stream.resume();
        return fail(new BadRequestError('Manifest must precede file parts'));
      }
      const idx = fileIndex++;
      const rel = manifest[idx];
      let dest: string;
      try {
        dest = resolveContainedDest(stageRoot, rel);
        // A folder upload is exactly one top-level directory: every entry must
        // have ≥2 segments and share the same first segment. This rejects a
        // bare file at the root (which would make the promote target a file)
        // and a multi-top manifest (which would silently drop all but the
        // first folder). Validated here, before any job is created.
        const segs = String(rel)
          .split('/')
          .filter((s) => s.length > 0);
        const firstSeg = (segs[0] ?? '').normalize('NFC');
        if (!topLevelName) {
          topLevelName = firstSeg;
        }
        if (segs.length < 2 || firstSeg !== topLevelName) {
          throw new BadRequestError('Upload must be a single folder of files');
        }
        mkdirContained(stageRoot, dest, dirState);
      } catch (err) {
        stream.resume();
        return fail(err as Error);
      }
      fileCount++;
      const ws = fs.createWriteStream(dest, { flags: 'wx' });
      const p = new Promise<void>((res, rej) => {
        stream.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > limits.maxTotalBytes) {
            stream.unpipe(ws);
            ws.destroy();
            rej(new BadRequestError('Upload exceeds total size limit', 413));
          }
        });
        stream.on('limit', () => {
          ws.destroy();
          rej(new BadRequestError('File exceeds size limit', 413));
        });
        stream.on('error', rej);
        ws.on('error', rej);
        ws.on('finish', () => res());
        stream.pipe(ws);
      });
      writePromises.push(p);
      p.catch(fail);
    });

    bb.on('filesLimit', () => fail(new BadRequestError('Too many files in upload', 413)));
    bb.on('partsLimit', () => fail(new BadRequestError('Too many parts in upload', 413)));
    bb.on('fieldsLimit', () => fail(new BadRequestError('Too many fields in upload')));
    bb.on('error', (err: unknown) =>
      fail(err instanceof Error ? err : new BadRequestError('Upload parse error')),
    );

    bb.on('close', () => {
      if (settled) return;
      Promise.all(writePromises)
        .then(() => {
          if (settled) return;
          if (manifest === null) return fail(new BadRequestError('Missing manifest'));
          if (fileCount === 0) return fail(new BadRequestError('Empty upload'));
          if (fileCount !== manifest.length) {
            return fail(new BadRequestError('Manifest/file count mismatch'));
          }
          if (!topLevelName) {
            return fail(new BadRequestError('Could not determine upload folder name'));
          }
          settled = true;
          resolve({ stageRoot, fileCount, totalBytes, topLevelName });
        })
        .catch(() => {
          /* a write rejected → fail() already invoked via p.catch */
        });
    });

    req.on('aborted', () => {
      if (!settled) fail(new BadRequestError('Upload aborted'));
    });
    req.on('error', (err: unknown) =>
      fail(err instanceof Error ? err : new BadRequestError('Request error')),
    );

    req.pipe(bb);
  });
}
