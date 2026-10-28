import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';

const { expectRename, fixture } = createRenameFixtureHelpers();
const fixtures = fileURLToPath(new URL('../fixtures/rename-integration/zig/', import.meta.url));

async function expectRefusal(files: Record<string, string>, kind: string) {
  const { root, nodes, symbol } = await fixture(files, 'target', kind);
  for (const dry_run of [true, false]) {
    expect(
      await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes),
      `dry_run=${dry_run}`,
    ).toMatchObject({
      status: 'error',
      planning_status: 'unsupported',
      code: 'unsupported_occurrence',
      total_edits: 0,
      applied: false,
    });
    for (const [file, content] of Object.entries(files))
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
  }
}

/**
 * A resolver-independent reading of `@hasDecl(T, "x")` / `@hasField(T, "x")`
 * over plain struct text. No Zig compiler is available to the suite, so this
 * evaluates the same compile-time booleans directly from the source bytes.
 */
function evaluateReflections(source: string): string[] {
  const body = (type: string): string => {
    const open = source.indexOf('{', source.search(new RegExp(`const ${type} = struct`)));
    let depth = 0;
    for (let index = open; index < source.length; index++) {
      depth += source[index] === '{' ? 1 : source[index] === '}' ? -1 : 0;
      if (depth === 0) return source.slice(open + 1, index);
    }
    throw new Error(`Unterminated struct ${type}`);
  };
  return [...source.matchAll(/@(hasDecl|hasField)\((\w+), "(\w+)"\)/g)].map(
    ([, builtin, type = '', member = '']) => {
      const present =
        builtin === 'hasDecl'
          ? new RegExp(`\\bfn ${member}\\b|\\b(?:const|var) ${member}\\b`).test(body(type))
          : new RegExp(`(?:^|[{,])\\s*${member}\\s*:`).test(body(type));
      return `@${builtin}(${type}, "${member}") = ${present}`;
    },
  );
}

async function fixtureSource(name: string, side: 'before' | 'after'): Promise<string> {
  return fs.readFile(path.join(fixtures, name, side, 'model.zig'), 'utf8');
}

