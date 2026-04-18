/**
 * Unit tests for the scope-aware registries (RFC §4; Ring 2 SHARED #917).
 *
 * Tests are organized per RFC §4.2 step so a regression localizes to the
 * step it broke:
 *
 *   §4.2 Step 1 — lexical scope-chain walk + shadowing
 *   §4.2 Step 2 — type-binding / MRO walk (method/field registries)
 *   §4.2 Step 3 — owner-scoped contributor
 *   §4.2 Step 4 — kind filter + kind-match evidence
 *   §4.2 Step 5 — arity filter
 *   §4.2 Step 6 — global-qualified fallback
 *   §4.2 Step 7 — rank + tie-break cascade
 *   §4.5       — lookupQualified helper
 *   §4.7       — invariants
 *
 * Corroborators (owner-match, unresolved-import cap, dynamic-unresolved)
 * get their own sections.
 */

import { describe, it, expect } from 'vitest';
import {
  buildClassRegistry,
  buildFieldRegistry,
  buildMethodRegistry,
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  lookupCore,
  lookupQualified,
  EvidenceWeights,
  type BindingRef,
  type ImportEdge,
  type Range,
  type RegistryContext,
  type Resolution,
  type Scope,
  type ScopeId,
  type ScopeKind,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const r = (startLine: number, startCol: number, endLine: number, endCol: number): Range => ({
  startLine,
  startCol,
  endLine,
  endCol,
});

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  nodeId: overrides.nodeId,
  filePath: overrides.filePath ?? 'x.ts',
  type: overrides.type ?? 'Class',
  ...overrides,
});

const mkBinding = (
  def: SymbolDefinition,
  origin: BindingRef['origin'],
  via?: ImportEdge,
): BindingRef => ({ def, origin, ...(via !== undefined ? { via } : {}) });

interface ScopeSpec {
  id: ScopeId;
  parent: ScopeId | null;
  kind?: ScopeKind;
  range?: Range;
  filePath?: string;
  bindings?: Record<string, readonly BindingRef[]>;
  ownedDefs?: readonly SymbolDefinition[];
  typeBindings?: Record<string, TypeRef>;
}

const mkScope = (s: ScopeSpec): Scope => ({
  id: s.id,
  parent: s.parent,
  kind: s.kind ?? 'Module',
  range: s.range ?? r(1, 0, 1000, 0),
  filePath: s.filePath ?? 'x.ts',
  bindings: new Map(Object.entries(s.bindings ?? {})),
  ownedDefs: s.ownedDefs ?? [],
  imports: [],
  typeBindings: new Map(Object.entries(s.typeBindings ?? {})),
});

const typeRef = (rawName: string, declaredAtScope: ScopeId): TypeRef => ({
  rawName,
  declaredAtScope,
  source: 'parameter-annotation',
});

function makeCtx(
  scopes: Scope[],
  defs: SymbolDefinition[],
  opts: {
    mro?: Record<string, readonly string[]>;
    implsByInterface?: Record<string, readonly string[]>;
    arity?: (
      callsite: { arity: number },
      def: SymbolDefinition,
    ) => 'compatible' | 'unknown' | 'incompatible';
  } = {},
): RegistryContext {
  const defIndex = buildDefIndex(defs);
  const qualifiedNameIndex = buildQualifiedNameIndex(defs);
  const moduleScopes = buildModuleScopeIndex(
    scopes
      .filter((s) => s.kind === 'Module')
      .map((s) => ({ filePath: s.filePath, moduleScopeId: s.id })),
  );
  const owners = Array.from(new Set(defs.map((d) => d.nodeId)));
  const methodDispatch = buildMethodDispatchIndex({
    owners,
    computeMro: (owner) => opts.mro?.[owner] ?? [],
    implementsOf: (owner) => {
      const out: string[] = [];
      for (const [iface, impls] of Object.entries(opts.implsByInterface ?? {})) {
        if (impls.includes(owner)) out.push(iface);
      }
      return out;
    },
  });
  return {
    scopes: buildScopeTree(scopes),
    defs: defIndex,
    qualifiedNames: qualifiedNameIndex,
    moduleScopes,
    methodDispatch,
    providers: opts.arity !== undefined ? { arityCompatibility: opts.arity } : {},
  };
}

