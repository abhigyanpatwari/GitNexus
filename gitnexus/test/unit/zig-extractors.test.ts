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
import { isOptionalGrammarRequired } from '../helpers/optional-grammar.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import { zigExportChecker } from '../../src/core/ingestion/export-detection.js';
import { createMethodExtractor } from '../../src/core/ingestion/method-extractors/generic.js';
import { zigMethodConfig } from '../../src/core/ingestion/method-extractors/configs/zig.js';
import { createVariableExtractor } from '../../src/core/ingestion/variable-extractors/generic.js';
import { zigVariableConfig } from '../../src/core/ingestion/variable-extractors/configs/zig.js';
import {
  emitZigScopeCaptures,
  isZigContainerOrImportBinding,
  isZigFileStruct,
  isZigKeywordDeclaration,
  isZigRedundantContainerCapture,
  isZigTypeShadowingBinding,
  zigCallableQualifiedName,
  zigContainerAnchor,
  zigContainerBindingName,
  zigContainerName,
  zigFileStructName,
} from '../../src/core/ingestion/languages/zig/captures.js';
import {
  interpretZigImport,
  interpretZigTypeBinding,
  normalizeZigTypeName,
} from '../../src/core/ingestion/languages/zig/interpret.js';
import {
  zigElementSpelling,
  zigOptionalPayloadSpelling,
  zigPointeeSpelling,
} from '../../src/core/ingestion/languages/zig/range-binding.js';
import { createFieldExtractor } from '../../src/core/ingestion/field-extractors/generic.js';
import { zigFieldConfig } from '../../src/core/ingestion/field-extractors/configs/zig.js';
import { zigProvider } from '../../src/core/ingestion/languages/zig.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { extract as extractScopes } from '../../src/core/ingestion/scope-extractor.js';
import { populateClassOwnedMembers } from '../../src/core/ingestion/scope-resolution/scope/walkers.js';

const _require = createRequire(import.meta.url);
let Zig: unknown = null;
try {
  Zig = _require('@tree-sitter-grammars/tree-sitter-zig');
} catch {
  // optional grammar absent on this platform — suite skips below
}

const describeZig = Zig ? describe : describe.skip;

// GITNEXUS_REQUIRE_ZIG=1 (set by the required CI jobs whose runners all have a
// prebuild) turns a missing grammar into a failure: a skipped file reports
// success, so without this the whole structure-phase suite could disappear from
// a green run. Inert wherever the grammar is genuinely optional.
describe.skipIf(!isOptionalGrammarRequired(SupportedLanguages.Zig))(
  'Zig extractors grammar presence (GITNEXUS_REQUIRE_ZIG=1)',
  () => {
    it('the optional grammar resolves, so the suite below is not green-by-skip', () => {
      expect(
        Zig,
        'GITNEXUS_REQUIRE_ZIG=1 declares the Zig grammar mandatory on this runner, but ' +
          "require('@tree-sitter-grammars/tree-sitter-zig') failed — every case below would " +
          'have skipped and the job would still be green.',
      ).not.toBeNull();
    });
  },
);

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

  it('reads the return type from function_declaration’s `type:` field (there is no `return_type`)', () => {
    // tree-sitter-zig 1.1.2 labels the type after `)` as the `type` field on
    // function_declaration — the same field NAME parameter nodes use, but on
    // a different node. There is no `return_type` field: reading that would
    // drop every Zig return type. Pin both the grammar fact and the extractor.
    const root = parse(`
const Counter = struct {
    n: u32,
    pub fn add(self: *Counter, by: u32) void { self.n += by; }
    pub fn make(n: u32) !*Counter { return error.Nope; }
};
`).rootNode;
    const addDecl = find(root, 'function_declaration', 'pub fn add');
    expect(addDecl.childForFieldName('return_type')).toBeNull();
    expect(addDecl.childForFieldName('type')?.text).toBe('void');

    const result = extractor.extract(find(root, 'struct_declaration'), ctx);
    const byName = new Map(result!.methods.map((m) => [m.name, m]));
    expect(byName.get('add')!.returnType).toBe('void');
    expect(byName.get('make')!.returnType).toBe('!*Counter');
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

  it('an `@import` in TYPE position (`var x: @import("m.zig").T = undefined;`) still declares the variable', () => {
    // The import-binding guard used to scan every named child, so the type
    // annotation's `@import` made `x` look like an import binding and no
    // Variable was emitted; a typed import binding (value position) stays out.
    const root = parse(`
var x: @import("m.zig").T = undefined;
const y: type = @import("m.zig");
const z = @import("m.zig").T;
`).rootNode;
    const names: string[] = [];
    const importBindings: boolean[] = [];
    for (let i = 0; i < root.namedChildCount; i++) {
      const decl = root.namedChild(i)!;
      importBindings.push(isZigContainerOrImportBinding(decl));
      const info = extractor.extract(decl, ctx);
      if (info) names.push(info.name);
    }
    expect(importBindings).toEqual([false, true, true]);
    expect(names).toEqual(['x']);
  });

  it('reads the type from the `type:` field and never from the initializer', () => {
    // The old positional fallback returned `target` as the type of
    // `const f = target;` and gave up on compound annotations (`*Foo`).
    const root = parse(`
const f = target;
const p: *Foo = undefined;
const q: ?[]const u8 = null;
const n: u32 = 1;
extern var g: T;
`).rootNode;
    const types: Array<string | null> = [];
    for (let i = 0; i < root.namedChildCount; i++) {
      const info = extractor.extract(root.namedChild(i)!, ctx);
      types.push(info?.type ?? null);
    }
    expect(types).toEqual([null, '*Foo', '?[]const u8', 'u32', 'T']);
  });
});

describeZig('Zig scope captures — `@import` in TYPE position is not an import binding', () => {
  it('`var x: @import("m.zig").T = undefined;` binds a variable `x`, keeps the file edge, imports no name', () => {
    // Every import rule matches a `variable_declaration` with an `@import`
    // child; the grammar's only field is `type:`, so a type annotation
    // spelled through `@import` matched too and bound `x` as a NAMED import of
    // `T` — a variable typed by an imported type became an alias of the type.
    const matches = emitZigScopeCaptures(
      'var x: @import("m.zig").T = undefined;\nconst z = @import("n.zig").T;\n',
      'test.zig',
    );
    const importNames = matches
      .filter((m) => m['@import.name'] !== undefined)
      .map((m) => `${m['@import.name']!.text}<-${m['@import.imported']?.text ?? '*'}`);
    expect(importNames).toEqual(['z<-T']);
    const variables = matches
      .filter((m) => m['@declaration.variable'] !== undefined)
      .map((m) => m['@declaration.name']!.text);
    expect(variables).toEqual(['x']);
    // The type-position `@import` still counts as a file dependency (a
    // side-effect import); the value-position one is claimed by its binding.
    const sideEffects = matches
      .filter((m) => m['@import.side-effect'] !== undefined)
      .map((m) => m['@import.source']!.text);
    expect(sideEffects).toEqual(['"m.zig"']);
  });
});

describeZig('Zig scope captures — receiver is the FIRST parameter named self', () => {
  function parameterBindings(src: string) {
    return emitZigScopeCaptures(src, 'test.zig')
      .filter((m) => m['@type-binding.parameter'] !== undefined)
      .map((m) => interpretZigTypeBinding(m))
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .map((b) => `${b.boundName}:${b.source}`);
  }

  it('marks a leading self as the receiver and later parameters as annotations', () => {
    expect(parameterBindings('const S = struct { fn m(self: *S, other: u32) void {} };')).toEqual([
      'self:self',
      'other:parameter-annotation',
    ]);
  });

  it('a later parameter named self is an ordinary parameter, not a receiver', () => {
    // Legal Zig; `zigReceiverBinding` picks the `self`-sourced binding, so
    // sourcing this one as `self` would turn a static fn into an instance method.
    expect(parameterBindings('const S = struct { fn f(other: u32, self: S) void {} };')).toEqual([
      'other:parameter-annotation',
      'self:parameter-annotation',
    ]);
  });
});

