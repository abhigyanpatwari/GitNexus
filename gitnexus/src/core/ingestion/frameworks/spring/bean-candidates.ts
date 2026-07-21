import type { Capture, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { makeScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { isClassLike, lookupBindingsAt } from '../../scope-resolution/scope/walkers.js';
import { SPRING_BEAN_STEREOTYPES } from './bean-catalog.js';

export interface ClassAnnotationFact {
  readonly classScopeId: ScopeId;
  readonly annotationNames: readonly string[];
}

export interface ClassAnnotationFactStore {
  clear(): void;
  set(filePath: string, facts: readonly ClassAnnotationFact[]): void;
  get(filePath: string): readonly ClassAnnotationFact[];
}

/** Per-language store for capture facts that cross the worker boundary. */
export function createClassAnnotationFactStore(): ClassAnnotationFactStore {
  const factsByFile = new Map<string, readonly ClassAnnotationFact[]>();
  return {
    clear: () => factsByFile.clear(),
    set: (filePath, facts) => {
      if (facts.length === 0) factsByFile.delete(filePath);
      else factsByFile.set(filePath, facts);
    },
    get: (filePath) => factsByFile.get(filePath) ?? [],
  };
}

/** Record one annotation from the language's existing scope-query traversal. */
export function recordClassAnnotationCapture(
  facts: Map<ScopeId, Set<string>>,
  filePath: string,
  classCapture: Pick<Capture, 'range'>,
  annotationName: string,
): void {
  const classScopeId = makeScopeId({ filePath, range: classCapture.range, kind: 'Class' });
  const names = facts.get(classScopeId) ?? new Set<string>();
  names.add(annotationName.trim());
  facts.set(classScopeId, names);
}

export function materializeClassAnnotationFacts(
  facts: ReadonlyMap<ScopeId, ReadonlySet<string>>,
): readonly ClassAnnotationFact[] {
  return [...facts].map(([classScopeId, annotationNames]) => ({
    classScopeId,
    annotationNames: [...annotationNames],
  }));
}

export interface SpringBeanCandidateAdapter {
  getClassAnnotationFacts(filePath: string): readonly ClassAnnotationFact[];
  isPackageVisibilityIncomplete(filePath: string): boolean;
}

type OwnedTypeNamesByOwner = ReadonlyMap<string, ReadonlySet<string>>;

function simpleNameOf(def: SymbolDefinition): string | undefined {
  const qualifiedName = def.qualifiedName;
  if (qualifiedName === undefined) return undefined;
  const separator = qualifiedName.lastIndexOf('.');
  return separator === -1 ? qualifiedName : qualifiedName.slice(separator + 1);
}

function buildOwnedTypeNamesByOwner(indexes: ScopeResolutionIndexes): OwnedTypeNamesByOwner {
  const namesByOwner = new Map<string, Set<string>>();
  for (const def of indexes.defs.byId.values()) {
    if (def.ownerId === undefined) continue;
    if (!isClassLike(def.type) && def.type !== 'Annotation') continue;
    const simpleName = simpleNameOf(def);
    if (simpleName === undefined) continue;
    const names = namesByOwner.get(def.ownerId) ?? new Set<string>();
    names.add(simpleName);
    namesByOwner.set(def.ownerId, names);
  }
  return namesByOwner;
}

function hasLexicalTypeDeclaration(
  startScope: ScopeId | null,
  simpleName: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  let scopeId = startScope;
  const visited = new Set<ScopeId>();
  while (scopeId !== null && !visited.has(scopeId)) {
    visited.add(scopeId);
    const scope = indexes.scopeTree.getScope(scopeId);
    if (scope === undefined) return false;
    const locals = scope.bindings.get(simpleName);
    if (locals?.some(({ def }) => isClassLike(def.type) || def.type === 'Annotation')) return true;
    scopeId = scope.parent;
  }
  return false;
}

function explicitImportTargets(parsed: ParsedFile, simpleName: string): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const entry of parsed.parsedImports) {
    if (entry.kind !== 'named' && entry.kind !== 'alias') continue;
    if (entry.localName !== simpleName) continue;
    targets.add(entry.targetRaw);
  }
  return targets;
}

