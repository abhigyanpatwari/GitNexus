import { runInSequence } from '../../../../test/helpers/run-in-sequence.mjs';
import { SupportedLanguages } from 'gitnexus-shared';
import { SCOPE_RESOLVERS } from '../../../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { renameSymbol } from '../../../../src/mcp/local/rename/rename-plan.js';
import { managedRename } from '../../../../test/helpers/managed-rename.js';

interface RenameCase {
  name: string;
  kind: string;
  file: string;
  source: string;
  target: string;
  newName: string;
  after?: string;
  error?: string;
  planning?: string;
  message?: string;
  absentFile?: string;
}
const cases: RenameCase[] = JSON.parse(
  await fs.readFile(
    new URL('../../../../test/fixtures/java-products/managed-rename.json', import.meta.url),
    'utf8',
  ),
);
assert.ok(cases.length);
for (const entry of cases) {
  test(entry.name, async (t) => {
    const roots: string[] = [];
    t.after(() =>
      Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))).then(
        () => undefined,
      ),
    );
    const { fixture, expectRename } = managedRename(roots);
    const files = { [entry.file]: entry.source };
    if (entry.after !== undefined) {
      await expectRename(
        files,
        { [entry.file]: entry.after },
        entry.target,
        entry.kind,
        entry.newName,
      );
      return;
    }
    assert.ok(entry.error);
    const { root, nodes, symbol } = await fixture(files, entry.target, entry.kind);
    await runInSequence([true, false], async (dry_run) => {
      const result = await renameSymbol(root, symbol, { new_name: entry.newName, dry_run }, nodes);
      assert.partialDeepStrictEqual(result, { status: 'error', code: entry.error, applied: false });
      if (entry.planning) {
        assert.partialDeepStrictEqual(result, {
          planning_status: entry.planning,
          application_status: 'not_started',
          total_edits: 0,
        });
      }
      if (entry.message) assert.ok(result.error?.includes(entry.message), result.error);
      assert.equal(await fs.readFile(path.join(root, entry.file), 'utf8'), entry.source);
      if (entry.absentFile) assert.ok(!(await fs.readdir(root)).includes(entry.absentFile));
    });
  });
}

test('refuses rename when the Java grammar cannot inventory Unicode escapes', async () => {
  const resolver = SCOPE_RESOLVERS.get(SupportedLanguages.Java)!;
  await assert.rejects(
    async () =>
      resolver.languageProvider.rename!.parseSource({
        filePath: 'model.java',
        content: String.raw`class Model { void t\u0061rget() {} }`,
        languageProvider: resolver.languageProvider,
        scopeResolver: resolver,
      }),
    { code: 'parse_error' },
  );
});
