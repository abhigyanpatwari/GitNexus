import type { BindingRef, Callsite, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import { elixirProvider } from '../elixir.js';
import {
  elixirFrameworkFacts,
  elixirImportExceptFacts,
  elixirImportOnlyFacts,
} from './import-filters.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import {
  findClassBindingInScope,
  resolveAmbiguousInheritanceBaseViaImports,
} from '../../scope-resolution/scope/walkers.js';
import { generateId } from '../../../../lib/utils.js';
import { routeNodeKey } from '../../route-extractors/route-path.js';
import { toZeroBasedLine } from '../../utils/line-base.js';

const CAPTURED_ALIAS_PREFIX = '@elixir-alias:';

function callableName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').at(-1) ?? def.qualifiedName ?? '';
}

const moduleFilesByWorkspace = new WeakMap<readonly ParsedFile[], ReadonlyMap<string, string>>();

function elixirModuleFiles(parsedFiles: readonly ParsedFile[]): ReadonlyMap<string, string> {
  const cached = moduleFilesByWorkspace.get(parsedFiles);
  if (cached) return cached;

  const candidates = new Map<string, Set<string>>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!def.qualifiedName || (def.type !== 'Class' && def.type !== 'Interface')) continue;
      const files = candidates.get(def.qualifiedName) ?? new Set<string>();
      files.add(parsed.filePath);
      candidates.set(def.qualifiedName, files);
    }
  }

  const unique = new Map<string, string>();
  for (const [name, files] of candidates) {
    if (files.size === 1) unique.set(name, [...files][0]!);
  }
  moduleFilesByWorkspace.set(parsedFiles, unique);
  return unique;
}

function importScope(
  parsed: ParsedFile,
  target: string,
  line: number,
  col: number,
): ScopeId | undefined {
  const candidates = parsed.parsedImports.filter(
    (imp) =>
      imp.kind === 'wildcard' && imp.targetRaw === target && imp.declaredAtScope !== undefined,
  );
  if (candidates.length === 1) return candidates[0]!.declaredAtScope;
  const scope = parsed.scopes
    .filter(
      (candidate) =>
        candidate.range.startLine <= line &&
        candidate.range.endLine >= line &&
        (candidate.range.startLine !== line || candidate.range.startCol <= col) &&
        (candidate.range.endLine !== line || candidate.range.endCol >= col),
    )
    .sort((a, b) => a.range.endLine - a.range.startLine - (b.range.endLine - b.range.startLine))[0];
  return scope?.id;
}

function populateElixirImportFilters(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  const byModule = new Map<string, ParsedFile[]>();
  for (const parsed of parsedFiles)
    for (const def of parsed.localDefs) {
      if ((def.type === 'Class' || def.type === 'Interface') && def.qualifiedName) {
        const files = byModule.get(def.qualifiedName) ?? [];
        if (!files.includes(parsed)) files.push(parsed);
        byModule.set(def.qualifiedName, files);
      }
    }
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
  for (const parsed of parsedFiles)
    for (const fact of [
      ...elixirImportExceptFacts(parsed).map((fact) => ({ ...fact, mode: 'except' as const })),
      ...elixirImportOnlyFacts(parsed).map((fact) => ({ ...fact, mode: 'only' as const })),
    ]) {
      const targets = byModule.get(fact.target);
      if (targets?.length !== 1) continue;
      const scopeId = importScope(parsed, fact.target, fact.startLine, fact.startCol);
      if (scopeId === undefined) continue;
      const selected = new Set(
        (fact.mode === 'except' ? fact.excluded : fact.allowed).map(
          ({ name, arity }) => `${name}/${arity}`,
        ),
      );
      const bucket = augmentations.get(scopeId) ?? new Map<string, BindingRef[]>();
      augmentations.set(scopeId, bucket);
      for (const def of targets[0]!.localDefs) {
        if ((def.type !== 'Function' && def.type !== 'Macro') || def.isExported === false) continue;
        if (fact.mode === 'only' && fact.category === 'functions' && def.type !== 'Function')
          continue;
        if (fact.mode === 'only' && fact.category === 'macros' && def.type !== 'Macro') continue;
        const name = callableName(def);
        if (
          !name ||
          (fact.mode === 'except'
            ? selected.has(`${name}/${def.parameterCount ?? 0}`)
            : fact.category === undefined && !selected.has(`${name}/${def.parameterCount ?? 0}`))
        )
          continue;
        const refs = bucket.get(name) ?? [];
        if (!refs.some((ref) => ref.def.nodeId === def.nodeId))
          refs.push({ def, origin: 'wildcard' });
        bucket.set(name, refs);
      }
    }
}

