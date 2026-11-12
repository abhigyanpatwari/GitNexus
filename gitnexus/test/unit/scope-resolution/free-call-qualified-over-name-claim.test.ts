/**
 * A module-qualified free call (`mod::fn()`) names its module, so a lexical name claim for the
 * bare tail (a local binding or parameter called `fn`) cannot be what the call means. The
 * `resolveQualifiedFreeCall` hook therefore runs BEFORE the name-claim block, and a defined hit
 * bypasses it. An undefined hit, a site without a written path and a language without the hook
 * keep the block, so the reorder only ever adds an edge for a site the hook resolved.
 *
 * The hook is a fake: this pins the ordering in the shared pass, not any language.
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
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitFreeCallFallback } from '../../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { ScopeResolver } from '../../../src/core/ingestion/scope-resolution/contract/scope-resolver.js';

const CALLER_FILE = 'caller.src';
const TARGET_FILE = 'target.src';

const range = (line: number): Range => ({
  startLine: line,
  startCol: 2,
  endLine: line,
  endCol: 8,
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

/** `helper()` or `target::helper()`: the second form carries the written path. */
const site = (qualified: boolean): ReferenceSite => ({
  name: 'helper',
  atRange: range(3),
  inScope: 'scope:caller-mod',
  kind: 'call',
  callForm: 'free',
  arity: 0,
  ...(qualified ? { rawQualifiedName: 'target::helper' } : {}),
});

function mkScope(
  id: string,
  filePath: string,
  ownedDefs: SymbolDefinition[],
  lexicalNames?: ReadonlySet<string>,
): Scope {
  return {
    id,
    parent: null,
    kind: 'Module',
    range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
    filePath,
    bindings: new Map(),
    ownedDefs,
    imports: [],
    typeBindings: new Map(),
    ...(lexicalNames === undefined ? {} : { lexicalNames }),
  };
}

type Hook = NonNullable<ScopeResolver['resolveQualifiedFreeCall']>;

function run(reference: ReferenceSite, hook: Hook | undefined, claimed = true) {
  const callerScope = mkScope(
    'scope:caller-mod',
    CALLER_FILE,
    [callerDef],
    claimed ? new Set(['helper']) : undefined,
  );
  const targetScope = mkScope('scope:target-mod', TARGET_FILE, [targetDef]);
  const callerParsed: ParsedFile = {
    filePath: CALLER_FILE,
    moduleScope: 'scope:caller-mod',
    scopes: [callerScope],
    parsedImports: [],
    localDefs: [callerDef],
    referenceSites: [reference],
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
  for (const [id, name, filePath] of [
    ['fn:main', 'main', CALLER_FILE],
    ['fn:helper', 'helper', TARGET_FILE],
  ] as const) {
    graph.addNode({
      id,
      label: 'Function' as NodeLabel,
      properties: { name, filePath, qualifiedName: name },
    });
  }
  const bindings: Array<{ status: string; basis?: string }> = [];
  emitFreeCallFallback(
    graph,
    indexes,
    [callerParsed, targetParsed],
    buildGraphNodeLookup(graph),
    { bySourceScope: new Map() },
    new Set<string>(),
    createSemanticModel(),
    buildWorkspaceResolutionIndex([callerParsed, targetParsed]),
    {
      recordSourceBinding: (_site, binding) => bindings.push(binding),
      ...(hook === undefined ? {} : { resolveQualifiedFreeCall: hook }),
    },
  );
  return {
    calls: graph.relationships.filter((r) => r.type === 'CALLS'),
    bindings,
  };
}

const hitHook = (): { hook: Hook; calls: number } => {
  const state = { calls: 0 };
  const hook: Hook = () => {
    state.calls++;
    return targetDef;
  };
  return {
    hook,
    get calls() {
      return state.calls;
    },
  };
};

describe('the qualified hook outranks a lexical name claim', () => {
  it('control: a name claim blocks an unqualified call', () => {
    const { calls, bindings } = run(site(false), undefined);
    expect(calls).toHaveLength(0);
    expect(bindings.map((b) => b.basis)).toContain('lexical-name-claim');
  });

  it('a defined hit for a qualified site bypasses the block and emits the edge', () => {
    const probe = hitHook();
    const { calls, bindings } = run(site(true), probe.hook);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      targetId: 'fn:helper',
      confidence: 0.85,
      reason: 'import-resolved',
    });
    expect(bindings.map((b) => b.basis)).not.toContain('lexical-name-claim');
    expect(probe.calls).toBe(1);
  });

  it('an undefined hit leaves the block in place', () => {
    const { calls, bindings } = run(site(true), () => undefined);
    expect(calls).toHaveLength(0);
    expect(bindings.map((b) => b.basis)).toContain('lexical-name-claim');
  });

  it('a site with no written path never reaches the hook and stays blocked', () => {
    const probe = hitHook();
    const { calls } = run(site(false), probe.hook);
    expect(calls).toHaveLength(0);
    expect(probe.calls).toBe(0);
  });

  it('a language without the hook keeps the block for a qualified site', () => {
    const { calls } = run(site(true), undefined);
    expect(calls).toHaveLength(0);
  });

  it('without a name claim the hook still resolves the site, once', () => {
    const probe = hitHook();
    const { calls } = run(site(true), probe.hook, false);
    expect(calls).toHaveLength(1);
    expect(probe.calls).toBe(1);
  });
});