describeZig('Zig callable-flow captures — member calls, receiver formals, decl literals', () => {
  const src = `
const Slot = struct {
    n: u32 = 0,
    pub fn release(self: *Slot) void { self.n = 0; }
};
const Global = struct {
    slot: *Slot,
    pub fn deinit(self: Global) void { self.slot.release(); }
    pub const release = deinit;
};
const Runner = struct {
    pub fn run(self: *Runner, cb: *const fn (u32) void) void { _ = self; cb(2); }
};
fn target(x: u32) void { _ = x; }
fn invoke(cb: *const fn (u32) void) void { cb(1); }
const helpers = struct {
    pub fn apply(cb: *const fn (u32) void) void { cb(3); }
};
pub fn main() void {
    var r: Runner = undefined;
    r.run(target);
    Runner.run(&r, target);
    helpers.apply(target);
    invoke(target);
    const reg: Runner = .init(target);
    _ = reg;
}
`;
  const flow = () =>
    emitZigScopeCaptures(src, 'test.zig').filter((m) =>
      Object.keys(m).some((k) => k.startsWith('@callable-flow.')),
    );
  const argumentFacts = () =>
    flow()
      .filter((m) => m['@callable-flow.argument'] !== undefined)
      .map((m) => ({
        call: m['@callable-flow.argument']!.text,
        source: m['@callable-flow.source']!.text,
        index: m['@callable-flow.parameter-index']!.text,
        directCallee: m['@callable-flow.direct-callee-name']?.text,
      }));

  it('a member call `r.run(target)` is NOT a direct call named `run` (no direct-callee-name)', () => {
    // With the name attached, the solver seeded the argument into EVERY
    // callable named `run` in the repo (thousands of cap warnings on Lightpanda,
    // `deinit → deinit` self-loops). tree-sitter-zig spells the member field
    // `member:`; the shared reader must see it.
    expect(argumentFacts()).toContainEqual({
      call: 'r.run(target)',
      source: 'target',
      index: '1',
      directCallee: undefined,
    });
  });

  it('a free call keeps its direct-callee-name so `invoke(target)` still joins `invoke`', () => {
    expect(argumentFacts()).toContainEqual({
      call: 'invoke(target)',
      source: 'target',
      index: '0',
      directCallee: 'invoke',
    });
  });

  it('both method-call spellings put the callback at the same index as formal `cb@1`', () => {
    // Formals keep the explicit `self` at 0. The implicit receiver of
    // `r.run(target)` is prepended as actual 0; the explicit
    // `Runner.run(&r, target)` already spells it. Slicing `self` off the
    // formals instead lined up only the implicit form (PR #1432 review).
    const runFormals = flow()
      .filter(
        (m) =>
          m['@callable-flow.formal'] !== undefined && m['@callable-flow.owner']!.text === 'run',
      )
      .map(
        (m) => `${m['@callable-flow.binding']!.text}@${m['@callable-flow.parameter-index']!.text}`,
      );
    expect(runFormals).toEqual(['self@0', 'cb@1']);
    const targetIndexByCall = argumentFacts()
      .filter((f) => f.source === 'target')
      .map((f) => `${f.call} → ${f.index}`);
    expect(targetIndexByCall).toContain('r.run(target) → 1');
    expect(targetIndexByCall).toContain('Runner.run(&r, target) → 1');
  });

  it('a namespace receiver `helpers.apply(target)` passes nothing implicitly (actual stays at 0)', () => {
    // `helpers` is a module-level container, not a fn-local value: prepending
    // it would shift the callback off formal `cb@0`.
    expect(argumentFacts()).toContainEqual({
      call: 'helpers.apply(target)',
      source: 'target',
      index: '0',
      directCallee: undefined,
    });
  });

  it('a decl-literal call `.init(target)` (inferred-type receiver) has no direct-callee-name', () => {
    // `.init` names no callee the solver may look up by simple name — Lightpanda
    // has hundreds of `init`s, and each such site fanned out to all of them.
    expect(argumentFacts()).toContainEqual({
      call: '.init(target)',
      source: 'target',
      index: '0',
      directCallee: undefined,
    });
  });

  it('a container-level alias `pub const release = deinit;` does not turn `self.slot.release()` into an invoke through it', () => {
    // The alias is a plain-name binding, not a store into Slot's `release`
    // member; gating on it produced the `Global.deinit → Global.deinit` self-loop.
    const invokes = flow()
      .filter((m) => m['@callable-flow.invoke'] !== undefined)
      .map((m) => m['@callable-flow.invoke']!.text);
    expect(invokes).not.toContain('self.slot.release()');
    // The alias itself is still a seed (`Global.release` really is `deinit`).
    expect(
      flow().some(
        (m) =>
          m['@callable-flow.seed'] !== undefined &&
          m['@callable-flow.destination']!.text === 'release' &&
          m['@callable-flow.target']!.text === 'deinit',
      ),
    ).toBe(true);
  });
});

describeZig('Zig `export` (C-ABI) visibility', () => {
  const src = `
export fn c_add(a: i32, b: i32) i32 { return a + b; }
fn hidden() void {}
export const table: [4]u8 = .{ 0, 0, 0, 0 };
`;

  it('zigExportChecker treats `export fn` as exported without `pub`', () => {
    // `export` is C-ABI linkage — the FFI entry point form — and never
    // carries `pub`. A `pub`-only check reported every C-ABI symbol private.
    const root = parse(src).rootNode;
    expect(zigExportChecker(find(root, 'function_declaration', 'export fn c_add'), 'c_add')).toBe(
      true,
    );
    expect(zigExportChecker(find(root, 'function_declaration', 'fn hidden'), 'hidden')).toBe(false);
    expect(zigExportChecker(find(root, 'variable_declaration', 'export const'), 'table')).toBe(
      true,
    );
  });

  it('`export` is C linkage, not Zig visibility: isExported true, visibility private, `pub` public', () => {
    // Language reference: only `pub` declarations are reachable from another
    // file through `@import`; `export` puts the symbol in the object file for
    // C callers and leaves it PRIVATE to Zig code. The graph keeps both facts
    // in their own property: `isExported` (visible outside the compilation
    // unit — the FFI surface, same reading as C external linkage) and
    // `visibility` (the Zig-module fact). Reporting `export fn` as `public`
    // let the resolver connect a cross-file call Zig would reject.
    const root = parse(`
const C = struct {
    export fn cb(self: *C) void { _ = self; }
    pub fn open(self: *C) void { _ = self; }
    fn hidden(self: *C) void { _ = self; }
};
export var counter: u32 = 0;
pub var visible: u32 = 0;
`).rootNode;
    const methods = createMethodExtractor(zigMethodConfig).extract(
      find(root, 'struct_declaration'),
      { filePath: 'test.zig', language: SupportedLanguages.Zig },
    );
    const vis = (name: string) => methods!.methods.find((m) => m.name === name)!.visibility;
    expect(vis('cb')).toBe('private');
    expect(vis('open')).toBe('public');
    expect(vis('hidden')).toBe('private');
    expect(zigExportChecker(find(root, 'function_declaration', 'export fn cb'), 'cb')).toBe(true);
    const variables = createVariableExtractor(zigVariableConfig);
    const ctx = { filePath: 'test.zig', language: SupportedLanguages.Zig };
    expect(
      variables.extract(find(root, 'variable_declaration', 'export var'), ctx)!.visibility,
    ).toBe('private');
    expect(variables.extract(find(root, 'variable_declaration', 'pub var'), ctx)!.visibility).toBe(
      'public',
    );
  });
});

describeZig('Zig test declarations', () => {
  const extractor = createMethodExtractor(zigMethodConfig);
  const src = `
fn add(a: i32, b: i32) i32 { return a + b; }
test "add works" { _ = add(1, 2); }
test { _ = add(3, 4); }
test add { _ = add(5, 6); }
`;

  it('names a `test "…"` block by its string node, quotes included, in the enclosing-function walk', () => {
    // Must be byte-equal to the `@name` capture in ZIG_QUERIES (the string
    // node) so calls inside attribute to the test's own node — and the quotes
    // are what keep `test "add"` and `fn add` from sharing Function:<file>:add.
    const root = parse(src).rootNode;
    const named = extractor.extractFunctionName!(
      find(root, 'test_declaration', 'test "add works"'),
    );
    expect(named).toEqual({ funcName: '"add works"', label: 'Function' });
  });

  it('returns an EMPTY name — never null — for anonymous and decl-form tests', () => {
    // `null` would fall through to `genericFuncName`, whose first-identifier
    // scan names `test add {}` "add": the REAL `fn add`'s id, so the test
    // body's calls would hang on the function under test. `''` stops the walk
    // here and lets the caller fall back to the File.
    const root = parse(src).rootNode;
    expect(extractor.extractFunctionName!(find(root, 'test_declaration', 'test {'))).toEqual({
      funcName: '',
      label: 'Function',
    });
    expect(extractor.extractFunctionName!(find(root, 'test_declaration', 'test add'))).toEqual({
      funcName: '',
      label: 'Function',
    });
  });

  it('declines (null) for anything that is not a test_declaration', () => {
    const root = parse(src).rootNode;
    expect(extractor.extractFunctionName!(find(root, 'function_declaration'))).toBeNull();
  });

  it('scope captures: a named test is a Function scope with a matching def; anonymous tests are scopes only', () => {
    const matches = emitZigScopeCaptures(src, 'test.zig');
    const fnScopes = matches.filter((m) => m['@scope.function'] !== undefined);
    // fn add + 3 test blocks
    expect(fnScopes).toHaveLength(4);
    const fnDefs = matches
      .filter((m) => m['@declaration.function'] !== undefined)
      .map((m) => m['@declaration.name']!.text);
    expect(fnDefs).toEqual(['add', '"add works"']);
  });

  it('a test inside a container stays a Function — the method extractor cannot describe it', () => {
    const src2 = `
const S = struct {
    fn m(self: S) void { _ = self; }
    test "S works" { _ = S{}; }
};
`;
    const labels = emitZigScopeCaptures(src2, 'test.zig')
      .filter(
        (m) => m['@declaration.function'] !== undefined || m['@declaration.method'] !== undefined,
      )
      .map((m) => (m['@declaration.method'] !== undefined ? 'method' : 'function'));
    expect(labels).toEqual(['method', 'function']);
  });
});

