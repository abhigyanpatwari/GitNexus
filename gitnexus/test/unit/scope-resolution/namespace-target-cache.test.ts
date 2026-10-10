import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScopeTree, type BindingRef, type ImportEdge, type Scope } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { createNamespaceTargetCache } from '../../../src/core/ingestion/scope-resolution/scope/namespace-target-cache.js';
import { DiskBackedScopeTree, persistScopeShards } from '../../../src/storage/scope-index-store.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'namespace-target-cache-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const at = (startLine: number, startCol = 0) => ({ startLine, startCol });
const range = (line: number, col = 0) => ({ ...at(line, col), endLine: line, endCol: col + 5 });
const edge = (targetFile: string, line: number, localName = 'pkg'): ImportEdge => ({
  localName,
  kind: 'namespace',
  targetFile,
  targetExportedName: '',
  atRange: range(line),
});
const scope = (id: string, parent: string | null, extra: Partial<Scope> = {}): Scope => ({
  id,
  parent,
  kind: parent === null ? 'Module' : 'Function',
  filePath: 'caller.ts',
  range:
    parent === null
      ? { ...at(0), endLine: 10000, endCol: 0 }
      : { ...at(1), endLine: 9999, endCol: 0 },
  imports: [],
  bindings: new Map(),
  typeBindings: new Map(),
  ownedDefs: [],
  ...extra,
});
const indexes = (fileScopes: Scope[]): ScopeResolutionIndexes =>
  ({
    scopeTree: buildScopeTree(fileScopes),
    imports: new Map(fileScopes.map((owner) => [owner.id, owner.imports])),
    bindings: new Map(),
    bindingAugmentations: new Map(),
  }) as unknown as ScopeResolutionIndexes;
const parsed = (fileScopes: Scope[]) => ({ moduleScope: 'module', scopes: fileScopes });

