/**
 * Zig: container types, methods, calls, and @import resolution.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  edgeSet,
  FIXTURES,
  getNodesByLabel,
  getNodesByLabelFull,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

// `@tree-sitter-grammars/tree-sitter-zig` is an optionalDependency: on a
// platform without a prebuild the grammar is absent and the pipeline skips
// `.zig` files by contract, so these suites skip too (Swift/Dart pattern).
const zigAvailable = isLanguageAvailable(SupportedLanguages.Zig);

describe.skipIf(!zigAvailable)('Zig basic resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-basic'), () => {});
  }, 60000);

  it('detects the Pioneer struct and State enum', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('Pioneer');
    expect(getNodesByLabel(result, 'Enum')).toContain('State');
  });

  it('labels `union(enum)` declarations as Union (not Class)', () => {
    expect(getNodesByLabel(result, 'Union')).toContain('Tag');
    // Negative-side check: Tag must NOT also appear under Class.
    expect(getNodesByLabel(result, 'Class')).not.toContain('Tag');
  });

  it('extracts top-level functions from main.zig', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('main');
    expect(fns).toContain('helper');
  });

  it('extracts struct methods (tick, reset) as Methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('tick');
    expect(methods).toContain('reset');
  });

  it('extracts union(enum) methods as Methods (Union is class-like)', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('isEnergy');
  });

  it('dispatches method calls on a union receiver (main → isEnergy)', () => {
    // Pins the `isClassLike('Union')` widening in scope/walkers.ts: without
    // it `populateClassOwnedMembers` finds no class-like def in the Tag
    // scope, the method gets no ownerId, and dispatch silently drops.
    expect(edgeSet(getRelationships(result, 'CALLS'))).toContain('main → isEnergy');
  });

  it('resolves the relative @import("./pioneer.zig") to pioneer.zig', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const internal = imports.filter((e) => e.targetFilePath.endsWith('pioneer.zig'));
    expect(internal.length).toBeGreaterThan(0);
    expect(internal[0].sourceFilePath).toContain('main.zig');
  });

  it('emits a CALLS edge for the free call main → helper', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(edgeSet(calls)).toContain('main → helper');
  });

  it('emits a CALLS edge for the receiver-bound method call main → tick', () => {
    const calls = getRelationships(result, 'CALLS');
    // `var p = pioneer.Pioneer{…}; p.tick()` — constructor-inferred receiver
    // type through the namespace import, dispatched onto Pioneer.tick.
    expect(edgeSet(calls)).toContain('main → tick');
  });
});

describe.skipIf(!zigAvailable)('Zig scope captures — variable bindings', () => {
  it('binds only the declared name, never the initializer identifier', async () => {
    // `(variable_declaration (identifier) @declaration.name)` without a
    // first-child anchor ALSO matches the RHS identifier of `const h = helper;`
    // and mints a phantom local named `helper` in the enclosing block. That
    // phantom shadows the real function for every later reference in the
    // block, so `helper()` below silently lost its CALLS edge — and the
    // callable-value-flow seed for `h` had nothing to resolve against.
    const { emitZigScopeCaptures } =
      await import('../../../src/core/ingestion/languages/zig/captures.js');
    const source = [
      'fn helper() void {}',
      'pub fn main() void {',
      '    const h = helper;',
      '    helper();',
      '}',
      '',
    ].join('\n');
    const variableNames = emitZigScopeCaptures(source, 'main.zig')
      .filter((m) => m['@declaration.variable'] !== undefined)
      .map((m) => m['@declaration.name']?.text);
    expect(variableNames).toEqual(['h']);
  });
});

describe.skipIf(!zigAvailable)('Zig export, opaque and test declarations (ffi.zig)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-basic'), () => {});
  }, 60000);

  it('marks `export fn` (C-ABI, no `pub`) as exported', () => {
    // `export` is the strongest visibility Zig has — FFI entry points are
    // declared this way and never carry `pub`. A `pub`-only checker left
    // every C-ABI symbol private in the graph.
    const cAdd = getNodesByLabelFull(result, 'Function').find((n) => n.name === 'c_add');
    expect(cAdd).toBeDefined();
    expect(cAdd!.properties.isExported).toBe(true);
  });

  it('models `opaque {}` as a Struct that owns its methods', () => {
    expect(getNodesByLabel(result, 'Struct')).toContain('Handle');
    expect(getNodesByLabel(result, 'Method')).toContain('close');
    expect(edgeSet(getRelationships(result, 'HAS_METHOD'))).toContain('Handle → close');
  });

  it('owns container members through the binding name (HAS_METHOD / HAS_PROPERTY)', () => {
    // tree-sitter-zig containers are anonymous; the owner walk used to climb
    // past them and NO Zig member ever got an owner edge, so `context(Pioneer)`
    // listed no methods and the struct's fields dangled off the File.
    expect(edgeSet(getRelationships(result, 'HAS_METHOD'))).toEqual(
      expect.arrayContaining(['Pioneer → tick', 'Pioneer → reset', 'Tag → isEnergy']),
    );
    expect(edgeSet(getRelationships(result, 'HAS_PROPERTY'))).toEqual(
      expect.arrayContaining(['Pioneer → energy', 'State → idle', 'Tag → energy']),
    );
  });

  it('dispatches a method call on an opaque receiver (release → close)', () => {
    expect(edgeSet(getRelationships(result, 'CALLS'))).toContain('release → close');
  });

  it('never mints a nameless Property for an empty container body', () => {
    // tree-sitter-zig 1.1.2 recovers `struct {}` / `opaque {}` as one
    // container_field with a zero-width MISSING identifier.
    expect(getNodesByLabel(result, 'Struct')).toContain('Empty');
    expect(getNodesByLabel(result, 'Property')).not.toContain('');
  });

  it('captures named tests as Functions, quoted, so `test "release"` and `fn release` stay distinct nodes', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('"c_add adds"');
    expect(fns).toContain('"release"');
    // Both must exist as separate nodes — an unquoted test name would have
    // merged onto Function:<file>:release and fabricated a self-call.
    expect(fns.filter((n) => n === 'release')).toHaveLength(1);
    expect(fns.filter((n) => n === '"release"')).toHaveLength(1);
  });

  it('attributes calls inside a named test to the test node, not the file', () => {
    const calls = edgeSet(getRelationships(result, 'CALLS'));
    expect(calls).toContain('"c_add adds" → c_add');
    expect(calls).toContain('"release" → release');
    expect(calls).not.toContain('release → release');
  });

  it('does not create a graph node for an anonymous `test {}`', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns.some((n) => n.startsWith('test@') || n === 'test')).toBe(false);
  });
});

/**
 * `zig-idioms`: the shapes real Zig is written in that `zig-basic` does not
 * exercise. Each case names the idiom and what breaks without the rule.
 */