const evidenceOfKind = (res: Resolution, kind: string) => res.evidence.find((e) => e.kind === kind);

// ─── §4.2 Step 1 — lexical scope-chain walk + shadowing ────────────────────

describe('Step 1: lexical scope-chain walk', () => {
  it('finds a class declared at the start scope with origin=local', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(userClass, 'local')] },
    });
    const ctx = makeCtx([mod], [userClass]);
    const registry = buildClassRegistry(ctx);
    const results = registry.lookup('User', 'scope:m');

    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(userClass);
    expect(evidenceOfKind(results[0]!, 'local')?.weight).toBe(EvidenceWeights.local);
  });

  it('walks parent scopes when the name is not bound at the start scope', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(userClass, 'import')] },
    });
    const fn = mkScope({
      id: 'scope:f',
      parent: 'scope:m',
      kind: 'Function',
      range: r(2, 0, 10, 0),
    });
    const ctx = makeCtx([mod, fn], [userClass]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:f');

    expect(results[0]!.def).toBe(userClass);
    const scopeChain = evidenceOfKind(results[0]!, 'scope-chain');
    expect(scopeChain?.weight).toBe(EvidenceWeights.scopeChainPerDepth * 1);
  });

  it('enforces hard shadow: outer bindings are ignored once a name is bound at an inner scope', () => {
    const outerClass = mkDef({ nodeId: 'def:outer', type: 'Class' });
    const innerVar = mkDef({ nodeId: 'def:inner', type: 'Variable' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(outerClass, 'local')] },
    });
    const fn = mkScope({
      id: 'scope:f',
      parent: 'scope:m',
      kind: 'Function',
      range: r(2, 0, 10, 0),
      bindings: { User: [mkBinding(innerVar, 'local')] },
    });
    const ctx = makeCtx([mod, fn], [outerClass, innerVar]);

    // Inner binding is a Variable (not a Class) → class registry returns empty.
    const results = buildClassRegistry(ctx).lookup('User', 'scope:f');
    expect(results).toEqual([]);
  });

  it('emits origin=import evidence when the binding is imported', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(userClass, 'import')] },
    });
    const ctx = makeCtx([mod], [userClass]);
    const res = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(evidenceOfKind(res[0]!, 'import')?.weight).toBe(EvidenceWeights.import);
  });
});

// ─── §4.2 Step 5 — arity filter ────────────────────────────────────────────

describe('Step 5: arity filter', () => {
  it('drops incompatible candidates when at least one compatible candidate exists', () => {
    const save2 = mkDef({
      nodeId: 'def:save-two',
      type: 'Method',
      qualifiedName: 'User.save',
      parameterCount: 2,
    });
    const save1 = mkDef({
      nodeId: 'def:save-one',
      type: 'Method',
      qualifiedName: 'User.save',
      parameterCount: 1,
    });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { save: [mkBinding(save2, 'local'), mkBinding(save1, 'local')] },
    });
    const ctx = makeCtx([mod], [save2, save1], {
      arity: (callsite, def) => {
        const count = def.parameterCount ?? 0;
        if (count === callsite.arity) return 'compatible';
        return 'incompatible';
      },
    });
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:m', {
      callsite: { arity: 1 },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.def.nodeId).toBe('def:save-one');
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchCompatible,
    );
  });

  it('keeps incompatible candidates when no compatible candidate exists (soft penalty)', () => {
    const save3 = mkDef({
      nodeId: 'def:save-three',
      type: 'Method',
      qualifiedName: 'User.save',
      parameterCount: 3,
    });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { save: [mkBinding(save3, 'local')] },
    });
    const ctx = makeCtx([mod], [save3], {
      arity: () => 'incompatible',
    });
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:m', {
      callsite: { arity: 1 },
    });
    expect(results).toHaveLength(1);
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchIncompatible,
    );
  });

  it('records arity=unknown when the provider is missing (neutral signal)', () => {
    const m = mkDef({ nodeId: 'def:m', type: 'Method', qualifiedName: 'C.m' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { m: [mkBinding(m, 'local')] },
    });
    const ctx = makeCtx([mod], [m]); // no arity provider
    const results = buildMethodRegistry(ctx).lookup('m', 'scope:m', {
      callsite: { arity: 7 },
    });
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchUnknown,
    );
  });
});