/** Resolve only capture-time verified lexical aliases, never inferred modules. */
function resolveElixirCapturedAliasMember(
  receiverName: string,
  memberName: string,
  _callerScope: ScopeId,
  _scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  callsite?: Callsite,
): SymbolDefinition | 'ambiguous' | undefined {
  if (!receiverName.startsWith(CAPTURED_ALIAS_PREFIX)) return undefined;
  const target = receiverName.slice(CAPTURED_ALIAS_PREFIX.length);
  const candidates = parsedFiles.flatMap((parsed) =>
    parsed.localDefs.filter(
      (def) =>
        def.type === 'Function' &&
        def.isExported !== false &&
        def.qualifiedName === `${target}.${memberName}` &&
        (callsite?.arity === undefined ||
          (callsite.arity >= (def.requiredParameterCount ?? def.parameterCount ?? 0) &&
            callsite.arity <= (def.parameterCount ?? 0))),
    ),
  );
  return candidates.length === 1 ? candidates[0] : candidates.length > 1 ? 'ambiguous' : undefined;
}

/** `defimpl P, for: T` is the one Elixir heritage form outside a module body. */
function emitElixirProtocolImplEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  scopes?: ScopeResolutionIndexes,
): void {
  if (!scopes) return;
  const emitted = new Set(
    [...graph.iterRelationshipsByType('IMPLEMENTS')].map(
      (rel) => `${rel.sourceId}->${rel.targetId}`,
    ),
  );
  for (const parsed of parsedFiles)
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'inherits' || !site.explicitReceiver?.name) continue;
      const implementation =
        findClassBindingInScope(site.inScope, site.explicitReceiver.name, scopes) ??
        resolveAmbiguousInheritanceBaseViaImports(site.inScope, site.explicitReceiver.name, scopes);
      const protocol =
        findClassBindingInScope(site.inScope, site.name, scopes) ??
        resolveAmbiguousInheritanceBaseViaImports(site.inScope, site.name, scopes);
      if (!implementation || !protocol || protocol.type !== 'Interface') continue;
      const sourceId = resolveDefGraphId(implementation.filePath, implementation, nodeLookup);
      const targetId = resolveDefGraphId(protocol.filePath, protocol, nodeLookup);
      if (!sourceId || !targetId || emitted.has(`${sourceId}->${targetId}`)) continue;
      emitted.add(`${sourceId}->${targetId}`);
      graph.addRelationship({
        id: generateId('IMPLEMENTS', `${sourceId}->${targetId}:elixir-protocol`),
        sourceId,
        targetId,
        type: 'IMPLEMENTS',
        confidence: 0.85,
        reason: 'elixir-protocol-impl',
      });
    }
}

