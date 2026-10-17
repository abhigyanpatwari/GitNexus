import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

it.each(['standard', 'large-evidence', 'unindexed-evidence'])(
  'binds public apply to the reviewed persisted semantic plan for tracked and untracked files (%s)',
  async (mode) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-preview-plan-'));
    const report = path.join(temporary, 'report.json');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GITNEXUS_HOME: path.join(temporary, 'home'),
      GITNEXUS_STORAGE_PATH: path.join(temporary, 'index'),
      GITNEXUS_SHARED_STORE: 'off',
      GITNEXUS_MEMORY: 'off',
      GITNEXUS_INDEX_LOCK_BACKEND: 'file',
      GITNEXUS_LBUG_EXTENSION_INSTALL: 'off',
      GITNEXUS_WORKER_READY_TIMEOUT_MS: '60000',
      // Large retained-source evidence exercises publication of 40 MiB of text;
      // keep the native COPY checkpoint above the ordinary 256 MiB test budget.
      ...(mode === 'large-evidence'
        ? { GITNEXUS_LBUG_BUFFER_POOL_SIZE: String(1024 * 1024 * 1024) }
        : {}),
    };
    delete env.GITNEXUS_STORAGE_ROOT;
    try {
      try {
        await promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(new URL('../helpers/rename-preview-plan-runner.mjs', import.meta.url)),
            temporary,
            report,
            mode,
          ],
          { env, maxBuffer: 8 * 1024 * 1024 },
        );
      } catch (error) {
        throw new Error(await fs.readFile(report, 'utf8').catch(() => String(error)), {
          cause: error,
        });
      }
      expect(JSON.parse(await fs.readFile(report, 'utf8'))).toMatchObject({ status: 'passed' });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  },
  180_000,
);
