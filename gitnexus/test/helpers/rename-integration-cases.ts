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

// A language whose fixtures outgrow one CI shard budget moves part of them into an overflow file.
// The ids listed here are skipped by `defineRenameFixtureTests` and run only through
// `defineRenameOverflowFixtureTests`, so every fixture is registered exactly once. Keyed by id,
// so a fixture added later stays in the primary file until it is listed.
export const renameOverflowIds: ReadonlySet<string> = new Set([
  'r/assign-local-conditional',
  'r/assign-local-constant-call',
  'r/assign-local-function-literal-no-call',
  'r/assign-local-nested-function',
  'r/assign-local-no-call',
  'r/backtick-definition',
  'r/block-def-conditional',
  'r/chained-receiver-same-name',
  'r/collision-new-name-parameter-call',
  'r/collision-unrelated-uses',
  'r/collision-variable-before',
  'r/cross-file-qualified-call',
  'r/duplicate-definition-other-file',
  'r/duplicate-definition-test-stub',
  'r/export-name-null',
  'r/function-call-chain',
  'r/generated-cpp11-wrapper',
  'r/infix-operator',
  'r/invalid-name-invalid-start',
  'r/local-def-call-before',
  'r/local-def-first',
  'r/local-def-loop',
  'r/namespace-export',
  'r/namespace-export-new-name',
  'r/namespace-pattern-new-name-exported',
  'r/namespace-pattern-word-boundary',
  'r/namespace-private-external-call',
  'r/namespace-private-local-import',
  'r/newname-pretty-dot',
  'r/parameter-body-read',
  'r/parameter-constant-default-call-and-read',
  'r/parameter-no-default-call',
  'r/r6-class',
  'r/r6-member-shadow-private',
  'r/r6-method',
  'r/rawnamespace-attached',
  'r/rc-own-method-shadow',
  'r/refclass-methods-call',
  'r/refclass-parent-without-member',
  'r/replacement-getter',
  'r/replacement-setter',
  'r/rprofile-mention',
  'r/s3-method',
  'r/s3-new-method-dotted-generic',
  'r/s3-new-method-name',
  'r/s4-class',
  'r/self-method-same-name',
  'r/string-built-name',
  'r/string-glue-call',
  'r/string-lookup-escaped',
  'r/string-parse-text',
  'r/superassign-in-function',
  'r/toplevel-call-before-definition-attached',
  'r/unindexed-no-mention',
  'r/unparseable-other-file',
  'r/value-reference-default',
  'r/value-reference-function-argument',
]);

// Separate files let CI distribute these real indexing runs across its shards.
export function defineRenameFixtureTests(language: string): void {
  defineRenameFixtureCases(
    (fixture) => fixture.language === language && !renameOverflowIds.has(fixture.id),
  );
}

// Registers only the overflow fixtures of `language`, for its second test file.
export function defineRenameOverflowFixtureTests(language: string): void {
  defineRenameFixtureCases(
    (fixture) => fixture.language === language && renameOverflowIds.has(fixture.id),
  );
}

function defineRenameFixtureCases(
  include: (fixture: (typeof renameCases)[number]) => boolean,
): void {
  describe('persisted semantic rename across providers (no mocks)', () => {
    it.each(renameCases.filter(include))(
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