describeZig('Zig opaque and empty containers', () => {
  it('captures `const H = opaque { … }` as a Struct-labelled class scope owning its methods', () => {
    const src = `
pub const H = opaque {
    pub fn close(self: *H) void { _ = self; }
};
`;
    const matches = emitZigScopeCaptures(src, 'test.zig');
    const struct = matches.find((m) => m['@declaration.struct'] !== undefined);
    expect(struct?.['@declaration.name']?.text).toBe('H');
    expect(matches.some((m) => m['@declaration.method'] !== undefined)).toBe(true);
    // No stray plain-variable binding for the container wrapper.
    expect(
      matches.some(
        (m) => m['@declaration.variable'] !== undefined && m['@declaration.name']?.text === 'H',
      ),
    ).toBe(false);
  });

  it('does not emit a nameless field for an empty container body', () => {
    // tree-sitter-zig 1.1.2 recovers `struct {}` / `opaque {}` as a
    // container_field whose identifier is a zero-width MISSING node.
    const fields = emitZigScopeCaptures('const E = struct {};\nconst O = opaque {};\n', 'test.zig')
      .filter((m) => m['@declaration.field'] !== undefined)
      .map((m) => m['@declaration.name']!.text);
    expect(fields).toEqual([]);
  });
});

describeZig('Zig declarations vs statement assignments (tree-sitter-zig 1.1.2 quirk)', () => {
  const src = `
var count: u32 = 0;
fn inc() void {
    count = 5;
    count += 1;
    _ = inc;
    const local = 1;
    var m: u32 = undefined;
    _ = local; _ = m;
}
`;

  it('`x = 5;`, `x += 1;` and `_ = expr;` are keyword-less variable_declarations, not bindings', () => {
    // The grammar reuses `variable_declaration` for statement assignments; the
    // `const` / `var` keyword child is the only thing that tells them apart.
    // Without the gate every assignment minted a phantom local (one `_` per
    // discard) and, on the structure side, a Const/Variable node per statement.
    const root = parse(src).rootNode;
    const decls: SyntaxNode[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n.type === 'variable_declaration') decls.push(n);
      n.children.forEach(walk);
    };
    walk(root);
    const verdicts = decls.map((d) => [d.text.split('\n')[0]!.trim(), isZigKeywordDeclaration(d)]);
    expect(verdicts).toEqual([
      ['var count: u32 = 0;', true],
      ['count = 5;', false],
      ['count += 1;', false],
      ['_ = inc;', false],
      ['const local = 1;', true],
      ['var m: u32 = undefined;', true],
      ['_ = local;', false],
      ['_ = m;', false],
    ]);
  });

  it('the variable extractor declines an assignment and the scope walker binds only real declarations', () => {
    const root = parse(src).rootNode;
    const extractor = createVariableExtractor(zigVariableConfig);
    const ctx = { filePath: 'x.zig', language: SupportedLanguages.Zig };
    expect(extractor.extract(find(root, 'variable_declaration', 'count = 5'), ctx)).toBeNull();
    expect(extractor.extract(find(root, 'variable_declaration', 'const local'), ctx)?.name).toBe(
      'local',
    );
    const bound = emitZigScopeCaptures(src, 'x.zig')
      .filter((m) => m['@declaration.variable'] !== undefined)
      .map((m) => m['@declaration.name']?.text);
    expect(bound).toEqual(['count', 'local', 'm']);
  });
});

