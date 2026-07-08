/**
 * Test helper: Temporary LadybugDB factory
 *
 * Creates temporary directories for tests and provides cleanup that tolerates
 * LadybugDB's known Windows handle-release lag after retries.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

export interface TestDBHandle {
  dbPath: string;
  cleanup: () => Promise<void>;
}

const CLEANUP_MAX_ATTEMPTS = 5;
const WINDOWS_NATIVE_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

const cleanupBackoffMs = (attempt: number): number => 100 * (attempt + 1);

const shouldSwallowCleanupError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  // ENOTEMPTY can race on any platform (macOS node-gyp cache, Linux
  // parallel test teardown) — swallow after retries are exhausted.
  if (code === 'ENOTEMPTY') return true;
  return process.platform === 'win32' && WINDOWS_NATIVE_LOCK_CODES.has(code ?? '');
};

const sleepSync = (ms: number): void => {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
};

export function cleanupTempDirSync(tmpDir: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < CLEANUP_MAX_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < CLEANUP_MAX_ATTEMPTS - 1) {
        sleepSync(cleanupBackoffMs(attempt));
      }
    }
  }

  if (shouldSwallowCleanupError(lastError)) {
    return;
  }
  throw lastError;
}

export async function cleanupTempDir(tmpDir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CLEANUP_MAX_ATTEMPTS; attempt++) {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < CLEANUP_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, cleanupBackoffMs(attempt)));
      }
    }
  }

  if (shouldSwallowCleanupError(lastError)) {
    return;
  }
  throw lastError;
}

/**
 * Create a temporary directory for LadybugDB tests.
 * Returns the path and a cleanup function.
 *
 * IMPORTANT: when adding a new test that passes a custom `prefix`, also add
 * the prefix to `TEST_FIXTURE_PREFIXES` in
 * `gitnexus/src/core/lbug/lbug-config.ts`. The stale-sidecar sweep relies
 * on the prefix list to recognize test fixtures; an unknown prefix means
 * the sweep silently won't fire for that fixture and Windows CI flakes
 * return.
 */
export async function createTempDir(prefix: string = 'gitnexus-test-'): Promise<TestDBHandle> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
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