// ─── §4.2 Step 6 — global-qualified fallback ───────────────────────────────

describe('Step 6: global-qualified fallback', () => {
  it('falls back to the qualified-name index when no lexical candidate is found', () => {
    const cls = mkDef({ nodeId: 'def:app.User', qualifiedName: 'app.User', type: 'Class' });
    const mod = mkScope({ id: 'scope:m', parent: null }); // no lexical binding
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('app.User', 'scope:m');
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(cls);
    expect(evidenceOfKind(results[0]!, 'global-qualified')?.weight).toBe(
      EvidenceWeights.globalQualified,
    );
  });

  it('does NOT consult the global index when a lexical hit exists (shadowing)', () => {
    const localCls = mkDef({ nodeId: 'def:local', type: 'Class' });
    const globalCls = mkDef({
      nodeId: 'def:global',
      qualifiedName: 'other.User',
      type: 'Class',
    });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(localCls, 'local')] },
    });
    const ctx = makeCtx([mod], [localCls, globalCls]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(localCls);
  });

  it('does NOT apply the global fallback for non-dotted names', () => {
    const cls = mkDef({ nodeId: 'def:x', qualifiedName: 'User', type: 'Class' });
    const mod = mkScope({ id: 'scope:m', parent: null });
    const ctx = makeCtx([mod], [cls]);
    // 'User' has no dot → no qname fallback.
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(results).toEqual([]);
  });
});

// ─── §4.2 Step 7 — tie-breaks ──────────────────────────────────────────────

describe('Step 7: tie-break cascade', () => {
  it('confidence DESC is the primary key', () => {
    const nearClass = mkDef({ nodeId: 'def:near', type: 'Class' });
    const farClass = mkDef({ nodeId: 'def:far', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(farClass, 'local')] },
    });
    const fn = mkScope({
      id: 'scope:f',
      parent: 'scope:m',
      kind: 'Function',
      range: r(2, 0, 10, 0),
      bindings: { User: [mkBinding(nearClass, 'local')] },
    });
    const ctx = makeCtx([mod, fn], [nearClass, farClass]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:f');

    // Inner binding shadows; only the near class should appear.
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(nearClass);
  });

  it('breaks ties by DefId.localeCompare when all secondary keys are equal', () => {
    const a = mkDef({ nodeId: 'def:aaa', type: 'Class' });
    const b = mkDef({ nodeId: 'def:bbb', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(b, 'local'), mkBinding(a, 'local')] }, // reversed
    });
    const ctx = makeCtx([mod], [a, b]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    expect(results[0]!.def.nodeId).toBe('def:aaa');
    expect(results[1]!.def.nodeId).toBe('def:bbb');
  });
});

// ─── Corroborators: unresolved-import cap (per-signal) ─────────────────────

describe('unresolved-import cap (per-signal)', () => {
  it('halves the import evidence weight when via.linkStatus is unresolved', () => {
    const cls = mkDef({ nodeId: 'def:User', type: 'Class' });
    const unresolvedEdge: ImportEdge = {
      localName: 'User',
      targetFile: null,
      targetExportedName: 'User',
      kind: 'named',
      linkStatus: 'unresolved',
    };
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { User: [mkBinding(cls, 'import', unresolvedEdge)] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('User', 'scope:m');
    const importEv = evidenceOfKind(results[0]!, 'import');
    expect(importEv?.weight).toBe(
      EvidenceWeights.import * EvidenceWeights.unlinkedImportMultiplier,
    );
  });

  it('leaves arity & owner-match signals unaffected by the unresolved-import cap', () => {
    const m = mkDef({
      nodeId: 'def:m',
      type: 'Method',
      qualifiedName: 'User.save',
      parameterCount: 1,
    });
    const unresolved: ImportEdge = {
      localName: 'save',
      targetFile: null,
      targetExportedName: 'save',
      kind: 'named',
      linkStatus: 'unresolved',
    };
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { save: [mkBinding(m, 'import', unresolved)] },
    });
    const ctx = makeCtx([mod], [m], {
      arity: () => 'compatible',
    });
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:m', {
      callsite: { arity: 1 },
    });
    expect(evidenceOfKind(results[0]!, 'arity-match')?.weight).toBe(
      EvidenceWeights.arityMatchCompatible,
    );
  });
});

