import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { planGraphRename } from '../../src/mcp/local/rename/graph-rename.js';
import { renameSymbol, type RenameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

describe('graph and SemanticModel rename', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-rename-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function fixture(file: string, source: string, extra: GraphNode[] = []) {
    await fs.writeFile(path.join(root, file), source);
    return [
      { id: `File:${file}`, label: 'File', properties: { name: file, filePath: file } },
      {
        id: `Function:${file}:target`,
        label: 'Function',
        properties: { name: 'target', filePath: file, startLine: 1, endLine: 1 },
      },
      ...extra,
    ] as GraphNode[];
  }
  const cases = [
    ['model.ts', 'function target() {}\ntarget();\n// target\nconst text = "target";\n'],
    ['model.js', 'function target() {}\ntarget();\n// target\nconst text = "target";\n'],
    ['model.py', 'def target(): pass\ntarget()\n# target\ntext = "target"\n'],
    ['model.rs', 'fn target() {}\nfn main() { target(); }\n// target\n'],
    ['model.go', 'package model\nfunc target() {}\nfunc caller() { target() }\n// target\n'],
  ];

  async function expectBlockedPreviewAndApply(
    file: string,
    source: string,
    symbol: RenameSymbol,
    nodes: GraphNode[],
    code: string,
  ) {
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(root, symbol, { new_name: 'Renamed', dry_run }, nodes);
      expect(result).toMatchObject({
        status: 'error',
        application_status: 'not_started',
        applied: false,
        total_edits: 0,
        files_affected: 0,
        changes: [],
        code,
      });
      expect(result.planning_status).not.toBe('ready');
      expect(await fs.readFile(path.join(root, file))).toEqual(Buffer.from(source));
    }
  }

  it('blocks PHP preview and apply until case-insensitive names have provider coverage', async () => {
    const file = 'model.php';
    const source = '<?php\nfunction target() {}\nTARGET();\n';
    const nodes = await fixture(file, source);
    await expectBlockedPreviewAndApply(
      file,
      source,
      {
        uid: nodes[1]!.id,
        name: 'target',
        kind: 'Function',
        filePath: file,
        startLine: 2,
      },
      nodes,
      'unsupported_language',
    );
  });

  it.each([
    [
      'Java constructor',
      'model.java',
      'class Writer {\n Writer() {}\n static void use() { new Writer(); }\n}\n',
    ],
    [
      'C# constructor',
      'model.cs',
      'class Writer {\n public Writer() {}\n static void Use() { new Writer(); }\n}\n',
    ],
    [
      'C++ constructor',
      'model.cpp',
      'class Writer {\n public: Writer() {}\n};\nvoid use() { Writer x; }\n',
    ],
    ['C# destructor', 'model.cs', 'class Writer {\n ~Writer() {}\n}\n'],
    ['C++ destructor', 'model.cpp', 'class Writer {\n public: ~Writer() {}\n};\n'],
  ])('blocks preview and apply for a class with a name-coupled %s', async (_name, file, source) => {
    const uid = `Class:${file}:Writer`;
    const nodes = await fixture(file!, source!, [
      {
        id: uid,
        label: 'Class',
        properties: { name: 'Writer', filePath: file!, startLine: 0 },
      },
    ]);
    await expectBlockedPreviewAndApply(
      file!,
      source!,
      {
        uid,
        name: 'Writer',
        kind: 'Class',
        filePath: file!,
        startLine: 1,
      },
      nodes,
      'unsupported_symbol_family',
    );
  });

  it.each([
    [
      'Python keyword argument',
      'model.py',
      'def target(): pass\ndef fn(**kwargs): pass\nfn(target=1)\ntarget()\n',
    ],
    [
      'JSX intrinsic element',
      'model.tsx',
      'function target() {}\nconst element = <target></target>;\ntarget();\n',
    ],
    [
      'JSX attribute',
      'model.tsx',
      'function target() {}\nconst element = <a target="_blank" />;\ntarget();\n',
    ],
  ])('preserves the unrelated %s in preview and apply', async (_name, file, source) => {
    const nodes = await fixture(file!, source!);
    nodes[1]!.properties.startLine = 0;
    const symbol = {
      uid: nodes[1]!.id,
      name: 'target',
      kind: 'Function',
      filePath: file!,
      startLine: 1,
    };
    const preview = await renameSymbol(root, symbol, { new_name: 'Renamed', dry_run: true }, nodes);
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'success', total_edits: 2 });
    expect(preview.changes[0]!.edits.map((edit) => edit.start)).toEqual([
      source!.indexOf('target'),
      source!.lastIndexOf('target'),
    ]);
    expect(await fs.readFile(path.join(root, file!))).toEqual(Buffer.from(source!));
    const applied = await renameSymbol(
      root,
      symbol,
      { new_name: 'Renamed', dry_run: false },
      nodes,
    );
    expect(applied).toMatchObject({ status: 'success', applied: true, changes: preview.changes });
    const first = source!.indexOf('target');
    const last = source!.lastIndexOf('target');
    const expected =
      source!.slice(0, first) +
      'Renamed' +
      source!.slice(first + 6, last) +
      'Renamed' +
      source!.slice(last + 6);
    expect(await fs.readFile(path.join(root, file!))).toEqual(Buffer.from(expected));
  });

  it('blocks unclassified JSX expression occurrences instead of inventing a binding role', async () => {
    const file = 'model.tsx';
    const source = 'function target() {}\nconst element = <a title={target} />;\n';
    const nodes = await fixture(file, source);
    nodes[1]!.properties.startLine = 0;
    await expectBlockedPreviewAndApply(
      file,
      source,
      {
        uid: nodes[1]!.id,
        name: 'target',
        kind: 'Function',
        filePath: file,
        startLine: 1,
      },
      nodes,
      'incomplete_semantics',
    );
  });

  it.each([
    ['variable key', 'const key = "close";\nwriter[key]();\n'],
    ['escaped literal key', 'writer["clo\\u0073e"]();\n'],
    ['concatenated key', 'writer["cl" + "ose"]();\n'],
    ['unknown receiver', 'unknown[key]();\n'],
  ])('blocks preview and apply for an unresolved computed %s', async (_name, call) => {
    const file = 'model.ts';
    const source = 'class Writer {\n close() {}\n}\nconst writer = new Writer();\n' + call;
    const uid = `Method:${file}:Writer.close#0`;
    const nodes = await fixture(file, source, [
      {
        id: `Class:${file}:Writer`,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0, endLine: 2 },
      },
      {
        id: uid,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 1, endLine: 1 },
      },
    ]);
    await expectBlockedPreviewAndApply(
      file,
      source,
      {
        uid,
        name: 'close',
        kind: 'Method',
        filePath: file,
        startLine: 2,
      },
      nodes,
      'unsupported_occurrence',
    );
  });
  it.each(cases)(
    'renames bound declaration and call with the registered provider: %s',
    async (file, source) => {
      const nodes = await fixture(file!, source!);
      const line = file!.endsWith('.go') ? 2 : 1;
      nodes[1]!.properties.startLine = line - 1;
      nodes[1]!.properties.endLine = line - 1;
      const plan = await planGraphRename(
        root,
        {
          uid: nodes[1]!.id,
          name: 'target',
          kind: 'Function',
          filePath: file!,
          startLine: line,
          endLine: line,
        },
        { new_name: 'renamed' },
        nodes,
      );
      expect(plan.edits).toHaveLength(2);
      expect(plan.edits.map((e) => source!.slice(e.start, e.start + e.length))).toEqual([
        'target',
        'target',
      ]);
      expect(plan.coverage).toMatchObject({
        name: 'gitnexus-semantic',
        scope: 'indexed-repository',
        source_file_count: 1,
      });
      expect(await fs.readFile(path.join(root, file!), 'utf8')).toBe(source);
    },
  );

  it('refuses a stale graph declaration', async () => {
    const nodes = await fixture('model.ts', 'function other() {}\n');
    await expect(
      planGraphRename(
        root,
        { uid: nodes[1]!.id, name: 'target', kind: 'Function', filePath: 'model.ts', startLine: 1 },
        { new_name: 'renamed' },
        nodes,
      ),
    ).rejects.toMatchObject({ code: 'stale_graph' });
  });

  it('renames only the member owned by the selected graph class', async () => {
    const source =
      'class Writer {\n close() {}\n}\nclass Other {\n close() {}\n}\nconst writer = new Writer();\nconst other = new Other();\nwriter.close();\nother.close();\nconst unrelated = { close: 1 };\n';
    const file = 'model.ts';
    const nodes = await fixture(file, source, [
      {
        id: `Class:${file}:Writer`,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0, endLine: 2 },
      },
      {
        id: `Class:${file}:Other`,
        label: 'Class',
        properties: { name: 'Other', filePath: file, startLine: 3, endLine: 5 },
      },
      {
        id: `Method:${file}:Writer.close#0`,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 1, endLine: 1 },
      },
      {
        id: `Method:${file}:Other.close#0`,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 4, endLine: 4 },
      },
    ]);
    const plan = await planGraphRename(
      root,
      {
        uid: `Method:${file}:Writer.close#0`,
        name: 'close',
        kind: 'Method',
        filePath: file,
        startLine: 2,
      },
      { new_name: 'finish' },
      nodes,
    );
    expect(plan.edits.map((edit) => edit.start)).toEqual([
      source.indexOf('close'),
      source.indexOf('writer.close') + 7,
    ]);
  });

  it('keeps parameter shadows, object keys, comments and strings unchanged while covering interpolation and bare values', async () => {
    const source =
      'function target() {}\nfunction wrapper(target) { return target; }\nconst literal = { target: 1 };\nconst value = target;\nconst text = `target ${target()}`;\n// target\n';
    const nodes = await fixture('model.ts', source);
    nodes[1]!.properties.startLine = 0;
    const plan = await planGraphRename(
      root,
      { uid: nodes[1]!.id, name: 'target', kind: 'Function', filePath: 'model.ts', startLine: 1 },
      { new_name: 'renamed' },
      nodes,
    );
    expect(plan.edits.map((edit) => edit.start)).toEqual([
      source.indexOf('target'),
      source.indexOf('= target') + 2,
      source.indexOf('${target') + 2,
    ]);
  });

  it('updates a named import while preserving an explicit alias and its usages', async () => {
    const source = 'export function target() {}\n';
    const nodes = await fixture('model.ts', source);
    nodes[1]!.properties.startLine = 0;
    const consumer = 'import { target as local } from "./model";\nlocal();\n';
    await fs.writeFile(path.join(root, 'consumer.ts'), consumer);
    nodes.push({
      id: 'File:consumer.ts',
      label: 'File',
      properties: { name: 'consumer.ts', filePath: 'consumer.ts' },
    });
    const plan = await planGraphRename(
      root,
      { uid: nodes[1]!.id, name: 'target', kind: 'Function', filePath: 'model.ts', startLine: 1 },
      { new_name: 'renamed' },
      nodes,
    );
    expect(plan.edits.map((edit) => [edit.file_path, edit.start])).toEqual([
      ['consumer.ts', consumer.indexOf('target')],
      ['model.ts', source.indexOf('target')],
    ]);
  });

  it('resolves a typed member through finalized cross-file import bindings', async () => {
    const file = 'model.ts';
    const nodes = await fixture(file, 'export class Writer {\n close() {}\n}\n', [
      {
        id: `Class:${file}:Writer`,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0, endLine: 2 },
      },
      {
        id: `Method:${file}:Writer.close#0`,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 1, endLine: 1 },
      },
    ]);
    const consumer =
      'import { Writer } from "./model.js";\nfunction use(writer: Writer) { writer.close(); }\n';
    await fs.writeFile(path.join(root, 'consumer.ts'), consumer);
    nodes.push({
      id: 'File:consumer.ts',
      label: 'File',
      properties: { name: 'consumer.ts', filePath: 'consumer.ts' },
    });
    const plan = await planGraphRename(
      root,
      {
        uid: `Method:${file}:Writer.close#0`,
        name: 'close',
        kind: 'Method',
        filePath: file,
        startLine: 2,
      },
      { new_name: 'finish' },
      nodes,
    );
    expect(plan.edits).toHaveLength(2);
    expect(plan.edits[0]).toMatchObject({
      file_path: 'consumer.ts',
      start: consumer.indexOf('close'),
    });
  });

  it.each([
    ['unknown receiver', 'function target() {}\nunknown.target();\n', 'ambiguous_reference'],
    [
      'shorthand property',
      'function target() {}\nconst object = { target };\n',
      'unsupported_occurrence',
    ],
    [
      'parameter capture',
      'function target() {}\nfunction other(renamed) { target(); }\n',
      'name_collision',
    ],
    ['keyword replacement', 'function target() {}\ntarget();\n', 'invalid_name'],
    ['keyword declaration only', 'function target() {}\n', 'invalid_name'],
    ['computed member', 'function target() {}\nobject["target"]();\n', 'unsupported_occurrence'],
    [
      'export alias',
      'function target() {}\nexport { target as publicTarget };\n',
      'unsupported_occurrence',
    ],
    [
      'destructuring',
      'function target() {}\nconst { target: other } = object;\n',
      'unsupported_occurrence',
    ],
  ])('refuses %s', async (_name, source, code) => {
    const nodes = await fixture('model.ts', source);
    nodes[1]!.properties.startLine = 0;
    await expect(
      planGraphRename(
        root,
        { uid: nodes[1]!.id, name: 'target', kind: 'Function', filePath: 'model.ts', startLine: 1 },
        { new_name: code === 'invalid_name' ? 'return' : 'renamed' },
        nodes,
      ),
    ).rejects.toMatchObject({ code });
  });

  it('refuses known graph references across an unsupported language boundary', async () => {
    const nodes = await fixture('model.ts', 'function target() {}\n');
    nodes[1]!.properties.startLine = 0;
    await expect(
      planGraphRename(
        root,
        { uid: nodes[1]!.id, name: 'target', filePath: 'model.ts', startLine: 1 },
        { new_name: 'renamed' },
        nodes,
        ['consumer.js'],
      ),
    ).rejects.toMatchObject({ code: 'unsupported_boundary' });
  });

  it('refuses a member with an override family', async () => {
    const file = 'model.ts';
    const source = 'class Base {\n close() {}\n}\nclass Derived extends Base {\n close() {}\n}\n';
    const nodes = await fixture(file, source, [
      {
        id: `Class:${file}:Base`,
        label: 'Class',
        properties: { name: 'Base', filePath: file, startLine: 0, endLine: 2 },
      },
      {
        id: `Class:${file}:Derived`,
        label: 'Class',
        properties: { name: 'Derived', filePath: file, startLine: 3, endLine: 5 },
      },
      {
        id: `Method:${file}:Base.close#0`,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 1, endLine: 1 },
      },
      {
        id: `Method:${file}:Derived.close#0`,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 4, endLine: 4 },
      },
    ]);
    await expect(
      planGraphRename(
        root,
        {
          uid: `Method:${file}:Base.close#0`,
          name: 'close',
          kind: 'Method',
          filePath: file,
          startLine: 2,
        },
        { new_name: 'finish' },
        nodes,
      ),
    ).rejects.toMatchObject({ code: 'unsupported_symbol_family' });
  });

  it('preserves a same-spelled import alias bound to a different symbol', async () => {
    const file = 'model.ts';
    const nodes = await fixture(file, 'export function target() {}\nexport function other() {}\n', [
      {
        id: `Function:${file}:other`,
        label: 'Function',
        properties: { name: 'other', filePath: file, startLine: 1, endLine: 1 },
      },
    ]);
    nodes[1]!.properties.startLine = 0;
    const consumer = 'import { other as target } from "./model";\ntarget();\n';
    await fs.writeFile(path.join(root, 'consumer.ts'), consumer);
    nodes.push({
      id: 'File:consumer.ts',
      label: 'File',
      properties: { name: 'consumer.ts', filePath: 'consumer.ts' },
    });
    const plan = await planGraphRename(
      root,
      { uid: nodes[1]!.id, name: 'target', filePath: file, startLine: 1 },
      { new_name: 'renamed' },
      nodes,
    );
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]!.file_path).toBe(file);
  });

  it('keeps exact UTF-16 offsets after Unicode source', async () => {
    const file = 'model.ts';
    const source = 'const message = "😀"; function target() {}\ntarget();\n';
    const nodes = await fixture(file, source);
    nodes[1]!.properties.startLine = 0;
    const plan = await planGraphRename(
      root,
      { uid: nodes[1]!.id, name: 'target', filePath: file, startLine: 1 },
      { new_name: 'renamed' },
      nodes,
    );
    expect(plan.edits.map((edit) => edit.start)).toEqual([
      source.indexOf('target'),
      source.lastIndexOf('target'),
    ]);
  });

  it.each([{ kind: 'Method' }, { uid: 'Function:model.ts:unrelated' }, { endLine: 2 }])(
    'refuses mismatched graph evidence %j',
    async (override) => {
      const nodes = await fixture('model.ts', 'function target() {}\ntarget();\n');
      nodes[1]!.properties.startLine = 0;
      await expect(
        planGraphRename(
          root,
          {
            uid: nodes[1]!.id,
            name: 'target',
            kind: 'Function',
            filePath: 'model.ts',
            startLine: 1,
            ...override,
          },
          { new_name: 'renamed' },
          nodes,
        ),
      ).rejects.toMatchObject({ code: 'stale_graph' });
    },
  );

  it('refuses stale ownership even when graph name and source position still match', async () => {
    const file = 'model.ts';
    const nodes = await fixture(file, 'class Other {\n close() {}\n}\n', [
      {
        id: `Class:${file}:Writer`,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0, endLine: 2 },
      },
      {
        id: `Method:${file}:Writer.close#0`,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 1, endLine: 1 },
      },
    ]);
    await expect(
      planGraphRename(
        root,
        {
          uid: `Method:${file}:Writer.close#0`,
          name: 'close',
          kind: 'Method',
          filePath: file,
          startLine: 2,
        },
        { new_name: 'finish' },
        nodes,
      ),
    ).rejects.toMatchObject({ code: 'stale_graph' });
  });
});
