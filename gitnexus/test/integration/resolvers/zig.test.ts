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
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { describeGrammarPresence, optionalGrammarGate } from '../../helpers/optional-grammar.js';

// `@tree-sitter-grammars/tree-sitter-zig` is an optionalDependency: on a
// platform without a prebuild the grammar is absent and the pipeline skips
// `.zig` files by contract, so these suites skip too (Swift/Dart pattern).
// Under GITNEXUS_REQUIRE_ZIG=1 the skip is not acceptable — the presence
// assertion below fails the job instead of letting Zig vanish from a green run.
const zig = optionalGrammarGate(SupportedLanguages.Zig);
const zigAvailable = zig.available;

describeGrammarPresence(zig);

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

  it('types a receiver by the FIELD it is read from (`self.counter.incr()`, `self.ptr.incr()`) — F5', () => {
    // A container's field types were never bound on its Class scope, so the
    // compound resolver (`typeOfMemberOnClass`) found nothing for `counter`
    // and `self.<field>.<method>()` — Lightpanda's dominant cross-object call
    // shape — resolved 9 of 2803 times (0.3 %). Plain, pointer and optional-
    // pointer field types all reduce to the nominal `Counter`.
    const viaField = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'viaField' && e.target === 'incr',
    );
    // `self.counter.incr()` and `self.ptr.incr()` — two sites, one callee, and
    // the callee lives in counter.zig, not in holder.zig.
    expect(viaField.length).toBeGreaterThanOrEqual(2);
    expect(viaField.every((e) => e.targetFilePath.endsWith('counter.zig'))).toBe(true);
    // (`if (self.opt) |c| c.incr()` — the payload capture — is F6 territory
    // and is deliberately not asserted here.)
  });

  it('types a local ALIAS of a field (`const c = self.counter; c.get()`, `var p = self.ptr; p.twice()`) — F5', () => {
    // `const c = self.counter;` binds nothing on the scope side without the
    // alias rule; the alias keeps the RHS path (`self.counter`) as its type
    // and the compound resolver re-resolves it as a receiver chain.
    expect(calls).toContain('viaAlias → get');
    expect(calls).toContain('viaAlias → twice');
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

  it('republishes a `pub const X = @import("X.zig")` so a third file reaches the type through the hub', () => {
    // Lightpanda's `lightpanda.zig` is one long list of `pub const X =
    // @import("...")`; `const lp = @import("lightpanda"); const Arena =
    // lp.Arena;` is how most files name their types. The re-export must
    // publish the TYPE (the file-struct), not just the module.
    expect(edgeSet(getRelationships(result, 'CALLS'))).toContain('viaHubAlias → getArena');
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

  it('dispatches through a file-struct FIELD typed by an imported file-struct (`self.session.name()`) — F5', () => {
    // `session: *Session` sits at the top level of Page.zig, whose Class
    // scope spans the file: the field's type binding must land there (not be
    // hoisted to the Module scope like the member NAMES are), and `Session`
    // must resolve through the import binding's type twin. Before F5 the
    // scope had no typeBindings at all and neither call resolved.
    const calls = edgeSet(getRelationships(result, 'CALLS'));
    expect(calls).toContain('sessionName → name');
    // `const s = self.session; s.name()` — alias of the field
    expect(calls).toContain('sessionLabel → name');
    const targets = getRelationships(result, 'CALLS').filter((e) => e.target === 'name');
    expect(targets.length).toBeGreaterThanOrEqual(2);
    expect(targets.every((e) => e.targetFilePath.endsWith('Session.zig'))).toBe(true);
  });
});

/**
 * F7 — type aliases (`src/aliases.zig` + `src/generic.zig` in zig-filestruct).
 * `const X = <type expr>;` is a Const in the graph; on the scope side the
 * alias name must be bound to the value's type so receivers written through
 * it dispatch. Before the fix every case below resolved nothing.
 */
describe.skipIf(!zigAvailable)('Zig type aliases (zig-filestruct fixture, aliases.zig)', () => {
  let result: PipelineResult;
  let calls: string[];

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-filestruct'), () => {});
    calls = edgeSet(
      getRelationships(result, 'CALLS').filter((e) => e.sourceFilePath.endsWith('aliases.zig')),
    );
  }, 60000);

  it('keeps every alias a Const (graph ids unchanged) — the type lives on the scope side', () => {
    const consts = getNodesByLabelFull(result, 'Const').filter((n) =>
      n.properties.filePath.endsWith('aliases.zig'),
    );
    expect(consts.map((n) => n.name)).toEqual(
      expect.arrayContaining(['LocalAlias', 'T2', 'B', 'P', 'max', 'bridge']),
    );
    expect(getNodesByLabel(result, 'TypeAlias')).toEqual([]);
  });

  it('dispatches through an alias of a same-file struct (`const LocalAlias = Local;`)', () => {
    // b1: class-name receiver typed by the alias binding (Case 4)
    expect(calls).toContain('b1 → mk');
    // b2: `var l = LocalAlias.mk()` chains l → LocalAlias → Local
    expect(calls).toContain('b2 → mk');
    expect(calls).toContain('b2 → go');
  });

  it('dispatches through an alias of an alias / import (`const T2 = Thing;`)', () => {
    expect(calls).toContain('b3 → make');
    expect(calls).toContain('b4 → make');
    expect(calls).toContain('b4 → run');
  });

  it('dispatches through an alias of an INSTANTIATED generic type constructor (`const B = generic.List(u8);`)', () => {
    // `B.init()` — the alias binds `generic.List` (comptime args dropped), Case 3
    expect(calls).toContain('b5 → init');
    // `var b = B{}` (constructor-inferred → B → generic.List)
    expect(calls).toContain('b6 → push');
    // `var x: B = .{}` (annotation → B → generic.List)
    expect(calls).toContain('b7 → push');
    // the same alias declared INSIDE a fn body (`const R = generic.List(u16);`)
    expect(calls).toContain('b8 → init');
    expect(calls).toContain('b8 → push');
  });

  it('dispatches through an alias of a namespace import that is a file-struct (`const P = Page;`)', () => {
    expect(calls).toContain('b10 → getArena');
  });

  it('a VALUE alias (`var cur = orig; cur.go()`) chains to the value’s type, as Rust’s `let x = y`', () => {
    expect(calls).toContain('b11 → go');
  });

  it('a value const / value call is not a type alias and gains no edge', () => {
    // `const helperResult = generic.Thing.make();` is a call, not an alias;
    // `const max = 5;` is a literal. Neither may bind a phantom type that
    // resolves `main`'s discards to anything.
    expect(calls.filter((c) => c.startsWith('main → '))).toEqual([]);
  });

  // F6 — locals bound WITHOUT an annotation (src/flow.zig). Before this, the
  // call-return rule needed the `call_expression` as the DIRECT value child,
  // so `const p = try Page.make(s)` (the shape of 2,551 Lightpanda sites),
  // `… catch return`, `… orelse return` typed nothing; no fn had a
  // return-type binding, so `const t = makeThing()` / `const el =
  // node.asElement()` typed nothing; and payload captures (`for … |*p|`,
  // `if (o) |p|`, `while (it.next()) |p|`) had no binding at all. Every
  // edge below is a method call on such a local.
  it('types a local through try / catch / orelse / parens around a constructor call', () => {
    const calls = edgeSet(getRelationships(result, 'CALLS'));
    expect(calls).toContain('viaTry → bump');
    expect(calls).toContain('viaCatch → bump');
    expect(calls).toContain('viaOrelse → name');
    expect(calls).toContain('viaParens → bump');
    // `try Page{ .session = s }` — a wrapped struct literal
    expect(calls).toContain('viaTryLiteral → bump');
  });

  it('types a local from the callee’s RETURN type: free call, member call on a local, member call on self', () => {
    const calls = edgeSet(getRelationships(result, 'CALLS'));
    // `const p = makeLocal();` — `fn makeLocal() Page`
    expect(calls).toContain('viaFreeCall → bump');
    // `const s = p.getSession();` — `p: *Page`, `fn getSession(self: *Page) *Session`.
    // The RECEIVER is a Page: had the old "receiver names the type" rule
    // applied to a value receiver, `s` would be a Page and `s.name()` would
    // find no method (or the wrong one).
    expect(calls).toContain('viaMemberReturn → name');
    // `const p = self.current();` inside `Runner`
    expect(calls).toContain('go → bump');
    // A TitleCase callee (`const L = List(u8)`) is a type constructor: the free
    // call itself resolves, and NOTHING else — `List ↦ type` must not bind.
    expect(calls.filter((c) => c.startsWith('viaTypeConstructor →'))).toEqual([
      'viaTypeConstructor → List',
    ]);
  });

  it('types payload captures from the subject: for |*p| / |p|, for (…, 0..) |p, i|, if (o) |p|, if (call) |s|, while (it.next()) |p|', () => {
    const calls = edgeSet(getRelationships(result, 'CALLS'));
    expect(calls).toContain('forSlice → bump');
    expect(calls).toContain('forSlice → getArena');
    expect(calls).toContain('forIndexed → bump');
    expect(calls).toContain('ifOptional → bump');
    // `if (p.maybeSession()) |s|` — the payload of the METHOD's `?*Session`
    expect(calls).toContain('ifCallOptional → name');
    // `while (s.next()) |p|` — `fn next(self: *Session) ?*Page`
    expect(calls).toContain('whileNext → bump');
  });

  it('types one-layer projections bound to a local: items[i], opt.?, ptr.*', () => {
    const calls = edgeSet(getRelationships(result, 'CALLS'));
    expect(calls).toContain('viaIndex → bump');
    expect(calls).toContain('viaUnwrap → bump');
    expect(calls).toContain('viaDeref → bump');
    // A pointer CAPTURE is deref-able too: `for (pages) |*p|` records `*Page`
    // (not `Page`), so `const q = p.*;` still sees the pointer layer.
    expect(calls).toContain('viaPtrCaptureDeref → bump');
  });
});