function hasInheritedTypeDeclaration(
  startScope: ScopeId | null,
  simpleName: string,
  indexes: ScopeResolutionIndexes,
  ownedTypeNamesByOwner: OwnedTypeNamesByOwner,
): boolean {
  let scopeId = startScope;
  const visited = new Set<ScopeId>();
  while (scopeId !== null && !visited.has(scopeId)) {
    visited.add(scopeId);
    const scope = indexes.scopeTree.getScope(scopeId);
    if (scope === undefined) return false;
    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((def) => isClassLike(def.type));
      if (classDef !== undefined) {
        for (const ancestorId of indexes.methodDispatch.mroFor(classDef.nodeId)) {
          if (ownedTypeNamesByOwner.get(ancestorId)?.has(simpleName) === true) return true;
        }
      }
    }
    scopeId = scope.parent;
  }
  return false;
}

function hasVisibleTypeBinding(
  startScope: ScopeId | null,
  simpleName: string,
  indexes: ScopeResolutionIndexes,
): boolean {
  let scopeId = startScope;
  const visited = new Set<ScopeId>();
  while (scopeId !== null && !visited.has(scopeId)) {
    visited.add(scopeId);
    const scope = indexes.scopeTree.getScope(scopeId);
    if (scope === undefined) return false;
    const visible = lookupBindingsAt(scopeId, simpleName, indexes);
    if (visible.some(({ def }) => isClassLike(def.type) || def.type === 'Annotation')) return true;
    scopeId = scope.parent;
  }
  return false;
}

function wildcardImportTarget(parsed: ParsedFile, simpleName: string): string | undefined {
  const wildcardPackages = new Set(
    parsed.parsedImports
      .filter((entry) => entry.kind === 'wildcard')
      .map((entry) => entry.targetRaw.replace(/\.\*$/, '')),
  );
  if (wildcardPackages.size !== 1) return undefined;
  const [packageName] = wildcardPackages;
  const target = `${packageName}.${simpleName}`;
  return SPRING_BEAN_STEREOTYPES.has(target) ? target : undefined;
}

function resolveSpringAnnotation(
  rawName: string,
  parsed: ParsedFile,
  enclosingScope: ScopeId | null,
  indexes: ScopeResolutionIndexes,
  ownedTypeNamesByOwner: OwnedTypeNamesByOwner,
  isPackageVisibilityIncomplete: boolean,
): string | undefined {
  if (rawName.includes('.')) {
    return SPRING_BEAN_STEREOTYPES.has(rawName) ? rawName : undefined;
  }

  if (hasLexicalTypeDeclaration(enclosingScope, rawName, indexes)) return undefined;
  if (hasInheritedTypeDeclaration(enclosingScope, rawName, indexes, ownedTypeNamesByOwner)) {
    return undefined;
  }

  const explicitImports = explicitImportTargets(parsed, rawName);
  if (explicitImports.size > 0) {
    if (explicitImports.size !== 1) return undefined;
    const [imported] = explicitImports;
    return SPRING_BEAN_STEREOTYPES.has(imported) ? imported : undefined;
  }

  const wildcardTarget = wildcardImportTarget(parsed, rawName);
  if (wildcardTarget === undefined || isPackageVisibilityIncomplete) return undefined;

  return hasVisibleTypeBinding(enclosingScope, rawName, indexes) ? undefined : wildcardTarget;
}

/** Build a language hook that enriches Class nodes after scope resolution. */
export function createSpringBeanCandidateAttacher(adapter: SpringBeanCandidateAdapter) {
  return (
    graph: KnowledgeGraph,
    parsedFiles: readonly ParsedFile[],
    nodeLookup: GraphNodeLookup,
    indexes: ScopeResolutionIndexes,
  ): void => {
    const ownedTypeNamesByOwner = buildOwnedTypeNamesByOwner(indexes);
    for (const parsed of parsedFiles) {
      for (const fact of adapter.getClassAnnotationFacts(parsed.filePath)) {
        const classScope = indexes.scopeTree.getScope(fact.classScopeId);
        if (classScope === undefined || classScope.kind !== 'Class') continue;
        const classDef = classScope.ownedDefs.find((def) => def.type === 'Class');
        if (classDef === undefined) continue;

        const graphId = resolveDefGraphId(parsed.filePath, classDef, nodeLookup);
        if (graphId === undefined) continue;
        const classNode = graph.getNode(graphId);
        if (classNode === undefined || classNode.label !== 'Class') continue;

        const recognized = new Set<string>();
        for (const rawName of fact.annotationNames) {
          const annotation = resolveSpringAnnotation(
            rawName,
            parsed,
            classScope.parent,
            indexes,
            ownedTypeNamesByOwner,
            adapter.isPackageVisibilityIncomplete(parsed.filePath),
          );
          if (annotation !== undefined) recognized.add(annotation);
        }

        if (recognized.size === 1) {
          classNode.properties.frameworkAnnotations = [...recognized];
        }
      }
    }
  };
}
