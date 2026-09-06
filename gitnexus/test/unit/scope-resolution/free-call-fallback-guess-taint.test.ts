/**
 * Review findings on #3182 (free-call-fallback.ts:710, bot + magyargergo): the
 * free-call CALLS edge is deduplicated per (caller, callee), and its
 * confidence/reason used to be whatever the FIRST collapsed site decided, so
 * `alpha(); precise();` and `precise(); alpha();` produced different edges for
 * the same dependency. Now the label is decided from every collapsed site: one
 * site resolved through a real binding PROVES the edge (0.85 /
 * `import-resolved`); it is a guess (0.5 / `global-name-fallback`) only when
 * every site was one. Order never decides.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  type NodeLabel,
  type ParsedFile,
  type Range,
  type ReferenceSite,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitFreeCallFallback } from '../../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import { GLOBAL_NAME_FALLBACK_REASON } from '../../../src/core/graph/edge-reasons.js';
import {
  formatNameFallbackSummary,
  summarizeNameFallback,
} from '../../../src/core/ingestion/scope-resolution/name-fallback-summary.js';
import type { ResolutionOutcome } from '../../../src/core/ingestion/scope-resolution/resolution-outcome.js';

const CALLER_FILE = 'caller.ts';
const TARGET_FILE = 'target.ts';

const range = (sl: number, sc: number, el = sl, ec = sc + 6): Range => ({
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

const targetDef: SymbolDefinition = {
  nodeId: 'def:helper',
  filePath: TARGET_FILE,
  type: 'Function',
  qualifiedName: 'helper',
};
const callerDef: SymbolDefinition = {
  nodeId: 'def:main',
  filePath: CALLER_FILE,
  type: 'Function',
  qualifiedName: 'main',
};

/** `h()` — resolved PRECISELY through an aliased binding `h → helper`. */
const preciseSite = (line: number): ReferenceSite => ({
  name: 'h',
  atRange: range(line, 2),
  inScope: 'scope:caller-mod',
  kind: 'call',
  callForm: 'free',
  arity: 0,
});
/** `helper()` — no binding in scope; only the global unique-name GUESS reaches it. */
const guessedSite = (line: number): ReferenceSite => ({
  name: 'helper',
  atRange: range(line, 2),
  inScope: 'scope:caller-mod',
  kind: 'call',
  callForm: 'free',
  arity: 0,
});

function mkScope(
  id: ScopeId,
  filePath: string,
  ownedDefs: SymbolDefinition[],
  bindings: Scope['bindings'],
): Scope {
  return {
    id,
    parent: null,
    kind: 'Module',
    range: range(1, 0, 100, 0),
    filePath,
    bindings,
    ownedDefs,
    imports: [],
    typeBindings: new Map(),
  };
}

function fnNode(graph: KnowledgeGraph, id: string, name: string, filePath: string): void {
  graph.addNode({
    id,
    label: 'Function' as NodeLabel,
    properties: { name, filePath, qualifiedName: name },
  });
}

