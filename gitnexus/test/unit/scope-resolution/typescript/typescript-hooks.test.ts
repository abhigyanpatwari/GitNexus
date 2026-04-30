/**
 * Unit 3 coverage for TypeScript simple hooks + receiver-binding synthesis.
 *
 * Exercises the small-surface hooks that mirror Python's simple-hooks:
 * `tsBindingScopeFor`, `tsImportOwningScope`, `tsReceiverBinding`. Also
 * covers AST-walking `synthesizeTsReceiverBinding`, which is the
 * TypeScript analog of Python's `self` / C#'s `this`+`base` synthesis.
 *
 * `isSuperReceiver` and `mergeBindings` live on the ScopeResolver
 * contract and are exercised in later units.
 */

import { describe, it, expect } from 'vitest';
import {
  tsBindingScopeFor,
  tsImportOwningScope,
  tsReceiverBinding,
} from '../../../../src/core/ingestion/languages/typescript/simple-hooks.js';
import { synthesizeTsReceiverBinding } from '../../../../src/core/ingestion/languages/typescript/receiver-binding.js';
import { typescriptMergeBindings } from '../../../../src/core/ingestion/languages/typescript/merge-bindings.js';
import { typescriptProvider } from '../../../../src/core/ingestion/languages/typescript.js';
import { typescriptArityCompatibility } from '../../../../src/core/ingestion/languages/typescript/arity.js';
import { computeTsArityMetadata } from '../../../../src/core/ingestion/languages/typescript/arity-metadata.js';
import { getTsParser } from '../../../../src/core/ingestion/languages/typescript/query.js';
import { emitTsScopeCaptures } from '../../../../src/core/ingestion/languages/typescript/captures.js';
import {
  findNodeAtRange,
  type SyntaxNode,
} from '../../../../src/core/ingestion/utils/ast-helpers.js';
import type {
  BindingRef,
  Callsite,
  CaptureMatch,
  NodeLabel,
  ParsedImport,
  Scope,
  ScopeId,
  ScopeTree,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';

// ─── Fake scope helpers ───────────────────────────────────────────────────

interface FakeScopeInit {
  readonly kind: Scope['kind'];
  readonly id?: ScopeId;
  readonly parent?: ScopeId | null;
  readonly typeBindings?: Map<string, TypeRef>;
}

function fakeScope(init: FakeScopeInit): Scope {
  return {
    id: (init.id ?? 's1') as ScopeId,
    parent: init.parent ?? null,
    kind: init.kind,
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
    filePath: 't.ts',
    bindings: new Map(),
    ownedDefs: [],
    imports: [],
    typeBindings: init.typeBindings ?? new Map<string, TypeRef>(),
  } as unknown as Scope;
}

function fakeTree(scopes: readonly Scope[]): ScopeTree {
  const byId = new Map<ScopeId, Scope>();
  for (const s of scopes) byId.set(s.id, s);
  return {
    getScope: (id: ScopeId) => byId.get(id),
  } as unknown as ScopeTree;
}

function typeRef(rawName: string, source: TypeRef['source'] = 'self'): TypeRef {
  return {
    rawName,
    declaredAtScope: 's-decl' as ScopeId,
    source,
  };
}

const emptyTree = {} as ScopeTree;

// ─── Capture helpers ──────────────────────────────────────────────────────

/** Build a minimal fake CaptureMatch carrying just the tags/text the
 *  hook under test inspects. */
function fakeCapture(tag: string, text: string, extras: Record<string, string> = {}): CaptureMatch {
  const mk = (t: string, src: string) => ({
    name: t,
    range: { startLine: 1, startCol: 0, endLine: 1, endCol: src.length },
    text: src,
  });
  const m: Record<string, ReturnType<typeof mk>> = {};
  m[tag] = mk(tag, text);
  for (const [k, v] of Object.entries(extras)) m[k] = mk(k, v);
  return m as unknown as CaptureMatch;
}

// ─── tsBindingScopeFor ────────────────────────────────────────────────────

describe('tsBindingScopeFor — let/const (block-scoped)', () => {
  it('delegates to innermost for `let` declarations', () => {
    const block = fakeScope({ kind: 'Block', id: 'blk' as ScopeId });
    const cap = fakeCapture('@declaration.variable', 'let x = 1');
    expect(tsBindingScopeFor(cap, block, emptyTree)).toBe(null);
  });

  it('delegates to innermost for `const` declarations', () => {
    const block = fakeScope({ kind: 'Block', id: 'blk' as ScopeId });
    const cap = fakeCapture('@declaration.variable', 'const x = 1');
    expect(tsBindingScopeFor(cap, block, emptyTree)).toBe(null);
  });
});

describe('tsBindingScopeFor — var (hoisted to function/module)', () => {
  it('hoists `var` from a nested block to the enclosing function scope', () => {
    const fn = fakeScope({ kind: 'Function', id: 'fn' as ScopeId });
    const blk = fakeScope({
      kind: 'Block',
      id: 'blk' as ScopeId,
      parent: 'fn' as ScopeId,
    });
    const tree = fakeTree([fn, blk]);
    const cap = fakeCapture('@declaration.variable', 'var x = 1');
    expect(tsBindingScopeFor(cap, blk, tree)).toBe('fn');
  });

  it('hoists top-level `var` to the enclosing module scope', () => {
    const mod = fakeScope({ kind: 'Module', id: 'mod' as ScopeId });
    const blk = fakeScope({
      kind: 'Block',
      id: 'blk' as ScopeId,
      parent: 'mod' as ScopeId,
    });
    const tree = fakeTree([mod, blk]);
    const cap = fakeCapture('@declaration.variable', 'var x = 1');
    expect(tsBindingScopeFor(cap, blk, tree)).toBe('mod');
  });

  it('stops at the innermost Function even when a Module is above it', () => {
    const mod = fakeScope({ kind: 'Module', id: 'mod' as ScopeId });
    const fn = fakeScope({
      kind: 'Function',
      id: 'fn' as ScopeId,
      parent: 'mod' as ScopeId,
    });
    const blk = fakeScope({
      kind: 'Block',
      id: 'blk' as ScopeId,
      parent: 'fn' as ScopeId,
    });
    const tree = fakeTree([mod, fn, blk]);
    const cap = fakeCapture('@declaration.variable', 'var x = 1');
    expect(tsBindingScopeFor(cap, blk, tree)).toBe('fn');
  });
});

describe('tsBindingScopeFor — method return types', () => {
  it('hoists @type-binding.return to the enclosing Module scope', () => {
    const mod = fakeScope({ kind: 'Module', id: 'mod' as ScopeId });
    const cls = fakeScope({
      kind: 'Class',
      id: 'cls' as ScopeId,
      parent: 'mod' as ScopeId,
    });
    const fn = fakeScope({
      kind: 'Function',
      id: 'fn' as ScopeId,
      parent: 'cls' as ScopeId,
    });
    const tree = fakeTree([mod, cls, fn]);
    const cap = fakeCapture('@type-binding.return', 'save', {
      '@type-binding.name': 'save',
      '@type-binding.type': 'User',
    });
    expect(tsBindingScopeFor(cap, fn, tree)).toBe('mod');
  });
});

// ─── tsImportOwningScope ──────────────────────────────────────────────────

describe('tsImportOwningScope', () => {
  const fakeImport: ParsedImport = {
    kind: 'named',
    localName: 'X',
    importedName: 'X',
    targetRaw: './m',
  } as unknown as ParsedImport;

  it('delegates to the central default (returns null)', () => {
    const mod = fakeScope({ kind: 'Module', id: 'mod' as ScopeId });
    expect(tsImportOwningScope(fakeImport, mod, emptyTree)).toBe(null);
  });

  it('delegates even when the innermost scope is a namespace', () => {
    const ns = fakeScope({ kind: 'Namespace', id: 'ns-1' as ScopeId });
    // Central default walks to nearest Module/Namespace — returning
    // null lets that happen and attaches to ns-1 via the default path.
    expect(tsImportOwningScope(fakeImport, ns, emptyTree)).toBe(null);
  });
});

// ─── tsReceiverBinding ────────────────────────────────────────────────────

describe('tsReceiverBinding', () => {
  it('returns the `this` type binding on a Function scope', () => {
    const ref = typeRef('User');
    const fn = fakeScope({
      kind: 'Function',
      typeBindings: new Map([['this', ref]]),
    });
    expect(tsReceiverBinding(fn)).toBe(ref);
  });

  it('returns null when no `this` has been synthesized (e.g. static method)', () => {
    const fn = fakeScope({ kind: 'Function' });
    expect(tsReceiverBinding(fn)).toBe(null);
  });

  it('returns null for non-Function scopes', () => {
    expect(tsReceiverBinding(fakeScope({ kind: 'Module' }))).toBe(null);
    expect(tsReceiverBinding(fakeScope({ kind: 'Class' }))).toBe(null);
    expect(tsReceiverBinding(fakeScope({ kind: 'Block' }))).toBe(null);
  });
});

// ─── synthesizeTsReceiverBinding (AST-walking) ────────────────────────────

function parseFirstFunction(src: string, fnType: string): SyntaxNode {
  const tree = getTsParser().parse(src);
  const stack: SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === fnType) return n;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c !== null) stack.push(c);
    }
  }
  throw new Error(`No ${fnType} node found in source`);
}