describe.skipIf(!zigAvailable)('Zig function-local and anonymous containers (F8)', () => {
  // reflect.zig mirrors Lightpanda's reflection.zig: a generic type
  // constructor whose builder fns each declare `const R = struct { fn get…
  // fn set… }`. Sorter.zig hosts the anonymous shapes: two `std.sort.pdq(…,
  // struct { fn lessThan … }.lessThan)` comparators in one fn (ImportMap.zig
  // has three), `const byteSize = struct { fn it … }.it;` (build.zig), a
  // field typed `?struct { min, max }`, and a test-local `const State`.
  // Before this modelling every `R` was one `Struct:…:R` with one `R.get`,
  // and every comparator's `lessThan` was an OWNERLESS `Method:<file>:lessThan`
  // — the corpus gate counted 14 ownerless Methods and 55 fns without a node.
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-filestruct'), () => {});
  }, 60000);

  const idsIn = (label: string, file: string): string[] => {
    const ids: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === label && String(n.properties.filePath).endsWith(file)) ids.push(n.id);
    });
    return ids.sort();
  };

  it('keys a function-local `const R = struct` by its enclosing callable, so two builders own two `R.get`s', () => {
    expect(idsIn('Struct', 'reflect.zig')).toEqual([
      'Struct:src/reflect.zig:Accessor',
      'Struct:src/reflect.zig:Reflect',
      'Struct:src/reflect.zig:Reflect.string$R',
      'Struct:src/reflect.zig:Reflect.url$R',
    ]);
    // Both `get`s exist, under distinct owner-qualified ids…
    expect(result.graph.getNode('Method:src/reflect.zig:Reflect.string$R.get#0')).toBeDefined();
    expect(result.graph.getNode('Method:src/reflect.zig:Reflect.url$R.get#0')).toBeDefined();
    // …and nothing is left under the bare binding name.
    expect(result.graph.getNode('Struct:src/reflect.zig:R')).toBeUndefined();
    expect(result.graph.getNode('Method:src/reflect.zig:R.get#0')).toBeUndefined();

    const hasMethod = getRelationships(result, 'HAS_METHOD').map(
      (e) => `${e.rel.sourceId} → ${e.rel.targetId}`,
    );
    expect(hasMethod).toContain(
      'Struct:src/reflect.zig:Reflect.string$R → Method:src/reflect.zig:Reflect.string$R.get#0',
    );
    expect(hasMethod).toContain(
      'Struct:src/reflect.zig:Reflect.url$R → Method:src/reflect.zig:Reflect.url$R.get#0',
    );
  });

  it('marks a struct-literal construction site (`return Accessor{…}`) on its CALLS edge, unlike an invocation', () => {
    // A struct literal `T{ .f = x }` (no parens) is deliberately modelled as a
    // CALLS edge to the type — the same shape Rust `T { .. }` and Go `T{}`
    // produce. The PR #1432 review found it indistinguishable from a real
    // call: the marker in `reason` is what lets a consumer tell "constructs an
    // instance of" apart from "invokes". `Reflect.string` / `Reflect.url`
    // each `return Accessor{ .get = R.get, .set = R.set }` (reflect.zig).
    // Same-file free-call fallback vocabulary, suffixed because the Zig
    // resolver opts into `markConstructionSites`.
    const calls = getRelationships(result, 'CALLS');
    const reasonsOf = (source: string, target: string): string[] =>
      calls.filter((e) => e.source === source && e.target === target).map((e) => e.rel.reason);
    expect(reasonsOf('string', 'Accessor')).toEqual(['local-call (constructor)']);
    expect(reasonsOf('url', 'Accessor')).toEqual(['local-call (constructor)']);
    // The invocation next door keeps its plain reason: `util.helper()` in
    // main.zig is a call, not a construction site.
    expect(reasonsOf('main', 'helper')).toHaveLength(1);
    expect(reasonsOf('main', 'helper')[0]).not.toContain('(constructor)');
    // Every marked edge targets a container type: a construction site can
    // never point at a callable.
    const constructionSites = calls.filter((e) => e.rel.reason.endsWith('(constructor)'));
    expect(constructionSites.length).toBeGreaterThan(0);
    expect(constructionSites.map((e) => e.targetLabel)).toEqual(
      constructionSites.map(() => 'Struct'),
    );
  });

  it('gives anonymous containers a host + ordinal identity, so no Method is ownerless and same-named fns never collide', () => {
    expect(idsIn('Struct', 'Sorter.zig')).toEqual([
      'Struct:src/Sorter.zig:Sorter',
      'Struct:src/Sorter.zig:Sorter$1', // `bounds: ?struct { min, max }`
      'Struct:src/Sorter.zig:Sorter$2', // `const byteSize = struct { fn it }.it`
      'Struct:src/Sorter.zig:Sorter.sortBoth$1', // first comparator
      'Struct:src/Sorter.zig:Sorter.sortBoth$2', // second comparator
      'Struct:src/Sorter.zig:Sorter.test@L41$State', // test-local `const State`
    ]);
    // Two `lessThan`s in one file → two nodes, each owned by its own Struct.
    expect(
      result.graph.getNode('Method:src/Sorter.zig:Sorter.sortBoth$1.lessThan#3'),
    ).toBeDefined();
    expect(
      result.graph.getNode('Method:src/Sorter.zig:Sorter.sortBoth$2.lessThan#3'),
    ).toBeDefined();
    expect(result.graph.getNode('Method:src/Sorter.zig:Sorter$2.it#1')).toBeDefined();
    const hasMethod = getRelationships(result, 'HAS_METHOD').map(
      (e) => `${e.rel.sourceId} → ${e.rel.targetId}`,
    );
    expect(hasMethod).toContain(
      'Struct:src/Sorter.zig:Sorter.sortBoth$1 → Method:src/Sorter.zig:Sorter.sortBoth$1.lessThan#3',
    );
    expect(hasMethod).toContain(
      'Struct:src/Sorter.zig:Sorter.sortBoth$2 → Method:src/Sorter.zig:Sorter.sortBoth$2.lessThan#3',
    );
    expect(hasMethod).toContain(
      'Struct:src/Sorter.zig:Sorter$2 → Method:src/Sorter.zig:Sorter$2.it#1',
    );
    // The anonymous field type owns its fields (they were `Sorter.min` before).
    const hasProp = getRelationships(result, 'HAS_PROPERTY').map(
      (e) => `${e.rel.sourceId} → ${e.rel.targetId}`,
    );
    expect(hasProp).toContain(
      'Struct:src/Sorter.zig:Sorter$1 → Property:src/Sorter.zig:Sorter$1.min',
    );
    // No ownerless Method anywhere in the fixture: every Method id is `<owner>.<name>#N`.
    const ownerless: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label === 'Method' && /^Method:[^:]+:[^.]+#\d+$/.test(n.id)) ownerless.push(n.id);
    });
    expect(ownerless).toEqual([]);
  });

  it('attributes calls inside such containers to the right node, on both ends', () => {
    const calls = getRelationships(result, 'CALLS').map(
      (e) => `${e.rel.sourceId} → ${e.rel.targetId}`,
    );
    // From inside each `R.get` — the caller is THAT builder's `R.get`.
    expect(calls).toContain(
      'Method:src/reflect.zig:Reflect.string$R.get#0 → Function:src/reflect.zig:readAttr',
    );
    expect(calls).toContain(
      'Method:src/reflect.zig:Reflect.url$R.get#0 → Function:src/reflect.zig:normalize',
    );
    // A `const Self = @This();` inside a local container still names THAT
    // container: `check(self: *const Self)` dispatches `self.get()` to `url$R.get`.
    expect(calls).toContain(
      'Method:src/reflect.zig:Reflect.url$R.check#0 → Method:src/reflect.zig:Reflect.url$R.get#0',
    );
    // From inside each anonymous comparator (and the test-local State).
    expect(calls).toContain(
      'Method:src/Sorter.zig:Sorter.sortBoth$1.lessThan#3 → Method:src/Sorter.zig:Sorter.before#2',
    );
    expect(calls).toContain(
      'Method:src/Sorter.zig:Sorter.sortBoth$2.lessThan#3 → Method:src/Sorter.zig:Sorter.before#2',
    );
    expect(calls).toContain(
      'Method:src/Sorter.zig:Sorter.test@L41$State.kill#0 → Method:src/Sorter.zig:Sorter.before#2',
    );
    // INTO a test-local container: `State{}` and `state.kill()` from the test
    // resolve to the qualified Struct / Method (the qualified key must survive
    // the class extractor's whitespace normalization — a test-string host would not).
    expect(calls).toContain(
      'Function:src/Sorter.zig:Sorter."Sorter: local state" → Struct:src/Sorter.zig:Sorter.test@L41$State',
    );
    expect(calls).toContain(
      'Function:src/Sorter.zig:Sorter."Sorter: local state" → Method:src/Sorter.zig:Sorter.test@L41$State.kill#0',
    );
  });
});