/** Match public implementation functions to non-callable @callback contracts. */
function emitElixirBehaviourMethodEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  indexes: ScopeResolutionIndexes,
): void {
  const emitted = new Set(
    [...graph.iterRelationshipsByType('METHOD_IMPLEMENTS')].map(
      (rel) => `${rel.sourceId}->${rel.targetId}`,
    ),
  );
  for (const parsed of parsedFiles)
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'inherits') continue;
      const behaviours = parsedFiles.flatMap((file) =>
        file.localDefs.filter((def) => def.qualifiedName === site.name && def.type === 'Interface'),
      );
      let scope = indexes.scopeTree.getScope(site.inScope);
      let implementation: SymbolDefinition | undefined;
      while (scope) {
        implementation = scope.ownedDefs.find((def) => def.type === 'Class');
        if (implementation) break;
        scope = scope.parent ? indexes.scopeTree.getScope(scope.parent) : undefined;
      }
      if (behaviours.length !== 1 || !implementation) continue;
      const behaviour = behaviours[0]!;
      for (const contract of parsedFiles
        .flatMap((file) => file.localDefs)
        .filter(
          (def) =>
            def.filePath === behaviour.filePath &&
            def.type === 'Function' &&
            def.qualifiedName?.startsWith(`${behaviour.qualifiedName}.`),
        )) {
        const method = parsed.localDefs.filter(
          (def) =>
            def.type === 'Function' &&
            def.isExported !== false &&
            def.qualifiedName === `${implementation.qualifiedName}.${callableName(contract)}` &&
            def.parameterCount === contract.parameterCount,
        );
        if (method.length !== 1) continue;
        const sourceId = resolveDefGraphId(method[0]!.filePath, method[0]!, nodeLookup);
        const targetId = resolveDefGraphId(contract.filePath, contract, nodeLookup);
        if (!sourceId || !targetId || emitted.has(`${sourceId}->${targetId}`)) continue;
        emitted.add(`${sourceId}->${targetId}`);
        graph.addRelationship({
          id: generateId('METHOD_IMPLEMENTS', `${sourceId}->${targetId}:elixir-behaviour`),
          sourceId,
          targetId,
          type: 'METHOD_IMPLEMENTS',
          confidence: 0.9,
          reason: 'elixir-behaviour-callback',
        });
      }
    }
}

