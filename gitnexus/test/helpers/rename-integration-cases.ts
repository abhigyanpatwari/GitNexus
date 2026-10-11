import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const fixtures = fileURLToPath(new URL('../fixtures/rename-integration/', import.meta.url));
const runner = fileURLToPath(new URL('./rename-integration-runner.mjs', import.meta.url));
const execute = promisify(execFile);
export const renameCases: Array<{
  id: string;
  directory: string;
  language: string;
  status: string;
}> = [];
for (const language of (await fs.readdir(fixtures, { withFileTypes: true })).filter((entry) =>
  entry.isDirectory(),
)) {
  for (const entry of (
    await fs.readdir(path.join(fixtures, language.name), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory())) {
    const directory = path.join(fixtures, language.name, entry.name);
    const specification = JSON.parse(await fs.readFile(path.join(directory, 'case.json'), 'utf8'));
    if (specification.language !== language.name)
      throw new Error(`Fixture language mismatch: ${directory}`);
    renameCases.push({
      id: `${language.name}/${entry.name}`,
      directory,
      language: specification.language,
      status: specification.expect.status,
    });
  }
}

renameCases.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

// Separate files let CI distribute these real indexing runs across its shards.
export function defineRenameFixtureTests(language: string): void {
  describe('persisted semantic rename across providers (no mocks)', () => {
    it.each(renameCases.filter((fixture) => fixture.language === language))(
      '$id',
      async ({ directory }) => {
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
          expect(result.status).toBe('passed');
          expect(result.nodes).toBeGreaterThan(0);
        } finally {
          await fs.rm(temporary, { recursive: true, force: true });
        }
      },
      180_000,
    );
  });
}