describe.skipIf(!zigAvailable)(
  'Zig qualified struct literals (`mod.T{…}`) as construction sites',
  () => {
    // The 2026-09-02 review re-test found that only same-file literals were
    // tracked: 163 `mod.Type{ … }` sites in a real project produced no CALLS
    // edge at all. A first attempt captured them as free constructors, which
    // resolve by the simple tail — `c.Thing{}` bound to a.zig's `Thing` although
    // c.zig defines none. Captured WITH the receiver they take the namespace
    // path `mod.fn()` takes, which resolves inside the module the receiver is
    // bound to: this suite pins the qualifier being honoured, not just the
    // edge appearing.
    let result: PipelineResult;
    let structCalls: ReturnType<typeof getRelationships>;

    beforeAll(async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-qualified-literal'), () => {});
      structCalls = getRelationships(result, 'CALLS').filter((e) => e.targetLabel === 'Struct');
    }, 60000);

    const edgesFrom = (source: string): string[] =>
      structCalls
        .filter((e) => e.source === source)
        .map((e) => `${e.target} @ ${e.targetFilePath} [${e.rel.reason}]`)
        .sort();

    it('binds each same-named `Thing` to the module its qualifier names, marked as a construction site', () => {
      expect(edgesFrom('useA')).toEqual(['Thing @ src/a.zig [import-resolved (constructor)]']);
      expect(edgesFrom('useB')).toEqual(['Thing @ src/b.zig [import-resolved (constructor)]']);
    });

    it('emits nothing when the qualifier’s module has no such member (`c.Thing{}`)', () => {
      // A tail-only resolution would have picked a.zig's or b.zig's `Thing`.
      expect(edgesFrom('useMissing')).toEqual([]);
    });

    it('emits nothing for an external qualifier (`std.Thread.Mutex{}`), even with a same-named local and imported `Mutex`', () => {
      expect(edgesFrom('useExternal')).toEqual([]);
    });

    it('keeps the same-file literal and the single-hop qualified literal apart by reason vocabulary', () => {
      expect(edgesFrom('useLocal')).toEqual([
        'Mutex @ src/d.zig [import-resolved (constructor)]',
        'Mutex @ src/main.zig [local-call (constructor)]',
      ]);
    });
  },
);