describe('synthesizeTsReceiverBinding — class methods', () => {
  it('emits `this` → class name for a class method_definition', () => {
    const src = 'class User { save() {} }';
    const fn = parseFirstFunction(src, 'method_definition');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).not.toBeNull();
    expect(m!['@type-binding.this']).toBeDefined();
    expect(m!['@type-binding.name'].text).toBe('this');
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('emits `this` → class name for an abstract class method', () => {
    const src = 'abstract class User { save() {} }';
    const fn = parseFirstFunction(src, 'method_definition');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).not.toBeNull();
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('skips static methods', () => {
    const src = 'class User { static create() {} }';
    const fn = parseFirstFunction(src, 'method_definition');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).toBeNull();
  });

  it('skips methods on anonymous class_expression without a name', () => {
    const src = 'const C = class { save() {} };';
    const fn = parseFirstFunction(src, 'method_definition');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).toBeNull();
  });
});

describe('synthesizeTsReceiverBinding — interface/abstract signatures', () => {
  it('emits `this` for an interface method_signature', () => {
    const src = 'interface IUser { save(): void; }';
    const fn = parseFirstFunction(src, 'method_signature');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).not.toBeNull();
    expect(m!['@type-binding.type'].text).toBe('IUser');
  });

  it('emits `this` for an abstract_method_signature', () => {
    const src = 'abstract class Base { abstract save(): void; }';
    const fn = parseFirstFunction(src, 'abstract_method_signature');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).not.toBeNull();
    expect(m!['@type-binding.type'].text).toBe('Base');
  });
});

