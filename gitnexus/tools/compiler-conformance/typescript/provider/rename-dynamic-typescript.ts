import { registerCases } from '../support/cases.mjs';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { expect } from 'expect';
import { SupportedLanguages, type GraphNode } from 'gitnexus-shared';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { source } from '../../../../test/helpers/rename-provider-source.js';
import { planGraphRename } from '../../../../src/mcp/local/rename/graph-rename.js';
import { renameSymbol } from '../../../../src/mcp/local/rename/rename-plan.js';
import { managedRename } from '../../../../test/helpers/managed-rename.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const { expectRename, fixture } = managedRename(roots);

describe('TypeScript rename provider', () => {
  const chainModel = `export class Leaf { score = 0; }
export class Branch { leaf: Leaf = new Leaf(); }
export class Root { branch: Branch = new Branch(); }
export class Other { score = 9; }
export const shared = new Root();
`;

  const chainUse = 'root.branch.leaf.score = root.branch.leaf.score + 1;\n';

  registerCases(
    it,
    [
      ['mismatched field initializer', 'const root = new Root();\n', '', 'new Other()'],
      ['base write', 'let root = new Root();\nroot = new Root();\n'],
      ['first field write', 'const root = new Root();\nroot.branch = { leaf: { score: 12 } };\n'],
      ['second field write', 'const root = new Root();\nroot.branch.leaf = { score: 12 };\n'],
      [
        'closure alias write',
        'const root = new Root();\nconst alias = root.branch;\nfunction change() { alias.leaf = { score: 12 }; }\n',
      ],
      ['destructuring write', 'const root = new Root();\n[root.branch.leaf] = [{ score: 12 }];\n'],
      ['delete', 'const root = new Root();\ndelete root.branch.leaf;\n'],
      [
        'computed write',
        'const root = new Root();\nroot.branch["leaf"] = { score: 12 };\n',
        'ambiguous_reference',
      ],
      [
        'unknown computed write',
        'const root = new Root();\nconst key = readKey();\nroot.branch[key] = { score: 12 };\n',
        'unsupported_occurrence',
      ],
    ],
    'refuses unsafe deep receiver ownership in preview and apply: %s',
    async (_name, setup, code = 'ambiguous_reference', initializer = 'new Leaf()') => {
      const files = {
        'model.ts': chainModel.replace('leaf: Leaf = new Leaf()', `leaf: Leaf = ${initializer}`),
        'entry.ts': 'import { Root, Other } from "./model";\n' + setup + chainUse,
      };
      const { root, nodes, symbol } = await fixture(files, 'score', 'Property', 'model.ts');
      for (const dry_run of [true, false]) {
        expect(
          await renameSymbol(root, symbol, { new_name: 'points', dry_run }, nodes),
        ).toMatchObject({
          status: 'error',
          code: code || 'ambiguous_reference',
          planning_status: 'unsupported',
          applied: false,
        });
        for (const [file, content] of Object.entries(files))
          expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
      }
    },
    60_000,
  );

  it(
    "refuses an intermediate field write through another file's imported alias",
    { timeout: 60_000 },
    async () => {
      const files = {
        'model.ts': chainModel,
        'entry.ts': 'import { shared as root } from "./model";\n' + chainUse,
        'mutator.ts':
          'import { shared as alias } from "./model";\nexport function change() { alias.branch.leaf = { score: 12 }; }\n',
      };
      const { root, nodes, symbol } = await fixture(files, 'score', 'Property', 'model.ts');
      for (const dry_run of [true, false]) {
        expect(
          await renameSymbol(root, symbol, { new_name: 'points', dry_run }, nodes),
        ).toMatchObject({
          status: 'error',
          code: 'ambiguous_reference',
          planning_status: 'unsupported',
          applied: false,
        });
        for (const [file, content] of Object.entries(files))
          expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
      }
    },
  );

  registerCases(
    it,
    [
      [
        'member',
        'const alias: OtherBranch = root.branch;\nalias.leaf = { score: 12 };\n',
        'ambiguous_reference',
      ],
      [
        'computed',
        'const alias: OtherBranch = root.branch;\nalias["leaf"] = { score: 12 };\n',
        'ambiguous_reference',
      ],
      [
        'parameter',
        'function change(alias: OtherBranch) { alias.leaf = { score: 12 }; }\n',
        'ambiguous_reference',
      ],
    ],
    'refuses a structural annotation hiding an alias write: %s',
    async (_name, mutation, code) => {
      const files = {
        'model.ts': chainModel + 'export class OtherBranch { leaf: Leaf = new Leaf(); }\n',
        'entry.ts':
          'import { Root, OtherBranch } from "./model";\nconst root = new Root();\n' +
          mutation +
          chainUse,
      };
      const { root, nodes, symbol } = await fixture(files, 'score', 'Property', 'model.ts');
      for (const dry_run of [true, false]) {
        expect(
          await renameSymbol(root, symbol, { new_name: 'points', dry_run }, nodes),
        ).toMatchObject({
          status: 'error',
          code,
          planning_status: 'unsupported',
          applied: false,
        });
        for (const [file, content] of Object.entries(files))
          expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
      }
    },
    60_000,
  );

  it(
    'preserves inherited constructor-proven field chains beside unrelated writes',
    { timeout: 60_000 },
    async () => {
      const files = {
        'model.ts':
          chainModel
            .replace('export class Root', 'export class Child extends Branch {}\nexport class Root')
            .replace('branch: Branch = new Branch()', 'branch: Branch = new Child()') +
          'export class Unrelated { leaf = 1; }\n',
        'entry.ts':
          'import { shared as root, Unrelated } from "./model";\nconst other = new Unrelated();\nother.leaf = 3;\nother["leaf"] = 4;\nfunction shadow() { const root = new Unrelated(); root.leaf = 5; }\n' +
          chainUse,
      };
      await expectRename(
        files,
        {
          'model.ts': files['model.ts'].replace('score = 0', 'points = 0'),
          'entry.ts': files['entry.ts'].replaceAll('.score', '.points'),
        },
        'score',
        'Property',
        'points',
        'model.ts',
      );
    },
  );

  it('preserves a deep field receiver rooted in lexical this', { timeout: 60_000 }, async () => {
    const content = chainModel.replace(
      'branch: Branch = new Branch();',
      'branch: Branch = new Branch();\nupdate() { this.branch.leaf.score += 1; }',
    );
    await expectRename(
      { 'model.ts': content },
      { 'model.ts': content.replace('score = 0', 'points = 0').replace('.score', '.points') },
      'score',
      'Property',
      'points',
    );
  });

  registerCases(
    it,
    [
      'export class Derived extends Base { child = new B(); }',
      'export class Middle extends Base {}\nexport class Derived extends Middle { child = new B(); }',
    ],
    'refuses a descendant replacing a polymorphic intermediate field: %s',
    async (derived) => {
      const content = `export class A { value = 1; }
export class B { value = 2; }
export class Base {
  child = new A();
  read() { return this.child.value; }
}
${derived}
export function run() { const instance = new Derived(); return instance.read(); }
`;
      const { root, nodes, symbol } = await fixture({ 'model.ts': content }, 'value', 'Property');
      for (const dry_run of [true, false]) {
        expect(
          await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes),
        ).toMatchObject({
          status: 'error',
          code: 'ambiguous_reference',
          planning_status: 'unsupported',
          applied: false,
        });
        expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toBe(content);
      }
    },
    60_000,
  );

  it(
    'preserves inherited this receivers when descendants retain the intermediate field',
    { timeout: 60_000 },
    async () => {
      const content = `export class A { value = 1; }
export class Base {
  child = new A();
  read() { return this.child.value; }
}
export class Derived extends Base {}
export function run() { const instance = new Derived(); return instance.read(); }
`;
      await expectRename(
        { 'model.ts': content },
        { 'model.ts': content.replace('value = 1', 'renamed = 1').replace('.value', '.renamed') },
        'value',
        'Property',
      );
    },
  );

  it(
    'preserves a concrete receiver beside a descendant shadowing its intermediate field',
    { timeout: 60_000 },
    async () => {
      const content = `export class A { value = 1; }
export class B { value = 2; }
export class Base { child = new A(); }
export class Derived extends Base { child = new B(); }
export function run() { const instance = new Base(); return instance.child.value; }
`;
      await expectRename(
        { 'model.ts': content },
        { 'model.ts': content.replace('value = 1', 'renamed = 1').replace('.value', '.renamed') },
        'value',
        'Property',
      );
    },
  );

  it(
    'preserves an explicit implementation family behind a constructor-proven field',
    { timeout: 60_000 },
    async () => {
      const content = `export interface Renderer { render(): string; }
export class Base implements Renderer { render() { return "base"; } }
export class Child extends Base { override render() { return "child"; } }
export class Root { renderer: Renderer = new Child(); }
const root = new Root();
root.renderer.render();
`;
      await expectRename(
        { 'model.ts': content },
        { 'model.ts': content.replaceAll('render()', 'paint()') },
        'render',
        'Method',
        'paint',
      );
    },
  );

  it(
    'rechecks imported receiver writes in each fresh workspace while preserving lexical shadows',
    { timeout: 60_000 },
    async () => {
      const model =
        'export class Worker { target() {} }\nexport class Other { target() {} }\nexport const value = new Worker();\n';
      const entry =
        'import { value as receiver, Other } from "./model";\nreceiver.target();\nreceiver.target();\nfunction shadow(receiver: Other) { receiver = new Other(); }\n';
      const mutator =
        'import { value as changedReceiver, Other } from "./model";\nexport function replace() { return 0; }\n';
      const { root, nodes, symbol } = await fixture(
        { 'model.ts': model, 'entry.ts': entry, 'mutator.ts': mutator },
        'target',
        'Method',
        'model.ts',
      );
      const options = { new_name: 'renamed', dry_run: true };
      const preview = await renameSymbol(root, symbol, options, nodes);
      assert.doesNotThrow(
        () => expect(preview).toMatchObject({ status: 'success', total_edits: 3 }),
        JSON.stringify(preview),
      );
      const reassigned =
        'import { value as changedReceiver, Other } from "./model";\nexport function replace() { changedReceiver = new Other(); }\n';
      await fs.writeFile(path.join(root, 'mutator.ts'), reassigned);
      expect(await renameSymbol(root, symbol, options, nodes)).toMatchObject({
        status: 'error',
        code: 'ambiguous_reference',
        planning_status: 'unsupported',
        error: 'The imported receiver binding is reassigned.',
        applied: false,
      });
      expect(await fs.readFile(path.join(root, 'mutator.ts'), 'utf8')).toBe(reassigned);
      await fs.writeFile(path.join(root, 'mutator.ts'), mutator);
      expect(await renameSymbol(root, symbol, { ...options, dry_run: false }, nodes)).toMatchObject(
        {
          status: 'success',
          total_edits: 3,
          applied: true,
        },
      );
      expect(await fs.readFile(path.join(root, 'model.ts'), 'utf8')).toBe(
        'export class Worker { renamed() {} }\nexport class Other { target() {} }\nexport const value = new Worker();\n',
      );
      expect(await fs.readFile(path.join(root, 'entry.ts'), 'utf8')).toBe(
        'import { value as receiver, Other } from "./model";\nreceiver.renamed();\nreceiver.renamed();\nfunction shadow(receiver: Other) { receiver = new Other(); }\n',
      );
    },
  );

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

  it('keeps labels and keyword names separate from lexical names', async () => {
    const js = await source(
      SupportedLanguages.TypeScript,
      'model.ts',
      'const value = { target: other, target };',
    );
    expect(
      js.occurrences.filter((item) => item.name === 'target').map((item) => item.role),
    ).toEqual(['unrelated', 'name']);
  });

  registerCases(
    it,
    [
      [
        'model.ts',
        'function target() {}\nconst value = { target };\n',
        'function renamed() {}\nconst value = { target: renamed };\n',
      ],
      [
        'model.ts',
        'function target() {}\nt\\u0061rget();\n',
        'function renamed() {}\nrenamed();\n',
      ],
      [
        'model.ts',
        'function target() {}\nif (target) { target(); }\nconst values = [1];\nconst other = values[0];\n',
        'function renamed() {}\nif (renamed) { renamed(); }\nconst values = [1];\nconst other = values[0];\n',
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
    ],
    'renames source-supported occurrences in %s (case %#)',
    async (file, content, expected) => {
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
    },
  );
});