describe('Zig reflected member lookups during rename', () => {
  it.each([
    [
      '@hasDecl of the selected name through an escaped literal',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\ncomptime { if (!@hasDecl(Worker, "tar\\x67et")) @compileError("gone"); }\n',
      'Method',
    ],
    [
      '@hasDecl of the destination name',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\ncomptime { if (@hasDecl(Worker, "renamed")) @compileError("present"); }\n',
      'Method',
    ],
    [
      '@hasField of the destination name spelled with a quoted identifier',
      'const Worker = struct { target: u8 };\ncomptime { if (@hasField(Worker, "renam\\x65d")) @compileError("present"); }\n',
      'Property',
    ],
    [
      '@hasDecl on a type parameter that may be the owner',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\nfn has(comptime T: type) bool { return @hasDecl(T, "target"); }\n',
      'Method',
    ],
    [
      '@hasDecl on an alias of the owner',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\nconst Alias = Worker;\ncomptime { if (!@hasDecl(Alias, "target")) @compileError("gone"); }\n',
      'Method',
    ],
    [
      '@hasField on @This() inside the owner',
      'const Worker = struct {\n    target: u8,\n    comptime { if (!@hasField(@This(), "target")) @compileError("gone"); }\n};\n',
      'Property',
    ],
    [
      '@hasDecl with a computed name on the owner',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\nfn has(comptime name: []const u8) bool { return @hasDecl(Worker, name); }\n',
      'Method',
    ],
    [
      '@hasDecl on a container that republishes the selected owner with usingnamespace',
      'const Mixin = struct { pub fn target(self: Mixin) void { _ = self; } };\nconst Other = struct { pub usingnamespace Mixin; };\ncomptime { if (!@hasDecl(Other, "target")) @compileError("gone"); }\n',
      'Method',
    ],
    [
      '@field on a value whose type is only an alias of the owner',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\nconst Alias = Worker;\nfn call(p: Alias) void { @field(p, "target")(p); }\n',
      'Method',
    ],
  ])(
    'refuses %s',
    async (_title, content, kind) => {
      await expectRefusal({ 'model.zig': content }, kind);
    },
    60000,
  );

  it.each([
    [
      '@hasDecl of a different name on the owner',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\ncomptime { if (!@hasDecl(Worker, "targets")) @compileError("gone"); }\n',
      'const Worker = struct { pub fn renamed(self: Worker) void { _ = self; } };\ncomptime { if (!@hasDecl(Worker, "targets")) @compileError("gone"); }\n',
      'Method',
    ],
    [
      '@hasDecl of a different name on an unprovable type parameter',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\nfn has(comptime T: type) bool { return @hasDecl(T, "other"); }\n',
      'const Worker = struct { pub fn renamed(self: Worker) void { _ = self; } };\nfn has(comptime T: type) bool { return @hasDecl(T, "other"); }\n',
      'Method',
    ],
    [
      '@hasField of a different name through an escaped literal',
      'const Worker = struct { target: u8 };\ncomptime { if (@hasField(Worker, "tar\\x67ets")) @compileError("present"); }\n',
      'const Worker = struct { renamed: u8 };\ncomptime { if (@hasField(Worker, "tar\\x67ets")) @compileError("present"); }\n',
      'Property',
    ],
    [
      '@hasDecl of the selected name on a proven different container',
      'const Worker = struct { pub fn target(self: Worker) void { _ = self; } };\nconst Other = struct { pub fn target(self: Other) void { _ = self; } };\ncomptime { if (!@hasDecl(Other, "tar\\x67et")) @compileError("gone"); }\n',
      'const Worker = struct { pub fn renamed(self: Worker) void { _ = self; } };\nconst Other = struct { pub fn target(self: Other) void { _ = self; } };\ncomptime { if (!@hasDecl(Other, "tar\\x67et")) @compileError("gone"); }\n',
      'Method',
    ],
  ])(
    'renames despite %s',
    async (_title, before, after, kind) => {
      await expectRename(
        { 'model.zig': before },
        { 'model.zig': after },
        'target',
        kind,
        'renamed',
      );
    },
    60000,
  );

  describe('compile-time results read independently of the resolver', () => {
    it.each([
      [
        'reflected-hasdecl-unrelated-owner',
        ['@hasDecl(Other, "target") = true', '@hasDecl(Other, "renamed") = false'],
      ],
      [
        'reflected-hasfield-unrelated-owner',
        ['@hasField(Other, "target") = true', '@hasField(Other, "renamed") = false'],
      ],
    ])('keeps every lookup result in %s after the rename', async (name, expected) => {
      const before = evaluateReflections(await fixtureSource(name, 'before'));
      expect(before).toEqual(expected);
      expect(evaluateReflections(await fixtureSource(name, 'after'))).toEqual(before);
    });

    it.each([
      [
        'reflected-hasdecl-old-name',
        ['@hasDecl(Worker, "target") = true'],
        ['@hasDecl(Worker, "target") = false'],
      ],
      [
        'reflected-hasfield-old-name',
        ['@hasField(Worker, "target") = true'],
        ['@hasField(Worker, "target") = false'],
      ],
      [
        'reflected-hasdecl-new-name',
        ['@hasDecl(Worker, "renamed") = false'],
        ['@hasDecl(Worker, "renamed") = true'],
      ],
      [
        'reflected-hasfield-new-name',
        ['@hasField(Worker, "renamed") = false'],
        ['@hasField(Worker, "renamed") = true'],
      ],
    ])(
      'would change a lookup result in %s if only the declaration were renamed',
      async (name, expectedBefore, expectedNaive) => {
        const source = await fixtureSource(name, 'before');
        const naive = source
          .replace(/\bfn target\b/, 'fn renamed')
          .replace(/\{ target:/, '{ renamed:');
        expect(evaluateReflections(source)).toEqual(expectedBefore);
        expect(evaluateReflections(naive)).toEqual(expectedNaive);
        expect(await fixtureSource(name, 'after')).toBe(source);
      },
    );
  });
});
