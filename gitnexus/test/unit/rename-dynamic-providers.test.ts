import { describe, expect, it } from 'vitest';
import { SupportedLanguages, type GraphNode } from 'gitnexus-shared';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { planGraphRename } from '../../src/mcp/local/rename/graph-rename.js';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';

const { expectRename } = createRenameFixtureHelpers();

async function source(language: SupportedLanguages, path: string, content: string) {
  const resolver = SCOPE_RESOLVERS.get(language)!;
  expect(resolver.languageProvider.rename).toBeDefined();
  return resolver.languageProvider.rename!.parseSource({
    filePath: path,
    content,
    languageProvider: resolver.languageProvider,
    scopeResolver: resolver,
  });
}

describe('dynamic-language rename providers', () => {
  it('renames escaped JavaScript declarations and references using ingested graph identities', async () => {
    await expectRename(
      { 'model.js': 'function t\\u0061rget() {}\nconst value = target;\nt\\u0061rget();\n' },
      { 'model.js': 'function renamed() {}\nconst value = renamed;\nrenamed();\n' },
      't\\u0061rget',
    );
  }, 60_000);

  it('renames normalized Python graph identities while preserving a shadowing binder', async () => {
    await expectRename(
      {
        'model.py':
          '# 😀\ndef Kelvin(): pass\ndef other(Kelvin):\n    return Kelvin\nKelvin()\nKelvin()\n',
      },
      {
        'model.py':
          '# 😀\ndef renamed(): pass\ndef other(Kelvin):\n    return Kelvin\nrenamed()\nrenamed()\n',
      },
      'Kelvin',
    );
  }, 60_000);

  it('inventories escaped names as one original-source span and covers bare reads', async () => {
    const content = 'function target() {}\nconst value = t\\u0061rget;\nif (target) target();\n';
    const parsed = await source(SupportedLanguages.TypeScript, 'model.ts', content);
    const escaped = parsed.occurrences.find(
      (occurrence) => occurrence.node?.text === 't\\u0061rget',
    );
    expect(escaped?.name).toBe('target');
    expect(escaped?.spans).toEqual([{ start: content.indexOf('t\\u0061rget'), length: 11 }]);
    expect(
      parsed.parsed.referenceSites.filter((site) => site.name === 'target').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('normalizes Python identifiers and retains UTF-16 source positions', async () => {
    const content = '# 😀\ndef Kelvin(): pass\nKelvin\n';
    const parsed = await source(SupportedLanguages.Python, 'model.py', content);
    const occurrence = parsed.occurrences.find((item) => item.node?.text === 'Kelvin');
    expect(occurrence?.name).toBe('Kelvin');
    expect(occurrence?.spans).toEqual([{ start: content.indexOf('Kelvin'), length: 6 }]);
    expect(parsed.parsed.referenceSites.some((site) => site.name === 'Kelvin')).toBe(true);
  });

  it('keeps labels and keyword names separate from lexical names', async () => {
    const js = await source(
      SupportedLanguages.TypeScript,
      'model.ts',
      'const value = { target: other, target };',
    );
    expect(
      js.occurrences.filter((item) => item.name === 'target').map((item) => item.role),
    ).toEqual(['unrelated', 'name']);
    const py = await source(SupportedLanguages.Python, 'model.py', 'call(target=target)');
    expect(
      py.occurrences.filter((item) => item.name === 'target').map((item) => item.role),
    ).toEqual(['unrelated', 'name']);
  });

  it.each([
    [
      'model.ts',
      'function target() {}\nconst value = { target };\n',
      'function renamed() {}\nconst value = { target: renamed };\n',
    ],
    ['model.ts', 'function target() {}\nt\\u0061rget();\n', 'function renamed() {}\nrenamed();\n'],
    [
      'model.ts',
      'function target() {}\nif (target) { target(); }\nconst values = [1];\nconst other = values[0];\n',
      'function renamed() {}\nif (renamed) { renamed(); }\nconst values = [1];\nconst other = values[0];\n',
    ],
    [
      'model.py',
      'def target(): pass\nif target:\n    target()\nvalues[0]\n',
      'def renamed(): pass\nif renamed:\n    renamed()\nvalues[0]\n',
    ],
    [
      'model.py',
      'def target(): pass\ndef other(target):\n    return target\ntarget()\n',
      'def renamed(): pass\ndef other(target):\n    return target\nrenamed()\n',
    ],
    [
      'model.ts',
      'function target() {}\nconst other = (target) => target;\ntarget();\n',
      'function renamed() {}\nconst other = (target) => target;\nrenamed();\n',
    ],
    [
      'model.ts',
      'function target() {}\nconst other = target => target;\ntarget();\n',
      'function renamed() {}\nconst other = target => target;\nrenamed();\n',
    ],
  ])('renames source-supported occurrences in %s', async (file, content, expected) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-provider-'));
    try {
      await fs.writeFile(path.join(root, file), content);
      const nodes: GraphNode[] = [
        { id: `File:${file}`, label: 'File', properties: { name: file, filePath: file } },
        {
          id: `Function:${file}:target`,
          label: 'Function',
          properties: { name: 'target', filePath: file, startLine: 0, endLine: 0 },
        },
      ];
      const plan = await planGraphRename(
        root,
        { uid: nodes[1]!.id, name: 'target', filePath: file, startLine: 1, kind: 'Function' },
        { new_name: 'renamed' },
        nodes,
      );
      let result = content;
      for (const edit of [...plan.edits].reverse())
        result =
          result.slice(0, edit.start) + edit.new_text + result.slice(edit.start + edit.length);
      expect(result).toBe(expected);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
