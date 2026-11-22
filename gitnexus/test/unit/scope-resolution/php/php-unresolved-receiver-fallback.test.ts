/**
 * DART-11 — PHP's 0.6 unique-method-name fallback must respect a stopped
 * receiver walk.
 *
 * `phpEmitUnresolvedReceiverEdges` guesses an edge when a receiver has no type
 * and exactly one method in the workspace has the called name. "No type" used
 * to be the only condition, so a receiver whose NEAREST binder declares it
 * without a type — a binder that deliberately stopped the walk — still got a
 * name-only guess. The fallback now reads that stop itself.
 *
 * PHP publishes no `Scope.lexicalNames` today, so no PHP fixture can reach the
 * stop; this drives the emitter with a hand-built scope that does. The control
 * proves the same site is guessed when the scope does not bind the name.
 */
import { describe, expect, it } from 'vitest';
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
  type SymbolDefinition,
} from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { buildGraphNodeLookup } from '../../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { phpScopeResolver } from '../../../../src/core/ingestion/languages/php/scope-resolver.js';

const CALLER_FILE = 'caller.php';
const TARGET_FILE = 'models.php';
const range = (sl: number, sc: number, el = sl, ec = sc + 10): Range => ({
  startLine: sl,
  startCol: sc,
  endLine: el,
  endCol: ec,
});

const callerDef: SymbolDefinition = {
  nodeId: 'def:only_fallback',
  filePath: CALLER_FILE,
  type: 'Function',
  qualifiedName: 'only_fallback',
};
const targetDef: SymbolDefinition = {
  nodeId: 'def:OnlyFormat.formatOnly',
  filePath: TARGET_FILE,
  type: 'Method',
  qualifiedName: 'OnlyFormat.formatOnly',
  ownerId: 'def:OnlyFormat',
  parameterCount: 0,
  requiredParameterCount: 0,
};

/** `$date->formatOnly()` inside `only_fallback($date)`. */
const site: ReferenceSite = {
  name: 'formatOnly',
  atRange: range(4, 2),
  inScope: 'scope:fn',
  kind: 'call',
  callForm: 'member',
  arity: 0,
  explicitReceiver: { name: '$date' },
};

function run(fnExtra: Partial<Scope>) {
  const moduleScope: Scope = {
    id: 'scope:mod',
    parent: null,
    kind: 'Module',
    range: range(1, 0, 20, 0),
    filePath: CALLER_FILE,
    bindings: new Map(),
    ownedDefs: [],
    imports: [],
    typeBindings: new Map(),
  };
  const fnScope: Scope = {
    id: 'scope:fn',
    parent: 'scope:mod',
    kind: 'Function',
    range: range(3, 0, 5, 1),
    filePath: CALLER_FILE,
    bindings: new Map(),
    ownedDefs: [callerDef],
    imports: [],
    typeBindings: new Map(),
    ...fnExtra,
  };
  const targetModule: Scope = { ...moduleScope, id: 'scope:target', filePath: TARGET_FILE };
  const scopes = [moduleScope, fnScope, targetModule];
  const defs = [callerDef, targetDef];
  const parsed: ParsedFile = {
    filePath: CALLER_FILE,
    moduleScope: 'scope:mod',
    scopes: [moduleScope, fnScope],
    parsedImports: [],
    localDefs: [callerDef],
    referenceSites: [site],
  };
  const indexes = {
    scopeTree: buildScopeTree(scopes),
    defs: buildDefIndex(defs),
    qualifiedNames: buildQualifiedNameIndex(defs),
    moduleScopes: buildModuleScopeIndex([
      { filePath: CALLER_FILE, moduleScopeId: 'scope:mod' },
      { filePath: TARGET_FILE, moduleScopeId: 'scope:target' },
    ]),
    methodDispatch: buildMethodDispatchIndex({
      owners: [],
      computeMro: () => [],
      implementsOf: () => [],
    }),
    imports: createEagerImportVisibility(new Map()),
    bindings: new Map(),
    bindingAugmentations: new Map(),
    workspaceTypeBindings: new Map(),
    namespaceTypeBindings: new Map(),
    accessibleNamespacesByScope: new Map(),
  } as unknown as ScopeResolutionIndexes;
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: 'Function:caller.php:only_fallback',
    label: 'Function' as NodeLabel,
    properties: { name: 'only_fallback', filePath: CALLER_FILE, qualifiedName: 'only_fallback' },
  });
  graph.addNode({
    id: 'Method:models.php:OnlyFormat.formatOnly',
    label: 'Method' as NodeLabel,
    properties: {
      name: 'formatOnly',
      filePath: TARGET_FILE,
      qualifiedName: 'OnlyFormat.formatOnly',
    },
  });
  const model = {
    methods: {
      lookupMethodByName: (name: string) => (name === 'formatOnly' ? [targetDef] : []),
    },
  } as unknown as SemanticModel;
  const emit = phpScopeResolver.emitUnresolvedReceiverEdges;
  if (emit === undefined) throw new Error('PHP lost its unresolved-receiver fallback');
  const emitted = emit(
    graph,
    indexes,
    [parsed],
    buildGraphNodeLookup(graph),
    new Set<string>(),
    model,
  );
  return {
    emitted,
    calls: graph.relationships
      .filter((r) => r.type === 'CALLS')
      .map((r) => `${r.sourceId} -> ${r.targetId} ${r.confidence} ${r.reason}`),
  };
}

describe('PHP unresolved-receiver fallback — respects an untyped binder stop', () => {
  it('control: an unbound receiver with a workspace-unique method is guessed at 0.6', () => {
    expect(run({})).toEqual({
      emitted: 1,
      calls: [
        'Function:caller.php:only_fallback -> Method:models.php:OnlyFormat.formatOnly 0.6 php-unresolved-receiver-fallback',
      ],
    });
  });

  it('a receiver whose nearest binder declares it without a type is not guessed', () => {
    expect(run({ lexicalNames: new Set(['$date']) })).toEqual({ emitted: 0, calls: [] });
  });
});