// ─── Corroborators: dynamic-unresolved degraded signal ─────────────────────

describe('dynamic-unresolved passthrough', () => {
  it('emits a degraded dynamic-import-unresolved signal for dynamic edges', () => {
    const cls = mkDef({ nodeId: 'def:X', type: 'Class' });
    const dynEdge: ImportEdge = {
      localName: 'X',
      targetFile: null,
      targetExportedName: '',
      kind: 'dynamic-unresolved',
    };
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { X: [mkBinding(cls, 'import', dynEdge)] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(evidenceOfKind(results[0]!, 'dynamic-import-unresolved')?.weight).toBe(
      EvidenceWeights.dynamicImportUnresolved,
    );
  });
});

// ─── lookupQualified helper (§4.5) ─────────────────────────────────────────

describe('lookupQualified (§4.5)', () => {
  it('filters by acceptedKinds', () => {
    const cls = mkDef({ nodeId: 'def:c', qualifiedName: 'app.User', type: 'Class' });
    const fn = mkDef({ nodeId: 'def:f', qualifiedName: 'app.User', type: 'Function' });
    const ctx = makeCtx([mkScope({ id: 'scope:m', parent: null })], [cls, fn]);
    const results = lookupQualified('app.User', { acceptedKinds: ['Class'] }, ctx);
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(cls);
  });

  it('returns empty for unknown qualified names', () => {
    const ctx = makeCtx([mkScope({ id: 'scope:m', parent: null })], []);
    expect(lookupQualified('app.Ghost', { acceptedKinds: ['Class'] }, ctx)).toEqual([]);
  });

  it('orders multiple partial-class defs deterministically by defId', () => {
    const a = mkDef({ nodeId: 'def:aaa', qualifiedName: 'app.User', type: 'Class' });
    const b = mkDef({ nodeId: 'def:bbb', qualifiedName: 'app.User', type: 'Class' });
    const ctx = makeCtx([mkScope({ id: 'scope:m', parent: null })], [b, a]);
    const results = lookupQualified('app.User', { acceptedKinds: ['Class'] }, ctx);
    expect(results.map((r) => r.def.nodeId)).toEqual(['def:aaa', 'def:bbb']);
  });
});

// ─── lookupCore with owner-scoped contributor (Step 3) ─────────────────────

describe('Step 3: owner-scoped contributor', () => {
  it('merges contributor hits as origin=local at the receiver scope', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const saveMethod = mkDef({
      nodeId: 'def:User.save',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
    });
    const mod = mkScope({ id: 'scope:m', parent: null });
    const ctx = makeCtx([mod], [userClass, saveMethod]);
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:m', {
      ownerScopedContributor: {
        ownerDefId: 'def:User',
        byName: (n) => (n === 'save' ? [saveMethod] : []),
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(saveMethod);
    expect(evidenceOfKind(results[0]!, 'local')?.weight).toBe(EvidenceWeights.local);
    expect(evidenceOfKind(results[0]!, 'owner-match')?.weight).toBe(EvidenceWeights.ownerMatch);
  });
});

// ─── Step 2: type-binding / MRO walk ───────────────────────────────────────

describe('Step 2: type-binding + MRO walk', () => {
  it('emits type-binding evidence with MRO-depth-decayed weight (explicit receiver)', () => {
    const userClass = mkDef({ nodeId: 'def:User', type: 'Class', qualifiedName: 'User' });
    const saveMethod = mkDef({
      nodeId: 'def:User.save',
      type: 'Method',
      qualifiedName: 'User.save',
      ownerId: 'def:User',
    });
    const callScope = mkScope({
      id: 'scope:call',
      parent: null,
      typeBindings: { user: typeRef('User', 'scope:call') },
    });
    const ctx = makeCtx([callScope], [userClass, saveMethod]);
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:call', {
      explicitReceiver: { name: 'user' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(saveMethod);
    const typeBinding = evidenceOfKind(results[0]!, 'type-binding');
    expect(typeBinding?.weight).toBe(EvidenceWeights.typeBindingByMroDepth[0]);
  });

  it('walks up the MRO when the method is declared on an ancestor', () => {
    const baseClass = mkDef({ nodeId: 'def:Base', type: 'Class', qualifiedName: 'Base' });
    const derivedClass = mkDef({ nodeId: 'def:Derived', type: 'Class', qualifiedName: 'Derived' });
    const saveOnBase = mkDef({
      nodeId: 'def:Base.save',
      type: 'Method',
      qualifiedName: 'Base.save',
      ownerId: 'def:Base',
    });
    const callScope = mkScope({
      id: 'scope:call',
      parent: null,
      typeBindings: { d: typeRef('Derived', 'scope:call') },
    });
    const ctx = makeCtx([callScope], [baseClass, derivedClass, saveOnBase], {
      mro: { 'def:Derived': ['def:Base'] },
    });
    const results = buildMethodRegistry(ctx).lookup('save', 'scope:call', {
      explicitReceiver: { name: 'd' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.def).toBe(saveOnBase);
    // MRO depth for Base when receiver is Derived = 1.
    expect(evidenceOfKind(results[0]!, 'type-binding')?.weight).toBe(
      EvidenceWeights.typeBindingByMroDepth[1],
    );
  });
});

// ─── §4.7 invariants ──────────────────────────────────────────────────────

describe('§4.7 invariants', () => {
  it('Resolution has confidence per-candidate (not per-tier)', () => {
    const cls = mkDef({ nodeId: 'def:c', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { X: [mkBinding(cls, 'local')] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(typeof results[0]!.confidence).toBe('number');
    expect(results[0]!.confidence).toBeGreaterThan(0);
    expect(results[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it('Resolution confidence is capped at 1.0', () => {
    const cls = mkDef({ nodeId: 'def:c', type: 'Class' });
    const dummyVia: ImportEdge = {
      localName: 'X',
      targetFile: 't.ts',
      targetExportedName: 'X',
      kind: 'named',
    };
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      // Same def bound via multiple origins — evidence may stack.
      bindings: { X: [mkBinding(cls, 'local', dummyVia)] },
    });
    const ctx = makeCtx([mod], [cls], { arity: () => 'compatible' });
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(results[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it('kind-match evidence is always present (weight 0) for debuggability', () => {
    const cls = mkDef({ nodeId: 'def:c', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { X: [mkBinding(cls, 'local')] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(evidenceOfKind(results[0]!, 'kind-match')).toBeDefined();
    expect(evidenceOfKind(results[0]!, 'kind-match')!.weight).toBe(0);
  });

  it('caller can read [0] for one-shot answers', () => {
    const cls = mkDef({ nodeId: 'def:c', type: 'Class' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { X: [mkBinding(cls, 'local')] },
    });
    const ctx = makeCtx([mod], [cls]);
    const results = buildClassRegistry(ctx).lookup('X', 'scope:m');
    expect(results[0]!.def).toBe(cls);
  });
});

// ─── Misses ───────────────────────────────────────────────────────────────

describe('misses', () => {
  it('returns empty for an unknown name with no lexical or global hit', () => {
    const mod = mkScope({ id: 'scope:m', parent: null });
    const ctx = makeCtx([mod], []);
    expect(buildClassRegistry(ctx).lookup('Ghost', 'scope:m')).toEqual([]);
  });

  it('filters out candidates whose kind is not in acceptedKinds', () => {
    const method = mkDef({ nodeId: 'def:m', type: 'Method' });
    const mod = mkScope({
      id: 'scope:m',
      parent: null,
      bindings: { save: [mkBinding(method, 'local')] },
    });
    const ctx = makeCtx([mod], [method]);
    // ClassRegistry excludes Method kind → empty.
    expect(buildClassRegistry(ctx).lookup('save', 'scope:m')).toEqual([]);
    // FieldRegistry also excludes Method → empty.
    expect(buildFieldRegistry(ctx).lookup('save', 'scope:m')).toEqual([]);
  });
});

// ─── lookupCore direct invocation ─────────────────────────────────────────

describe('lookupCore direct invocation', () => {
  it('accepts an empty params surface and returns empty for an unknown name', () => {
    const mod = mkScope({ id: 'scope:m', parent: null });
    const ctx = makeCtx([mod], []);
    const results = lookupCore(
      'Ghost',
      'scope:m',
      {
        acceptedKinds: ['Class'],
        useReceiverTypeBinding: false,
        ownerScopedContributor: null,
      },
      ctx,
    );
    expect(results).toEqual([]);
  });
});
