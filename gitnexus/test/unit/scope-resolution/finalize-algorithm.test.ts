/**
 * Unit tests for `finalize` (RFC #909 Ring 2 SHARED #915).
 *
 * Covers: acyclic chain · single-SCC cycle · multi-SCC · wildcard
 * expansion · re-export flattening · dynamic import passthrough/linking ·
 * side-effect imports · bounded fixpoint cap · module-scope binding
 * materialization · unresolved target · external target · provider
 * `mergeBindings` precedence.
 */

import { describe, it, expect } from 'vitest';
import {
  finalize,
  type FinalizeFile,
  type FinalizeHooks,
  type ParsedImport,
  type BindingRef,
  type SymbolDefinition,
  type ScopeId,
} from 'gitnexus-shared';

// ─── Test helpers ───────────────────────────────────────────────────────────

const def = (
  nodeId: string,
  type: SymbolDefinition['type'] = 'Class',
  qualifiedName?: string,
): SymbolDefinition => ({
  nodeId,
  filePath: 'x',
  type,
  ...(qualifiedName !== undefined ? { qualifiedName } : {}),
});

const file = (
  filePath: string,
  localDefs: SymbolDefinition[] = [],
  parsedImports: ParsedImport[] = [],
): FinalizeFile => ({
  filePath,
  moduleScope: `scope:${filePath}#1:0-9999:0:Module`,
  localDefs: localDefs.map((d) => ({ ...d, filePath })),
  parsedImports,
});

/** Simple hook set: `resolveImportTarget` does a direct path lookup; wildcard
 *  expansion returns the concrete names from the target's own local defs;
 *  `mergeBindings` appends (no precedence logic). */
const defaultHooks = (files: readonly FinalizeFile[]): FinalizeHooks => ({
  resolveImportTarget(targetRaw) {
    if (targetRaw === null || targetRaw.length === 0) return null;
    return files.some((f) => f.filePath === targetRaw) ? targetRaw : null;
  },
  expandsWildcardTo(targetModuleScope) {
    const target = files.find((f) => f.moduleScope === targetModuleScope);
    if (target === undefined) return [];
    return target.localDefs.map((d) => deriveSimple(d)).filter((n): n is string => n !== null);
  },
  mergeBindings(existing, incoming) {
    return [...existing, ...incoming];
  },
});

function deriveSimple(d: SymbolDefinition): string | null {
  const q = d.qualifiedName;
  if (q === undefined || q.length === 0) return null;
  const dot = q.lastIndexOf('.');
  return dot === -1 ? q : q.slice(dot + 1);
}

const named = (localName: string, importedName: string, targetRaw: string): ParsedImport => ({
  kind: 'named',
  localName,
  importedName,
  targetRaw,
});

const aliased = (
  localName: string,
  importedName: string,
  alias: string,
  targetRaw: string,
): ParsedImport => ({ kind: 'alias', localName, importedName, alias, targetRaw });

const namespace = (localName: string, importedName: string, targetRaw: string): ParsedImport => ({
  kind: 'namespace',
  localName,
  importedName,
  targetRaw,
});

const reexport = (localName: string, importedName: string, targetRaw: string): ParsedImport => ({
  kind: 'reexport',
  localName,
  importedName,
  targetRaw,
});

const wildcard = (targetRaw: string): ParsedImport => ({ kind: 'wildcard', targetRaw });

const dynamic = (localName: string, targetRaw: string | null): ParsedImport => ({
  kind: 'dynamic-unresolved',
  localName,
  targetRaw,
});

const dynamicResolved = (targetRaw: string): ParsedImport => ({
  kind: 'dynamic-resolved',
  targetRaw,
});

const sideEffect = (targetRaw: string): ParsedImport => ({ kind: 'side-effect', targetRaw });

const firstImport = (out: ReturnType<typeof finalize>, scope: ScopeId) => {
  const imports = out.imports.get(scope);
  return imports?.[0];
};

