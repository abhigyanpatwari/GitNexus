import { describe, expect, it } from 'vitest';
import { SupportedLanguages, type GraphNode } from 'gitnexus-shared';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { source } from '../helpers/rename-provider-source.js';
import { planGraphRename } from '../../src/mcp/local/rename/graph-rename.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';

const { expectRename, fixture } = createRenameFixtureHelpers();

describe('dynamic-language rename providers', () => {
  it('refuses writes to inferred JavaScript receiver fields', async () => {
    const chainModel = `export class Leaf { score = 0; }
export class Branch { leaf = new Leaf(); }
export class Root { branch = new Branch(); }
export class Other { score = 9; }
export const shared = new Root();
`;
    const chainUse = 'root.branch.leaf.score = root.branch.leaf.score + 1;\n';
    const content =
      chainModel + 'const root = new Root();\nroot.branch.leaf = { score: 12 };\n' + chainUse;
    const { root, nodes, symbol } = await fixture({ 'model.js': content }, 'score', 'Property');
    for (const dry_run of [true, false]) {
      expect(
        await renameSymbol(root, symbol, { new_name: 'points', dry_run }, nodes),
      ).toMatchObject({
        status: 'error',
        code: 'ambiguous_reference',
        planning_status: 'unsupported',
        applied: false,
      });
      expect(await fs.readFile(path.join(root, 'model.js'), 'utf8')).toBe(content);
    }
  }, 60_000);

  it('renames Python members beside unrelated decoded literal attributes', async () => {
    const uses = String.raw`worker = Worker()
worker.target()
getattr(worker, "other_member")
setattr(worker, "other_\x6dember", 1)
hasattr(worker, u"other_\u006dember")
hasattr(worker, "other_\U0000006dember")
hasattr(worker, "other_\155ember")
hasattr(worker, r"other_member")
hasattr(worker, """other_member""")
delattr(worker, "other_" "member")
def inspect_unknown(receiver):
    return getattr(receiver, "other_member")
`;
    await expectRename(
      { 'model.py': 'class Worker:\n    def target(self): pass\n' + uses },
      {
        'model.py':
          'class Worker:\n    def renamed(self): pass\n' +
          uses.replace('worker.target()', 'worker.renamed()'),
      },
      'target',
      'Method',
    );
  }, 60_000);

  it.each([
    ['getattr(worker, "renamed")', 'renamed'],
    ['setattr(worker, "renamed", 42)', 'renamed'],
    ['delattr(worker, "renamed")', 'renamed'],
    ['hasattr(worker, "renamed")', 'renamed'],
    [String.raw`setattr(worker, "rena\u006ded", 42)`, 'renamed'],
    ['setattr(worker, "Kelvin", 42)', 'Kelvin'],
  ])(
    'refuses Python dynamic destination collisions: %s renamed to %s',
    async (access, newName) => {
      const content =
        'class Worker:\n    def target(self): return 7\nworker = Worker()\n' +
        access +
        '\nworker.target()\n';
      const { root, nodes, symbol } = await fixture({ 'model.py': content }, 'target', 'Method');
      for (const dry_run of [true, false]) {
        expect(
          await renameSymbol(root, symbol, { new_name: newName, dry_run }, nodes),
        ).toMatchObject({
          status: 'error',
          planning_status: 'unsupported',
          code: 'unsupported_occurrence',
          applied: false,
        });
        expect(await fs.readFile(path.join(root, 'model.py'), 'utf8')).toBe(content);
      }
    },
    60_000,
  );

  it('keeps Python runtime attribute strings distinct from normalized destination identifiers', async () => {
    const content =
      'class Worker:\n    def target(self): return 7\nworker = Worker()\n' +
      'setattr(worker, "Kelvin", 42)\nworker.target()\n';
    await expectRename(
      { 'model.py': content },
      { 'model.py': content.replaceAll('target', 'Kelvin') },
      'target',
      'Method',
      'Kelvin',
    );
  }, 60_000);

  it('preserves Python dynamic destination attributes on proven unrelated receivers', async () => {
    const content =
      'class Worker:\n    def target(self): return 7\n' +
      'class Other:\n    def unrelated(self): return 1\n' +
      'worker = Worker()\nother = Other()\n' +
      'setattr(other, "renamed", 42)\nworker.target()\n';
    await expectRename(
      { 'model.py': content },
      { 'model.py': content.replaceAll('target', 'renamed') },
      'target',
      'Method',
    );
  }, 60_000);

  it.each([
    '"target"',
    '"tar\\x67et"',
    '"tar\\u0067et"',
    '"tar\\U00000067et"',
    '"tar\\147et"',
    '"tar" "get"',
    'r"target"',
    '"""target"""',
    'f"{name}"',
    'name',
    '"tar\\N{LATIN SMALL LETTER G}et"',
  ])(
    'refuses matching or unproven Python attribute names: %s',
    async (attribute) => {
      const content =
        'class Worker:\n    def target(self): pass\nworker = Worker()\nworker.target()\n' +
        `getattr(worker, ${attribute})\n`;
      const { root, nodes, symbol } = await fixture({ 'model.py': content }, 'target', 'Method');
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes);
        expect(result).toMatchObject({
          status: 'error',
          planning_status: 'unsupported',
          code: 'unsupported_occurrence',
          applied: false,
        });
        expect(await fs.readFile(path.join(root, 'model.py'), 'utf8')).toBe(content);
      }
    },
    60_000,
  );

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

  it('normalizes Python identifiers and retains UTF-16 source positions', async () => {
    const content = '# 😀\ndef Kelvin(): pass\nKelvin\n';
    const parsed = await source(SupportedLanguages.Python, 'model.py', content);
    const occurrence = parsed.occurrences.find((item) => item.node?.text === 'Kelvin');
    expect(occurrence?.name).toBe('Kelvin');
    expect(occurrence?.spans).toEqual([{ start: content.indexOf('Kelvin'), length: 6 }]);
    expect(parsed.parsed.referenceSites.some((site) => site.name === 'Kelvin')).toBe(true);
  });

  it('keeps labels and keyword names separate from lexical names', async () => {
    const py = await source(SupportedLanguages.Python, 'model.py', 'call(target=target)');
    expect(
      py.occurrences.filter((item) => item.name === 'target').map((item) => item.role),
    ).toEqual(['unrelated', 'name']);
  });

  it.each([
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
  ])('renames source-supported occurrences in %s (case %#)', async (file, content, expected) => {
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