describeZig('Zig import forms', () => {
  it('a member alias off @import and a usingnamespace are import bindings, not variables', () => {
    // `const Foo = @import("x.zig").Foo;` is the single-symbol import Zig is
    // written with; treating it as a plain Const lost the file edge and left
    // `Foo{}` untyped. `pub usingnamespace @import(...)` has no name at all.
    const root = parse(`
const std = @import("std");
const Foo = @import("foo.zig").Foo;
const Alloc = @import("std").mem.Allocator;
const plain = 1;
`).rootNode;
    expect(isZigContainerOrImportBinding(find(root, 'variable_declaration', 'const std'))).toBe(
      true,
    );
    expect(isZigContainerOrImportBinding(find(root, 'variable_declaration', 'const Foo'))).toBe(
      true,
    );
    expect(isZigContainerOrImportBinding(find(root, 'variable_declaration', 'const Alloc'))).toBe(
      true,
    );
    expect(isZigContainerOrImportBinding(find(root, 'variable_declaration', 'const plain'))).toBe(
      false,
    );
  });

  it('interprets namespace, named, alias, wildcard and namespace-member forms', () => {
    const src = `
const c = @import("net/counter.zig");
const Counter = c.Counter;
const Renamed = @import("counter.zig").Counter;
const Same = @import("counter.zig").Same;
const Deep = @import("std").mem.Allocator;
pub usingnamespace @import("mixin.zig");
const notAnImport = other.Thing;
test {
    _ = @import("all_tests.zig");
    x = @import("keyword_less.zig");
}
`;
    const imports = emitZigScopeCaptures(src, 'x.zig')
      .filter((m) => m['@import.source'] !== undefined)
      .map((m) => interpretZigImport(m));
    expect(imports).toEqual([
      // namespace: localName is the handle, importedName the MODULE (contract:
      // Go `import foo "pkg/bar"` records `bar`), never the handle.
      { kind: 'namespace', localName: 'c', importedName: 'counter', targetRaw: 'net/counter.zig' },
      // …and its TYPE twin: the same binding also names the file-struct the
      // target declares (`counter.zig` → `counter`), so `x: *c` can dispatch on
      // it. Binds nothing when the target is only a namespace.
      {
        kind: 'alias',
        localName: 'c',
        importedName: 'counter',
        alias: 'c',
        targetRaw: 'net/counter.zig',
      },
      // alias of a namespace member → promoted to a named import of that member
      {
        kind: 'named',
        localName: 'Counter',
        importedName: 'Counter',
        targetRaw: 'net/counter.zig',
      },
      {
        kind: 'alias',
        localName: 'Renamed',
        importedName: 'Counter',
        alias: 'Renamed',
        targetRaw: 'counter.zig',
      },
      { kind: 'named', localName: 'Same', importedName: 'Same', targetRaw: 'counter.zig' },
      {
        kind: 'alias',
        localName: 'Deep',
        importedName: 'Allocator',
        alias: 'Deep',
        targetRaw: 'std',
      },
      { kind: 'wildcard', targetRaw: 'mixin.zig' },
      // `_ = @import(...)` and any keyword-less `<ident> = @import(...)` are
      // statements (no `const`/`var`): a file reference, not a binding.
      { kind: 'side-effect', targetRaw: 'all_tests.zig' },
      { kind: 'side-effect', targetRaw: 'keyword_less.zig' },
    ]);
    // `other` is not an @import binding of this file → stays a variable.
    const vars = emitZigScopeCaptures(src, 'x.zig')
      .filter((m) => m['@declaration.variable'] !== undefined)
      .map((m) => m['@declaration.name']?.text);
    expect(vars).toEqual(['notAnImport']);
  });

  it('emits a side-effect import for every @import in EXPRESSION position, once per source, never doubling a bound one', () => {
    // Both query sets only saw `@import` as the value of a const/var (or
    // under `usingnamespace`). Lightpanda's `Interfaces = .{ @import(…), … }`
    // table (288 modules), `CounterEnum("size", @import("ArenaPool.zig").BucketSize)`
    // (call argument), `event.is(@import("x.zig"))` and
    // `JsApi == @import("x.zig").JsApi` (comparison) all produced NO file
    // edge: 487 of 3,471 in-repo import pairs missing. Each is a dependency
    // without a name — a side-effect import — and the same file spelled
    // twice, or spelled inline AND bound to a const, gets one edge, not two.
    const src = `
const std = @import("std");
const c = @import("counter.zig");
pub const Interfaces = .{ @import("a.zig"), @import("b.zig"), @import("a.zig") };
const size = CounterEnum("size", @import("ArenaPool.zig").BucketSize);
pub fn f() void {
    if (event.is(@import("event/MouseEvent.zig"))) {}
    if (JsApi == @import("cdata/Text.zig").JsApi) {}
    _ = @import("counter.zig").Extra;
    _ = std.mem;
}
`;
    const imports = emitZigScopeCaptures(src, 'x.zig')
      .filter((m) => m['@import.source'] !== undefined)
      .map((m) => interpretZigImport(m));
    expect(imports).toEqual([
      { kind: 'namespace', localName: 'std', importedName: 'std', targetRaw: 'std' },
      { kind: 'namespace', localName: 'c', importedName: 'counter', targetRaw: 'counter.zig' },
      // the namespace import's file-struct TYPE twin (see the file-struct suite)
      {
        kind: 'alias',
        localName: 'c',
        importedName: 'counter',
        alias: 'c',
        targetRaw: 'counter.zig',
      },
      { kind: 'side-effect', targetRaw: 'a.zig' },
      { kind: 'side-effect', targetRaw: 'b.zig' },
      { kind: 'side-effect', targetRaw: 'ArenaPool.zig' },
      { kind: 'side-effect', targetRaw: 'event/MouseEvent.zig' },
      { kind: 'side-effect', targetRaw: 'cdata/Text.zig' },
      // `@import("counter.zig").Extra` in a discard: counter.zig is already
      // bound above (`const c = …`) — no second edge, and no phantom binding.
    ]);
    // The tuple binds `Interfaces` as an ordinary Const (its value is a
    // struct literal, not an import); the discard binds nothing.
    const vars = emitZigScopeCaptures(src, 'x.zig')
      .filter((m) => m['@declaration.variable'] !== undefined)
      .map((m) => m['@declaration.name']?.text);
    expect(vars).toEqual(['Interfaces', 'size']);
  });

  it('binds an inline import used as a member-call receiver under its own text, so `@import("dump.zig").root()` resolves', () => {
    // `try @import("dump.zig").root(…)` (80 sites in Lightpanda, 0 resolved):
    // the receiver is the builtin, not a const handle. Emitting a namespace
    // import whose local name IS the receiver text lets the shared
    // namespace-receiver lookup (`namespaceTargets.get(receiverText)`) find
    // dump.zig. One binding per distinct source; a deeper chain
    // (`@import("x.zig").Foo.init()`) is not a module receiver and stays a
    // plain side-effect import.
    const src = `
pub fn f() !void {
    try @import("dump.zig").root(1);
    @import("dump.zig").other();
    _ = @import("../id.zig").uuidv4(&buf);
    _ = @import("x.zig").Foo.init();
}
`;
    const groups = emitZigScopeCaptures(src, 'x.zig');
    const imports = groups
      .filter((m) => m['@import.source'] !== undefined)
      .map((m) => interpretZigImport(m));
    expect(imports).toEqual([
      {
        kind: 'namespace',
        localName: '@import("dump.zig")',
        importedName: 'dump',
        targetRaw: 'dump.zig',
      },
      {
        kind: 'namespace',
        localName: '@import("../id.zig")',
        importedName: 'id',
        targetRaw: '../id.zig',
      },
      { kind: 'side-effect', targetRaw: 'x.zig' },
    ]);
    // The receiver capture on the call carries exactly the binding's text —
    // that identity is what makes the lookup succeed.
    const receivers = groups
      .filter((m) => m['@reference.call.member'] !== undefined)
      .map((m) => m['@reference.receiver']?.text);
    expect(receivers).toEqual([
      '@import("dump.zig")',
      '@import("dump.zig")',
      '@import("../id.zig")',
      '@import("x.zig").Foo',
    ]);
  });

  it('a function-scoped @import is not deferred: Zig imports are compile-time (importsExecuteWhereWritten: false)', () => {
    // C `#include` and Rust `use` answer the same. Without the flag the scope
    // extractor marks a body-level `@import` `runsOnlyWhenCalled`, hiding a
    // real import cycle through it from `check --cycles`.
    const src = `
pub fn run() void {
    const helper = @import("helper.zig");
    helper.go();
}
`;
    const result = extractScopes(emitZigScopeCaptures(src, 'x.zig'), 'x.zig', zigProvider);
    const helper = result.parsedImports.find((i) => i.targetRaw === 'helper.zig');
    expect(helper).toBeDefined();
    expect(helper!.runsOnlyWhenCalled).toBeUndefined();
  });

  it('the provider skips the Const capture for container and @import bindings', () => {
    const root = parse(`
const std = @import("std");
const Foo = @import("foo.zig").Foo;
const S = struct {};
const n = 1;
`).rootNode;
    const skip = (prefix: string) =>
      zigProvider.shouldSkipDefinitionCapture!(
        { 'definition.const': find(root, 'variable_declaration', prefix) },
        'Const',
      );
    expect(skip('const std')).toBe(true);
    expect(skip('const Foo')).toBe(true);
    expect(skip('const S')).toBe(true);
    expect(skip('const n')).toBe(false);
  });
});

describeZig('Zig generic type constructors', () => {
  const src = `
pub fn Stack(comptime T: type) type {
    return struct {
        items: []T = &.{},
        pub fn push(self: *@This(), v: T) void { _ = self; _ = v; }
    };
}
fn notAType(comptime T: type) u32 {
    return struct { pub fn x() u32 { return 1; } }.x();
}
const Plain = struct { a: u8 };
`;

  it('names the container returned by a fn returning `type` after that fn; an anonymous container is keyed by its host (F8)', () => {
    const root = parse(src).rootNode;
    const structs: SyntaxNode[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n.type === 'struct_declaration') structs.push(n);
      n.children.forEach(walk);
    };
    walk(root);
    // `struct { … }.x()` inside `notAType` has no binding name; its identity
    // is `<enclosing fn>$<ordinal>` so its fn `x` is a Method WITH an owner.
    expect(structs.map((n) => zigContainerBindingName(n))).toEqual(['Stack', undefined, 'Plain']);
    expect(structs.map((n) => zigContainerName(n))).toEqual(['Stack', 'notAType$1', 'Plain']);
  });

  it('the method and field extractors own the generic container’s members under the fn name', () => {
    const root = parse(src).rootNode;
    const container = find(root, 'struct_declaration', 'struct {\n        items');
    const ctx = { filePath: 'x.zig', language: SupportedLanguages.Zig };
    const methods = createMethodExtractor(zigMethodConfig).extract(container, ctx);
    expect(methods?.ownerName).toBe('Stack');
    expect(methods?.methods.map((m) => m.name)).toEqual(['push']);
    const fields = createFieldExtractor(zigFieldConfig).extract(container, {
      ...ctx,
      typeEnv: {
        lookup: () => undefined,
        constructorBindings: [],
        fileScope: () => new Map(),
        allScopes: () => new Map(),
        constructorTypeMap: new Map(),
      } as unknown as import('../../src/core/ingestion/type-env.js').TypeEnvironment,
      symbolTable: createSemanticModel().symbols,
    });
    expect(fields?.ownerFqn).toBe('Stack');
    expect(fields?.fields.map((f) => f.name)).toEqual(['items']);
  });

  it('normalizes generic instantiations to the constructor name and leaves builtins alone', () => {
    expect(normalizeZigTypeName('List(u8)')).toBe('List');
    expect(normalizeZigTypeName('*std.ArrayList(u8)')).toBe('std.ArrayList');
    expect(normalizeZigTypeName('?*const Stack(u16)')).toBe('Stack');
    expect(normalizeZigTypeName('@This()')).toBe('@This()');
    expect(normalizeZigTypeName('*const @This()')).toBe('@This()');
    expect(normalizeZigTypeName('[]const u8')).toBe('u8');
  });
});

