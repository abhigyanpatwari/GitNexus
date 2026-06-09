/**
 * POST /api/analyze/upload — analyze a browser folder upload.
 *
 * Securely ingests the multipart upload into a sandbox (upload-ingest.ts),
 * promotes it to a persistent app-controlled directory, and analyzes it via
 * the same job/worker machinery as a git clone — never returning a server
 * path to the client. Factored as a dependency-injected handler so the job
 * machinery (createJob + the worker launcher) can be mocked in unit tests.
 */

import path from 'path';
import fsp from 'fs/promises';
import type { Request, Response } from 'express';
import type { IncomingMessage } from 'http';
import { ingestUpload } from './upload-ingest.js';
import { UPLOAD_ROOT, getUploadDir, deriveUploadName } from './upload-paths.js';
import { BadRequestError } from './validation.js';

export interface UploadJobRef {
  id: string;
  status: string;
}

export interface AnalyzeUploadDeps {
  /** Create (or throw on busy) an analysis job for the given upload dir. */
  createJob: (params: { repoPath: string }) => UploadJobRef;
  /** Launch the analyze worker against an already-resolved repo directory. */
  launch: (job: UploadJobRef, targetPath: string, opts: { registryName: string }) => void;
  /** Injectable for tests (defaults to the real ingestUpload). */
  ingest?: typeof ingestUpload;
}

/**
 * Find an available upload directory name, appending `-2`, `-3`, … on
 * collision with an existing upload. Bounded to avoid an unbounded scan.
 */
async function pickAvailableName(base: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    let dir: string;
    try {
      dir = getUploadDir(name);
    } catch {
      continue;
    }
    try {
      await fsp.access(dir);
      // exists → try the next suffix
    } catch {
      return name; // ENOENT → available
    }
  }
  throw new BadRequestError('Could not allocate an upload directory', 409);
}

export function createAnalyzeUploadHandler(deps: AnalyzeUploadDeps) {
  const ingest = deps.ingest ?? ingestUpload;

  return async function handleAnalyzeUploadRequest(req: Request, res: Response): Promise<void> {
    let stageRoot: string | undefined;
    let promotedDir: string | undefined;
    let launched = false;
    try {
      const result = await ingest(req as unknown as IncomingMessage);
      stageRoot = result.stageRoot;

      const baseName = deriveUploadName(result.topLevelName);
      if (!baseName) {
        throw new BadRequestError('Uploaded folder has no usable name');
      }
      const finalName = await pickAvailableName(baseName);
      const finalDir = getUploadDir(finalName);

      // createJob BEFORE promote: a busy server throws → 409 and nothing has
      // been moved into place yet, so the staging dir is the only thing to clean.
      let job: UploadJobRef;
      try {
        job = deps.createJob({ repoPath: finalDir });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('already in progress')) {
          throw new BadRequestError(msg, 409);
        }
        throw err;
      }

      // webkitRelativePath prefixes every entry with the picked folder, so the
      // real repo root is stageRoot/<topLevelName>. Promote that inner dir.
      const innerRoot = path.join(result.stageRoot, result.topLevelName);
      try {
        if (!(await fsp.stat(innerRoot)).isDirectory()) {
          throw new BadRequestError('Upload must be a folder');
        }
      } catch (err) {
        if (err instanceof BadRequestError) throw err;
        throw new BadRequestError('Upload must be a folder');
      }

      // Promote staging → persistent upload dir. Both live under UPLOAD_ROOT's
      // filesystem, so this rename stays atomic (no EXDEV).
      await fsp.mkdir(UPLOAD_ROOT, { recursive: true });
      await fsp.rename(innerRoot, finalDir);
      promotedDir = finalDir;
      const oldStage = stageRoot;
      stageRoot = undefined;
      await fsp.rm(oldStage, { recursive: true, force: true }).catch(() => {});

      // Drop any crafted index the upload may have carried (a `.gitnexus`
      // segment passes containment); the worker will build a fresh one.
      await fsp
        .rm(path.join(finalDir, '.gitnexus'), { recursive: true, force: true })
        .catch(() => {});

      deps.launch(job, finalDir, { registryName: finalName });
      launched = true;

      res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err) {
      if (stageRoot) {
        await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      }
      if (promotedDir && !launched) {
        await fsp.rm(promotedDir, { recursive: true, force: true }).catch(() => {});
      }
      if (err instanceof BadRequestError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'Upload failed' });
    }
  };
}

/**
 * Per-route guard that restricts an endpoint to localhost browser origins.
 * Non-browser requests (no Origin header, e.g. curl) pass through. This closes
 * cross-origin reach (e.g. the allow-listed public deploy + Private Network
 * Access) to write routes without affecting read routes.
 */
export function requireLocalhostOrigin(req: Request, res: Response, next: () => void): void {
  const origin = req.headers.origin;
  if (origin === undefined) {
    next();
    return;
  }
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      next();
      return;
    }
  } catch {
    /* malformed origin → reject */
  }
  res.status(403).json({ error: 'This endpoint is restricted to localhost origins' });
}