function run(sites: readonly ReferenceSite[]) {
  const callerScope = mkScope(
    'scope:caller-mod',
    CALLER_FILE,
    [callerDef],
    new Map([['h', [{ def: targetDef, origin: 'import' as const }]]]),
  );
  const targetScope = mkScope('scope:target-mod', TARGET_FILE, [targetDef], new Map());
  const callerParsed: ParsedFile = {
    filePath: CALLER_FILE,
    moduleScope: 'scope:caller-mod',
    scopes: [callerScope],
    parsedImports: [],
    localDefs: [callerDef],
    referenceSites: sites,
  };
  const targetParsed: ParsedFile = {
    filePath: TARGET_FILE,
    moduleScope: 'scope:target-mod',
    scopes: [targetScope],
    parsedImports: [],
    localDefs: [targetDef],
    referenceSites: [],
  };
  const scopes = [callerScope, targetScope];
  const allDefs = [callerDef, targetDef];
  const indexes = {
    scopeTree: buildScopeTree(scopes),
    defs: buildDefIndex(allDefs),
    qualifiedNames: buildQualifiedNameIndex(allDefs),
    moduleScopes: buildModuleScopeIndex(
      scopes.map((s) => ({ filePath: s.filePath, moduleScopeId: s.id })),
    ),
    methodDispatch: buildMethodDispatchIndex({
      owners: [],
      computeMro: () => [],
      implementsOf: () => [],
    }),
    imports: new Map(),
    bindings: new Map(),
    bindingAugmentations: new Map(),
    workspaceFqnBindings: new Map(),
    workspaceTypeBindings: new Map(),
    namespaceFqnBindings: new Map(),
    namespaceTypeBindings: new Map(),
    accessibleNamespacesByScope: new Map(),
    referenceSites: [],
    sccs: [],
    stats: {
      totalFiles: 2,
      totalEdges: 0,
      linkedEdges: 0,
      unresolvedEdges: 0,
      sccCount: 0,
      largestSccSize: 0,
      ambiguousWildcardExports: [],
    },
  } as unknown as ScopeResolutionIndexes;
  const graph = createKnowledgeGraph();
  fnNode(graph, 'fn:main', 'main', CALLER_FILE);
  fnNode(graph, 'fn:helper', 'helper', TARGET_FILE);
  const outcomes: ResolutionOutcome[] = [];
  emitFreeCallFallback(
    graph,
    indexes,
    [callerParsed, targetParsed],
    buildGraphNodeLookup(graph),
    { bySourceScope: new Map() },
    new Set<string>(),
    createSemanticModel(),
    buildWorkspaceResolutionIndex([callerParsed, targetParsed]),
    { allowGlobalFallback: true, recordResolutionOutcome: (o) => outcomes.push(o) },
  );
  const calls = graph.relationships.filter((r) => r.type === 'CALLS');
  return { calls, outcomes };
}

describe('free-call dedup: the label is decided from every collapsed site, never by order', () => {
  it('control — a lone precise site is import-resolved at 0.85', () => {
    const { calls } = run([preciseSite(3)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.confidence).toBe(0.85);
    expect(calls[0]!.reason).toBe('import-resolved');
  });

  it('control — a lone guessed site is labeled at 0.5', () => {
    const { calls, outcomes } = run([guessedSite(3)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.confidence).toBe(0.5);
    expect(calls[0]!.reason).toBe(GLOBAL_NAME_FALLBACK_REASON);
    expect(outcomes.map((o) => o.kind)).toEqual(['fallback-guessed']);
  });

  it('guess FIRST, precise second: the precise site proves the edge — 0.85 import-resolved', () => {
    const { calls } = run([guessedSite(3), preciseSite(4)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.confidence).toBe(0.85);
    expect(calls[0]!.reason).toBe('import-resolved');
  });

  it('precise FIRST, guess second: identical — a redundant guess does not taint a proven edge', () => {
    const { calls } = run([preciseSite(3), guessedSite(4)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.confidence).toBe(0.85);
    expect(calls[0]!.reason).toBe('import-resolved');
  });

  it('two guessed sites stay a guess', () => {
    const { calls } = run([guessedSite(3), guessedSite(4)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.confidence).toBe(0.5);
    expect(calls[0]!.reason).toBe(GLOBAL_NAME_FALLBACK_REASON);
  });

  it('reports guessed sites without claiming they are final guessed edges', () => {
    for (const sites of [
      [guessedSite(3), preciseSite(4)],
      [preciseSite(3), guessedSite(4)],
    ]) {
      const { calls, outcomes } = run(sites);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.reason).toBe('import-resolved');
      const summary = summarizeNameFallback(outcomes);
      expect(summary?.totalGuessed).toBe(1);
      const line = formatNameFallbackSummary(summary);
      expect(line).toContain('name-fallback resolution: 1 call site (');
      expect(line).not.toContain('CALLS edges');
    }
  });
});
