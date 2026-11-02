import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Safely read a file inside a repo, rejecting any path that escapes
 * `repoPath` via `..` traversal or absolute segments. Returns `null` if
 * the path is outside the repo or the file can't be read.
 *
 * Used by every source-scan extractor under this directory. Kept as a
 * single shared implementation so the path-traversal guard (security-
 * sensitive) lives in exactly one place.
 */
export function readSafe(repoPath: string, rel: string): string | null {
  const abs = path.resolve(repoPath, rel);
  const base = path.resolve(repoPath);
  const relToBase = path.relative(base, abs);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) return null;
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

/** Read a regular in-repo file without buffering more than `maxBytes`. */
export async function readSafeBounded(
  repoPath: string,
  rel: string,
  maxBytes: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
  const abs = path.resolve(repoPath, rel);
  const base = path.resolve(repoPath);
  const relToBase = path.relative(base, abs);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) return null;

  try {
    const canonicalBase = await fs.promises.realpath(base);
    const canonicalFile = await fs.promises.realpath(abs);
    const canonicalRelative = path.relative(canonicalBase, canonicalFile);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) return null;
    const beforeOpen = await fs.promises.lstat(canonicalFile);
    if (!beforeOpen.isFile() || beforeOpen.size > maxBytes) return null;
    if (maxBytes === 0) return beforeOpen.size === 0 ? '' : null;

    return await new Promise<string | null>((resolve) => {
      const stream = fs.createReadStream(canonicalFile, {
        flags: 'r',
        start: 0,
        end: maxBytes,
        autoClose: true,
      });
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let validated = false;
      let settled = false;

      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      stream.pause();
      stream.once('open', (fd) => {
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.size > maxBytes) {
            finish(null);
            stream.destroy();
            return;
          }

          const currentCanonical = fs.realpathSync(canonicalFile);
          const currentRelative = path.relative(canonicalBase, currentCanonical);
          const current = fs.statSync(currentCanonical);
          if (
            currentRelative.startsWith('..') ||
            path.isAbsolute(currentRelative) ||
            opened.dev !== current.dev ||
            opened.ino !== current.ino
          ) {
            finish(null);
            stream.destroy();
            return;
          }

          validated = true;
          stream.resume();
        } catch {
          finish(null);
          stream.destroy();
        }
      });
      stream.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.length;
        if (totalBytes > maxBytes) {
          finish(null);
          stream.destroy();
          return;
        }
        chunks.push(bytes);
      });
      stream.once('end', () => {
        finish(validated ? Buffer.concat(chunks, totalBytes).toString('utf8') : null);
      });
      stream.once('error', () => finish(null));
      stream.once('close', () => finish(null));
    });
  } catch {
    return null;
  }
}