describeZig('Zig receiver typing sources', () => {
  it('annotation and call-return bindings type receivers; a discard is never a binding', () => {
    const src = `
pub fn run() void {
    var a = Counter.init();
    var b: Counter = undefined;
    const c: Counter = .init();
    var d = counter.Counter.init();
    var e = Stack(u8).init();
    _ = e.top();
}
`;
    const bindings = emitZigScopeCaptures(src, 'x.zig')
      .filter((m) => m['@type-binding.name'] !== undefined)
      .map((m) => interpretZigTypeBinding(m));
    expect(bindings).toEqual([
      { boundName: 'a', rawTypeName: 'Counter', source: 'constructor-inferred' },
      { boundName: 'b', rawTypeName: 'Counter', source: 'annotation' },
      { boundName: 'c', rawTypeName: 'Counter', source: 'annotation' },
      { boundName: 'd', rawTypeName: 'counter.Counter', source: 'constructor-inferred' },
      { boundName: 'e', rawTypeName: 'Stack', source: 'constructor-inferred' },
    ]);
  });

  // F7 — `const X = <type expr>;` was a plain `@declaration.variable` and
  // nothing else, so `LocalAlias.mk()`, `T2.make()`, `B.init()`, `var x: B`
  // and `B{}` all typed nothing (see the r3-flow b1..b9 repro). The alias
  // name must carry a typeBinding to the value's type text.
  it('binds a type alias (`const X = Local;` / `const B = util.List(u8);`) to its target type', () => {
    const src = `
const util = @import("util.zig");
const Stack = @import("counter.zig").Stack;
const Thing = util.Thing;
const Local = struct {};
const LocalAlias = Local;
const T2 = Thing;
const B = util.List(u8);
pub const bridge = js.Bridge(Local);
const max = 5;
const log = std.log.scoped(.x);
const t = util.makeThing();
const val = lp.log;
fn body(orig: *Local) void {
    const R = util.List(u16);
    var r = R.init();
    var cur = orig;
    const lit = .foo;
    var und: Local = undefined;
    _ = r;
    _ = cur;
    _ = lit;
    _ = und;
}
`;
    const bindings = emitZigScopeCaptures(src, 'x.zig')
      .filter((m) => m['@type-binding.name'] !== undefined)
      .map((m) => interpretZigTypeBinding(m));
    // Same-file struct, alias of an alias, instantiated generic type
    // constructor (module level and inside a fn body), a TitleCase call
    // through a namespace member.
    expect(bindings).toEqual(
      expect.arrayContaining([
        { boundName: 'LocalAlias', rawTypeName: 'Local', source: 'assignment-inferred' },
        { boundName: 'T2', rawTypeName: 'Thing', source: 'assignment-inferred' },
        { boundName: 'B', rawTypeName: 'util.List', source: 'assignment-inferred' },
        { boundName: 'bridge', rawTypeName: 'js.Bridge', source: 'assignment-inferred' },
        { boundName: 'R', rawTypeName: 'util.List', source: 'assignment-inferred' },
        // the receiver of `R.init()` chains to `R`, then to `util.List`
        { boundName: 'r', rawTypeName: 'R', source: 'constructor-inferred' },
        // a `var` VALUE alias (Rust `let x = y`) chains to `orig`'s type
        { boundName: 'cur', rawTypeName: 'orig', source: 'assignment-inferred' },
      ]),
    );
    // `.foo` (enum / decl literal) is a field_expression without an object:
    // a value, never a type name.
    expect(bindings.find((b) => b?.boundName === 'lit')).toBeUndefined();
    // `var und: Local = undefined;` — `undefined` is an anonymous node, so the
    // last named child is the annotation: the alias rule must not read it as
    // a value (the annotation rule owns the binding, exactly once).
    expect(bindings.filter((b) => b?.boundName === 'und')).toEqual([
      { boundName: 'und', rawTypeName: 'Local', source: 'annotation' },
    ]);
    // A type-constructor instantiation gets exactly ONE binding: the
    // call-return rule (`B` ↦ `util`, the call's receiver) must not compete.
    expect(bindings.filter((b) => b?.boundName === 'B')).toHaveLength(1);
    expect(bindings.filter((b) => b?.boundName === 'R')).toHaveLength(1);
    // A promoted namespace-member alias is a named import, not an alias
    // binding; a value const / a camelCase call are not type aliases.
    expect(bindings.find((b) => b?.boundName === 'Thing')).toBeUndefined();
    // …nor is an @import binding of one member (`@import("counter.zig").Stack`
    // is a field_expression too): an alias binding there would shadow the
    // import binding for `Stack(u8){}` and `Stack(u8).init()`.
    expect(bindings.find((b) => b?.boundName === 'Stack')).toBeUndefined();
    expect(bindings.find((b) => b?.boundName === 'max')).toBeUndefined();
    // A value call (camelCase callee) is the call-return rule's alone: no
    // alias binding to `std.log.scoped` / `util.makeThing`.
    expect(bindings.filter((b) => b?.boundName === 'log').map((b) => b?.source)).not.toContain(
      'assignment-inferred',
    );
    expect(bindings.filter((b) => b?.boundName === 't').map((b) => b?.source)).not.toContain(
      'assignment-inferred',
    );
    // A value member alias binds like Rust's `let x = y` (resolves nothing).
    expect(bindings).toContainEqual({
      boundName: 'val',
      rawTypeName: 'lp.log',
      source: 'assignment-inferred',
    });
  });

  it('an annotation on the same name outranks the alias binding (`const x: T = y;`)', () => {
    // 'assignment-inferred' (strength 1) vs 'annotation' (3): the declared
    // type wins in the extractor's per-scope merge. Verified end to end
    // through `extract`, which is where the strengths are compared.
    const src = `
const Foo = struct { pub fn f(self: *Foo) void { _ = self; } };
const Bar = struct {};
const y = Bar;
pub fn run() void {
    const x: Foo = y;
    x.f();
}
`;
    const parsed = extractScopes(emitZigScopeCaptures(src, 'x.zig'), 'x.zig', zigProvider);
    const xs = parsed.scopes.map((s) => s.typeBindings.get('x')).filter((b) => b !== undefined);
    expect(xs).toEqual([expect.objectContaining({ rawName: 'Foo', source: 'annotation' })]);
  });
});