describe.skipIf(!zigAvailable)('Zig idioms (zig-idioms fixture)', () => {
  let result: PipelineResult;
  let calls: string[];
  let imports: string[];

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-idioms'), () => {});
    calls = edgeSet(getRelationships(result, 'CALLS'));
    imports = getRelationships(result, 'IMPORTS').map(
      (e) => `${path.basename(e.sourceFilePath)} → ${e.targetFilePath}`,
    );
  }, 90000);

  it('mints Const / Variable nodes for `pub const` / `pub var` (incl. error sets and type aliases)', () => {
    // ZIG_QUERIES had no @definition.const / @definition.variable at all, so
    // `zigVariableConfig` never ran and `pub const VERSION`, error sets and
    // aliases like `const Allocator = std.mem.Allocator` were absent from
    // the graph.
    expect(getNodesByLabel(result, 'Const')).toEqual(
      expect.arrayContaining(['VERSION', 'Err', 'Allocator']),
    );
    expect(getNodesByLabel(result, 'Variable')).toContain('global_count');
  });

  it('never mints a Const for a container or an @import binding, nor for a statement assignment', () => {
    // `const Counter = struct {…}` is the Struct node; `const counter =
    // @import(…)` is the import binding; `counter.global_count = 5;` and
    // `_ = counter.VERSION;` are assignments that tree-sitter-zig 1.1.2 parses
    // as keyword-less `variable_declaration`s.
    const consts = getNodesByLabel(result, 'Const');
    // (`const Counter = counter.Counter;` IS a Const node — an alias — but
    // the struct itself is not duplicated as one: exactly one `Counter` Const,
    // from main.zig.)
    expect(getNodesByLabelFull(result, 'Const').filter((n) => n.name === 'Counter')).toHaveLength(
      1,
    );
    expect(consts).not.toContain('counter');
    expect(consts).not.toContain('std');
    expect(consts).not.toContain('_');
    expect(getNodesByLabel(result, 'Variable')).not.toContain('_');
  });

  it('types a receiver from a constructor CALL (`var a = Counter.init(); a.incr()`)', () => {
    expect(calls).toContain('main → incr');
  });

  it('types a receiver from its ANNOTATION (`var b: Counter = undefined; b.twice()`, `const c: Counter = .init(); c.get()`)', () => {
    // The declared type is the ONLY type source for `= undefined` and for
    // 0.14+ decl literals (`.init`, `.empty`), which current std uses for
    // every container constructor.
    expect(calls).toContain('main → twice');
    expect(calls).toContain('main → get');
  });

  it('follows an alias of a namespace member as a named import (`const Counter = counter.Counter;`)', () => {
    // Every receiver above is typed through the alias — none resolves if the
    // scope-side binding is a plain local shadowing the import (the graph
    // still carries the alias as a Const node in main.zig, which is what it is).
    expect(calls).toContain('main → get');
    expect(calls).toContain('main → init');
  });

  it('owns a generic type constructor’s members and dispatches on its instantiations', () => {
    // `pub fn Stack(comptime T: type) type { return struct {…}; }` — the
    // returned container had no owner (methods hung off the File) and
    // `Stack(u8){}` / `Stack(u8).init()` / `: Stack(u16)` typed nothing.
    expect(getNodesByLabel(result, 'Struct')).toContain('Stack');
    expect(getNodesByLabel(result, 'Function')).toContain('Stack');
    expect(edgeSet(getRelationships(result, 'HAS_METHOD'))).toEqual(
      expect.arrayContaining(['Stack → push', 'Stack → top', 'Stack → clear']),
    );
    expect(edgeSet(getRelationships(result, 'HAS_PROPERTY'))).toContain('Stack → items');
    expect(calls).toEqual(expect.arrayContaining(['main → push', 'main → top', 'main → clear']));
  });

  it('imports the file behind `const X = @import("x.zig").X` and `usingnamespace @import(...)`', () => {
    // Both forms lost the file-level IMPORTS edge: the rule needed
    // `builtin_function` as a DIRECT child of the declaration.
    expect(imports).toContain('main.zig → src/mixin.zig');
    // counter.zig is imported twice from main.zig (namespace + member); the
    // edge is deduped, so its presence proves at least one form resolved and
    // `Stack` (member form only) dispatching proves the other.
    expect(imports).toContain('main.zig → src/counter.zig');
    expect(calls).toContain('main → push');
  });

  it('imports every file behind an `@import` in EXPRESSION position (the `Interfaces = .{ @import(…), … }` table)', () => {
    // Both query sets only matched `@import` as the value of a const/var or
    // under `usingnamespace`, so a registration table of inline imports
    // (Lightpanda's bridge.zig: ~290 modules) produced NO file edges — the
    // modules looked unreferenced. Neither element binds a name; each is
    // still a dependency of main.zig.
    expect(imports).toContain('main.zig → src/webapi/AbortController.zig');
    expect(imports).toContain('main.zig → src/webapi/AbortSignal.zig');
    // and it mints no Const for the tuple elements — only for the table
    expect(getNodesByLabel(result, 'Const')).toContain('Interfaces');
  });

  it('resolves a member call whose receiver is an inline import (`@import("dump.zig").root(…)`)', () => {
    // The receiver text is the builtin itself, not a `const` handle; the
    // inline import is bound as a namespace import under that very text so
    // the shared namespace-receiver lookup lands in dump.zig.
    expect(imports).toContain('main.zig → src/dump.zig');
    expect(calls).toContain('main → root');
  });

  it('resolves a build.zig.zon path dep to the root its build.zig declares (src/root.zig)', () => {
    // `zig init` ≥ 0.12 lays libraries out as src/root.zig; the resolver only
    // knew src/<name>.zig and src/main.zig, so every such dep was unresolved.
    expect(imports).toContain('main.zig → libs/geo/src/root.zig');
    expect(calls).toContain('main → area');
    expect(calls).toContain('main → shift');
  });

  it('still resolves the older src/<name>.zig convention when the dep has no build.zig', () => {
    expect(imports).toContain('main.zig → libs/oldlib/src/oldlib.zig');
    expect(calls).toContain('main → legacy');
  });

  it('resolves `@import("<own module>")` through the ROOT build.zig’s addModule (Lightpanda: `@import("lightpanda")`)', () => {
    // Bare names were resolved through build.zig.zon path deps only, so the
    // package's own root module — `b.addModule("idioms", .{ .root_source_file
    // = b.path("src/idioms.zig") })`, re-imported into itself via addImport —
    // had no IMPORTS edge and nothing reached through it resolved.
    expect(imports).toContain('main.zig → src/idioms.zig');
    expect(calls).toContain('main → boot');
    // …and a type reached through the module namespace dispatches.
    expect(calls).toContain('main → reset');
  });

  it('does not fabricate an edge for a generated module (`addOptions().createModule()`)', () => {
    // `build_config` exists only at build time; there is no file to import.
    expect(imports.some((e) => e.startsWith('main.zig → ') && /build_config/.test(e))).toBe(false);
  });

  it('a re-assignment (`a = Counter.init();`) is not a declaration and does not shadow the typed binding', () => {
    // Guarded on the scope side by the literal `"const"` / `"var"` in the
    // query and on the structure side by `isZigKeywordDeclaration`.
    // main → incr resolves twice through the same binding (before and after
    // the re-assignment); an untyped phantom `a` would drop the second.
    expect(
      getRelationships(result, 'CALLS').filter((e) => e.source === 'main' && e.target === 'incr')
        .length,
    ).toBeGreaterThanOrEqual(2);
  });
});