describe('synthesizeTsReceiverBinding — class-field arrow functions', () => {
  it('emits `this` for a class field assigned an arrow function (`m = () => {}`)', () => {
    const src = 'class User { save = () => {}; }';
    const fn = parseFirstFunction(src, 'arrow_function');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).not.toBeNull();
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('emits `this` for a class field assigned a function_expression', () => {
    const src = 'class User { save = function() {}; }';
    const fn = parseFirstFunction(src, 'function_expression');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).not.toBeNull();
    expect(m!['@type-binding.type'].text).toBe('User');
  });

  it('skips `static m = () => {}` (no instance `this`)', () => {
    const src = 'class User { static save = () => {}; }';
    const fn = parseFirstFunction(src, 'arrow_function');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).toBeNull();
  });

  it('does NOT emit for arrow functions nested inside method bodies', () => {
    // scope-chain lookup on `tsReceiverBinding` resolves nested arrows'
    // `this` via the enclosing method's synthesized binding — no direct
    // synthesis needed here.
    const src = 'class User { save() { const f = () => {}; } }';
    const fn = parseFirstFunction(src, 'arrow_function');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).toBeNull();
  });

  it('does NOT emit for a module-level arrow function', () => {
    const src = 'const fn = () => {};';
    const fn = parseFirstFunction(src, 'arrow_function');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).toBeNull();
  });

  it('does NOT emit for a module-level function_declaration', () => {
    const src = 'function fn() {}';
    const fn = parseFirstFunction(src, 'function_declaration');
    const m = synthesizeTsReceiverBinding(fn);
    expect(m).toBeNull();
  });
});

// ─── End-to-end integration: captures.ts wiring ───────────────────────────