describeZig(
  'Zig file-structs (a file with top-level fields IS a struct named after the file)',
  () => {
    const FILE_STRUCT = `
const std = @import("std");
const Page = @This();
const Session = @import("Session.zig");
session: *Session,
count: u32 = 0,
pub fn init(session: *Session) Page { return .{ .session = session }; }
pub fn getArena(self: *Page) u32 { return self.count; }
`;
    const NAMESPACE = `
const util = @This();
pub fn helper() u32 { return 1; }
`;

    it('detects a file-struct by its top-level fields, never by the @This() alias alone', () => {
      expect(isZigFileStruct(parse(FILE_STRUCT).rootNode)).toBe(true);
      expect(isZigFileStruct(parse(NAMESPACE).rootNode)).toBe(false);
      // An empty container body is recovered with a MISSING placeholder field.
      expect(isZigFileStruct(parse('').rootNode)).toBe(false);
    });

    it('names the type after the FILE STEM, on every platform spelling', () => {
      expect(zigFileStructName('src/browser/Page.zig')).toBe('Page');
      expect(zigFileStructName('src\\browser\\Sighandler.zig')).toBe('Sighandler');
      const root = parse(FILE_STRUCT).rootNode;
      expect(zigContainerName(root, 'src/Page.zig')).toBe('Page');
      // A namespace file is not a container, whatever it aliases itself as.
      expect(zigContainerName(parse(NAMESPACE).rootNode, 'src/util.zig')).toBeUndefined();
      // No path, no name — the caller must supply it.
      expect(zigContainerName(root)).toBeUndefined();
    });

    it('emits a Class scope + Struct def over the whole file and relabels top-level fns Method', () => {
      const caps = emitZigScopeCaptures(FILE_STRUCT, 'src/Page.zig');
      const structDef = caps.find((m) => m['@declaration.struct'] !== undefined);
      expect(structDef?.['@declaration.name']?.text).toBe('Page');
      // The Class scope and the Struct def share the file's own range.
      const classScope = caps.find(
        (m) =>
          m['@scope.class'] !== undefined &&
          m['@scope.class'].range.endLine === structDef?.['@declaration.struct']?.range.endLine,
      );
      expect(classScope).toBeDefined();
      const methods = caps
        .filter((m) => m['@declaration.method'] !== undefined)
        .map((m) => m['@declaration.name']?.text);
      expect(methods).toEqual(['init', 'getArena']);
      expect(caps.some((m) => m['@declaration.function'] !== undefined)).toBe(false);

      // A namespace file: no class scope, no struct, fns stay Functions.
      const nsCaps = emitZigScopeCaptures(NAMESPACE, 'src/util.zig');
      expect(nsCaps.some((m) => m['@scope.class'] !== undefined)).toBe(false);
      expect(nsCaps.some((m) => m['@declaration.struct'] !== undefined)).toBe(false);
      expect(nsCaps.some((m) => m['@declaration.function'] !== undefined)).toBe(true);
    });

    it('drops the file-level `const Page = @This();` binding of a file-struct, keeps a namespace alias', () => {
      // A Const named `Page` beside `Struct Page` would shadow the type for
      // every `x: *Page` (locals outrank imports in zigMergeBindings).
      const vars = emitZigScopeCaptures(FILE_STRUCT, 'src/Page.zig')
        .filter((m) => m['@declaration.variable'] !== undefined)
        .map((m) => m['@declaration.name']?.text);
      expect(vars).not.toContain('Page');
      const nsVars = emitZigScopeCaptures(NAMESPACE, 'src/util.zig')
        .filter((m) => m['@declaration.variable'] !== undefined)
        .map((m) => m['@declaration.name']?.text);
      expect(nsVars).toContain('util');
      // Same verdict for the structure phase (variable extractor / shouldSkip).
      const decl = find(parse(FILE_STRUCT).rootNode, 'variable_declaration', 'const Page');
      expect(isZigTypeShadowingBinding(decl)).toBe(true);
      const nsDecl = find(parse(NAMESPACE).rootNode, 'variable_declaration', 'const util');
      expect(isZigTypeShadowingBinding(nsDecl)).toBe(false);
    });

    it('rewrites @This() aliases in type position to the container name (`self: *SigHandler` in Sighandler.zig, nested `Self`)', () => {
      const src = `
const SigHandler = @This();
armed: bool = false,
pub fn arm(self: *SigHandler, other: ?*const SigHandler) void { _ = self; _ = other; }
pub const Inner = struct {
    const Self = @This();
    n: u32,
    pub fn get(self: *const Self) u32 { return self.n; }
};
`;
      const types = emitZigScopeCaptures(src, 'src/Sighandler.zig')
        .filter((m) => m['@type-binding.parameter'] !== undefined)
        .map((m) => [m['@type-binding.name']?.text, m['@type-binding.type']?.text]);
      expect(types).toEqual([
        ['self', '*Sighandler'],
        ['other', '?*const Sighandler'],
        ['self', '*const Inner'],
      ]);
    });

    it('flags file-level `pub` import bindings as republishing their name (reexportsName)', () => {
      // `pub const Arena = @import("Arena.zig");` / `pub const X = @import("x.zig").X;`
      // at file scope publish the name from THIS module (Python `__init__.py`
      // shape); a private or fn-local binding does not.
      const src = `
pub const Arena = @import("Arena.zig");
pub const Foo = @import("foo.zig").Foo;
const hidden = @import("hidden.zig");
const ns = @import("ns.zig");
pub const Bar = ns.Bar;
fn f() void {
    const Local = @import("local.zig").Local;
    _ = Local;
}
`;
      const imports = emitZigScopeCaptures(src, 'lp.zig')
        .filter((m) => m['@import.source'] !== undefined)
        .map((m) => interpretZigImport(m))
        .filter((i) => i !== null && (i.kind === 'named' || i.kind === 'alias'))
        .map((i) => [i!.localName, (i as { reexportsName?: boolean }).reexportsName === true]);
      expect(imports).toEqual([
        ['Arena', true], // the file-struct TYPE twin of a pub namespace import
        ['Foo', true],
        ['hidden', false], // no `pub`
        ['ns', false],
        ['Bar', true], // pub alias of a namespace member
        ['Local', false], // fn-local: binds locally, publishes nothing
      ]);
    });

    it('gives a namespace import of a .zig file a TYPE twin (named import of the file stem)', () => {
      const src = `
const Page = @import("Page.zig");
const P = @import("sub/Page.zig");
const std = @import("std");
const lp = @import("lightpanda");
`;
      const imports = emitZigScopeCaptures(src, 'main.zig')
        .filter((m) => m['@import.source'] !== undefined)
        .map((m) => interpretZigImport(m));
      expect(imports).toEqual([
        { kind: 'namespace', localName: 'Page', importedName: 'Page', targetRaw: 'Page.zig' },
        { kind: 'named', localName: 'Page', importedName: 'Page', targetRaw: 'Page.zig' },
        { kind: 'namespace', localName: 'P', importedName: 'Page', targetRaw: 'sub/Page.zig' },
        {
          kind: 'alias',
          localName: 'P',
          importedName: 'Page',
          alias: 'P',
          targetRaw: 'sub/Page.zig',
        },
        // bare modules (`std`, build.zig modules) get no twin — no file stem to name.
        { kind: 'namespace', localName: 'std', importedName: 'std', targetRaw: 'std' },
        { kind: 'namespace', localName: 'lp', importedName: 'lightpanda', targetRaw: 'lightpanda' },
      ]);
    });
  },
);

describeZig(
  'Zig field types (F5: `self.field.m()` resolves through the field’s declared type)',
  () => {
    // Lightpanda's dominant cross-object call shape is `self.<field>.<method>()`
    // (2803 sites) — and it resolved 9 times, because a container's field types
    // were never bound on its Class scope: `typeOfMemberOnClass` reads
    // `classScope.typeBindings.get(field)` and found nothing.
    const SRC = `
const Page = @This();
const Session = @import("Session.zig");
session: *Session,
parent: ?*Page,
count: u32 = 0,
pub const Holder = struct {
    const Self = @This();
    counter: Counter,
    ptr: *Counter,
    opt: ?*Counter,
    list: []const Counter,
    gen: std.ArrayList(u8),
    next: ?*Self,
    inline_: struct { a: u32 },
    pub fn viaField(self: *Holder) void { self.counter.incr(); }
};
pub const Kind = enum { a, b };
pub const Payload = union(enum) { x: u32, y: Counter };
`;

    it('emits one @type-binding.field per TYPED field — the nominal type, sigils stripped, aliases rewritten', () => {
      const fields = emitZigScopeCaptures(SRC, 'src/Page.zig')
        .filter((m) => m['@type-binding.field'] !== undefined)
        .map((m) => {
          const parsed = interpretZigTypeBinding(m)!;
          return [
            parsed.boundName,
            m['@type-binding.type']!.text,
            parsed.rawTypeName,
            parsed.source,
          ];
        });
      expect(fields).toEqual([
        // file-struct fields; `?*Page` is the file's own @This() alias, kept as
        // the file stem (Page.zig → Page) exactly like a parameter type
        ['session', '*Session', 'Session', 'annotation'],
        ['parent', '?*Page', 'Page', 'annotation'],
        ['count', 'u32', 'u32', 'annotation'],
        // nested container: plain / pointer / optional pointer / slice /
        // generic instantiation / nested `Self` alias
        ['counter', 'Counter', 'Counter', 'annotation'],
        ['ptr', '*Counter', 'Counter', 'annotation'],
        ['opt', '?*Counter', 'Counter', 'annotation'],
        ['list', '[]const Counter', 'Counter', 'annotation'],
        ['gen', 'std.ArrayList(u8)', 'std.ArrayList', 'annotation'],
        ['next', '?*Holder', 'Holder', 'annotation'],
        // the anonymous inline struct's OWN field, not `inline_` itself
        ['a', 'u32', 'u32', 'annotation'],
        // union variants carry a type; enum variants (`a`, `b`) do not
        ['x', 'u32', 'u32', 'annotation'],
        ['y', 'Counter', 'Counter', 'annotation'],
      ]);
    });

    it('hosts the binding on the CONTAINER’s Class scope — the file’s Class scope for a file-struct — never hoisted to Module', () => {
      // `zigBindingScopeFor` hoists member NAMES of a file-struct to the Module
      // scope so `Page.init()` keeps working; the compound resolver reads member
      // TYPES from the Class scope, so those must stay put.
      const parsed = extractScopes(
        emitZigScopeCaptures(SRC, 'src/Page.zig'),
        'src/Page.zig',
        zigProvider,
      );
      const byKind = (kind: string) => parsed.scopes.filter((s) => s.kind === kind);
      const moduleScope = byKind('Module')[0]!;
      expect(moduleScope.typeBindings.size).toBe(0);
      const fileClass = byKind('Class').find(
        (s) =>
          s.range.startLine === moduleScope.range.startLine &&
          s.range.endLine === moduleScope.range.endLine,
      )!;
      expect(fileClass).toBeDefined();
      expect(fileClass.typeBindings.get('session')?.rawName).toBe('Session');
      // The written spelling survives beside the reduced name (`TypeRef.declaredSpelling`).
      expect(fileClass.typeBindings.get('session')?.declaredSpelling).toBe('*Session');
      expect(fileClass.typeBindings.get('parent')?.rawName).toBe('Page');
      const holder = byKind('Class').find((s) => s.typeBindings.has('counter'))!;
      expect(holder).toBeDefined();
      expect(holder.id).not.toBe(fileClass.id);
      expect(holder.typeBindings.get('opt')).toMatchObject({
        rawName: 'Counter',
        declaredSpelling: '?*Counter',
      });
      expect(holder.typeBindings.get('next')?.rawName).toBe('Holder');
      // The receiver `self` stays on the function scope, not on the class.
      expect(holder.typeBindings.has('self')).toBe(false);
      expect(byKind('Function')[0]!.typeBindings.get('self')?.rawName).toBe('Holder');
    });

    it('binds a local alias of a field to the RHS path (`const page = self.page;`), never an import alias', () => {
      const src = `
const counter = @import("counter.zig");
const Counter = counter.Counter;
const Allocator = std.mem.Allocator;
pub fn run(self: *Holder) void {
    const page = self.page;
    var s = self.session;
    const typed: *Page = self.page;
    _ = page; _ = s; _ = typed;
}
`;
      const aliases = emitZigScopeCaptures(src, 'x.zig')
        .filter((m) => m['@type-binding.alias'] !== undefined)
        .map((m) => interpretZigTypeBinding(m));
      expect(aliases).toEqual([
        // `std` is not an @import binding in this snippet, so the chain is an
        // ordinary (type) alias — F7 keeps it; it resolves to nothing.
        { boundName: 'Allocator', rawTypeName: 'std.mem.Allocator', source: 'assignment-inferred' },
        { boundName: 'page', rawTypeName: 'self.page', source: 'assignment-inferred' },
        { boundName: 's', rawTypeName: 'self.session', source: 'assignment-inferred' },
        { boundName: 'typed', rawTypeName: 'self.page', source: 'assignment-inferred' },
      ]);
      // `const Counter = counter.Counter;` is a NAMED IMPORT (counter is an
      // @import binding) — never a value alias.
      expect(aliases.map((a) => a!.boundName)).not.toContain('Counter');
      // The annotation outranks the alias for the same name.
      const parsed = extractScopes(emitZigScopeCaptures(src, 'x.zig'), 'x.zig', zigProvider);
      const fn = parsed.scopes.find((s) => s.kind === 'Function')!;
      const block = parsed.scopes.find((s) => s.kind === 'Block')!;
      const typed = block.typeBindings.get('typed') ?? fn.typeBindings.get('typed');
      expect(typed).toMatchObject({ rawName: 'Page', source: 'annotation' });
    });
  },
);

