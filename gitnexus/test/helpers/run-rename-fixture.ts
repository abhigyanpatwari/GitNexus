import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runner = fileURLToPath(new URL('./rename-integration-runner.mjs', import.meta.url));
const execute = promisify(execFile);
/** Exercise preview, apply and persistence against a fresh database for this fixture. */
export async function runRenameFixture(directory: string): Promise<void> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-integration-'));
  const report = path.join(temporary, 'result.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITNEXUS_HOME: path.join(temporary, 'home'),
    GITNEXUS_STORAGE_PATH: path.join(temporary, 'index'),
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_MEMORY: 'off',
    GITNEXUS_INDEX_LOCK_BACKEND: 'file',
    GITNEXUS_CONTENT_RETENTION: 'full',
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'off',
    GITNEXUS_WORKER_READY_TIMEOUT_MS: process.env.GITNEXUS_WORKER_READY_TIMEOUT_MS ?? '15000',
  };
  delete env.CODEX_HOME;
  delete env.GITNEXUS_STORAGE_ROOT;
  try {
    try {
      // No kill timeout: let native workers finish and release their own handles.
      await execute(process.execPath, [runner, directory, temporary, report], {
        cwd: temporary,
        env,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const evidence = await fs.readFile(report, 'utf8').catch(() => String(error));
      throw new Error(evidence, { cause: error });
    }
    const result = JSON.parse(await fs.readFile(report, 'utf8'));
    assert.equal(result.status, 'passed');
    assert.ok(result.nodes > 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
