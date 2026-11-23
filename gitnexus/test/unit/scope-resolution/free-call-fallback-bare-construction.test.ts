/**
 * #3950: a language whose free call constructs (`constructionSyntax.bare`,
 * Python `Plain(1)`) links a bare call bound to exactly one class to that
 * Class. Without the flag, or when the name binds several classes, the call
 * still emits no edge.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  createEagerImportVisibility,
  type NodeLabel,
  type ParsedFile,
  type Range,
  type ReferenceSite,
  type Scope,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';
import { buildGraphNodeLookup } from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { emitFreeCallFallback } from '../../../src/core/ingestion/scope-resolution/passes/free-call-fallback.js';
import { buildWorkspaceResolutionIndex } from '../../../src/core/ingestion/scope-resolution/workspace-index.js';
import { createSemanticModel } from '../../../src/core/ingestion/model/semantic-model.js';
import type { SourceBindingResolution } from '../../../src/core/ingestion/scope-resolution/source-binding-resolution.js';

const CALLER_FILE = 'core.py';

const range = (sl: number, sc: number, el = sl, ec = sc + 6): Range => ({
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

const callerDef: SymbolDefinition = {
  nodeId: 'def:make_plain',
  filePath: CALLER_FILE,
  type: 'Function',
  qualifiedName: 'make_plain',
};

const classIn = (filePath: string): SymbolDefinition => ({
  nodeId: `def:${filePath}:Plain`,
  filePath,
  type: 'Class',
  qualifiedName: 'Plain',
});

/** `Plain(1)` — an ordinary free call, not a `new`-form constructor site. */
const site: ReferenceSite = {
  name: 'Plain',
  atRange: range(3, 11),
  inScope: 'scope:caller-mod',
  kind: 'call',
  callForm: 'free',
  arity: 1,
};

function mkScope(id: ScopeId, filePath: string, ownedDefs: SymbolDefinition[]): Scope {
  return {
    id,
    parent: null,
    kind: 'Module',
    range: range(1, 0, 100, 0),
    filePath,
    bindings: new Map(),
    ownedDefs,
    imports: [],
    typeBindings: new Map(),
  };
}

function run(classes: readonly SymbolDefinition[], bareCallConstructs: boolean) {
  const callerScope: Scope = {
    ...mkScope('scope:caller-mod', CALLER_FILE, [callerDef]),
    bindings: new Map([['Plain', classes.map((def) => ({ def, origin: 'import' as const }))]]),
  };
  const targetScopes = classes.map((def, i) => mkScope(`scope:target-${i}`, def.filePath, [def]));
  const parsedOf = (scope: Scope, sites: readonly ReferenceSite[]): ParsedFile => ({
    filePath: scope.filePath,
    moduleScope: scope.id,
    scopes: [scope],
    parsedImports: [],
    localDefs: scope.ownedDefs,
    referenceSites: sites,
  });
  const parsedFiles = [
    parsedOf(callerScope, [site]),
    ...targetScopes.map((scope) => parsedOf(scope, [])),
  ];
  const scopes = [callerScope, ...targetScopes];
  const allDefs = [callerDef, ...classes];
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
    imports: createEagerImportVisibility(new Map()),
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
      totalFiles: parsedFiles.length,
      totalEdges: 0,
      linkedEdges: 0,
      unresolvedEdges: 0,
      sccCount: 0,
      largestSccSize: 0,
      ambiguousWildcardExports: [],
    },
  } as unknown as ScopeResolutionIndexes;
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'fn:make_plain',
    label: 'Function' as NodeLabel,
    properties: { name: 'make_plain', filePath: CALLER_FILE, qualifiedName: 'make_plain' },
  });
  for (const def of classes) {
    graph.addNode({
      id: `cls:${def.filePath}:Plain`,
      label: 'Class' as NodeLabel,
      properties: { name: 'Plain', filePath: def.filePath, qualifiedName: 'Plain' },
    });
  }
  const bindings: SourceBindingResolution[] = [];
  emitFreeCallFallback(
    graph,
    indexes,
    parsedFiles,
    buildGraphNodeLookup(graph),
    { bySourceScope: new Map() },
    new Set<string>(),
    createSemanticModel(),
    buildWorkspaceResolutionIndex(parsedFiles),
    {
      bareCallConstructs,
      recordSourceBinding: (_site, binding) => bindings.push(binding),
    },
  );
  const calls = graph.relationships
    .filter((r) => r.type === 'CALLS')
    .map((r) => ({ targetId: r.targetId, confidence: r.confidence, reason: r.reason }));
  return { calls, finalBinding: bindings.at(-1) };
}

describe('bare-call construction links a free call to its one bound class (#3950)', () => {
  it('emits no edge when the language does not construct with a bare call', () => {
    const { calls, finalBinding } = run([classIn('models.py')], false);
    expect(calls).toEqual([]);
    expect(finalBinding).toMatchObject({ status: 'resolved', basis: 'construction' });
  });

  it('links the call to the Class and records a construction binding', () => {
    const { calls, finalBinding } = run([classIn('models.py')], true);
    expect(calls).toEqual([
      { targetId: 'cls:models.py:Plain', confidence: 0.85, reason: 'import-resolved' },
    ]);
    expect(finalBinding).toMatchObject({
      status: 'resolved',
      targetDefIds: ['def:models.py:Plain'],
      basis: 'construction',
    });
  });

  it('emits no edge when the name binds two classes', () => {
    const { calls, finalBinding } = run([classIn('a.py'), classIn('b.py')], true);
    expect(calls).toEqual([]);
    expect(finalBinding).toMatchObject({
      status: 'ambiguous',
      targetDefIds: ['def:a.py:Plain', 'def:b.py:Plain'],
      basis: 'construction',
    });
  });
});
