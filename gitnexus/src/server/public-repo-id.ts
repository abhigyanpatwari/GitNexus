/**
 * Opaque repo handle for unauthenticated payloads.
 *
 * Public job views and SSE terminal frames must not carry the analyzed path,
 * and a registry name is not unique (see `repo-manager.ts`). An HMAC of the
 * canonical registry path under a per-process random key is unique per entry,
 * reveals nothing about the path, and matches the `id` on `GET /api/repos`
 * entries, so a client can select the exact entry a job just analyzed.
 *
 * Stable only for the lifetime of this server process: resolve it right after
 * the job finishes, never persist it.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { canonicalizePath, registryPathEquals } from '../storage/repo-manager.js';

const KEY = randomBytes(32);

export const publicRepoId = (repoPath: string): string => {
  const canonical = canonicalizePath(repoPath);
  // Same equality the registry uses: case-insensitive on Windows only.
  const key = registryPathEquals('A', 'a') ? canonical.toLowerCase() : canonical;
  return createHmac('sha256', KEY).update(key).digest('base64url').slice(0, 22);
};
