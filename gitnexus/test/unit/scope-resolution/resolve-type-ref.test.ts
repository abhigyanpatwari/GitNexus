/**
 * Unit tests for `resolveTypeRef` (RFC #909 Ring 2 SHARED #916).
 *
 * Covers: local type, parameter/return annotation via scope walk, aliased
 * import, re-exported type, shadowing by local variable, wildcard-origin
 * ignored, qualified-name fallback (unique + ambiguous), broken scope chain,
 * cycle guard.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveTypeRef,
  buildDefIndex,
  buildQualifiedNameIndex,
  type ResolveTypeRefContext,
  type ScopeLookup,
  type BindingRef,
  type ImportEdge,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
  type TypeRef,
} from 'gitnexus-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  nodeId: overrides.nodeId,
  filePath: overrides.filePath ?? 'src/test.ts',
  type: overrides.type ?? 'Class',
  ...overrides,
});

const mkBinding = (
  def: SymbolDefinition,
  origin: BindingRef['origin'],
  via?: ImportEdge,
): BindingRef => ({ def, origin, ...(via !== undefined ? { via } : {}) });

const mkScope = (
  id: ScopeId,
  parent: ScopeId | null,
  bindings: Record<string, BindingRef[]> = {},
  filePath = 'src/test.ts',
): Scope => ({
  id,
  parent,
  kind: 'Module',
  range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
  filePath,
  bindings: new Map(Object.entries(bindings)),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(),
});

const mkLookup = (scopes: Scope[]): ScopeLookup => {
  const byId = new Map(scopes.map((s) => [s.id, s]));
  return { getScope: (id) => byId.get(id) };
};

const mkCtx = (scopes: Scope[], defs: SymbolDefinition[]): ResolveTypeRefContext => ({
  scopes: mkLookup(scopes),
  defIndex: buildDefIndex(defs),
  qualifiedNameIndex: buildQualifiedNameIndex(defs),
});

const typeRef = (
  rawName: string,
  declaredAtScope: ScopeId,
  source: TypeRef['source'] = 'parameter-annotation',
): TypeRef => ({ rawName, declaredAtScope, source });

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('resolveTypeRef', () => {
  describe('scope-chain walk', () => {
    it('resolves a local type defined in the same scope', () => {
      const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'local')],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      const result = resolveTypeRef(typeRef('User', 'scope:module'), ctx);
      expect(result).toBe(userClass);
    });

    it('walks parent scopes when the name is not bound locally (return-annotation case)', () => {
      const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'local')],
      });
      const functionScope = mkScope('scope:fn', 'scope:module');
      const ctx = mkCtx([moduleScope, functionScope], [userClass]);
      const result = resolveTypeRef(typeRef('User', 'scope:fn', 'return-annotation'), ctx);
      expect(result).toBe(userClass);
    });

    it('returns the closest binding when the name is bound at multiple levels', () => {
      const outerUser = mkDef({ nodeId: 'def:outer', type: 'Class' });
      const innerUser = mkDef({ nodeId: 'def:inner', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(outerUser, 'local')],
      });
      const classScope = mkScope('scope:class', 'scope:module', {
        User: [mkBinding(innerUser, 'local')],
      });
      const ctx = mkCtx([moduleScope, classScope], [outerUser, innerUser]);
      const result = resolveTypeRef(typeRef('User', 'scope:class'), ctx);
      expect(result).toBe(innerUser); // inner shadows outer
    });
  });

  describe('import origins', () => {
    it('resolves a plain named import', () => {
      const userClass = mkDef({ nodeId: 'def:User', filePath: 'models.ts', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'import')],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      expect(resolveTypeRef(typeRef('User', 'scope:module'), ctx)).toBe(userClass);
    });

    it('resolves an aliased import under the alias (e.g., `import { User as Account }`)', () => {
      // In `def save_user(user: Account)` where `Account` is an aliased import
      // of `User`, we resolve `Account` to the underlying `User` class def.
      const userClass = mkDef({ nodeId: 'def:User', filePath: 'models.ts', type: 'Class' });
      const importEdge: ImportEdge = {
        localName: 'Account',
        targetFile: 'models.ts',
        targetExportedName: 'User',
        targetDefId: 'def:User',
        kind: 'alias',
      };
      const moduleScope = mkScope('scope:module', null, {
        Account: [mkBinding(userClass, 'import', importEdge)],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      expect(resolveTypeRef(typeRef('Account', 'scope:module'), ctx)).toBe(userClass);
    });

    it('returns null for a namespace-origin binding whose def is not a type kind', () => {
      const numpyMod = mkDef({ nodeId: 'def:numpy-mod', type: 'Namespace' });
      // A namespace binding must resolve to a type-kind def to satisfy strict
      // mode. Here the binding is the namespace module itself — `Namespace`
      // is intentionally NOT in `TYPE_KINDS` (see resolve-type-ref.ts), so
      // the binding is treated as a shadowing non-type and we fail fast.
      const moduleScope = mkScope('scope:module', null, {
        np: [mkBinding(numpyMod, 'namespace')],
      });
      const ctx = mkCtx([moduleScope], [numpyMod]);
      expect(resolveTypeRef(typeRef('np', 'scope:module'), ctx)).toBeNull();
    });

    it('resolves a re-exported type (`export { X } from `./y`)', () => {
      const userClass = mkDef({ nodeId: 'def:User', filePath: 'y.ts', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'reexport')],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      expect(resolveTypeRef(typeRef('User', 'scope:module'), ctx)).toBe(userClass);
    });

    it('ignores wildcard origin — not in the strict set', () => {
      const userClass = mkDef({ nodeId: 'def:User', filePath: 'models.ts', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(userClass, 'wildcard')],
      });
      const ctx = mkCtx([moduleScope], [userClass]);
      // Binding exists but wildcard is not strict → return null (shadow).
      expect(resolveTypeRef(typeRef('User', 'scope:module'), ctx)).toBeNull();
    });

    it('prefers a strict-origin type binding over a non-strict binding at the same scope', () => {
      const wildcardClass = mkDef({ nodeId: 'def:wild', type: 'Class' });
      const importClass = mkDef({ nodeId: 'def:import', type: 'Class' });
      const moduleScope = mkScope('scope:module', null, {
        // The strict-origin binding wins regardless of input order.
        User: [mkBinding(wildcardClass, 'wildcard'), mkBinding(importClass, 'import')],
      });
      const ctx = mkCtx([moduleScope], [wildcardClass, importClass]);
      expect(resolveTypeRef(typeRef('User', 'scope:module'), ctx)).toBe(importClass);
    });
  });

  describe('shadowing (non-type binding fails fast)', () => {
    it('returns null when a local variable shadows an outer imported type', () => {
      // Outer module has `import { User }`; inner function declares `User = 5`.
      // Per RFC §4.6, the local non-type shadows; strict resolver returns null.
      const importedUser = mkDef({ nodeId: 'def:imp', type: 'Class' });
      const localUser = mkDef({ nodeId: 'def:local', type: 'Variable' });
      const moduleScope = mkScope('scope:module', null, {
        User: [mkBinding(importedUser, 'import')],
      });
      const functionScope = mkScope('scope:fn', 'scope:module', {
        User: [mkBinding(localUser, 'local')],
      });
      const ctx = mkCtx([moduleScope, functionScope], [importedUser, localUser]);
      expect(resolveTypeRef(typeRef('User', 'scope:fn'), ctx)).toBeNull();
    });

    it('returns null when the only binding at the declaration scope is a Method', () => {
      const method = mkDef({ nodeId: 'def:m', type: 'Method' });
      const scope = mkScope('scope:class', null, {
        save: [mkBinding(method, 'local')],
      });
      const ctx = mkCtx([scope], [method]);
      expect(resolveTypeRef(typeRef('save', 'scope:class'), ctx)).toBeNull();
    });

    it('does NOT fall through to the qualified-name index when shadowed', () => {
      // Even if `app.User` is a unique type in the qualified-name index, a
      // shadowing non-type binding at the declaration scope should short-circuit.
      const shadowVar = mkDef({ nodeId: 'def:v', type: 'Variable' });
      const globalType = mkDef({
        nodeId: 'def:g',
        qualifiedName: 'app.User',
        type: 'Class',
      });
      const scope = mkScope('scope:s', null, {
        'app.User': [mkBinding(shadowVar, 'local')],
      });
      const ctx = mkCtx([scope], [shadowVar, globalType]);
      expect(resolveTypeRef(typeRef('app.User', 'scope:s'), ctx)).toBeNull();
    });
  });

  describe('dotted qualified-name fallback', () => {
    it('resolves a unique qualified name when no scope binding matches', () => {
      const userClass = mkDef({
        nodeId: 'def:appUser',
        qualifiedName: 'app.models.User',
        type: 'Class',
      });
      const scope = mkScope('scope:s', null); // no bindings for `app.models.User`
      const ctx = mkCtx([scope], [userClass]);
      expect(resolveTypeRef(typeRef('app.models.User', 'scope:s'), ctx)).toBe(userClass);
    });

    it('does NOT apply the qualified-name fallback for non-dotted names', () => {
      const simple = mkDef({ nodeId: 'def:s', qualifiedName: 'User', type: 'Class' });
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], [simple]);
      // Even though `User` is in the qname index as `User`, the fallback only
      // fires for dotted names (scope walk is the answer for simple names).
      expect(resolveTypeRef(typeRef('User', 'scope:s'), ctx)).toBeNull();
    });

    it('returns null when the qualified name is ambiguous across type defs', () => {
      const a = mkDef({ nodeId: 'def:a', qualifiedName: 'app.User', type: 'Class' });
      const b = mkDef({ nodeId: 'def:b', qualifiedName: 'app.User', type: 'Class' });
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], [a, b]);
      expect(resolveTypeRef(typeRef('app.User', 'scope:s'), ctx)).toBeNull();
    });

    it('ignores non-type-kind hits and accepts the single type hit', () => {
      const cls = mkDef({ nodeId: 'def:c', qualifiedName: 'app.User', type: 'Class' });
      const fn = mkDef({ nodeId: 'def:f', qualifiedName: 'app.User', type: 'Function' });
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], [cls, fn]);
      expect(resolveTypeRef(typeRef('app.User', 'scope:s'), ctx)).toBe(cls);
    });

    it('returns null when no qualified-name hit is a type kind', () => {
      const fn = mkDef({ nodeId: 'def:f', qualifiedName: 'app.User', type: 'Function' });
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], [fn]);
      expect(resolveTypeRef(typeRef('app.User', 'scope:s'), ctx)).toBeNull();
    });
  });

  describe('robustness', () => {
    it('returns null for a missing type (no scope binding, no qname hit)', () => {
      const scope = mkScope('scope:s', null);
      const ctx = mkCtx([scope], []);
      expect(resolveTypeRef(typeRef('User', 'scope:s'), ctx)).toBeNull();
    });

    it('returns null when the declaredAtScope id is not known to the lookup', () => {
      const ctx = mkCtx([], []);
      expect(resolveTypeRef(typeRef('User', 'scope:missing'), ctx)).toBeNull();
    });

    it('returns null when a parent pointer references an unknown scope (broken chain)', () => {
      const functionScope = mkScope('scope:fn', 'scope:ghost');
      const ctx = mkCtx([functionScope], []);
      expect(resolveTypeRef(typeRef('User', 'scope:fn'), ctx)).toBeNull();
    });

    it('terminates cleanly on a cyclic parent chain (defensive guard)', () => {
      // A well-formed scope tree is acyclic; construction bugs shouldn't hang.
      const a: Scope = mkScope('scope:a', 'scope:b');
      const b: Scope = mkScope('scope:b', 'scope:a');
      const ctx = mkCtx([a, b], []);
      expect(resolveTypeRef(typeRef('User', 'scope:a'), ctx)).toBeNull();
    });

    it('accepts all annotation source flavors uniformly', () => {
      const userClass = mkDef({ nodeId: 'def:User', type: 'Class' });
      const scope = mkScope('scope:s', null, {
        User: [mkBinding(userClass, 'local')],
      });
      const ctx = mkCtx([scope], [userClass]);
      for (const source of [
        'annotation',
        'parameter-annotation',
        'return-annotation',
        'self',
        'assignment-inferred',
        'constructor-inferred',
        'receiver-propagated',
      ] as const) {
        expect(resolveTypeRef(typeRef('User', 'scope:s', source), ctx)).toBe(userClass);
      }
    });
  });
});