describe('namespace target activation cache', () => {
  it('collects stable imports once for a thousand distinct receiver positions', () => {
    const imports = Array.from({ length: 32 }, (_, i) => edge(`pkg${i}.ts`, 0, `pkg${i}`));
    const module = scope('module', null, {
      imports,
      nameClaims: imports.map((entry) => ({
        name: entry.localName,
        kind: 'import',
        range: entry.atRange!,
      })),
    });
    const receiverPaths = vi.fn(() => undefined);
    const cache = createNamespaceTargetCache(
      parsed([module]),
      indexes([module]),
      { receiverPaths },
      false,
    );
    expect(cache.requiresLexicalLookup).toBe(true);
    const first = cache.at(module.id, at(1));
    for (let line = 2; line <= 1000; line++) expect(cache.at(module.id, at(line))).toBe(first);
    expect(first.size).toBe(32);
    // One map build (32 import visits), not 1,000 builds (32,000 visits).
    expect(receiverPaths).toHaveBeenCalledTimes(32);
    // Unspecified lookup position has its own snapshot, even after the last activation.
    expect(cache.at()).not.toBe(first);
  });

  it('changes snapshots exactly at same-line import and blocking activations', () => {
    const outer = edge('outer.ts', 0);
    const inner = { ...edge('inner.ts', 10), atRange: range(10, 5) };
    const module = scope('module', null, { imports: [outer] });
    const fn = scope('function', module.id, {
      imports: [inner],
      nameClaims: [
        {
          name: 'pkg',
          kind: 'import',
          range: inner.atRange,
          availableFrom: at(10, 5),
          inactive: 'outer',
        },
        { name: 'pkg', kind: 'blocked', range: range(10, 20), availableFrom: at(10, 20) },
      ],
    });
    const cache = createNamespaceTargetCache(parsed([module, fn]), indexes([module, fn]), {}, true);
    const before = cache.at(fn.id, at(10, 4));
    const imported = cache.at(fn.id, at(10, 5));
    const blocked = cache.at(fn.id, at(10, 20));
    expect(before.get('pkg')).toEqual(['outer.ts']);
    expect(imported.get('pkg')).toEqual(['inner.ts']);
    expect(blocked.has('pkg')).toBe(false);
    expect(cache.at(fn.id, at(2))).toBe(before);
    expect(cache.at(fn.id, at(10, 19))).toBe(imported);
    expect(cache.at(fn.id, at(11))).toBe(blocked);
  });

  it.each(['local', 'finalized', 'augmented', 'workspace', 'namespace'] as const)(
    'splits the cache when a %s binding starts shadowing a namespace',
    (channel) => {
      const module = scope('module', null, { imports: [edge('outer.ts', 0)] });
      const binding: BindingRef = {
        def: { nodeId: 'local:pkg', type: 'Variable', filePath: 'caller.ts' },
        origin: 'local',
        availableFrom: at(10),
      };
      const bindings = new Map([['pkg', [binding]]]);
      const fn = scope('function', module.id, {
        bindings: channel === 'local' ? bindings : new Map(),
      });
      const base = indexes([module, fn]);
      const scopes = {
        ...base,
        bindings: channel === 'finalized' ? new Map([[fn.id, bindings]]) : base.bindings,
        bindingAugmentations:
          channel === 'augmented' ? new Map([[fn.id, bindings]]) : base.bindingAugmentations,
        workspaceFqnBindings: channel === 'workspace' ? bindings : new Map(),
        namespaceFqnBindings:
          channel === 'namespace' ? new Map([['Example', bindings]]) : new Map(),
        accessibleNamespacesByScope:
          channel === 'namespace' ? new Map([[fn.id, ['Example']]]) : new Map(),
      };
      const cache = createNamespaceTargetCache(parsed([module, fn]), scopes, {}, true);
      const before = cache.at(fn.id, at(9));
      const after = cache.at(fn.id, at(10));
      expect(before.get('pkg')).toEqual(['outer.ts']);
      expect(after.has('pkg')).toBe(false);
      expect(cache.at(fn.id, at(2))).toBe(before);
      expect(cache.at(fn.id, at(11))).toBe(after);
    },
  );

  it('keeps deferred parent lookup independent of the child source position', () => {
    const first = edge('first.ts', 20);
    const last = edge('last.ts', 30);
    const module = scope('module', null, {
      imports: [first, last],
      nameClaims: [first, last].map((entry) => ({
        name: 'pkg',
        kind: 'import',
        range: entry.atRange!,
        availableFrom: entry.atRange,
      })),
    });
    const fn = scope('function', module.id, { lookupPolicy: { deferParentActivation: true } });
    const cache = createNamespaceTargetCache(parsed([module, fn]), indexes([module, fn]), {}, true);
    expect(cache.at(fn.id, at(5)).get('pkg')).toEqual(['last.ts']);
    expect(cache.at(fn.id, at(25)).get('pkg')).toEqual(['last.ts']);
    expect(cache.at(module.id, at(25)).get('pkg')).toEqual(['first.ts']);
    expect(cache.at(fn.id, at(6))).toBe(cache.at(fn.id, at(5)));
  });

  it('reads activation boundaries and claims from sealed disk scopes', () => {
    const module = scope('module', null, { imports: [edge('outer.ts', 0)] });
    const inner = edge('inner.ts', 10);
    const fn = scope('function', module.id, {
      imports: [inner],
      nameClaims: [
        {
          name: 'pkg',
          kind: 'import',
          range: inner.atRange!,
          availableFrom: at(10),
          inactive: 'outer',
        },
      ],
    });
    const fileScopes = [module, fn];
    const base = indexes(fileScopes);
    const scopeTree = new DiskBackedScopeTree(tmp, persistScopeShards(tmp, fileScopes));
    const cache = createNamespaceTargetCache(parsed([]), { ...base, scopeTree }, {}, false);
    expect(cache.requiresLexicalLookup).toBe(true);
    expect(cache.at(fn.id, at(9)).get('pkg')).toEqual(['outer.ts']);
    expect(cache.at(fn.id, at(10)).get('pkg')).toEqual(['inner.ts']);
    expect(cache.at(fn.id, at(11))).toBe(cache.at(fn.id, at(10)));
  });

  it('uses exact positions if a partial index cannot enumerate activations', () => {
    const module = scope('module', null, { imports: [edge('outer.ts', 0)] });
    const inner = edge('inner.ts', 10);
    const fn = scope('function', module.id, {
      imports: [inner],
      nameClaims: [
        {
          name: 'pkg',
          kind: 'import',
          range: inner.atRange!,
          availableFrom: at(10),
          inactive: 'outer',
        },
      ],
    });
    const base = indexes([module, fn]);
    const scopeTree = { getScope: base.scopeTree.getScope } as ScopeResolutionIndexes['scopeTree'];
    const cache = createNamespaceTargetCache(parsed([]), { ...base, scopeTree }, {}, false);
    const before = cache.at(fn.id, at(9));
    expect(before.get('pkg')).toEqual(['outer.ts']);
    expect(cache.at(fn.id, at(10)).get('pkg')).toEqual(['inner.ts']);
    expect(cache.at(fn.id, at(8))).not.toBe(before);
    expect(cache.at(fn.id, at(9))).toBe(before);
  });
});
