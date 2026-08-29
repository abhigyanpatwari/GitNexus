import fs from 'node:fs';
import * as path from 'node:path';

export const MAX_REPO_CONTROL_FILE_BYTES = 1024 * 1024;

/** Read a bounded, regular control file owned by the repository root. */
export async function readRepoControlFile(
  repoRoot: string,
  filename: string,
): Promise<string | null> {
  const requestedRoot = path.resolve(repoRoot);
  const requested = path.resolve(requestedRoot, filename);
  const relative = path.relative(requestedRoot, requested);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${filename} resolves outside the repository root`);
  }

  try {
    const canonicalRoot = fs.realpathSync(requestedRoot);
    const beforeOpen = fs.lstatSync(requested);
    if (beforeOpen.isSymbolicLink()) throw new Error(`${filename} must not be a symbolic link`);
    if (!beforeOpen.isFile()) throw new Error(`${filename} must be a regular file`);
    if (beforeOpen.nlink !== 1) throw new Error(`${filename} must not be a hard link`);
    if (beforeOpen.size > MAX_REPO_CONTROL_FILE_BYTES) {
      throw new Error(`${filename} exceeds ${MAX_REPO_CONTROL_FILE_BYTES} bytes`);
    }
    return await new Promise<string>((resolve, reject) => {
      const stream = fs.createReadStream(requested, {
        flags: 'r',
        start: 0,
        end: MAX_REPO_CONTROL_FILE_BYTES,
        autoClose: true,
      });
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let validated = false;
      let settled = false;

      const finish = (value: string): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      stream.pause();
      stream.once('open', (fd) => {
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile()) throw new Error(`${filename} must be a regular file`);
          if (opened.nlink !== 1) throw new Error(`${filename} must not be a hard link`);
          if (opened.size > MAX_REPO_CONTROL_FILE_BYTES) {
            throw new Error(`${filename} exceeds ${MAX_REPO_CONTROL_FILE_BYTES} bytes`);
          }

          const entry = fs.lstatSync(requested);
          if (entry.isSymbolicLink()) throw new Error(`${filename} must not be a symbolic link`);
          if (
            !entry.isFile() ||
            entry.nlink !== 1 ||
            entry.dev !== opened.dev ||
            entry.ino !== opened.ino
          ) {
            throw new Error(`${filename} moved or was replaced while being opened`);
          }
          const canonicalFile = fs.realpathSync(requested);
          const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
          if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
            throw new Error(`${filename} resolves outside the repository root`);
          }
          const canonical = fs.statSync(canonicalFile);
          if (
            canonical.nlink !== 1 ||
            canonical.dev !== opened.dev ||
            canonical.ino !== opened.ino
          ) {
            throw new Error(`${filename} moved or was replaced while being opened`);
          }

          validated = true;
          stream.resume();
        } catch (error) {
          fail(error);
          stream.destroy();
        }
      });
      stream.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.length;
        if (totalBytes > MAX_REPO_CONTROL_FILE_BYTES) {
          fail(new Error(`${filename} exceeds ${MAX_REPO_CONTROL_FILE_BYTES} bytes`));
          stream.destroy();
          return;
        }
        chunks.push(bytes);
      });
      stream.once('end', () => {
        if (!validated) {
          fail(new Error(`${filename} could not be validated`));
          return;
        }
        finish(Buffer.concat(chunks, totalBytes).toString('utf8'));
      });
      stream.once('error', fail);
      stream.once('close', () => {
        if (!settled) fail(new Error(`${filename} closed before it could be read`));
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
