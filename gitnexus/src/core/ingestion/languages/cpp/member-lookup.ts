import type { ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ReceiverMemberResolution } from '../../scope-resolution/contract/scope-resolver.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import {
  isOverloadAmbiguousAfterNormalization,
  narrowOverloadCandidates,
} from '../../scope-resolution/passes/overload-narrowing.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { cppConstraintCompatibility } from './constraint-filter.js';
import { CPP_CONVERSION_ONLY_ARG_TYPE_PREFIXES, cppConversionRank } from './conversion-rank.js';

interface CapturedBaseEdge {
  readonly childName: string;
  readonly childQualifiedName?: string;
  readonly baseName: string;
  readonly baseQualifiedName?: string;
  readonly isVirtual: boolean;
}

interface CapturedMemberUsing {
  readonly childName: string;
  readonly childQualifiedName?: string;
  readonly baseName: string;
  readonly baseQualifiedName?: string;
  readonly memberName: string;
}

export interface CppMemberLookupSideChannel {
  readonly baseEdges: readonly CapturedBaseEdge[];
  readonly memberUsings: readonly CapturedMemberUsing[];
}

const capturedByFile = new Map<string, CppMemberLookupSideChannel>();
let directParentsByDefId = new Map<string, readonly string[]>();
let virtualEdges = new Set<string>();
let ancestorsByDefId = new Map<string, ReadonlySet<string>>();
let memberUsingsByDefId = new Map<
  string,
  readonly { readonly baseDefId: string; readonly memberName: string }[]
>();
let inheritedLookupCache = new Map<string, CachedInheritedLookup>();

const MAX_INHERITANCE_VISITS = 4096;

type CachedInheritedLookup =
  | { readonly kind: 'none' }
  | { readonly kind: 'candidates'; readonly definitions: readonly SymbolDefinition[] }
  | { readonly kind: 'ambiguous'; readonly candidateIds: readonly string[] };

export function clearCppMemberLookupState(): void {
  capturedByFile.clear();
  directParentsByDefId = new Map();
  virtualEdges = new Set();
  ancestorsByDefId = new Map();
  memberUsingsByDefId = new Map();
  inheritedLookupCache = new Map();
}

export function captureCppMemberLookupFacts(root: SyntaxNode, filePath: string): void {
  const baseEdges: CapturedBaseEdge[] = [];
  const memberUsings: CapturedMemberUsing[] = [];
  const stack: SyntaxNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
      const childName = classNameOf(node);
      const childQualifiedName = classQualifiedNameOf(node);
      if (childName !== '') {
        const baseClause = directChildOfType(node, 'base_class_clause');
        if (baseClause !== null) {
          captureBaseEdges(baseClause, childName, childQualifiedName, baseEdges);
        }
        const body = directChildOfType(node, 'field_declaration_list');
        if (body !== null) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child?.type !== 'using_declaration') continue;
            const parsed = parseMemberUsing(child, childName, childQualifiedName);
            if (parsed !== undefined) memberUsings.push(parsed);
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) stack.push(child);
    }
  }

  if (baseEdges.length === 0 && memberUsings.length === 0) {
    capturedByFile.delete(filePath);
  } else {
    capturedByFile.set(filePath, { baseEdges, memberUsings });
  }
}

export function collectCppMemberLookupSideChannel(filePath: string): CppMemberLookupSideChannel {
  return capturedByFile.get(filePath) ?? { baseEdges: [], memberUsings: [] };
}

export function applyCppMemberLookupSideChannel(
  filePath: string,
  data: CppMemberLookupSideChannel,
): void {
  if (!Array.isArray(data.baseEdges) || !Array.isArray(data.memberUsings)) return;
  if (data.baseEdges.length === 0 && data.memberUsings.length === 0) {
    capturedByFile.delete(filePath);
    return;
  }
  capturedByFile.set(filePath, {
    baseEdges: data.baseEdges.slice(),
    memberUsings: data.memberUsings.slice(),
  });
}

export function buildCppMemberLookupMro(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): Map<string, string[]> {
  populateResolvedHierarchy(graph, parsedFiles, nodeLookup);
  return buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);
}