describeZig('Zig value-inferred and return-type bindings (F6)', () => {
  // Only the value-inferred / return kinds this suite owns: parameter, field
  // (F5) and alias (F7) bindings for the same names are asserted elsewhere.
  const bindingsOf = (src: string, file = 'x.zig') =>
    emitZigScopeCaptures(src, file)
      .filter(
        (m) =>
          m['@type-binding.name'] !== undefined &&
          m['@type-binding.parameter'] === undefined &&
          m['@type-binding.field'] === undefined &&
          m['@type-binding.alias'] === undefined,
      )
      .map((m) => ({
        ...interpretZigTypeBinding(m),
        kind: Object.keys(m).find(
          (k) =>
            k !== '@type-binding.name' &&
            k !== '@type-binding.type' &&
            k !== '@type-binding.member-call-return',
        ),
      }));
  const cr = (boundName: string, rawTypeName: string) => ({
    boundName,
    rawTypeName,
    source: 'constructor-inferred',
    kind: '@type-binding.call-return',
  });
  const ret = (boundName: string, rawTypeName: string) => ({
    boundName,
    rawTypeName,
    source: 'return-annotation',
    kind: '@type-binding.return',
  });

  it('unwraps try / catch / orelse / parens around a constructor call — the receiver still names the type', () => {
    // Before: the call had to be the DIRECT value child, so every one of
    // these (2,551 `try T.f()` sites in Lightpanda) typed nothing.
    const src = `
fn f() !void {
    const a = try Thing.make();
    const b = Thing.make() catch return;
    const c = Thing.maybe() orelse return;
    const d = (Thing.make());
    const e = try Thing.make() catch |err| return err;
    var g = try mod.Thing.make();
}
`;
    expect(bindingsOf(src)).toEqual([
      cr('a', 'Thing'),
      cr('b', 'Thing'),
      cr('c', 'Thing'),
      cr('d', 'Thing'),
      cr('e', 'Thing'),
      cr('g', 'mod.Thing'),
    ]);
  });

  it('a keyword-less re-assignment `p = T{…};` / `_ = T{…};` binds no constructor type (only declarations do)', () => {
    // tree-sitter-zig 1.1.2 parses assignments as `variable_declaration` too;
    // the constructor rules used to match them and mint a binding for `p` (and
    // for `_`) in the assignment's block. `p` already carries its type from its
    // declaration, so the assignment adds nothing — the rules are keyword-gated
    // like the import and call-return rules.
    const src = `
fn f() void {
    var p = Thing{ .a = 1 };
    const q = mod.Thing{ .a = 1 };
    const l = List(u8){};
    p = Thing{ .a = 2 };
    q = mod.Thing{ .a = 2 };
    l = List(u8){};
    _ = Thing{ .a = 3 };
}
`;
    const ctor = (boundName: string, rawTypeName: string) => ({
      boundName,
      rawTypeName,
      source: 'constructor-inferred',
      kind: '@type-binding.constructor',
    });
    expect(bindingsOf(src)).toEqual([
      ctor('p', 'Thing'),
      ctor('q', 'mod.Thing'),
      ctor('l', 'List'),
    ]);
  });

  it('a wrapped struct literal (`try Thing{…}`) is a constructor binding', () => {
    expect(bindingsOf('fn f() !void { const t = try Thing{ .a = 1 }; }')).toEqual([
      {
        boundName: 't',
        rawTypeName: 'Thing',
        source: 'constructor-inferred',
        kind: '@type-binding.constructor',
      },
    ]);
  });

  it('a free call binds the callee name (chained to its return binding); a member call on a fn-LOCAL receiver binds the compound `recv.method()`', () => {
    const src = `
fn f(node: *Node) void {
    const t = makeThing();
    const el = try node.asElement();
    const p = self.parser.next();
    for (items) |it| { const n = it.next(); }
}
const R = struct { pub fn go(self: *R) void { const q = self.current(); } };
`;
    expect(bindingsOf(src)).toEqual([
      cr('t', 'makeThing'),
      // `node` is a parameter: the type is asElement's RETURN, walked by the
      // shared compound resolver — NOT `Node` (the old rule typed el as its
      // receiver, a confidently wrong owner for `el.m()`).
      cr('el', 'node.asElement()'),
      // `self` is NOT a local of `f` (no such parameter): module-level
      // receiver semantics — the receiver text is the type (declines later).
      cr('p', 'self.parser'),
      // a payload capture is a local too
      cr('n', 'it.next()'),
      cr('q', 'self.current()'),
    ]);
  });

  it('emits nothing for a TitleCase callee (type constructor), a decl literal, an identifier or a field chain', () => {
    const src = `
fn f() void {
    const B = util.List(u8);
    const L = List(u8);
    const X = Foo.Bar();
    const d = .init();
    const y = other;
    const z = a.b;
    const n = 42;
}
`;
    expect(bindingsOf(src)).toEqual([]);
  });

  it('binds a fn name to its NOMINAL return type; builtins, `type`, @TypeOf and comptime type parameters bind nothing', () => {
    const src = `
pub const Iter = struct {
    const Self = @This();
    pub fn next(self: *Iter) ?Thing { _ = self; return null; }
    pub fn me(self: *Iter) *Self { return self; }
    pub fn mine() @This() { return .{}; }
    pub fn count(self: *Iter) usize { _ = self; return 0; }
    pub fn is(self: *Iter, comptime T: type) ?*T { _ = self; return null; }
    pub fn Wrap(comptime T: type) type { return struct { pub fn get(self: *@This()) T { _ = self; } }; }
};
pub fn makeErr() std.mem.Allocator.Error!*Thing { return .{}; }
pub fn make0() void {}
pub fn make1() []const u8 {}
pub fn make2() @TypeOf(x) {}
pub fn make3() !List(u8) {}
`;
    expect(bindingsOf(src)).toEqual([
      ret('next', 'Thing'),
      // `*Self` and `@This()` both name the enclosing container
      ret('me', 'Iter'),
      ret('mine', 'Iter'),
      ret('makeErr', 'Thing'),
      ret('make3', 'List'),
    ]);
  });

  it('a file-struct’s `@This()` return names the file stem', () => {
    const src = `
count: u32 = 0,
pub fn init() @This() { return .{}; }
`;
    expect(bindingsOf(src, 'src/Page.zig')).toEqual([ret('init', 'Page')]);
  });

  it('normalizes an error-union payload’s own sigils (`Allocator.Error!*Page` → `Page`)', () => {
    expect(normalizeZigTypeName('Allocator.Error!*Page')).toBe('Page');
    expect(normalizeZigTypeName('!?*const Page')).toBe('Page');
    expect(normalizeZigTypeName('anyerror![]Thing')).toBe('Thing');
  });

  it('projects one layer off a written type for payloads and projections', () => {
    expect(zigElementSpelling('[]Thing')).toBe('Thing');
    expect(zigElementSpelling('[]const *Thing')).toBe('*Thing');
    expect(zigElementSpelling('[4]Thing')).toBe('Thing');
    expect(zigElementSpelling('[*:0]const u8')).toBe('u8');
    expect(zigElementSpelling('*const []Thing')).toBe('Thing');
    expect(zigElementSpelling('![]Thing')).toBe('Thing');
    // not visibly iterable — declines instead of guessing
    expect(zigElementSpelling('std.ArrayList(Thing)')).toBeUndefined();
    expect(zigElementSpelling('Thing')).toBeUndefined();
    expect(zigOptionalPayloadSpelling('?*Thing')).toBe('*Thing');
    expect(zigOptionalPayloadSpelling('!?Thing')).toBe('Thing');
    expect(zigOptionalPayloadSpelling('*Thing')).toBeUndefined();
    expect(zigPointeeSpelling('*const Thing')).toBe('Thing');
    expect(zigPointeeSpelling('Thing')).toBeUndefined();
  });
});