describe('emitTsScopeCaptures — integration with receiver synthesis', () => {
  it('emits @type-binding.this on class methods', () => {
    const src = 'class User { save() { this.name = "x"; } }';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const thisMatches = caps.filter(
      (c) => (c as Record<string, unknown>)['@type-binding.this'] !== undefined,
    );
    expect(thisMatches.length).toBeGreaterThanOrEqual(1);
    const m = thisMatches[0]! as Record<string, { text: string }>;
    expect(m['@type-binding.name'].text).toBe('this');
    expect(m['@type-binding.type'].text).toBe('User');
  });

  it('does NOT emit @type-binding.this on free functions', () => {
    const src = 'function save() { return 1; }';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const thisMatches = caps.filter(
      (c) => (c as Record<string, unknown>)['@type-binding.this'] !== undefined,
    );
    expect(thisMatches).toHaveLength(0);
  });

  it('does NOT emit @type-binding.this on static methods', () => {
    const src = 'class User { static create() { return 1; } }';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const thisMatches = caps.filter(
      (c) => (c as Record<string, unknown>)['@type-binding.this'] !== undefined,
    );
    expect(thisMatches).toHaveLength(0);
  });

  it('emits @type-binding.this on class-field arrow functions', () => {
    const src = 'class User { save = () => { this.name = "x"; }; }';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const thisMatches = caps.filter(
      (c) => (c as Record<string, unknown>)['@type-binding.this'] !== undefined,
    );
    expect(thisMatches.length).toBeGreaterThanOrEqual(1);
    const m = thisMatches[0]! as Record<string, { text: string }>;
    expect(m['@type-binding.type'].text).toBe('User');
  });

  it('emits @type-binding.this on interface method signatures', () => {
    const src = 'interface IUser { save(): void; }';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const thisMatches = caps.filter(
      (c) => (c as Record<string, unknown>)['@type-binding.this'] !== undefined,
    );
    expect(thisMatches.length).toBeGreaterThanOrEqual(1);
    const m = thisMatches[0]! as Record<string, { text: string }>;
    expect(m['@type-binding.type'].text).toBe('IUser');
  });

  it('silences-findNodeAtRange suppresses unused import', () => {
    // Guard test: ensures helper ref remains valid after refactor.
    expect(typeof findNodeAtRange).toBe('function');
  });
});

// ─── typescriptMergeBindings ──────────────────────────────────────────────

describe('typescriptMergeBindings — LEGB tier shadowing (single space)', () => {
  const binding = (
    origin: BindingRef['origin'],
    nodeId: string,
    type: NodeLabel = 'Function',
  ): BindingRef =>
    ({
      def: { nodeId, filePath: 't.ts', type } as SymbolDefinition,
      origin,
    }) as BindingRef;

  it('local shadows `import` (value space)', () => {
    const local = binding('local', 'L', 'Function');
    const imp = binding('import', 'I', 'Function');
    expect(typescriptMergeBindings([imp, local])).toEqual([local]);
  });

  it('local shadows `wildcard` (value space)', () => {
    const local = binding('local', 'L', 'Variable');
    const wc = binding('wildcard', 'W', 'Variable');
    expect(typescriptMergeBindings([wc, local])).toEqual([local]);
  });

  it('explicit `import` shadows `wildcard` at tier-1', () => {
    const imp = binding('import', 'I', 'Function');
    const wc = binding('wildcard', 'W', 'Function');
    expect(typescriptMergeBindings([wc, imp])).toEqual([imp]);
  });

  it('keeps overload siblings at the same tier', () => {
    const a = binding('local', 'A', 'Function');
    const b = binding('local', 'B', 'Function');
    const out = typescriptMergeBindings([a, b]);
    expect(out).toHaveLength(2);
  });

  it('dedupes same-nodeId bindings', () => {
    const a = binding('local', 'A', 'Function');
    const a2 = binding('local', 'A', 'Function');
    expect(typescriptMergeBindings([a, a2])).toHaveLength(1);
  });

  it('empty in → empty out', () => {
    expect(typescriptMergeBindings([])).toEqual([]);
  });
});