/**
 * `zig-rootmodule`: a repo with a root `build.zig` and NO `build.zig.zon`.
 * Its only bare-name import is the module its own build.zig declares through
 * a `createModule` binding that `addImport("core", core_mod)` names.
 */
describe.skipIf(!zigAvailable)(
  'Zig own root module without build.zig.zon (zig-rootmodule fixture)',
  () => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-rootmodule'), () => {});
    }, 60000);

    it('resolves `@import("core")` to src/core.zig and the `core.start()` call through it', () => {
      // The resolution config was null without a build.zig.zon, so the repo's
      // own module never resolved: no IMPORTS edge, no call through `core.`.
      const imports = getRelationships(result, 'IMPORTS').map(
        (e) => `${path.basename(e.sourceFilePath)} → ${e.targetFilePath}`,
      );
      expect(imports).toContain('main.zig → src/core.zig');
      expect(edgeSet(getRelationships(result, 'CALLS'))).toContain('main → start');
    });
  },
);

describe.skipIf(!zigAvailable)('Zig file-structs (zig-filestruct fixture)', () => {
  // In Zig every file is a struct; one with top-level FIELDS is an
  // instantiable type named after the file (`Page.zig` declares `Page`), and
  // its top-level `fn`s are that type's methods. Lightpanda spells 73 % of its
  // types this way, and before this modelling `page.getArena()` on a
  // `page: *Page` parameter resolved 23 of 993 times (2.3 %) in that corpus:
  // `impact` on `Page.getArena` reported 0 callers for 159 call sites.
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-filestruct'), () => {});
  }, 60000);

  it('declares a Struct named after the file for a file with top-level fields', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('Page');
    expect(structs).toContain('Session');
    // The name is the FILE STEM, not the `@This()` alias (`SigHandler`).
    expect(structs).toContain('Sighandler');
    expect(structs).not.toContain('SigHandler');
    // A namespace file (no fields) is NOT a type, even with a `@This()` alias.
    expect(structs).not.toContain('util');
  });

  it('owns top-level fns and fields as Methods / Properties of that Struct', () => {
    // Member ids are owner-qualified exactly like `const T = struct {…}` members.
    expect(result.graph.getNode('Method:src/Page.zig:Page.getArena#0')).toBeDefined();
    expect(result.graph.getNode('Method:src/Session.zig:Session.findFrame#1')).toBeDefined();
    expect(result.graph.getNode('Method:src/Sighandler.zig:Sighandler.arm#0')).toBeDefined();
    expect(result.graph.getNode('Property:src/Page.zig:Page.session')).toBeDefined();
    expect(result.graph.getNode('Function:src/Page.zig:getArena')).toBeUndefined();
    // Namespace-file fns keep their Function ids.
    expect(getNodesByLabel(result, 'Function')).toContain('helper');
    expect(getNodesByLabel(result, 'Method')).not.toContain('helper');

    const hasMethod = edgeSet(getRelationships(result, 'HAS_METHOD'));
    expect(hasMethod).toContain('Page → getArena');
    expect(hasMethod).toContain('Sighandler → arm');
    const hasProp = edgeSet(getRelationships(result, 'HAS_PROPERTY'));
    expect(hasProp).toContain('Page → session');
    expect(hasProp).toContain('Session → label');
  });

  it('does not mint a Const for the file-level `@This()` self-alias of a file-struct', () => {
    // `const Page = @This();` names the file's own type; a Const beside the
    // Struct would shadow it for every `x: *Page`. A namespace file's alias
    // (`const util = @This();`) stays a Const — there is no type to shadow.
    const consts = getNodesByLabel(result, 'Const');
    expect(consts).not.toContain('Page');
    expect(consts).not.toContain('SigHandler');
    expect(consts).toContain('util');
  });

  it('dispatches method calls on receivers typed by another file-struct', () => {
    const calls = edgeSet(getRelationships(result, 'CALLS'));
    // parameter annotation `page: *Page` (Page = @import("Page.zig"))
    expect(calls).toContain('useParam → getArena');
    expect(calls).toContain('findFrame → getArena');
    // `var q: Page = undefined` and the call-return rule `var p = Page.init(&s)`
    expect(calls).toContain('main → getArena');
    expect(calls).toContain('main → bump');
    expect(calls).toContain('main → findFrame');
    // the alias-spelled receiver `self: *SigHandler` inside Sighandler.zig
    expect(calls).toContain('arm → check');
    // `var h: Sighandler = .{}` — annotation naming the file stem
    expect(calls).toContain('main → arm');
    // namespace-member calls keep working beside the type
    expect(calls).toContain('main → init');
    expect(calls).toContain('main → helper');
    // and `self.getArena()` inside the file-struct itself
    expect(calls).toContain('bump → getArena');
  });

  it('keeps the file-struct type reachable through the namespace import binding', () => {
    // `const Page = @import("Page.zig")` binds both the module (`Page.init`)
    // and the type it declares. Two Struct defs named `Page` in different
    // files must NOT be conflated: `Session` and `Page` each dispatch to
    // their own methods.
    const calls = getRelationships(result, 'CALLS');
    const target = calls.find((e) => e.source === 'findFrame' && e.target === 'getArena');
    expect(target?.targetFilePath).toMatch(/Page\.zig$/);
    const nameCall = calls.filter((e) => e.target === 'name');
    expect(nameCall.every((e) => e.targetFilePath.endsWith('Session.zig'))).toBe(true);
  });
});
