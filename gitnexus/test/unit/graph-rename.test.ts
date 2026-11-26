import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { planGraphRename } from '../../src/mcp/local/rename/graph-rename.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

import {
  fixture,
  expectBlockedPreviewAndApply,
  expectSupportedPreviewAndApply,
} from '../helpers/graph-rename-case.js';

describe('graph and SemanticModel rename', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-rename-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const cases = [
    ['model.js', 'function target() {}\ntarget();\n// target\nconst text = "target";\n'],
    ['model.py', 'def target(): pass\ntarget()\n# target\ntext = "target"\n'],
    ['model.rs', 'fn target() {}\nfn main() { target(); }\n// target\n'],
    ['model.go', 'package model\nfunc target() {}\nfunc caller() { target() }\n// target\n'],
  ];

  it.each([
    [
      'escaped JS reference',
      'model.js',
      'function target() {}\nt\\u0061rget();\n',
      'target',
      'Function',
      'function Renamed() {}\nRenamed();\n',
    ],
    [
      'Python normalized reference',
      'model.py',
      'def K(): pass\nK()\n',
      'K',
      'Function',
      'def Renamed(): pass\nRenamed()\n',
    ],
    [
      'Python normalized shadow binder',
      'model.py',
      'def K(): pass\ndef other(K):\n    K()\n',
      'K',
      'Function',
      'def Renamed(): pass\ndef other(K):\n    K()\n',
    ],
  ] as const)(
    'renames the provider-canonical binding and preserves shadows for %s',
    async (_name, file, source, name, kind, expected) => {
      const nodes = await fixture(root, file, source);
      nodes[1] = {
        id: `${kind}:${file}:${name}`,
        label: kind,
        properties: { name, filePath: file, startLine: 0, endLine: 0 },
      };
      await expectSupportedPreviewAndApply(
        root,
        file,
        source,
        {
          uid: nodes[1].id,
          name,
          kind,
          filePath: file,
          startLine: 1,
        },
        nodes,
        expected,
      );
    },
  );

  it('renames a provider-proven verbatim type reference', async () => {
    const file = 'model.cs';
    const source = 'class Target {}\nclass Use { @Target value; }\n';
    const nodes = await fixture(root, file, source);
    nodes[1] = {
      id: 'Class:model.cs:Target',
      label: 'Class',
      properties: { name: 'Target', filePath: file, startLine: 0, endLine: 0 },
    };
    await expectSupportedPreviewAndApply(
      root,
      file,
      source,
      { uid: nodes[1]!.id, name: 'Target', kind: 'Class', filePath: file, startLine: 1 },
      nodes,
      'class Renamed {}\nclass Use { @Renamed value; }\n',
    );
  });

  it.each([
    ['private field', '    __secret = 42\n', 'w = Writer()\nprint(w._Writer__secret)\n'],
    [
      'private method',
      '    def __secret(self): return 42\n',
      'w = Writer()\nprint(w._Writer__secret())\n',
    ],
    [
      'private local in a method',
      '    def read(self):\n        __secret = 42\n        return __secret\n',
      'w = Writer()\n',
    ],
    [
      'private tuple slot',
      '    __slots__ = ("__secret",)\n',
      'w = Writer()\nw._Writer__secret = 42\nprint(w._Writer__secret)\n',
    ],
    ['private string slot', '    __slots__ = "__secret"\n', 'w = Writer()\n'],
    ['unknown slot expression', '    __slots__ = make_slots()\n', 'w = Writer()\n'],
    [
      'loop-bound private slots',
      '    for __slots__ in [("__secret",)]: pass\n',
      'w = Writer()\nw._Writer__secret = 42\nprint(w._Writer__secret)\n',
    ],
    [
      'named-expression private slots',
      '    (__slots__ := ("__secret",))\n',
      'w = Writer()\nw._Writer__secret = 42\nprint(w._Writer__secret)\n',
    ],
  ])('blocks Python class renames with a mangled %s', async (_name, body, use) => {
    const file = 'model.py';
    const source = `class Writer:\n${body}${use}`;
    const uid = `Class:${file}:Writer`;
    const nodes = await fixture(root, file, source, [
      {
        id: uid,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0 },
      },
    ]);
    await expectBlockedPreviewAndApply(
      root,
      file,
      source,
      {
        uid,
        name: 'Writer',
        kind: 'Class',
        filePath: file,
        startLine: 1,
      },
      nodes,
      'unsupported_symbol_family',
    );
  });

  it.each([
    ['shadow property', 'const object = { target: () => "object" };\nwith (object) target();\n'],
    ['unknown object', 'with (object) target();\n'],
    ['deferred closure', 'with (object) { function invoke() { return target(); } }\n'],
  ])('blocks dynamic with bindings in preview and apply: %s', async (_name, use) => {
    const file = 'model.js';
    const source = 'function target() { return "global"; }\n' + use;
    const nodes = await fixture(root, file, source);
    nodes[1]!.properties.startLine = 0;
    await expectBlockedPreviewAndApply(
      root,
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
      'unsupported_occurrence',
    );
  });

  it.each([
    [
      'conditional var redeclaration to another class',
      'var writer = new Writer();\nif (false) { var writer = new Other(); }\nwriter.close();\n',
      'model.js',
    ],
    [
      'conditional var redeclaration to the target class',
      'var writer = new Other();\nif (false) { var writer = new Writer(); }\nwriter.close();\n',
      'model.js',
    ],
    [
      'conditional var before the final declaration',
      'if (false) { var writer = new Other(); }\nvar writer = new Writer();\nwriter.close();\n',
      'model.js',
    ],
    [
      'conditional target var before the final declaration',
      'if (false) { var writer = new Writer(); }\nvar writer = new Other();\nwriter.close();\n',
      'model.js',
    ],
    [
      'function-hoisted conditional var redeclaration',
      'function use() {\nvar writer = new Writer();\nif (false) { var writer = new Other(); }\nwriter.close();\n}\nuse();\n',
      'model.js',
    ],
  ])('blocks unproven receiver ownership in preview and apply: %s', async (_name, use, file) => {
    const source = 'class Writer {\n close() {}\n}\nclass Other {\n close() {}\n}\n' + use;
    const uid = `Method:${file}:Writer.close#0`;
    const nodes = await fixture(root, file, source, [
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
        id: uid,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 1, endLine: 1 },
      },
      {
        id: `Method:${file}:Other.close#0`,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 4, endLine: 4 },
      },
    ]);
    await expectBlockedPreviewAndApply(
      root,
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
      'ambiguous_reference',
    );
  });

  it.each([
    [
      'prototype function expression',
      'model.js',
      'class Writer {\n closeWriter() {}\n}\nWriter.prototype.flush = function () { return this.closeWriter(); };\n',
    ],
  ])('refuses a member call on a call-site-bound this: %s', async (_name, file, source) => {
    const uid = `Method:${file}:Writer.closeWriter#0`;
    const nodes = await fixture(root, file, source, [
      {
        id: `Class:${file}:Writer`,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0, endLine: 2 },
      },
      {
        id: uid,
        label: 'Method',
        properties: { name: 'closeWriter', filePath: file, startLine: 1, endLine: 1 },
      },
    ]);
    await expectBlockedPreviewAndApply(
      root,
      file,
      source,
      { uid, name: 'closeWriter', kind: 'Method', filePath: file, startLine: 2 },
      nodes,
      'ambiguous_reference',
      'shutdown',
    );
  });

  it('preserves Python lexical with scopes', async () => {
    const file = 'model.py';
    const source = 'def target(): pass\nwith open("file") as stream:\n    target()\n';
    const nodes = await fixture(root, file, source);
    nodes[1]!.properties.startLine = 0;
    const symbol = {
      uid: nodes[1]!.id,
      name: 'target',
      kind: 'Function',
      filePath: file,
      startLine: 1,
    };
    const preview = await renameSymbol(root, symbol, { new_name: 'renamed', dry_run: true }, nodes);
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'success', total_edits: 2 });
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(source);
    const applied = await renameSymbol(
      root,
      symbol,
      { new_name: 'renamed', dry_run: false },
      nodes,
    );
    expect(applied).toMatchObject({ status: 'success', applied: true, changes: preview.changes });
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(
      'def renamed(): pass\nwith open("file") as stream:\n    renamed()\n',
    );
  });

  it('preserves Python member renames for a single constructor assignment', async () => {
    const file = 'model.py';
    const source = 'class Writer:\n    def close(self): pass\nwriter = Writer()\nwriter.close()\n';
    const uid = `Method:${file}:Writer.close#0`;
    const nodes = await fixture(root, file, source, [
      {
        id: `Class:${file}:Writer`,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0, endLine: 1 },
      },
      {
        id: uid,
        label: 'Method',
        properties: { name: 'close', filePath: file, startLine: 1, endLine: 1 },
      },
    ]);
    const plan = await planGraphRename(
      root,
      {
        uid,
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
      source.lastIndexOf('close'),
    ]);
  });

  it('preserves Python class renames with ordinary dunder names', async () => {
    const file = 'model.py';
    const source = 'class Writer:\n    def __init__(self): pass\nwriter = Writer()\n';
    const uid = `Class:${file}:Writer`;
    const nodes = await fixture(root, file, source, [
      {
        id: uid,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0, endLine: 1 },
      },
    ]);
    const plan = await planGraphRename(
      root,
      {
        uid,
        name: 'Writer',
        kind: 'Class',
        filePath: file,
        startLine: 1,
      },
      { new_name: 'Renamed' },
      nodes,
    );
    expect(plan.edits.map((edit) => edit.start)).toEqual([
      source.indexOf('Writer'),
      source.lastIndexOf('Writer'),
    ]);
  });

  it.each([
    ['nested class slots', '    class Nested:\n        __slots__ = ("__secret",)\n'],
    ['ordinary string', '    label = "__slots__ __secret"\n'],
    ['method-local slots name', '    def use(self):\n        __slots__ = ("__secret",)\n'],
    ['method parameter slots name', '    def use(self, __slots__): pass\n'],
    ['method default parameter slots name', '    def use(self, __slots__ = ("__secret",)): pass\n'],
  ])('preserves Python class preview and apply with an unrelated %s', async (_name, body) => {
    const file = 'model.py';
    const source = `class Writer:\n${body}writer = Writer()\n`;
    const uid = `Class:${file}:Writer`;
    const nodes = await fixture(root, file, source, [
      {
        id: uid,
        label: 'Class',
        properties: { name: 'Writer', filePath: file, startLine: 0 },
      },
    ]);
    const symbol = { uid, name: 'Writer', kind: 'Class', filePath: file, startLine: 1 };
    const preview = await renameSymbol(root, symbol, { new_name: 'Renamed', dry_run: true }, nodes);
    expect(preview, JSON.stringify(preview)).toMatchObject({ status: 'success', total_edits: 2 });
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(source);
    const applied = await renameSymbol(
      root,
      symbol,
      { new_name: 'Renamed', dry_run: false },
      nodes,
    );
    expect(applied).toMatchObject({ status: 'success', applied: true, changes: preview.changes });
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(
      `class Renamed:\n${body}writer = Renamed()\n`,
    );
  });

  it('renames PHP case-insensitive callable names through its provider', async () => {
    const file = 'model.php';
    const source = '<?php\nfunction target() {}\nTARGET();\n';
    const nodes = await fixture(root, file, source);
    await expectSupportedPreviewAndApply(
      root,
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
      '<?php\nfunction Renamed() {}\nRenamed();\n',
    );
  });

  it.each([
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
  ])('renames a class with a name-coupled %s', async (_name, file, source) => {
    const uid = `Class:${file}:Writer`;
    const nodes = await fixture(root, file!, source!, [
      {
        id: uid,
        label: 'Class',
        properties: { name: 'Writer', filePath: file!, startLine: 0 },
      },
    ]);
    await expectSupportedPreviewAndApply(
      root,
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
      source!.replaceAll('Writer', 'Renamed'),
    );
  });

  it.each([
    [
      'Python keyword argument',
      'model.py',
      'def target(): pass\ndef fn(**kwargs): pass\nfn(target=1)\ntarget()\n',
    ],
  ])('preserves the unrelated %s in preview and apply', async (_name, file, source) => {
    const nodes = await fixture(root, file!, source!);
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

  it.each(cases)(
    'renames bound declaration and call with the registered provider: %s',
    async (file, source) => {
      const nodes = await fixture(root, file!, source!);
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
      // Files added after the last analyze are skipped; the result must say so.
      expect(plan.coverage.limitations).toContainEqual(
        expect.stringContaining('added after the last analyze'),
      );
      expect(await fs.readFile(path.join(root, file!), 'utf8')).toBe(source);
    },
  );
});