describe('typescriptMergeBindings — declaration merging (multi-space)', () => {
  const binding = (origin: BindingRef['origin'], nodeId: string, type: NodeLabel): BindingRef =>
    ({
      def: { nodeId, filePath: 't.ts', type } as SymbolDefinition,
      origin,
    }) as BindingRef;

  it('keeps local class + local interface (different spaces at tier-0)', () => {
    // class Foo {} + interface Foo {} — class occupies value+type,
    // interface occupies type only. Both at tier-0 locally; they
    // coexist in their spaces and pass through intact.
    const cls = binding('local', 'C', 'Class');
    const iface = binding('local', 'I', 'Interface');
    const out = typescriptMergeBindings([cls, iface]);
    expect(out).toHaveLength(2);
    expect(out).toContain(cls);
    expect(out).toContain(iface);
  });

  it('keeps local namespace + local class (namespace + value/type coexist)', () => {
    const ns = binding('local', 'N', 'Namespace');
    const cls = binding('local', 'C', 'Class');
    const out = typescriptMergeBindings([ns, cls]);
    expect(out).toHaveLength(2);
  });

  it('keeps local interface + imported value (different spaces)', () => {
    // `interface Foo {}` locally, `import { Foo } from './a'` (Function).
    // Local wins in type space; import wins in value space. Both kept.
    const iface = binding('local', 'I', 'Interface');
    const imp = binding('import', 'V', 'Function');
    const out = typescriptMergeBindings([iface, imp]);
    expect(out).toHaveLength(2);
  });

  it('local class shadows imported class (both spaces overlap)', () => {
    // Both occupy value+type — local wins in both spaces.
    const local = binding('local', 'L', 'Class');
    const imp = binding('import', 'I', 'Class');
    expect(typescriptMergeBindings([local, imp])).toEqual([local]);
  });

  it('local enum shadows imported enum (both dual-space)', () => {
    const local = binding('local', 'L', 'Enum');
    const imp = binding('import', 'I', 'Enum');
    expect(typescriptMergeBindings([local, imp])).toEqual([local]);
  });

  it('wildcard-only bindings survive when nothing better exists', () => {
    const wc = binding('wildcard', 'W', 'Function');
    expect(typescriptMergeBindings([wc])).toEqual([wc]);
  });

  it('imported namespace shadows wildcard in both namespace and value spaces', () => {
    const imp = binding('import', 'I', 'Namespace');
    const wc = binding('wildcard', 'W', 'Namespace');
    expect(typescriptMergeBindings([wc, imp])).toEqual([imp]);
  });

  it('unknown NodeLabel falls back to value space', () => {
    // A random-ish label we don't specially handle.
    const local = binding('local', 'L', 'Route');
    const imp = binding('import', 'I', 'Route');
    expect(typescriptMergeBindings([local, imp])).toEqual([local]);
  });
});

describe('typescriptProvider.mergeBindings adapter', () => {
  const binding = (origin: BindingRef['origin'], nodeId: string, type: NodeLabel): BindingRef =>
    ({
      origin,
      def: { nodeId, type },
    }) as BindingRef;

  it('is scope-id independent because finalize calls it per (scope, name)', () => {
    const merge = typescriptProvider.mergeBindings;
    if (merge === undefined) throw new Error('typescriptProvider.mergeBindings missing');

    const importBinding = binding('import', 'I', 'Class');
    const localBinding = binding('local', 'L', 'Class');
    const scopeA = fakeScope({ kind: 'Module', id: 'module-a' as ScopeId });
    const scopeB = fakeScope({ kind: 'Module', id: 'module-b' as ScopeId });

    expect(merge(scopeA, [importBinding, localBinding])).toEqual([localBinding]);
    expect(merge(scopeB, [importBinding, localBinding])).toEqual([localBinding]);
  });
});

// ─── typescriptArityCompatibility ─────────────────────────────────────────

