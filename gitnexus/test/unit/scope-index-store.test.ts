/**
 * Out-of-core scope index — `DiskBackedScopeTree` must be a behavior-identical, value-faithful
 * stand-in for the in-heap `buildScopeTree` for the methods scope-resolution
 * calls (`getScope`, `getChildren`, `getParent`, `getAncestors`, `has`, `size`).
 * Every scope-resolution consumer reads a `Scope` BY VALUE, so a round-trip
 * through disk that preserves field values (and the def-identity collapse) is
 * byte-identical to resolution. This locks that contract.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScopeTree } from 'gitnexus-shared';
import type { Scope, ScopeId, SymbolDefinition, BindingRef } from 'gitnexus-shared';
import {
  persistScopeShards,
  DiskBackedScopeTree,
  TransitionalScopeTree,
  clearScopeIndexStore,
  getScopeIndexStoreDir,
} from '../../src/storage/scope-index-store.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'scope-index-store-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const def = (nodeId: string, filePath: string): SymbolDefinition => ({
  nodeId,
  filePath,
  type: 'Function',
  qualifiedName: nodeId,
  parameterCount: 0,
});

/** A module scope + one child function scope per file, with a def shared across
 *  the module's ownedDefs AND a binding (exercises the def-identity collapse). */
const fileScopes = (filePath: string): Scope[] => {
  const moduleId = `scope:${filePath}#0:0-100:0:Module` as ScopeId;
  const fnId = `scope:${filePath}#10:0-20:0:Function` as ScopeId;
  const d = def(`def:${filePath}:fn`, filePath);
  const binding: BindingRef = { def: d, origin: 'local' };
  const moduleScope: Scope = {
    id: moduleId,
    parent: null,
    kind: 'Module' as Scope['kind'],
    range: { startLine: 0, startCol: 0, endLine: 100, endCol: 0 } as Scope['range'],
    filePath,
    bindings: new Map([['fn', [binding]]]),
    ownedDefs: [d], // same object as binding.def
    imports: [],
    typeBindings: new Map(),
  };
  const fnScope: Scope = {
    id: fnId,
    parent: moduleId,
    kind: 'Function' as Scope['kind'],
    range: { startLine: 10, startCol: 0, endLine: 20, endCol: 0 } as Scope['range'],
    filePath,
    bindings: new Map(),
    ownedDefs: [],
    imports: [],
    typeBindings: new Map(),
  };
  return [moduleScope, fnScope];
};

const ALL: Scope[] = [...fileScopes('a.ts'), ...fileScopes('b.ts'), ...fileScopes('c.ts')];

describe('DiskBackedScopeTree — value-faithful stand-in for buildScopeTree', () => {
  const resident = buildScopeTree(ALL);
  const skeleton = persistScopeShards(tmp, ALL);
  // maxResidentShards=1 forces eviction + re-load across the 3 files, so the
  // LRU path (cache miss after eviction) is exercised, not just first-load.
  const disk = new DiskBackedScopeTree(tmp, skeleton, 1);

  it('size matches', () => {
    expect(disk.size).toBe(resident.size);
  });

  it('getScope returns value-identical scopes for every id (incl. after LRU eviction)', () => {
    for (const s of ALL) {
      expect(disk.getScope(s.id)).toEqual(resident.getScope(s.id));
    }
    // Re-query the first file's scopes AFTER the others evicted its shard —
    // a fresh load must still be value-identical.
    expect(disk.getScope(ALL[0].id)).toEqual(resident.getScope(ALL[0].id));
  });

  it('collapses the shared def to ONE object on load (localDefs === binding.def)', () => {
    const m = disk.getScope('scope:a.ts#0:0-100:0:Module' as ScopeId)!;
    const fromOwned = m.ownedDefs[0];
    const fromBinding = m.bindings.get('fn')![0].def;
    expect(fromOwned).toBe(fromBinding); // same object reference
  });

  it('getChildren matches resident (input order)', () => {
    for (const s of ALL) {
      expect(disk.getChildren(s.id)).toEqual(resident.getChildren(s.id));
    }
  });

  it('getParent + getAncestors + has match resident', () => {
    for (const s of ALL) {
      expect(disk.getParent(s.id)).toEqual(resident.getParent(s.id));
      expect(disk.getAncestors(s.id)).toEqual(resident.getAncestors(s.id));
      expect(disk.has(s.id)).toBe(resident.has(s.id));
    }
    expect(disk.has('scope:nope#0:0-1:0:Module' as ScopeId)).toBe(false);
    expect(disk.getScope('scope:nope#0:0-1:0:Module' as ScopeId)).toBeUndefined();
  });

  it('byId throws (debug-only path, incompatible with disk mode)', () => {
    expect(() => disk.byId).toThrow(/byId is unsupported/);
  });
});

