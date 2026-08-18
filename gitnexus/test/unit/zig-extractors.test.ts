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
import {
  emitZigScopeCaptures,
  isZigContainerOrImportBinding,
  isZigKeywordDeclaration,
  zigContainerName,
} from '../../src/core/ingestion/languages/zig/captures.js';
import {
  interpretZigImport,
  interpretZigTypeBinding,
  normalizeZigTypeName,
} from '../../src/core/ingestion/languages/zig/interpret.js';
import { createFieldExtractor } from '../../src/core/ingestion/field-extractors/generic.js';
import { zigFieldConfig } from '../../src/core/ingestion/field-extractors/configs/zig.js';
import { zigProvider } from '../../src/core/ingestion/languages/zig.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { extract as extractScopes } from '../../src/core/ingestion/scope-extractor.js';

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

  it('names the container returned by a fn returning `type` after that fn; other anonymous containers stay nameless', () => {
    const root = parse(src).rootNode;
    const structs: SyntaxNode[] = [];
    const walk = (n: SyntaxNode): void => {
      if (n.type === 'struct_declaration') structs.push(n);
      n.children.forEach(walk);
    };
    walk(root);
    expect(structs.map((n) => zigContainerName(n))).toEqual(['Stack', undefined, 'Plain']);
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
});