describe('typescriptArityCompatibility', () => {
  const callsite = (arity: number): Callsite => ({ arity }) as Callsite;
  const def = (o: Partial<SymbolDefinition> = {}): SymbolDefinition =>
    ({ nodeId: 'd1', filePath: 't.ts', type: 'Function', ...o }) as SymbolDefinition;

  it('unknown when both parameter counts are missing', () => {
    expect(typescriptArityCompatibility(def(), callsite(2))).toBe('unknown');
  });

  it('compatible inside [required, total]', () => {
    expect(
      typescriptArityCompatibility(
        def({ parameterCount: 3, requiredParameterCount: 1 }),
        callsite(2),
      ),
    ).toBe('compatible');
  });

  it('compatible at exactly requiredParameterCount', () => {
    expect(
      typescriptArityCompatibility(
        def({ parameterCount: 3, requiredParameterCount: 2 }),
        callsite(2),
      ),
    ).toBe('compatible');
  });

  it('compatible at exactly parameterCount', () => {
    expect(
      typescriptArityCompatibility(
        def({ parameterCount: 3, requiredParameterCount: 1 }),
        callsite(3),
      ),
    ).toBe('compatible');
  });

  it('incompatible below required', () => {
    expect(
      typescriptArityCompatibility(
        def({ parameterCount: 3, requiredParameterCount: 2 }),
        callsite(1),
      ),
    ).toBe('incompatible');
  });

  it('incompatible above max without rest params', () => {
    expect(
      typescriptArityCompatibility(
        def({ parameterCount: 2, requiredParameterCount: 0 }),
        callsite(5),
      ),
    ).toBe('incompatible');
  });

  it('compatible above declared params when def has rest params', () => {
    expect(
      typescriptArityCompatibility(
        def({
          parameterCount: undefined,
          requiredParameterCount: 0,
          parameterTypes: ['params'],
        }),
        callsite(7),
      ),
    ).toBe('compatible');
  });

  it('compatible above declared params with mixed prefix + rest', () => {
    expect(
      typescriptArityCompatibility(
        def({
          parameterCount: undefined,
          requiredParameterCount: 1,
          parameterTypes: ['string', 'params number[]'],
        }),
        callsite(4),
      ),
    ).toBe('compatible');
  });

  it('unknown for negative arity (defensive)', () => {
    expect(
      typescriptArityCompatibility(
        def({ parameterCount: 3, requiredParameterCount: 1 }),
        callsite(-1),
      ),
    ).toBe('unknown');
  });

  it('unknown for non-finite arity', () => {
    expect(
      typescriptArityCompatibility(
        def({ parameterCount: 3, requiredParameterCount: 1 }),
        callsite(NaN),
      ),
    ).toBe('unknown');
  });
});

// ─── computeTsArityMetadata (AST-driven) ──────────────────────────────────

function parseFunctionNode(src: string, fnType: string): SyntaxNode {
  const tree = getTsParser().parse(src);
  const stack: SyntaxNode[] = [tree.rootNode];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === fnType) return n;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c !== null) stack.push(c);
    }
  }
  throw new Error(`No ${fnType} node found`);
}

