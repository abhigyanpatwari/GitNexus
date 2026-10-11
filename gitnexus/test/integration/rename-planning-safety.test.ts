import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const runner = fileURLToPath(
  new URL('../helpers/rename-planning-safety-runner.mjs', import.meta.url),
);
const execute = promisify(execFile);

describe('persisted rename planning safety (no mocks)', () => {
  it.each([
    ['unsupported-encoding', 'unsupported_encoding'],
    ['symlink-escape', 'outside_repository'],
  ])(
    'refuses %s through preview and apply without changing source bytes',
    async (scenario, code) => {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-planning-safety-'));
      const report = path.join(temporary, 'report.json');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GITNEXUS_HOME: path.join(temporary, 'home'),
        GITNEXUS_STORAGE_PATH: path.join(temporary, 'index'),
        GITNEXUS_SHARED_STORE: 'off',
        GITNEXUS_MEMORY: 'off',
        GITNEXUS_INDEX_LOCK_BACKEND: 'file',
        GITNEXUS_CONTENT_RETENTION: 'full',
        GITNEXUS_LBUG_EXTENSION_INSTALL: 'off',
        GITNEXUS_WORKER_READY_TIMEOUT_MS: '15000',
      };
      delete env.CODEX_HOME;
      delete env.GITNEXUS_STORAGE_ROOT;
      try {
        try {
          await execute(process.execPath, [runner, scenario, temporary, report], {
            cwd: temporary,
            env,
            maxBuffer: 8 * 1024 * 1024,
          });
        } catch (error) {
          throw new Error(await fs.readFile(report, 'utf8').catch(() => String(error)), {
            cause: error,
          });
        }
        const result = JSON.parse(await fs.readFile(report, 'utf8'));
        expect(result).toMatchObject({ status: 'passed', code });
        expect(result.nodes).toBeGreaterThan(0);
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