export function resolveCppReceiverMember(
  ownerDef: SymbolDefinition,
  memberName: string,
  callsite: ReferenceSite,
  _scopes: ScopeResolutionIndexes,
  model: SemanticModel,
): ReceiverMemberResolution | undefined {
  if (callsite.kind !== 'call') return undefined;
  const ownMethods = model.methods.lookupAllByOwner(ownerDef.nodeId, memberName);
  const introduced = introducedDefinitions(ownerDef.nodeId, memberName, model);

  if (introduced.length > 0) {
    return chooseOverload(uniqueDefinitions([...ownMethods, ...introduced]), callsite);
  }

  // Direct declarations hide every base declaration. Let the shared path
  // retain its existing overload/static filtering for this common case.
  if (ownMethods.length > 0) return undefined;

  const lookup = inheritedLookupSet(ownerDef.nodeId, memberName, model);
  if (lookup.kind === 'none') return undefined;
  if (lookup.kind === 'ambiguous') return lookup;
  return chooseOverload(lookup.definitions, callsite);
}

interface MemberOccurrence {
  readonly ownerDefId: string;
  readonly definitions: readonly SymbolDefinition[];
  readonly path: readonly string[];
  readonly virtualAnchor?: string;
}

function collectInheritedOccurrences(
  ownerDefId: string,
  memberName: string,
  model: SemanticModel,
  path: readonly string[],
  virtualAnchor: string | undefined,
  active: Set<string>,
  budget: { remaining: number; truncated: boolean },
): MemberOccurrence[] {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }
  budget.remaining--;
  if (active.has(ownerDefId)) return [];
  const nextActive = new Set(active);
  nextActive.add(ownerDefId);

  const definitions = uniqueDefinitions([
    ...model.methods.lookupAllByOwner(ownerDefId, memberName),
    ...introducedDefinitions(ownerDefId, memberName, model),
  ]);
  if (definitions.length > 0) {
    return [{ ownerDefId, definitions, path, virtualAnchor }];
  }

  const results: MemberOccurrence[] = [];
  for (const parentDefId of directParentsByDefId.get(ownerDefId) ?? []) {
    const edgeKey = `${ownerDefId}\0${parentDefId}`;
    results.push(
      ...collectInheritedOccurrences(
        parentDefId,
        memberName,
        model,
        [...path, parentDefId],
        virtualEdges.has(edgeKey) ? parentDefId : virtualAnchor,
        nextActive,
        budget,
      ),
    );
  }
  return results;
}