describe('computeTsArityMetadata — basics', () => {
  it('counts required parameters without annotations', () => {
    const fn = parseFunctionNode('function f(a, b, c) {}', 'function_declaration');
    const m = computeTsArityMetadata(fn);
    expect(m.parameterCount).toBe(3);
    expect(m.requiredParameterCount).toBe(3);
  });

  it('records declared parameter types (stripping generics)', () => {
    const fn = parseFunctionNode(
      'function f(a: string, b: Array<User>, c: User[]) {}',
      'function_declaration',
    );
    const m = computeTsArityMetadata(fn);
    expect(m.parameterCount).toBe(3);
    expect(m.parameterTypes).toEqual(['string', 'Array', 'User']);
  });

  it('treats optional `p?: T` as optional', () => {
    const fn = parseFunctionNode('function f(a: string, b?: number) {}', 'function_declaration');
    const m = computeTsArityMetadata(fn);
    expect(m.parameterCount).toBe(2);
    expect(m.requiredParameterCount).toBe(1);
  });

  it('treats `p: T = …` (default) as optional', () => {
    const fn = parseFunctionNode('function f(a: string, b: number = 1) {}', 'function_declaration');
    const m = computeTsArityMetadata(fn);
    expect(m.parameterCount).toBe(2);
    expect(m.requiredParameterCount).toBe(1);
  });

  it('rest params: `...args: T[]` → max unknown + `params` marker', () => {
    const fn = parseFunctionNode(
      'function f(a: string, ...rest: number[]) {}',
      'function_declaration',
    );
    const m = computeTsArityMetadata(fn);
    expect(m.parameterCount).toBeUndefined();
    expect(m.requiredParameterCount).toBeUndefined();
    expect(m.parameterTypes).toContain('params');
  });

  it('does NOT count generic type parameters toward arity', () => {
    const fn = parseFunctionNode('function f<T, U>(a: T, b: U): void {}', 'function_declaration');
    const m = computeTsArityMetadata(fn);
    expect(m.parameterCount).toBe(2);
  });

  it('omits parameterTypes when all params are untyped', () => {
    const fn = parseFunctionNode('function f(a, b) {}', 'function_declaration');
    const m = computeTsArityMetadata(fn);
    expect(m.parameterTypes).toBeUndefined();
  });

  it('strips `Foo<Bar<Baz>>[]` to `Foo`', () => {
    const fn = parseFunctionNode('function f(a: Foo<Bar<Baz>>[]) {}', 'function_declaration');
    const m = computeTsArityMetadata(fn);
    expect(m.parameterTypes).toEqual(['Foo']);
  });

  it('works on method definitions', () => {
    const fn = parseFunctionNode(
      'class C { m(a: string, b?: number, c: User = null) {} }',
      'method_definition',
    );
    const m = computeTsArityMetadata(fn);
    expect(m.parameterCount).toBe(3);
    expect(m.requiredParameterCount).toBe(1);
    expect(m.parameterTypes).toEqual(['string', 'number', 'User']);
  });

  it('works on function overload signatures', () => {
    const fn = parseFunctionNode(
      'function f(x: string): void; function f(x) {}',
      'function_signature',
    );
    const m = computeTsArityMetadata(fn);
    expect(m.parameterCount).toBe(1);
    expect(m.parameterTypes).toEqual(['string']);
  });
});

// ─── End-to-end: arity metadata emitted via captures.ts ───────────────────

describe('emitTsScopeCaptures — arity metadata integration', () => {
  it('attaches @declaration.parameter-count to function declarations', () => {
    const src = 'function f(a, b, c) {}';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const fn = caps.find(
      (c) => (c as Record<string, unknown>)['@declaration.function'] !== undefined,
    );
    expect(fn).toBeDefined();
    expect((fn as Record<string, { text: string }>)['@declaration.parameter-count'].text).toBe('3');
    expect(
      (fn as Record<string, { text: string }>)['@declaration.required-parameter-count'].text,
    ).toBe('3');
  });

  it('omits parameter-count when rest params make max unknown', () => {
    const src = 'function f(...args: number[]) {}';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const fn = caps.find(
      (c) => (c as Record<string, unknown>)['@declaration.function'] !== undefined,
    );
    expect(fn).toBeDefined();
    expect((fn as Record<string, unknown>)['@declaration.parameter-count']).toBeUndefined();
    expect((fn as Record<string, { text: string }>)['@declaration.parameter-types'].text).toContain(
      'params',
    );
  });

  it('attaches @reference.arity on free calls', () => {
    const src = 'f(1, 2, 3);';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const call = caps.find(
      (c) => (c as Record<string, unknown>)['@reference.call.free'] !== undefined,
    );
    expect(call).toBeDefined();
    expect((call as Record<string, { text: string }>)['@reference.arity'].text).toBe('3');
  });

  it('attaches @reference.arity on constructor calls', () => {
    const src = 'const u = new User("a", 1);';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const call = caps.find(
      (c) => (c as Record<string, unknown>)['@reference.call.constructor'] !== undefined,
    );
    expect(call).toBeDefined();
    expect((call as Record<string, { text: string }>)['@reference.arity'].text).toBe('2');
    // parameter-types should infer string + number from literals.
    const types = JSON.parse(
      (call as Record<string, { text: string }>)['@reference.parameter-types'].text,
    ) as string[];
    expect(types).toEqual(['string', 'number']);
  });

  it('attaches @reference.arity on member calls', () => {
    const src = 'obj.m(x);';
    const caps = emitTsScopeCaptures(src, 't.ts');
    const call = caps.find(
      (c) => (c as Record<string, unknown>)['@reference.call.member'] !== undefined,
    );
    expect(call).toBeDefined();
    expect((call as Record<string, { text: string }>)['@reference.arity'].text).toBe('1');
  });
});
