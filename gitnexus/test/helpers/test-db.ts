/**
 * Test helper: Temporary LadybugDB factory
 *
 * Creates a temp directory, initializes LadybugDB with schema, and
 * optionally loads minimal test data. Returns a cleanup function.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface TestDBHandle {
  dbPath: string;
  cleanup: () => Promise<void>;
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
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}