function inheritedLookupSet(
  ownerDefId: string,
  memberName: string,
  model: SemanticModel,
): CachedInheritedLookup {
  const cacheKey = `${ownerDefId}\0${memberName}`;
  const cached = inheritedLookupCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const budget = { remaining: MAX_INHERITANCE_VISITS, truncated: false };
  const occurrences = collectInheritedOccurrences(
    ownerDefId,
    memberName,
    model,
    [],
    undefined,
    new Set(),
    budget,
  );
  if (budget.truncated) {
    const conservative: CachedInheritedLookup = {
      kind: 'ambiguous',
      candidateIds: uniqueDefinitions(occurrences.flatMap((entry) => entry.definitions)).map(
        (definition) => definition.nodeId,
      ),
    };
    inheritedLookupCache.set(cacheKey, conservative);
    return conservative;
  }
  if (occurrences.length === 0) {
    const none: CachedInheritedLookup = { kind: 'none' };
    inheritedLookupCache.set(cacheKey, none);
    return none;
  }

  // A declaration can dominate another lookup set only when the latter is
  // reached through a shared virtual subobject. Ordinary ancestry alone is
  // insufficient: declarations in one non-virtual branch do not hide members
  // reached through a sibling base subobject.
  const undominated = occurrences.filter(
    (candidate) =>
      !(
        candidate.virtualAnchor !== undefined &&
        occurrences.some(
          (other) =>
            other.ownerDefId !== candidate.ownerDefId &&
            isAncestor(candidate.ownerDefId, other.ownerDefId),
        )
      ),
  );
  const groups = new Map<string, MemberOccurrence[]>();
  for (const occurrence of undominated) {
    const key =
      occurrence.virtualAnchor !== undefined
        ? `virtual:${occurrence.virtualAnchor}:${occurrence.ownerDefId}`
        : `path:${occurrence.path.join('>')}:${occurrence.ownerDefId}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [occurrence]);
    else bucket.push(occurrence);
  }

  let result: CachedInheritedLookup;
  if (groups.size !== 1) {
    result = {
      kind: 'ambiguous',
      candidateIds: uniqueDefinitions(undominated.flatMap((entry) => entry.definitions)).map(
        (definition) => definition.nodeId,
      ),
    };
  } else {
    result = {
      kind: 'candidates',
      definitions: groups.values().next().value?.[0]?.definitions ?? [],
    };
  }
  inheritedLookupCache.set(cacheKey, result);
  return result;
}

function introducedDefinitions(
  ownerDefId: string,
  memberName: string,
  model: SemanticModel,
): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = [];
  for (const entry of memberUsingsByDefId.get(ownerDefId) ?? []) {
    if (entry.memberName !== memberName) continue;
    definitions.push(...model.methods.lookupAllByOwner(entry.baseDefId, memberName));
  }
  return definitions;
}

function uniqueDefinitions(definitions: readonly SymbolDefinition[]): SymbolDefinition[] {
  return [...new Map(definitions.map((definition) => [definition.nodeId, definition])).values()];
}

function chooseOverload(
  candidates: readonly SymbolDefinition[],
  callsite: ReferenceSite,
): ReceiverMemberResolution | undefined {
  if (candidates.length === 0) return undefined;
  const narrowed = narrowOverloadCandidates(candidates, callsite.arity, callsite.argumentTypes, {
    argumentTypeClasses: callsite.argumentTypeClasses,
    conversionRankFn: cppConversionRank,
    conversionOnlyArgTypePrefixes: CPP_CONVERSION_ONLY_ARG_TYPE_PREFIXES,
    constraintCompatibility: cppConstraintCompatibility,
  });
  if (narrowed.length === 1) return { kind: 'resolved', definition: narrowed[0]! };
  if (narrowed.length > 1 || isOverloadAmbiguousAfterNormalization(narrowed, callsite.arity)) {
    return {
      kind: 'ambiguous',
      candidateIds: narrowed.map((candidate) => candidate.nodeId),
    };
  }
  return undefined;
}

function populateResolvedHierarchy(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  const defByGraphId = new Map<string, SymbolDefinition>();
  const defById = new Map<string, SymbolDefinition>();
  const defsByFileAndName = new Map<string, SymbolDefinition[]>();

  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId === undefined) continue;
      defByGraphId.set(graphId, def);
      defById.set(def.nodeId, def);
      const names = new Set([simpleName(def), definitionQualifiedName(def)]);
      for (const name of names) {
        if (name === '') continue;
        const key = `${parsed.filePath}\0${name}`;
        const bucket = defsByFileAndName.get(key);
        if (bucket === undefined) defsByFileAndName.set(key, [def]);
        else bucket.push(def);
      }
    }
  }

  const parents = new Map<string, string[]>();
  for (const rel of graph.iterRelationshipsByType('EXTENDS')) {
    const child = defByGraphId.get(rel.sourceId);
    const parent = defByGraphId.get(rel.targetId);
    if (child === undefined || parent === undefined) continue;
    const bucket = parents.get(child.nodeId);
    if (bucket === undefined) parents.set(child.nodeId, [parent.nodeId]);
    else bucket.push(parent.nodeId);
  }
  directParentsByDefId = parents;
  ancestorsByDefId = buildAncestorClosure(parents);
  inheritedLookupCache = new Map();

  const nextVirtualEdges = new Set<string>();
  const nextUsings = new Map<
    string,
    { readonly baseDefId: string; readonly memberName: string }[]
  >();
  for (const parsed of parsedFiles) {
    const captured = capturedByFile.get(parsed.filePath);
    if (captured === undefined) continue;
    for (const edge of captured.baseEdges) {
      if (!edge.isVirtual) continue;
      for (const child of matchingChildren(
        parsed.filePath,
        edge.childName,
        edge.childQualifiedName,
        defsByFileAndName,
      )) {
        const parent = findCapturedParent(
          parents.get(child.nodeId) ?? [],
          edge.baseName,
          edge.baseQualifiedName,
          defById,
        );
        if (parent !== undefined) nextVirtualEdges.add(`${child.nodeId}\0${parent.nodeId}`);
      }
    }
    for (const using of captured.memberUsings) {
      const children = matchingChildren(
        parsed.filePath,
        using.childName,
        using.childQualifiedName,
        defsByFileAndName,
      );
      for (const child of children) {
        const baseDef = findCapturedParent(
          parents.get(child.nodeId) ?? [],
          using.baseName,
          using.baseQualifiedName,
          defById,
        );
        if (baseDef === undefined) continue;
        const bucket = nextUsings.get(child.nodeId);
        const entry = { baseDefId: baseDef.nodeId, memberName: using.memberName };
        if (bucket === undefined) nextUsings.set(child.nodeId, [entry]);
        else bucket.push(entry);
      }
    }
  }
  virtualEdges = nextVirtualEdges;
  memberUsingsByDefId = nextUsings;
}

function captureBaseEdges(
  baseClause: SyntaxNode,
  childName: string,
  childQualifiedName: string,
  output: CapturedBaseEdge[],
): void {
  let segmentStart = 0;
  for (let i = 0; i < baseClause.childCount; i++) {
    const child = baseClause.child(i);
    if (child === null) continue;
    if (child.type === ',' || child.text === ',') {
      segmentStart = i + 1;
      continue;
    }
    if (
      child.type !== 'type_identifier' &&
      child.type !== 'template_type' &&
      child.type !== 'qualified_identifier'
    ) {
      continue;
    }
    let isVirtual = false;
    for (let j = segmentStart; j < i; j++) {
      const modifier = baseClause.child(j);
      if (modifier?.text === 'virtual') isVirtual = true;
    }
    const baseQualifiedName = qualifiedTypeName(child.text);
    const baseName = baseQualifiedName.split('.').at(-1) ?? '';
    if (baseName !== '') {
      output.push({
        childName,
        ...(childQualifiedName !== childName ? { childQualifiedName } : {}),
        baseName,
        ...(baseQualifiedName !== baseName ? { baseQualifiedName } : {}),
        isVirtual,
      });
    }
  }
}

function parseMemberUsing(
  node: SyntaxNode,
  childName: string,
  childQualifiedName: string,
): CapturedMemberUsing | undefined {
  const qualified = node.namedChildren.find((child) => child.type === 'qualified_identifier');
  if (qualified === undefined) return undefined;
  const parts = splitQualifiedSegments(qualified.text);
  if (parts.length < 2) return undefined;
  const memberName = stripTemplateSuffix(parts.at(-1) ?? '');
  const baseParts = parts.slice(0, -1).map(stripTemplateSuffix).filter(Boolean);
  const baseName = baseParts.at(-1) ?? '';
  const baseQualifiedName = baseParts.join('.');
  if (baseName === '' || memberName === '') return undefined;
  return {
    childName,
    ...(childQualifiedName !== childName ? { childQualifiedName } : {}),
    baseName,
    ...(baseQualifiedName !== baseName ? { baseQualifiedName } : {}),
    memberName,
  };
}

function classNameOf(node: SyntaxNode): string {
  const name = node.childForFieldName?.('name');
  return name === null || name === undefined ? '' : trailingIdentifier(name.text);
}

function classQualifiedNameOf(node: SyntaxNode): string {
  const parts = [classNameOf(node)];
  let current = node.parent;
  while (current !== null) {
    if (current.type === 'class_specifier' || current.type === 'struct_specifier') {
      const name = classNameOf(current);
      if (name !== '') parts.unshift(name);
    } else if (current.type === 'namespace_definition') {
      const name = current.childForFieldName?.('name');
      if (name !== null && name !== undefined) {
        parts.unshift(
          ...splitQualifiedSegments(name.text).map(stripTemplateSuffix).filter(Boolean),
        );
      }
    }
    current = current.parent;
  }
  return parts.filter(Boolean).join('.');
}

function directChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

function trailingIdentifier(value: string): string {
  return stripTemplateSuffix(splitQualifiedSegments(value).at(-1) ?? '');
}

function qualifiedTypeName(value: string): string {
  return splitQualifiedSegments(value).map(stripTemplateSuffix).filter(Boolean).join('.');
}

function splitQualifiedSegments(value: string): string[] {
  const parts: string[] = [];
  let angleDepth = 0;
  let segmentStart = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '<') angleDepth++;
    else if (char === '>' && angleDepth > 0) angleDepth--;
    else if (char === ':' && value[i + 1] === ':' && angleDepth === 0) {
      const segment = value.slice(segmentStart, i).trim();
      if (segment !== '') parts.push(segment);
      segmentStart = i + 2;
      i++;
    }
  }
  const tail = value.slice(segmentStart).trim();
  if (tail !== '') parts.push(tail);
  return parts;
}

function stripTemplateSuffix(value: string): string {
  const templateStart = value.indexOf('<');
  return (templateStart >= 0 ? value.slice(0, templateStart) : value).trim();
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').at(-1) ?? '';
}

function definitionQualifiedName(def: SymbolDefinition): string {
  const name = def.qualifiedName ?? '';
  if (name === '' || def.namespacePrefix === undefined || def.namespacePrefix === '') return name;
  return name.startsWith(`${def.namespacePrefix}.`) ? name : `${def.namespacePrefix}.${name}`;
}

function matchingChildren(
  filePath: string,
  childName: string,
  childQualifiedName: string | undefined,
  defsByFileAndName: ReadonlyMap<string, readonly SymbolDefinition[]>,
): readonly SymbolDefinition[] {
  if (childQualifiedName !== undefined) {
    const qualified = defsByFileAndName.get(`${filePath}\0${childQualifiedName}`) ?? [];
    if (qualified.length > 0) return qualified;
  }
  const simple = defsByFileAndName.get(`${filePath}\0${childName}`) ?? [];
  return simple.length === 1 ? simple : [];
}

function findCapturedParent(
  parentIds: readonly string[],
  baseName: string,
  baseQualifiedName: string | undefined,
  defById: ReadonlyMap<string, SymbolDefinition>,
): SymbolDefinition | undefined {
  const candidates = parentIds
    .map((id) => defById.get(id))
    .filter((definition): definition is SymbolDefinition => definition !== undefined);
  if (baseQualifiedName !== undefined) {
    const qualified = candidates.filter((definition) => {
      const name = definitionQualifiedName(definition);
      return name === baseQualifiedName || name.endsWith(`.${baseQualifiedName}`);
    });
    if (qualified.length === 1) return qualified[0];
    return undefined;
  }
  const simple = candidates.filter((definition) => simpleName(definition) === baseName);
  return simple.length === 1 ? simple[0] : undefined;
}

function buildAncestorClosure(
  parents: ReadonlyMap<string, readonly string[]>,
): Map<string, ReadonlySet<string>> {
  const closure = new Map<string, ReadonlySet<string>>();
  const visiting = new Set<string>();

  const ancestorsOf = (defId: string): ReadonlySet<string> => {
    const cached = closure.get(defId);
    if (cached !== undefined) return cached;
    if (visiting.has(defId)) return new Set();
    visiting.add(defId);
    const ancestors = new Set<string>();
    for (const parent of parents.get(defId) ?? []) {
      ancestors.add(parent);
      for (const ancestor of ancestorsOf(parent)) ancestors.add(ancestor);
    }
    visiting.delete(defId);
    closure.set(defId, ancestors);
    return ancestors;
  };

  for (const defId of parents.keys()) ancestorsOf(defId);
  return closure;
}

function isAncestor(ancestorDefId: string, descendantDefId: string): boolean {
  return ancestorsByDefId.get(descendantDefId)?.has(ancestorDefId) === true;
}