describe.skipIf(!zigAvailable)(
  'Zig qualified struct literals — zig-basic (`pioneer.Pioneer{…}`, `pioneer.Tag{…}`)',
  () => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-basic'), () => {});
    }, 60000);

    it('tracks a qualified struct AND union literal as marked construction sites', () => {
      const marked = getRelationships(result, 'CALLS')
        .filter((e) => e.source === 'main' && e.rel.reason.endsWith('(constructor)'))
        .map((e) => `${e.target}:${e.targetLabel} [${e.rel.reason}]`)
        .sort();
      expect(marked).toEqual([
        'Pioneer:Struct [import-resolved (constructor)]',
        'Tag:Union [import-resolved (constructor)]',
      ]);
    });
  },
);

describe.skipIf(!zigAvailable)('Zig hub modules (`pub const X = @import(…)` re-exports)', () => {
  // Audit of three real projects (tigerbeetle, mach, ghostty, 2026-09-02):
  // a hub file made only of re-exports owns NO local binding, so the
  // local-only export lookup answered nothing for `terminal.Terminal.init()`,
  // `t: stdx.Thing`, `var p = stdx.PRNG.from_seed()`. Measured before → after:
  // CALLS into ghostty's `src/terminal/` from outside it 46 → 253, into
  // tigerbeetle's `stdx` hub from outside it 837 → 1500. The published names
  // live in the finalized channel; `namespaceExportsIncludeImportedNames` lets
  // the namespace paths read it.
  let result: PipelineResult;
  let calls: string[];

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-hub'), () => {});
    calls = getRelationships(result, 'CALLS')
      .filter((e) => e.sourceFilePath.endsWith('main.zig'))
      .map((e) => `${e.source} → ${e.target} @ ${e.targetFilePath}`);
  }, 60000);

  it('resolves a static call through a hub-republished NAMED type (`stdx.Thing.make()`)', () => {
    expect(calls).toContain('c1_hub_named_static → make @ src/stdx/thing.zig');
  });

  it('resolves a static call through a hub-republished MODULE (`stdx.PRNG.from_seed()`, `PRNG = @import("prng.zig")`)', () => {
    // ghostty's `terminal.Terminal.init(…)` shape (150 sites).
    expect(calls).toContain('c2_hub_module_static → from_seed @ src/stdx/prng.zig');
  });

  it('types a receiver ANNOTATED with the hub path (`t: stdx.Thing`, `p: stdx.PRNG`)', () => {
    // tigerbeetle: 289 `: stdx.Type` annotations.
    expect(calls).toContain('c3_hub_named_annotation → m @ src/stdx/thing.zig');
    expect(calls).toContain('c4_hub_module_annotation → next @ src/stdx/prng.zig');
  });

  it('types a receiver from a constructor call through the hub (`var p = stdx.PRNG.from_seed()`)', () => {
    expect(calls).toContain('c6_hub_call_return_typing → next @ src/stdx/prng.zig');
    expect(calls).toContain('c6_hub_call_return_typing → from_seed @ src/stdx/prng.zig');
  });

  it('types a generic instantiation annotated through the hub (`h: stdx.BoundedArrayType(u8, 4)`)', () => {
    expect(calls).toContain('c10_hub_generic_annotation → count @ src/stdx/bounded_array.zig');
  });

  it('resolves a hub-republished free function (`stdx.helper()`)', () => {
    expect(calls).toContain('c11_hub_reexported_fn → helper @ src/stdx/util.zig');
  });

  it('still resolves the alias-then-use shape (`const PRNG = stdx.PRNG; PRNG.from_seed()`)', () => {
    expect(calls).toContain('c5_alias_then_static → from_seed @ src/stdx/prng.zig');
    expect(calls).toContain('c5_alias_then_static → next @ src/stdx/prng.zig');
  });

  it('never resolves a name through the hub that the hub does not publish', () => {
    // `stdx.secret` (a private `const secret = @import(…)`) is not referenced
    // by the fixture because it would not compile; the guard here is that no
    // call from main.zig lands in util.zig except through the published
    // `helper` — nothing leaks via the private import.
    const intoUtil = calls.filter((c) => c.endsWith('@ src/stdx/util.zig'));
    expect(intoUtil).toEqual(['c11_hub_reexported_fn → helper @ src/stdx/util.zig']);
  });
});

