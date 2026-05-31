/**
 * Unit tests for `pickUniqueGlobalClass` + `buildGlobalClassIndex` — the
 * constructor-form global class fallback in `free-call-fallback.ts`.
 *
 * U5 (Swift remediation, 2026-05-31) replaced a per-call-site
 * `scopes.defs.byId.values()` rescan with a once-built `simpleName ->
 * class-like defs` index, making each constructor-form fallback site O(1)
 * instead of O(|defs|). The refactor is behavior-PRESERVING for all 8
 * `allowGlobalFreeCallFallback` languages (c, cpp, go, javascript, php, ruby,
 * rust, swift) — the only observable change is performance.
 *
 * These tests exercise the helpers via synthetic `SymbolDefinition` stubs — no
 * fixtures, no pipeline — mirroring the `pick-implicit-this-overload.test.ts`
 * precedent. They assert:
 *   - the resolution contract (unique / same-qualifiedName-keep-first /
 *     distinct-qualifiedName-ambiguous);
 *   - the `Class | Struct | Interface` kind filter, including KEEP-`Interface`
 *     (KTD5 — a future drop of `Interface` is a deliberate test-breaking
 *     change, not an accident);
 *   - equivalence with a reference linear scan, which guards the O(n)->O(1)
 *     ordering invariant the refactor relies on.
 */

import { describe, it, expect } from 'vitest';
import type { SymbolDefinition } from 'gitnexus-shared';
import {
  buildGlobalClassIndex,
  pickUniqueGlobalClass,
} from '../../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const mkDef = (overrides: Partial<SymbolDefinition> & { nodeId: string }): SymbolDefinition => ({
  filePath: 'x.swift',
  type: 'Class',
  qualifiedName: overrides.nodeId,
  ...overrides,
});

/** Wrap a flat def list as the `scopes.defs.byId` map `buildGlobalClassIndex`
 *  iterates. Insertion order is preserved by `Map`, so this reproduces the
 *  `defs.byId.values()` iteration order the old per-site scan walked. */
const mkScopes = (defs: readonly SymbolDefinition[]): ScopeResolutionIndexes =>
  ({
    defs: {
      byId: new Map(defs.map((d) => [d.nodeId, d])),
    },
  }) as unknown as ScopeResolutionIndexes;

/** Reference O(|defs|) linear scan — the pre-U5 `pickUniqueGlobalClass` body,
 *  kept verbatim so the equivalence test can prove the index path matches it
 *  for every scenario. */