/** Materialize worker-captured literal Phoenix/Ecto facts only after all modules are known. */
function emitElixirFrameworkEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  const classDef = (name: string) => {
    const matches = parsedFiles.flatMap((file) =>
      file.localDefs.filter(
        (def) =>
          def.type === 'Class' &&
          (def.qualifiedName === name || def.qualifiedName?.split('.').at(-1) === name),
      ),
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const classId = (name: string) => {
    const def = classDef(name);
    return def ? resolveDefGraphId(def.filePath, def, nodeLookup) : undefined;
  };
  for (const parsed of parsedFiles)
    for (const fact of elixirFrameworkFacts(parsed)) {
      if (fact.kind === 'route') {
        const target = classDef(fact.handler);
        const handler =
          fact.action && target
            ? parsedFiles.flatMap((file) =>
                file.localDefs.filter(
                  (def) =>
                    def.type === 'Function' &&
                    def.qualifiedName === `${target.qualifiedName}.${fact.action}`,
                ),
              )
            : target
              ? [target]
              : [];
        const uniqueHandlers = [...new Map(handler.map((def) => [def.nodeId, def])).values()];
        if (uniqueHandlers.length !== 1) continue;
        const handlerId = resolveDefGraphId(
          uniqueHandlers[0]!.filePath,
          uniqueHandlers[0]!,
          nodeLookup,
        );
        if (!handlerId) continue;
        const key = routeNodeKey(fact.method, fact.path);
        const routeId = generateId('Route', key);
        const routeProperties = {
          filePath: uniqueHandlers[0]!.filePath,
          startLine: toZeroBasedLine(fact.line),
          endLine: toZeroBasedLine(fact.line),
          handlerSymbolId: handlerId,
          ...(fact.pipelines.length ? { middleware: [...fact.pipelines] } : {}),
        };
        const existingRoute = graph.getNode(routeId);
        if (existingRoute) Object.assign(existingRoute.properties, routeProperties);
        else
          graph.addNode({
            id: routeId,
            label: 'Route',
            properties: { name: fact.path, method: fact.method, ...routeProperties },
          });
        const fileId = generateId('File', uniqueHandlers[0]!.filePath);
        graph.addRelationship({
          id: generateId('HANDLES_ROUTE', `${fileId}->${routeId}`),
          sourceId: fileId,
          targetId: routeId,
          type: 'HANDLES_ROUTE',
          confidence: 1,
          reason: 'phoenix-router',
        });
        graph.addRelationship({
          id: generateId('HANDLES_ROUTE', `${handlerId}->${routeId}`),
          sourceId: handlerId,
          targetId: routeId,
          type: 'HANDLES_ROUTE',
          confidence: 1,
          reason: 'phoenix-router',
        });
      } else if (fact.kind === 'property') {
        const ownerId = classId(fact.model);
        if (!ownerId) continue;
        const propertyId = generateId('Property', `${parsed.filePath}:${fact.model}.${fact.name}`);
        if (!graph.getNode(propertyId))
          graph.addNode({
            id: propertyId,
            label: 'Property',
            properties: {
              name: fact.name,
              qualifiedName: `${fact.model}.${fact.name}`,
              filePath: parsed.filePath,
              startLine: toZeroBasedLine(fact.line),
              endLine: toZeroBasedLine(fact.line),
              language: SupportedLanguages.Elixir,
              elixirKind: fact.propertyKind,
            },
          });
        graph.addRelationship({
          id: generateId('HAS_PROPERTY', `${ownerId}->${propertyId}`),
          sourceId: ownerId,
          targetId: propertyId,
          type: 'HAS_PROPERTY',
          confidence: 1,
          reason: `ecto-${fact.propertyKind}`,
        });
        if (fact.target) {
          const targetId = classId(fact.target);
          if (targetId)
            graph.addRelationship({
              id: generateId('USES', `${ownerId}->${targetId}:ecto-${fact.propertyKind}`),
              sourceId: ownerId,
              targetId,
              type: 'USES',
              confidence: 0.9,
              reason: `ecto-${fact.propertyKind}`,
            });
        }
      } else if (fact.kind === 'query') {
        const modelId = classId(fact.model);
        if (!modelId) continue;
        const fileId = generateId('File', parsed.filePath);
        graph.addRelationship({
          id: generateId('QUERIES', `${fileId}->${modelId}:${fact.method}`),
          sourceId: fileId,
          targetId: modelId,
          type: 'QUERIES',
          confidence: 0.9,
          reason: `ecto-${fact.method}`,
        });
      }
    }
}

export const elixirScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Elixir,
  languageProvider: elixirProvider,
  importEdgeReason: 'elixir-scope: module declaration',
  resolveImportTarget: (raw, _from, _paths, _config, context) =>
    elixirModuleFiles(context?.parsedFiles ?? []).get(raw) ?? null,
  mergeBindings: (existing) => [...existing],
  importsBindAtLexicalScope: true,
  arityCompatibility: (callsite: Callsite, def: SymbolDefinition) => {
    if (callsite.arity === undefined || def.parameterCount === undefined) return 'unknown';
    return callsite.arity >= (def.requiredParameterCount ?? def.parameterCount) &&
      callsite.arity <= def.parameterCount
      ? 'compatible'
      : 'incompatible';
  },
  buildMro: () => new Map(),
  emitHeritageEdges: emitElixirProtocolImplEdges,
  populateOwners: (parsed) => populateClassOwnedMembers(parsed),
  isSuperReceiver: () => false,
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: false,
  resolveQualifiedReceiverMember: resolveElixirCapturedAliasMember,
  populateNamespaceSiblings: populateElixirImportFilters,
  emitPostResolutionEdges(graph, parsedFiles, nodeLookup, indexes) {
    emitElixirBehaviourMethodEdges(graph, parsedFiles, nodeLookup, indexes);
    emitElixirFrameworkEdges(graph, parsedFiles, nodeLookup);
  },
};