describe.skipIf(!zigAvailable)(
  'Zig enum variants as typed receivers (`Op.create.event_max()`)',
  () => {
    let result: PipelineResult;
    let calls: string[];

    beforeAll(async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-hub'), () => {});
      calls = getRelationships(result, 'CALLS')
        .filter((e) => e.sourceFilePath.endsWith('main.zig'))
        .map((e) => `${e.source} → ${e.target}`);
    }, 60000);

    it('dispatches a method called on a variant reached through the enum type', () => {
      // tigerbeetle writes `Operation.<variant>.event_max(…)` 147 times. The
      // variant has no written type; its type is the enum, so the field walk
      // that already handles `self.session.name()` types `Op.create` as `Op`.
      expect(calls).toContain('c7_enum_variant_receiver → event_max');
    });

    it('dispatches a method on an enum-typed parameter (`op: Op`)', () => {
      expect(calls).toContain('c8_enum_param_receiver → event_max');
    });
  },
);

describe.skipIf(!zigAvailable)(
  'Zig receivers named after their type (`counter: *Counter`, `pool: *@This()`)',
  () => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-receivers'), () => {});
    }, 60000);

    it('labels container-typed first parameters as receivers: instance methods, receiver out of the arity', () => {
      // `self` is a convention. tigerbeetle names the receiver after its type
      // (777 of 1127 methods), mach writes `pool: *@This()` (764 of 833); both
      // used to be `isStatic: true` with the receiver counted in `#<arity>`.
      const methods = new Map<string, { isStatic: boolean }>();
      result.graph.forEachNode((n) => {
        if (n.label === 'Method') methods.set(n.id, { isStatic: n.properties.isStatic === true });
      });
      expect(methods.get('Method:src/counter.zig:Counter.incr#0')?.isStatic).toBe(false);
      expect(methods.get('Method:src/counter.zig:Counter.incr_self#0')?.isStatic).toBe(false);
      expect(methods.get('Method:src/counter.zig:Counter.by_value#0')?.isStatic).toBe(false);
      expect(methods.get('Method:src/counter.zig:Pool.release#1')?.isStatic).toBe(false);
      expect(methods.get('Method:src/counter.zig:Op.event_max#0')?.isStatic).toBe(false);
      expect(methods.get('Method:src/stdx/prng.zig:prng.next#0')?.isStatic).toBe(false);
      // A factory keeps its static label and full arity.
      expect(methods.get('Method:src/stdx/prng.zig:prng.from_seed#1')?.isStatic).toBe(true);
      // Nothing is left under the old receiver-counted ids.
      expect(methods.has('Method:src/counter.zig:Counter.incr#1')).toBe(false);
      expect(methods.has('Method:src/counter.zig:Pool.release#2')).toBe(false);
    });

    it('labels a file-struct receiver typed by the file stem (`ledger: *Ledger` in `Ledger.zig`)', () => {
      // `Ledger.zig` declares no `Self` alias: the stem is the only spelling of
      // its type, and only the file path can supply it. The structure phase
      // used to build these methods without the path, so `add` came out static
      // as `Ledger.add#2` while the scope side (which has the path) resolved
      // `ledger.add(3)` to `Ledger.add#1` — an id that did not exist.
      const methods = new Map<string, boolean>();
      result.graph.forEachNode((n) => {
        if (n.label === 'Method') methods.set(n.id, n.properties.isStatic === true);
      });
      expect(methods.get('Method:src/Ledger.zig:Ledger.add#1')).toBe(false);
      expect(methods.get('Method:src/Ledger.zig:Ledger.sum#0')).toBe(false);
      expect(methods.get('Method:src/Ledger.zig:Ledger.empty#0')).toBe(true);
      expect(methods.has('Method:src/Ledger.zig:Ledger.add#2')).toBe(false);
      const calls = edgeSet(getRelationships(result, 'CALLS'));
      expect(calls).toEqual(
        expect.arrayContaining([
          'use_file_struct_receiver → empty',
          'use_file_struct_receiver → add',
          'use_file_struct_receiver → sum',
        ]),
      );
    });

    it('dispatches calls onto those methods exactly as onto `self` methods', () => {
      const calls = edgeSet(getRelationships(result, 'CALLS'));
      expect(calls).toEqual(
        expect.arrayContaining([
          'use_named_receiver → incr',
          'use_named_receiver → incr_self',
          'use_named_receiver → by_value',
          'use_this_receiver → release',
        ]),
      );
    });
  },
);