const referenceLinearScan = (
  name: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined => {
  let found: SymbolDefinition | undefined;
  for (const def of scopes.defs.byId.values()) {
    if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
    const qualified = def.qualifiedName;
    if (qualified === undefined || qualified.length === 0) continue;
    const dot = qualified.lastIndexOf('.');
    const simple = dot === -1 ? qualified : qualified.slice(dot + 1);
    if (simple !== name) continue;
    if (found !== undefined && found.qualifiedName !== def.qualifiedName) return undefined;
    if (found === undefined) found = def;
  }
  return found;
};

const resolve = (name: string, defs: readonly SymbolDefinition[]): SymbolDefinition | undefined =>
  pickUniqueGlobalClass(name, buildGlobalClassIndex(mkScopes(defs)));

describe('pickUniqueGlobalClass — once-built global class index (U5)', () => {
  it('returns the def for a unique simple-name match', () => {
    const user = mkDef({ nodeId: 'def:User', qualifiedName: 'app.User' });
    const result = resolve('User', [user]);
    expect(result?.nodeId).toBe('def:User');
  });

  it('keeps the first fragment when matches share one qualifiedName (extension / partial)', () => {
    // Same logical type re-keyed across extension / partial-class fragments —
    // they resolve to the same graph node, so this is NOT ambiguous.
    const main = mkDef({ nodeId: 'def:User#1', qualifiedName: 'app.User' });
    const ext = mkDef({ nodeId: 'def:User#2', qualifiedName: 'app.User' });
    const result = resolve('User', [main, ext]);
    expect(result?.nodeId).toBe('def:User#1');
  });

  it('returns undefined for a distinct-qualifiedName collision (ambiguous)', () => {
    // Two genuinely distinct types sharing a simple name → unresolved rather
    // than guessing.
    const a = mkDef({ nodeId: 'def:a.User', qualifiedName: 'a.User' });
    const b = mkDef({ nodeId: 'def:b.User', qualifiedName: 'b.User' });
    const result = resolve('User', [a, b]);
    expect(result).toBeUndefined();
  });

  it('does not index non-class-like kinds (Function/Method/Constructor/Enum/Record)', () => {
    const defs: SymbolDefinition[] = [
      mkDef({ nodeId: 'def:fn', type: 'Function', qualifiedName: 'app.Foo' }),
      mkDef({ nodeId: 'def:m', type: 'Method', qualifiedName: 'app.Foo' }),
      mkDef({ nodeId: 'def:ctor', type: 'Constructor', qualifiedName: 'app.Foo' }),
      mkDef({ nodeId: 'def:enum', type: 'Enum', qualifiedName: 'app.Foo' }),
      mkDef({ nodeId: 'def:rec', type: 'Record', qualifiedName: 'app.Foo' }),
    ];
    const index = buildGlobalClassIndex(mkScopes(defs));
    expect(index.has('Foo')).toBe(false);
    expect(pickUniqueGlobalClass('Foo', index)).toBeUndefined();
  });

  it('resolves a Struct match', () => {
    const point = mkDef({ nodeId: 'def:Point', type: 'Struct', qualifiedName: 'geo.Point' });
    expect(resolve('Point', [point])?.nodeId).toBe('def:Point');
  });

  it('resolves an Interface match (locks in KEEP-Interface — KTD5)', () => {
    // KTD5: Interface stays in the filter for the behavior-preserving 8-lang
    // refactor. A future protocol-exclusion change must break THIS test
    // deliberately rather than silently.
    const proto = mkDef({
      nodeId: 'def:Drawable',
      type: 'Interface',
      qualifiedName: 'ui.Drawable',
    });
    expect(resolve('Drawable', [proto])?.nodeId).toBe('def:Drawable');
  });

  it('skips defs with empty or undefined qualifiedName', () => {
    const defs: SymbolDefinition[] = [
      mkDef({ nodeId: 'def:empty', qualifiedName: '' }),
      mkDef({ nodeId: 'def:undef', qualifiedName: undefined }),
    ];
    const index = buildGlobalClassIndex(mkScopes(defs));
    expect(index.size).toBe(0);
    expect(pickUniqueGlobalClass('', index)).toBeUndefined();
  });

  it('returns undefined for a missing-name lookup', () => {
    const user = mkDef({ nodeId: 'def:User', qualifiedName: 'app.User' });
    expect(resolve('Nonexistent', [user])).toBeUndefined();
  });

  it('keys by the last dotted segment, not the full qualifiedName', () => {
    // Deeply-qualified name — lookup is by simple name only.
    const deep = mkDef({ nodeId: 'def:deep', qualifiedName: 'a.b.c.Widget' });
    expect(resolve('Widget', [deep])?.nodeId).toBe('def:deep');
    expect(resolve('a.b.c.Widget', [deep])).toBeUndefined();
  });

  it('matches an undotted qualifiedName by its whole value', () => {
    const bare = mkDef({ nodeId: 'def:Bare', qualifiedName: 'Bare' });
    expect(resolve('Bare', [bare])?.nodeId).toBe('def:Bare');
  });

  it('equivalence: index result == reference linear scan for every scenario', () => {
    // One combined corpus mixing class-like kinds, excluded kinds, same- and
    // distinct-qualifiedName collisions, and skipped defs — exercised across a
    // battery of names. The index path must agree with the linear scan on
    // BOTH the resolved nodeId and the ambiguous/miss (undefined) outcome,
    // which is what guards the O(n)->O(1) ordering invariant.
    const corpus: SymbolDefinition[] = [
      mkDef({ nodeId: 'def:User#1', qualifiedName: 'app.User' }),
      mkDef({ nodeId: 'def:fn', type: 'Function', qualifiedName: 'app.User' }),
      mkDef({ nodeId: 'def:User#2', qualifiedName: 'app.User' }), // same-qn fragment
      mkDef({ nodeId: 'def:a.Item', qualifiedName: 'a.Item' }),
      mkDef({ nodeId: 'def:b.Item', qualifiedName: 'b.Item' }), // distinct-qn collision
      mkDef({ nodeId: 'def:Point', type: 'Struct', qualifiedName: 'geo.Point' }),
      mkDef({ nodeId: 'def:Drawable', type: 'Interface', qualifiedName: 'ui.Drawable' }),
      mkDef({ nodeId: 'def:Enumish', type: 'Enum', qualifiedName: 'app.Enumish' }),
      mkDef({ nodeId: 'def:empty', qualifiedName: '' }),
      mkDef({ nodeId: 'def:undef', qualifiedName: undefined }),
    ];
    const scopes = mkScopes(corpus);
    const index = buildGlobalClassIndex(scopes);
    const names = [
      'User', // same-qn keep-first
      'Item', // distinct-qn ambiguous
      'Point', // struct
      'Drawable', // interface
      'Enumish', // excluded kind → miss
      'Missing', // miss
      '', // skipped-qn → miss
    ];
    for (const name of names) {
      const fromIndex = pickUniqueGlobalClass(name, index);
      const fromScan = referenceLinearScan(name, scopes);
      expect(fromIndex?.nodeId).toBe(fromScan?.nodeId);
    }
  });
});
