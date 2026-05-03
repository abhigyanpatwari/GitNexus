/**
 * Test helper: Temporary LadybugDB factory
 *
 * Creates temporary directories for tests and provides cleanup that tolerates
 * LadybugDB's known Windows handle-release lag after retries.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface TestDBHandle {
  dbPath: string;
  cleanup: () => Promise<void>;
}

const WINDOWS_NATIVE_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

export async function cleanupTempDir(tmpDir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }

  const code = (lastError as NodeJS.ErrnoException | undefined)?.code;
  if (process.platform === 'win32' && WINDOWS_NATIVE_LOCK_CODES.has(code ?? '')) {
    return;
  }
  throw lastError;
}

/**
 * Create a temporary directory for LadybugDB tests.
 * Returns the path and a cleanup function.
 */
export async function createTempDir(prefix: string = 'gitnexus-test-'): Promise<TestDBHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dbPath: tmpDir,
    cleanup: async () => {
      try {
        await cleanupTempDir(tmpDir);
      } catch {
        // best-effort cleanup
      }
    },
  };
}
