import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';

const { fixture, expectRename } = createRenameFixtureHelpers();
const fixtureRoot = fileURLToPath(new URL('../fixtures/rename-integration/', import.meta.url));
const cases = [
  'typescript/member-destructure-alias-refusal',
  'typescript/member-destructure-destination-refusal',
  'typescript/member-destructure-shorthand-refusal',
  'typescript/member-object-method-refusal',
  'typescript/member-object-pair-refusal',
  'typescript/member-keys-unrelated-owner',
  'typescript/inherited-computed-member-refusal',
  'javascript/member-destructure-refusal',
  'javascript/member-object-key-refusal',
  'vue/member-destructure-refusal',
  'vue/member-object-key-refusal',
];

async function sources(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(directory)).map(async (file) => [
        file,
        await fs.readFile(path.join(directory, file), 'utf8'),
      ]),
    ),
  );
}

async function expectRefusal(
  files: Record<string, string>,
  targetFile = 'model.ts',
  code = 'ambiguous_reference',
) {
  const { root, nodes, symbol } = await fixture(files, 'close', 'Method', targetFile);
  for (const dry_run of [true, false]) {
    expect(await renameSymbol(root, symbol, { new_name: 'finish', dry_run }, nodes)).toMatchObject({
      status: 'error',
      code,
      planning_status: 'unsupported',
      applied: false,
    });
    for (const [file, content] of Object.entries(files))
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
  }
}

describe('TypeScript-family member-key safety', () => {
  it.each(cases)(
    'checks the real-source fixture %s',
    async (name) => {
      const directory = path.join(fixtureRoot, name);
      const specification = JSON.parse(
        await fs.readFile(path.join(directory, 'case.json'), 'utf8'),
      );
      const before = await sources(path.join(directory, 'before'));
      if (specification.expect.status === 'success') {
        await expectRename(
          before,
          await sources(path.join(directory, 'after')),
          'close',
          'Method',
          'finish',
          specification.target.file,
        );
      } else await expectRefusal(before, specification.target.file, specification.expect.code);
    },
    60_000,
  );

  it.each([
    'const { close = fallback } = writer;',
    'let alias; ({ close: alias } = writer);',
    'const { nested: { close: alias } } = unknown;',
    'const { "close": alias } = writer;',
    'const { [key]: alias } = writer;',
    'const backup = { "close": () => 1 };',
    String.raw`const backup = { "cl\u006fse": () => 1 };`,
    'const backup = { [key]: () => 1 };',
    'const finish = () => 1; const backup = { finish };',
  ])(
    'refuses unproven key syntax: %s',
    async (statement) => {
      const content =
        'export class Writer { close() { return 1; } }\n' +
        'const writer = new Writer();\n' +
        statement +
        '\nwriter.close();\n';
      await expectRefusal({ 'model.ts': content });
    },
    60_000,
  );
});