describeZig('Zig function-local and anonymous containers (F8)', () => {
  // Lightpanda shapes: reflection.zig's per-builder `const R = struct {…}`,
  // ImportMap.zig's `std.sort.pdq(…, struct { fn lessThan … }.lessThan)`
  // (three in one file), build.zig's `const byte_size = struct { fn it … }.it;`,
  // and a test-local `const State = struct {…}`.
  const src = `
const Page = @This();
count: u32 = 0,
pub fn Reflect(comptime T: type) type {
    return struct {
        pub fn string() void {
            const R = struct {
                fn get(self: *const T) u8 { _ = self; return 1; }
            };
            _ = R.get;
        }
        pub fn url() void {
            const R = struct {
                fn get(self: *const T) u8 { _ = self; return 2; }
            };
            _ = R.get;
        }
    };
}
pub fn sortBoth(self: *Page) void {
    _ = self;
    sort(struct { fn lessThan(a: u32, b: u32) bool { return a < b; } }.lessThan);
    sort(struct { fn lessThan(a: u32, b: u32) bool { return a > b; } }.lessThan);
}
const byte_size = struct { fn it(n: u32) u32 { return n; } }.it;
test "Page: local state" {
    const State = struct { fn kill(self: *@This()) void { _ = self; } };
    var s = State{};
    s.kill();
}
`;
  const containers = (): SyntaxNode[] => {
    const out: SyntaxNode[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n.type === 'struct_declaration') out.push(n);
      n.children.forEach(walk);
    };
    walk(parse(src).rootNode);
    return out;
  };
  const findFn = (n: SyntaxNode, name: string): SyntaxNode | undefined =>
    n.type === 'function_declaration' && n.childForFieldName('name')?.text === name
      ? n
      : n.children.map((c) => findFn(c, name)).find((x) => x !== undefined);

  it('keys a function-local container by its enclosing callable and an anonymous one by host + ordinal', () => {
    // Before F8 the two `R` collapsed onto one `Struct:<file>:R` (one `R.get`
    // for ~20 builders in reflection.zig) and the anonymous comparators had
    // no identity at all — their `lessThan`s were ownerless, colliding Methods.
    expect(containers().map((n) => zigContainerName(n, 'src/Page.zig'))).toEqual([
      'Reflect',
      'Reflect.string$R',
      'Reflect.url$R',
      'Page.sortBoth$1',
      'Page.sortBoth$2',
      'Page$1',
      // A test block is keyed by its line: its string is not stable under
      // the class extractor's qualified-name normalization (whitespace).
      'Page.test@L26$State',
    ]);
    // The BINDING name is what code writes — the scope binds `R`, not `string$R`.
    expect(containers().map((n) => zigContainerBindingName(n))).toEqual([
      'Reflect',
      'R',
      'R',
      undefined,
      undefined,
      undefined,
      'State',
    ]);
    // Which ZIG_QUERIES rule mints each: only file/container-level bindings
    // stay on the `const T = struct` wrapper rule.
    expect(containers().map((n) => zigContainerAnchor(n))).toEqual([
      'constructor',
      'container',
      'container',
      'container',
      'container',
      'container',
      'container',
    ]);
    const root = parse(src).rootNode;
    expect(zigCallableQualifiedName(findFn(root, 'get')!, 'src/Page.zig')).toBe(
      'Reflect.string$R.get',
    );
    expect(zigCallableQualifiedName(findFn(root, 'sortBoth')!, 'src/Page.zig')).toBe(
      'Page.sortBoth',
    );
    // A namespace file (no fields) prefixes nothing for the file itself.
    const nsRoot = parse('fn build() void { const R = struct {}; _ = R; }').rootNode;
    expect(
      zigContainerName(
        findFn(nsRoot, 'build')!.descendantsOfType('struct_declaration')[0]!,
        'build.zig',
      ),
    ).toBe('build$R');
  });

  it('the redundancy predicate keeps exactly one structure-phase rule per container', () => {
    const [ctor, localR, , anon] = containers();
    // Type constructor: its own rule (anchored on the container, fn `@name`)
    // is kept; the bare rule's match (no name) is redundant.
    const ctorFn = findFn(parse(src).rootNode, 'Reflect')!;
    expect(isZigRedundantContainerCapture(ctor!, ctorFn.childForFieldName('name')!)).toBe(false);
    expect(isZigRedundantContainerCapture(ctor!, undefined)).toBe(true);
    // Function-local `const R = struct`: the wrapper rule is redundant, the
    // bare rule owns it (it is the one that names it `string$R`).
    const wrapper = localR!.parent!;
    expect(isZigRedundantContainerCapture(wrapper, wrapper.namedChild(0)!)).toBe(true);
    expect(isZigRedundantContainerCapture(localR!, undefined)).toBe(false);
    // Anonymous: only the bare rule matches, and it is kept.
    expect(isZigRedundantContainerCapture(anon!, undefined)).toBe(false);
    // File-level `const Plain = struct {}` stays on the wrapper rule.
    const plainWrapper = parse('const Plain = struct { a: u8 };').rootNode.namedChild(0)!;
    const plain = plainWrapper.namedChild(1)!;
    expect(isZigRedundantContainerCapture(plainWrapper, plainWrapper.namedChild(0)!)).toBe(false);
    expect(isZigRedundantContainerCapture(plain, undefined)).toBe(true);
  });

  it('scope captures: a local container def is qualified but binds its own name; anonymous ones get distinct synthetic defs', () => {
    const caps = emitZigScopeCaptures(src, 'src/Page.zig');
    const structDefs = caps
      .filter((m) => m['@declaration.struct'] !== undefined)
      .map((m) => [
        m['@declaration.name']?.text,
        m['@declaration.binding-name']?.text,
        m['@declaration.is-synthetic']?.text,
      ]);
    expect(structDefs).toContainEqual(['Reflect.string$R', 'R', undefined]);
    expect(structDefs).toContainEqual(['Reflect.url$R', 'R', undefined]);
    expect(structDefs).toContainEqual(['Page.test@L26$State', 'State', undefined]);
    // Two same-shaped `struct { fn lessThan }` comparators → two identities.
    expect(structDefs).toContainEqual(['Page.sortBoth$1', undefined, 'true']);
    expect(structDefs).toContainEqual(['Page.sortBoth$2', undefined, 'true']);
    expect(structDefs).toContainEqual(['Page$1', undefined, 'true']);
    // No def is left under the bare binding name.
    expect(structDefs.map((d) => d[0])).not.toContain('R');

    // Through the scope extractor: the members are owned by DISTINCT class
    // defs and their qualified names carry the identity — the graph node id
    // the structure phase mints (`Method:<file>:Reflect.string$R.get`).
    const parsed = extractScopes(caps, 'src/Page.zig', zigProvider);
    populateClassOwnedMembers(parsed);
    const gets = parsed.localDefs.filter(
      (d) => d.type === 'Method' && d.qualifiedName?.endsWith('.get'),
    );
    expect(gets.map((d) => d.qualifiedName).sort()).toEqual([
      'Reflect.string$R.get',
      'Reflect.url$R.get',
    ]);
    expect(new Set(gets.map((d) => d.ownerId)).size).toBe(2);
    const lts = parsed.localDefs.filter(
      (d) => d.type === 'Method' && d.qualifiedName?.endsWith('.lessThan'),
    );
    expect(lts.map((d) => d.qualifiedName).sort()).toEqual([
      'Page.sortBoth$1.lessThan',
      'Page.sortBoth$2.lessThan',
    ]);
    expect(lts.every((d) => d.ownerId !== undefined)).toBe(true);
  });

  it('a `@This()` alias inside a local container rewrites to the BINDING name (`R`), which is what the scope binds', () => {
    const localAliasSrc = `
pub fn string() void {
    const R = struct {
        const Self = @This();
        fn get(self: *const Self) u8 { _ = self; return 1; }
    };
    _ = R;
}
`;
    const selfParam = emitZigScopeCaptures(localAliasSrc, 'src/r.zig').find(
      (m) => m['@type-binding.parameter'] !== undefined && m['@type-binding.name']?.text === 'self',
    );
    expect(selfParam?.['@type-binding.type']?.text).toBe('*const R');
  });
});