describe('TransitionalScopeTree — resident → sealed(disk) transition', () => {
  const reference = buildScopeTree(ALL);

  it('serves value-identically to buildScopeTree BEFORE seal (resident phase)', () => {
    const t = new TransitionalScopeTree(ALL);
    expect(t.sealed).toBe(false);
    expect(t.size).toBe(reference.size);
    for (const s of ALL) {
      expect(t.getScope(s.id)).toEqual(reference.getScope(s.id));
      expect(t.getChildren(s.id)).toEqual(reference.getChildren(s.id));
    }
    // byId works in the resident phase (delegates to buildScopeTree).
    expect(t.byId.size).toBe(reference.byId.size);
  });

  it('serves value-identically AFTER seal (disk phase) + drops resident byId', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'transitional-seal-'));
    try {
      const t = new TransitionalScopeTree(ALL);
      t.seal(dir, 1); // tiny LRU → forces shard eviction + reload
      expect(t.sealed).toBe(true);
      expect(t.size).toBe(reference.size);
      for (const s of ALL) {
        expect(t.getScope(s.id)).toEqual(reference.getScope(s.id));
        expect(t.getChildren(s.id)).toEqual(reference.getChildren(s.id));
      }
      // Disk mode: byId is unsupported (the debug emit path is incompatible).
      expect(() => t.byId).toThrow(/byId is unsupported/);
      // Seal is idempotent.
      t.seal(dir);
      expect(t.getScope(ALL[0].id)).toEqual(reference.getScope(ALL[0].id));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scope-index-store cleanup — no stale shards survive a seal', () => {
  const jsonShards = (storagePath: string): string[] =>
    readdirSync(getScopeIndexStoreDir(storagePath))
      .filter((f) => f.endsWith('.json'))
      .sort();

  it('removes a stale shard left by a prior run', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'scope-index-stale-'));
    try {
      const store = getScopeIndexStoreDir(dir);
      mkdirSync(store, { recursive: true });
      // A leftover shard from a previous run that this seal will NOT rewrite.
      writeFileSync(path.join(store, 's99.json'), '[]', 'utf-8');

      persistScopeShards(dir, fileScopes('a.ts')); // writes s0.json, clears first

      expect(existsSync(path.join(store, 's99.json'))).toBe(false); // stale gone
      expect(existsSync(path.join(store, 's0.json'))).toBe(true); // fresh present
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a re-seal with FEWER files leaves no tail shards (s1/s2 from the prior seal)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'scope-index-fewer-'));
    try {
      // First seal: 3 files → s0, s1, s2.
      persistScopeShards(dir, [
        ...fileScopes('a.ts'),
        ...fileScopes('b.ts'),
        ...fileScopes('c.ts'),
      ]);
      expect(jsonShards(dir)).toEqual(['s0.json', 's1.json', 's2.json']);

      // Re-seal with 1 file → only s0 should remain; s1/s2 must be cleared.
      persistScopeShards(dir, fileScopes('a.ts'));
      expect(jsonShards(dir)).toEqual(['s0.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clearScopeIndexStore removes the store dir and is idempotent', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'scope-index-clear-'));
    try {
      persistScopeShards(dir, fileScopes('a.ts'));
      expect(existsSync(getScopeIndexStoreDir(dir))).toBe(true);
      clearScopeIndexStore(dir);
      expect(existsSync(getScopeIndexStoreDir(dir))).toBe(false);
      clearScopeIndexStore(dir); // no throw when already absent
      expect(existsSync(getScopeIndexStoreDir(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
