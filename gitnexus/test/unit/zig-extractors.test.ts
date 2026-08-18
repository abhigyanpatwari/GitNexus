/**
 * Zig structure-phase extractors: export detection, method parameters, and
 * the variable extractor's container/import guard. Each case pins a finding
 * from the PR review of the Zig provider — the assertion is the behavior that
 * was wrong, not merely that extraction runs.
 *
 * `@tree-sitter-grammars/tree-sitter-zig` is an optionalDependency: the whole
 * file skips cleanly when it is absent, mirroring the Dart/Kotlin suites.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import Parser from 'tree-sitter';
import { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { zigExportChecker } from '../../src/core/ingestion/export-detection.js';
import { createMethodExtractor } from '../../src/core/ingestion/method-extractors/generic.js';
import { zigMethodConfig } from '../../src/core/ingestion/method-extractors/configs/zig.js';
import { createVariableExtractor } from '../../src/core/ingestion/variable-extractors/generic.js';
import { zigVariableConfig } from '../../src/core/ingestion/variable-extractors/configs/zig.js';

const _require = createRequire(import.meta.url);
let Zig: unknown = null;
try {
  Zig = _require('@tree-sitter-grammars/tree-sitter-zig');
} catch {
  // optional grammar absent on this platform — suite skips below
}

const describeZig = Zig ? describe : describe.skip;

const parser = new Parser();
const parse = (code: string) => {
  parser.setLanguage(Zig as Parser.Language);
  return parser.parse(code);
};

/** Depth-first search for the first node of `type` whose text starts with `prefix`. */
function find(root: SyntaxNode, type: string, prefix = ''): SyntaxNode {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === type && n.text.startsWith(prefix)) return n;
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  throw new Error(`no ${type} node starting with ${JSON.stringify(prefix)}`);
}

describeZig('zigExportChecker', () => {
  const src = `
pub const Point = struct {
    x: i32,
    pub fn public(self: Point) i32 { return self.x; }
    fn private(self: Point) i32 { return self.x; }
};
const Hidden = struct {
    pub fn shown() void {}
};
`;

  it('reads a method’s own `pub`, not the enclosing container’s', () => {
    // Before the fix the walk continued from a non-`pub` fn up to
    // `pub const Point`, so every private method of a public container was
    // reported exported.
    const root = parse(src).rootNode;
    expect(zigExportChecker(find(root, 'function_declaration', 'pub fn public'), 'public')).toBe(
      true,
    );
    expect(zigExportChecker(find(root, 'function_declaration', 'fn private'), 'private')).toBe(
      false,
    );
  });

  it('a `pub fn` inside a private container is still marked pub on its own terms', () => {
    const root = parse(src).rootNode;
    expect(zigExportChecker(find(root, 'function_declaration', 'pub fn shown'), 'shown')).toBe(
      true,
    );
  });

  it('container fields inherit the wrapper’s visibility', () => {
    const root = parse(src).rootNode;
    expect(zigExportChecker(find(root, 'container_field', 'x'), 'x')).toBe(true);
  });
});

describeZig('Zig MethodExtractor — receiver vs parameters', () => {
  const extractor = createMethodExtractor(zigMethodConfig);
  const ctx = { filePath: 'test.zig', language: SupportedLanguages.Zig };

  it('excludes the leading `self` receiver from `parameters` (Rust parity)', () => {
    const root = parse(`
const Counter = struct {
    n: u32,
    pub fn add(self: *Counter, by: u32) void { self.n += by; }
    pub fn make(n: u32) Counter { return .{ .n = n }; }
};
`).rootNode;
    const result = extractor.extract(find(root, 'struct_declaration'), ctx);
    expect(result).not.toBeNull();
    const byName = new Map(result!.methods.map((m) => [m.name, m]));

    const add = byName.get('add')!;
    expect(add.receiverType).toBe('*Counter');
    expect(add.parameters.map((p) => p.name)).toEqual(['by']);
    expect(add.isStatic).toBe(false);

    // No receiver: every parameter is regular, even when one is not first.
    const make = byName.get('make')!;
    expect(make.receiverType).toBeNull();
    expect(make.parameters.map((p) => p.name)).toEqual(['n']);
    expect(make.isStatic).toBe(true);
  });

  it('only a FIRST parameter named self is the receiver', () => {
    const root = parse(`
const S = struct {
    fn f(other: u32, self: u32) void { _ = other; _ = self; }
};
`).rootNode;
    const result = extractor.extract(find(root, 'struct_declaration'), ctx);
    expect(result!.methods[0].parameters.map((p) => p.name)).toEqual(['other', 'self']);
    expect(result!.methods[0].receiverType).toBeNull();
  });
});

describeZig('Zig VariableExtractor — container and import bindings are not variables', () => {
  const extractor = createVariableExtractor(zigVariableConfig);
  const ctx = { filePath: 'test.zig', language: SupportedLanguages.Zig };

  it('skips `const T = struct/enum/union {…}` and `const x = @import(…)`', () => {
    // These nodes are already emitted as Struct/Enum/Union nodes and IMPORTS
    // edges; a Variable record beside them was a duplicate.
    const root = parse(`
const std = @import("std");
pub const Point = struct { x: i32 };
const Color = enum { red, green };
const Tag = union(enum) { a: u8, b: u16 };
const limit: u32 = 10;
var count = @as(u32, 0);
`).rootNode;
    const names: string[] = [];
    for (let i = 0; i < root.namedChildCount; i++) {
      const decl = root.namedChild(i)!;
      expect(extractor.isVariableDeclaration(decl)).toBe(true); // node-type hint stays broad
      const info = extractor.extract(decl, ctx);
      if (info) names.push(info.name);
    }
    expect(names).toEqual(['limit', 'count']);
  });
});