const bindingsFor = (
  out: ReturnType<typeof finalize>,
  scope: ScopeId,
  name: string,
): readonly BindingRef[] => {
  const scopeBindings = out.bindings.get(scope);
  return scopeBindings?.get(name) ?? [];
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('finalize', () => {
  describe('trivial / acyclic', () => {
    it('handles an empty workspace', () => {
      const out = finalize({ files: [], workspaceIndex: undefined }, defaultHooks([]));
      expect(out.stats.totalFiles).toBe(0);
      expect(out.stats.totalEdges).toBe(0);
      expect(out.sccs).toEqual([]);
    });

    it('resolves a single named import across two files', () => {
      const b = file('b', [def('def:b.User', 'Class', 'b.User')]);
      const a = file('a', [], [named('User', 'User', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.kind).toBe('named');
      expect(edge.targetFile).toBe('b');
      expect(edge.targetModuleScope).toBe(b.moduleScope);
      expect(edge.targetDefId).toBe('def:b.User');
      expect(edge.linkStatus).toBeUndefined();
      expect(out.stats.linkedEdges).toBe(1);
      expect(out.stats.unresolvedEdges).toBe(0);
    });

    it('marks an edge unresolved when target file cannot be resolved', () => {
      const a = file('a', [], [named('User', 'User', 'external-pkg')]);
      const out = finalize({ files: [a], workspaceIndex: undefined }, defaultHooks([a]));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.linkStatus).toBe('unresolved');
      expect(edge.targetFile).toBeNull();
    });

    it('marks an edge unresolved when target file exists but name is not exported', () => {
      const b = file('b', [def('def:b.Other', 'Class', 'b.Other')]);
      const a = file('a', [], [named('User', 'User', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.linkStatus).toBe('unresolved');
      // targetFile still known — unresolvability is at the name level.
      expect(edge.targetFile).toBe('b');
    });

    it('passes dynamic-unresolved edges through without linking', () => {
      const a = file('a', [], [dynamic('', 'runtime.computed')]);
      const out = finalize({ files: [a], workspaceIndex: undefined }, defaultHooks([a]));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.kind).toBe('dynamic-unresolved');
      expect(edge.targetFile).toBeNull();
      expect(edge.linkStatus).toBeUndefined();
    });

    it('links dynamic-resolved imports as file-level edges without bindings', () => {
      const feature = file('feature', [def('def:feature.Feature', 'Class', 'feature.Feature')]);
      const app = file('app', [], [dynamicResolved('feature')]);
      const files = [app, feature];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edge = firstImport(out, app.moduleScope)!;
      expect(edge.kind).toBe('dynamic-resolved');
      expect(edge.targetFile).toBe('feature');
      expect(edge.linkStatus).toBeUndefined();
      expect(edge.targetDefId).toBeUndefined();
      expect(bindingsFor(out, app.moduleScope, 'Feature')).toEqual([]);
      expect(out.stats.linkedEdges).toBe(1);
    });

    it('links side-effect imports as file-level edges without bindings', () => {
      const polyfill = file('polyfill', [
        def('def:polyfill.install', 'Function', 'polyfill.install'),
      ]);
      const app = file('app', [], [sideEffect('polyfill')]);
      const files = [app, polyfill];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edge = firstImport(out, app.moduleScope)!;
      expect(edge.kind).toBe('side-effect');
      expect(edge.localName).toBe('');
      expect(edge.targetFile).toBe('polyfill');
      expect(edge.linkStatus).toBeUndefined();
      expect(edge.targetDefId).toBeUndefined();
      expect(bindingsFor(out, app.moduleScope, 'install')).toEqual([]);
      expect(out.stats.linkedEdges).toBe(1);
    });
  });

  describe('cycles + bounded fixpoint', () => {
    it('finalizes a two-file cycle (A → B → A) without hanging', () => {
      const a = file('a', [def('def:a.X', 'Class', 'a.X')], [named('Y', 'Y', 'b')]);
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const aEdge = firstImport(out, a.moduleScope)!;
      const bEdge = firstImport(out, b.moduleScope)!;
      expect(aEdge.targetDefId).toBe('def:b.Y');
      expect(bEdge.targetDefId).toBe('def:a.X');
      expect(out.stats.sccCount).toBeGreaterThanOrEqual(1);
    });

    it('packs cyclic files into a single SCC with isCycle=true', () => {
      const a = file('a', [def('def:a.X', 'Class', 'a.X')], [named('Y', 'Y', 'b')]);
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const cycles = out.sccs.filter((scc) => scc.isCycle);
      expect(cycles.length).toBe(1);
      expect(cycles[0]!.files.length).toBe(2);
      expect(new Set(cycles[0]!.files)).toEqual(new Set(['a', 'b']));
    });

    it('separates disjoint SCCs', () => {
      // a↔b cycle, c↔d cycle — disjoint.
      const a = file('a', [def('def:a.X', 'Class', 'a.X')], [named('Y', 'Y', 'b')]);
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const c = file('c', [def('def:c.P', 'Class', 'c.P')], [named('Q', 'Q', 'd')]);
      const d = file('d', [def('def:d.Q', 'Class', 'd.Q')], [named('P', 'P', 'c')]);
      const files = [a, b, c, d];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const cycleSCCs = out.sccs.filter((scc) => scc.isCycle);
      expect(cycleSCCs.length).toBe(2);
    });

    it('reports stats distinguishing linked from unresolved edges in a cycle', () => {
      const a = file(
        'a',
        [def('def:a.X', 'Class', 'a.X')],
        [named('Y', 'Y', 'b'), named('Ghost', 'Ghost', 'b')],
      );
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      expect(out.stats.linkedEdges).toBe(2); // a→b.Y and b→a.X resolve
      expect(out.stats.unresolvedEdges).toBe(1); // a→b.Ghost doesn't
    });

    it('transitions an intra-SCC edge to linkStatus=unresolved when the cap is reached', () => {
      // A↔B cycle; A imports a name that B never exports. The file-level
      // target resolves (b exists), but the name-level lookup never
      // succeeds, so the fixpoint exhausts its cap and we fall through to
      // `linkStatus: 'unresolved'` (distinct from `targetFile: null`).
      const a = file(
        'a',
        [def('def:a.X', 'Class', 'a.X')],
        [named('Ghost', 'Ghost', 'b'), named('Y', 'Y', 'b')],
      );
      const b = file('b', [def('def:b.Y', 'Class', 'b.Y')], [named('X', 'X', 'a')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const aEdges = out.imports.get(a.moduleScope) ?? [];
      const ghost = aEdges.find((e) => e.localName === 'Ghost');
      expect(ghost).toBeDefined();
      // Cap-hit distinction: file target is known, but name never resolved.
      expect(ghost!.targetFile).toBe('b');
      expect(ghost!.linkStatus).toBe('unresolved');
      expect(ghost!.targetDefId).toBeUndefined();
    });
  });

  describe('wildcard expansion', () => {
    it('expands `wildcard` into one ImportEdge per exported name', () => {
      const b = file('b', [
        def('def:b.X', 'Class', 'b.X'),
        def('def:b.Y', 'Class', 'b.Y'),
        def('def:b.Z', 'Class', 'b.Z'),
      ]);
      const a = file('a', [], [wildcard('b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edges = out.imports.get(a.moduleScope) ?? [];
      expect(edges.length).toBe(3);
      expect(edges.every((e) => e.kind === 'wildcard-expanded')).toBe(true);
      expect(new Set(edges.map((e) => e.localName))).toEqual(new Set(['X', 'Y', 'Z']));
      expect(new Set(edges.map((e) => e.targetDefId))).toEqual(
        new Set(['def:b.X', 'def:b.Y', 'def:b.Z']),
      );
    });

    it('leaves a wildcard unresolved when the target file cannot be resolved', () => {
      const a = file('a', [], [wildcard('external-pkg')]);
      const out = finalize({ files: [a], workspaceIndex: undefined }, defaultHooks([a]));
      const edges = out.imports.get(a.moduleScope) ?? [];
      expect(edges.length).toBe(1);
      expect(edges[0]!.linkStatus).toBe('unresolved');
    });

    it('expanded bindings land at `origin: wildcard`', () => {
      const b = file('b', [def('def:b.X', 'Class', 'b.X')]);
      const a = file('a', [], [wildcard('b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const bindings = bindingsFor(out, a.moduleScope, 'X');
      expect(bindings.length).toBeGreaterThanOrEqual(1);
      const imported = bindings.find((br) => br.origin === 'wildcard');
      expect(imported).toBeDefined();
      expect(imported!.def.nodeId).toBe('def:b.X');
    });
  });

  describe('re-export flattening', () => {
    it('sets transitiveVia on reexport edges', () => {
      const c = file('c', [def('def:c.X', 'Class', 'c.X')]);
      const b = file('b', [], [reexport('X', 'X', 'c')]);
      const a = file('a', [], [named('X', 'X', 'b')]);
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const reexportEdge = firstImport(out, b.moduleScope)!;
      expect(reexportEdge.kind).toBe('reexport');
      expect(reexportEdge.transitiveVia).toEqual(['c']);
    });

    it('multi-hop re-export chains resolve via the precomputed closure even when intermediate files do not surface the name', () => {
      // Contract (see FinalizeFile.localDefs doc): `finalize` first looks
      // up `importedName` in `B.localDefs`. If B only has
      //   export { X } from './C'
      // and does NOT surface X in its own localDefs, finalize falls back
      // to the precomputed re-export closure (`buildReexportClosures`),
      // which encodes every name reachable through B's reexport/wildcard
      // chain. The lookup is O(1) and inherits the leaf `targetDefId`.
      // SCC-condensed iteration handles cyclic chains structurally.
      //
      // The "thin" variant (B does not surface X) resolves to C's def
      // via the re-export chain. The "thick" variant (B has its own X
      // local def) short-circuits to B's local def — surfacing the name
      // is a valid optimization that bypasses the recursive crawl, but
      // it can also intentionally shadow the re-export.
      const c = file('c', [def('def:c.X', 'Class', 'c.X')]);

      // Variant 1: B does NOT include X in its own localDefs.
      const bThin = file('b', [], [reexport('X', 'X', 'c')]);
      const aThin = file('a', [], [named('X', 'X', 'b')]);
      const thinFiles = [aThin, bThin, c];
      const thinOut = finalize(
        { files: thinFiles, workspaceIndex: undefined },
        defaultHooks(thinFiles),
      );
      const thinEdge = firstImport(thinOut, aThin.moduleScope)!;
      expect(thinEdge.linkStatus).toBeUndefined();
      expect(thinEdge.targetDefId).toBe('def:c.X');
      // `transitiveVia` records the chain: through B (target) into C (leaf).
      expect(thinEdge.transitiveVia).toEqual(['b', 'c']);

      // Variant 2: B surfaces X via its OWN localDefs (distinct nodeId
      // from C's X) → direct B.localDefs lookup short-circuits the
      // closure consult. This is the "shadowing" optimization: when B
      // explicitly surfaces a name, importers see B's def, not the
      // upstream one. `transitiveVia` is undefined since no chain walk
      // happened.
      const bThick = file('b', [def('def:b.X', 'Class', 'b.X')], [reexport('X', 'X', 'c')]);
      const aThick = file('a', [], [named('X', 'X', 'b')]);
      const thickFiles = [aThick, bThick, c];
      const thickOut = finalize(
        { files: thickFiles, workspaceIndex: undefined },
        defaultHooks(thickFiles),
      );
      const thickEdge = firstImport(thickOut, aThick.moduleScope)!;
      expect(thickEdge.linkStatus).toBeUndefined();
      expect(thickEdge.targetDefId).toBe('def:b.X');
      expect(thickEdge.transitiveVia).toBeUndefined();
    });

    it('resolves a 3-hop re-export chain (a → b → c → d) where intermediates do not surface the name', () => {
      const d = file('d', [def('def:d.X', 'Class', 'd.X')]);
      const c = file('c', [], [reexport('X', 'X', 'd')]);
      const b = file('b', [], [reexport('X', 'X', 'c')]);
      const a = file('a', [], [named('X', 'X', 'b')]);
      const files = [a, b, c, d];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.linkStatus).toBeUndefined();
      expect(edge.targetDefId).toBe('def:d.X');
      expect(edge.transitiveVia).toEqual(['b', 'c', 'd']);
    });

    it('terminates without infinite recursion when re-exports cycle back through the chain', () => {
      // Cycle: b re-exports from c, c re-exports from b. Neither surfaces
      // X. The SCC-condensed closure builder lumps b+c into one cyclic
      // SCC and runs a bounded fixpoint inside it; with no terminal def
      // anywhere in the cycle, the closure entry for X never appears
      // and the consuming edge is correctly marked unresolved. No call
      // stack involvement at any point.
      const c = file('c', [], [reexport('X', 'X', 'b')]);
      const b = file('b', [], [reexport('X', 'X', 'c')]);
      const a = file('a', [], [named('X', 'X', 'b')]);
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.targetFile).toBe('b');
      expect(edge.linkStatus).toBe('unresolved');
      expect(edge.targetDefId).toBeUndefined();
    });

    it('falls through wildcard re-exports via the precomputed closure', () => {
      // B has `export * from './c'` (wildcard re-export). A imports `X`
      // from B. The closure builder fans out the wildcard at B by
      // copying every name from C's localDefs (and C's own closure)
      // into B's closure, so the lookup at finalize time is O(1).
      const c = file('c', [def('def:c.X', 'Class', 'c.X')]);
      const b = file('b', [], [wildcard('c')]);
      const a = file('a', [], [named('X', 'X', 'b')]);
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.linkStatus).toBeUndefined();
      expect(edge.targetDefId).toBe('def:c.X');
    });

    it('resolves arbitrarily deep re-export chains without stack overflow (1000 hops, fully linked)', () => {
      // Build a 1000-link chain a₀ → a₁ → … → a₁₀₀₀, where each
      // intermediate is `export { X } from './aₙ₊₁'`. Only the last
      // file holds the actual `def:X`. The legacy recursive
      // implementation needed `MAX_REEXPORT_DEPTH=100` purely as a
      // call-stack ceiling (anything deeper would crash); the new
      // SCC-condensed iterative closure resolves the entire chain
      // structurally with zero stack involvement. Asserting full
      // resolution + accurate `transitiveVia` proves both that the
      // recursion is gone AND that the closure correctly inherits
      // the leaf def across all hops.
      const CHAIN_LEN = 1000;
      const chain: FinalizeFile[] = [];
      for (let i = 0; i <= CHAIN_LEN; i++) {
        const fp = `chain${i}`;
        if (i === CHAIN_LEN) {
          chain.push(file(fp, [def(`def:chain${i}.X`, 'Class', `chain${i}.X`)]));
        } else {
          chain.push(file(fp, [], [reexport('X', 'X', `chain${i + 1}`)]));
        }
      }
      const consumer = file('consumer', [], [named('X', 'X', 'chain1')]);
      const files = [consumer, ...chain];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, consumer.moduleScope)!;
      expect(edge.targetFile).toBe('chain1');
      expect(edge.linkStatus).toBeUndefined();
      expect(edge.targetDefId).toBe(`def:chain${CHAIN_LEN}.X`);
      // `transitiveVia` enumerates every intermediate file from chain1
      // through chain1000 — proves the closure walked the full path.
      expect(edge.transitiveVia).toBeDefined();
      expect(edge.transitiveVia!.length).toBe(CHAIN_LEN);
      expect(edge.transitiveVia![0]).toBe('chain1');
      expect(edge.transitiveVia![CHAIN_LEN - 1]).toBe(`chain${CHAIN_LEN}`);
    });

    it('first-match-wins when the closure encounters multiple sources for the same name', () => {
      // B re-exports X from BOTH c and d. The closure builder walks
      // re-exports in declaration order; first match wins.
      // Resolution must be deterministic (no flaky picks).
      const c = file('c', [def('def:c.X', 'Class', 'c.X')]);
      const d = file('d', [def('def:d.X', 'Class', 'd.X')]);
      const b = file('b', [], [reexport('X', 'X', 'c'), reexport('X', 'X', 'd')]);
      const a = file('a', [], [named('X', 'X', 'b')]);
      const files = [a, b, c, d];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.linkStatus).toBeUndefined();
      // First re-export draft (`from 'c'`) wins. Recording this as the
      // contract — if the algorithm changes to last-wins or merge, this
      // test must be updated alongside the multi-binding propagation
      // pass that mirrors typeBindings (which also uses first-wins).
      expect(edge.targetDefId).toBe('def:c.X');
    });

    it('keeps first-wins precedence stable through cyclic shadowing', () => {
      const c = file('c', [def('def:c.X', 'Class', 'c.X')]);
      const d = file('d', [def('def:d.X', 'Class', 'd.X')]);
      const a = file('a', [], [reexport('X', 'X', 'b'), reexport('X', 'X', 'd')]);
      const b = file('b', [], [reexport('X', 'X', 'a'), reexport('X', 'X', 'c')]);
      const consumer = file('consumer', [], [named('X', 'X', 'a')]);
      const files = [consumer, a, b, c, d];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));

      const edge = firstImport(out, consumer.moduleScope)!;
      expect(edge.linkStatus).toBeUndefined();
      expect(edge.targetDefId).toBe('def:c.X');
      expect(edge.transitiveVia).toEqual(['a', 'b', 'c']);
    });
  });

  describe('aliased + namespace imports', () => {
    it('resolves an alias under its local name while preserving targetExportedName', () => {
      const b = file('b', [def('def:b.User', 'Class', 'b.User')]);
      const a = file('a', [], [aliased('Account', 'User', 'Account', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const edge = firstImport(out, a.moduleScope)!;
      expect(edge.kind).toBe('alias');
      expect(edge.localName).toBe('Account');
      expect(edge.targetExportedName).toBe('User');
      expect(edge.targetDefId).toBe('def:b.User');
    });

    it('records namespace imports with origin=namespace in bindings', () => {
      // Provider emits a synthetic module-representing def so the namespace
      // binding can anchor to a real SymbolDefinition.
      const numpyFile = file('numpy.py', [
        def('def:numpy', 'Namespace', 'numpy'),
        def('def:numpy.array', 'Function', 'numpy.array'),
      ]);
      const a = file('a', [], [namespace('np', 'numpy', 'numpy.py')]);
      const files = [a, numpyFile];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const npEdge = firstImport(out, a.moduleScope)!;
      expect(npEdge.kind).toBe('namespace');
      expect(npEdge.targetModuleScope).toBe(numpyFile.moduleScope);

      const bindings = bindingsFor(out, a.moduleScope, 'np');
      expect(bindings.some((b) => b.origin === 'namespace')).toBe(true);
      expect(bindings.find((b) => b.origin === 'namespace')!.def.nodeId).toBe('def:numpy');
    });

    it('links a namespace import to the module scope even when no module-def exists', () => {
      // No synthetic def in target — the edge still resolves to the module
      // scope, just without a `targetDefId`. Bindings materialization skips
      // the binding (no def to anchor to), but the edge itself is linked.
      const numpyFile = file('numpy.py', [def('def:numpy.array', 'Function', 'numpy.array')]);
      const a = file('a', [], [namespace('np', 'numpy', 'numpy.py')]);
      const files = [a, numpyFile];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const npEdge = firstImport(out, a.moduleScope)!;
      expect(npEdge.kind).toBe('namespace');
      expect(npEdge.linkStatus).toBeUndefined();
      expect(npEdge.targetModuleScope).toBe(numpyFile.moduleScope);
      expect(npEdge.targetDefId).toBeUndefined();
    });
  });

  describe('module-scope binding materialization', () => {
    it('lays down local defs with origin=local', () => {
      const a = file('a', [def('def:a.X', 'Class', 'a.X')]);
      const out = finalize({ files: [a], workspaceIndex: undefined }, defaultHooks([a]));
      const bindings = bindingsFor(out, a.moduleScope, 'X');
      expect(bindings.length).toBe(1);
      expect(bindings[0]!.origin).toBe('local');
      expect(bindings[0]!.def.nodeId).toBe('def:a.X');
    });

    it('layers imports on top of local defs via mergeBindings', () => {
      const b = file('b', [def('def:b.User', 'Class', 'b.User')]);
      const a = file('a', [def('def:a.User', 'Class', 'a.User')], [named('User', 'User', 'b')]);
      const files = [a, b];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      const bindings = bindingsFor(out, a.moduleScope, 'User');
      expect(bindings.length).toBe(2);
      expect(bindings.some((br) => br.origin === 'local')).toBe(true);
      expect(bindings.some((br) => br.origin === 'import')).toBe(true);
    });

    it('resolves imported defs across many files via O(1) defById index lookup', () => {
      // Regression for the materializeBindings O(N²) → O(1) fix:
      // a single consumer importing one symbol from each of N other
      // files must materialize an `import` binding for each. Prior to
      // the fix, finding `def.X` for each edge meant re-scanning every
      // file's localDefs (O(N × D × E)). With the index, every
      // `defById.get` is O(1), so this test stays under 50 ms even
      // at N=200.
      const N = 200;
      const leafFiles: FinalizeFile[] = [];
      const imports: ParsedImport[] = [];
      for (let i = 0; i < N; i++) {
        const fp = `leaf${i}`;
        const localName = `Leaf${i}`;
        leafFiles.push(file(fp, [def(`def:${fp}.${localName}`, 'Class', `${fp}.${localName}`)]));
        imports.push(named(localName, localName, fp));
      }
      const consumer = file('consumer', [], imports);
      const files = [consumer, ...leafFiles];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      for (let i = 0; i < N; i++) {
        const bindings = bindingsFor(out, consumer.moduleScope, `Leaf${i}`);
        expect(bindings.length).toBe(1);
        expect(bindings[0]!.origin).toBe('import');
        expect(bindings[0]!.def.nodeId).toBe(`def:leaf${i}.Leaf${i}`);
      }
    });

    it('honors provider precedence: mergeBindings can drop existing bindings', () => {
      // Provider decides imports win over locals (Python-ish precedence).
      const b = file('b', [def('def:b.User', 'Class', 'b.User')]);
      const a = file('a', [def('def:a.User', 'Class', 'a.User')], [named('User', 'User', 'b')]);
      const files = [a, b];
      const hooks: FinalizeHooks = {
        ...defaultHooks(files),
        mergeBindings(_existing, incoming) {
          // Replace existing with incoming — last-write-wins across tiers.
          return incoming;
        },
      };
      const out = finalize({ files, workspaceIndex: undefined }, hooks);
      const bindings = bindingsFor(out, a.moduleScope, 'User');
      // Only the last merged layer (the import) remains.
      expect(bindings.length).toBe(1);
      expect(bindings[0]!.origin).toBe('import');
    });
  });

  describe('SCC-DAG exposure for parallelism', () => {
    it('returns SCCs in reverse-topological order (leaves first)', () => {
      // c ← b ← a (a imports b, b imports c, c has no imports)
      const c = file('c', [def('def:c.C', 'Class', 'c.C')]);
      const b = file('b', [def('def:b.B', 'Class', 'b.B')], [named('C', 'C', 'c')]);
      const a = file('a', [def('def:a.A', 'Class', 'a.A')], [named('B', 'B', 'b')]);
      const files = [a, b, c];
      const out = finalize({ files, workspaceIndex: undefined }, defaultHooks(files));
      // First SCC processed must be `c` (leaf), last must be `a`.
      expect(out.sccs[0]!.files[0]).toBe('c');
      expect(out.sccs[out.sccs.length - 1]!.files[0]).toBe('a');
    });
  });
});
