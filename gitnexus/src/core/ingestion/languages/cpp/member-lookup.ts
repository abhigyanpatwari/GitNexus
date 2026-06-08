import type { ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import {
  isOverloadAmbiguousAfterNormalization,
  narrowOverloadCandidates,
} from '../../scope-resolution/passes/overload-narrowing.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { cppConstraintCompatibility } from './constraint-filter.js';
import { cppConversionRank } from './conversion-rank.js';

interface CapturedBaseEdge {
  readonly childName: string;
  readonly baseName: string;
  readonly isVirtual: boolean;
}

interface CapturedMemberUsing {
  readonly childName: string;
  readonly baseName: string;
  readonly memberName: string;
}

export interface CppMemberLookupSideChannel {
  readonly baseEdges: readonly CapturedBaseEdge[];
  readonly memberUsings: readonly CapturedMemberUsing[];
}

export type CppReceiverMemberResolution =
  | { readonly kind: 'resolved'; readonly definition: SymbolDefinition }
  | { readonly kind: 'ambiguous'; readonly candidateIds: readonly string[] };

const capturedByFile = new Map<string, CppMemberLookupSideChannel>();
let directParentsByDefId = new Map<string, readonly string[]>();
let virtualEdges = new Set<string>();
let memberUsingsByDefId = new Map<
  string,
  readonly { readonly baseDefId: string; readonly memberName: string }[]
>();

export function clearCppMemberLookupState(): void {
  capturedByFile.clear();
  directParentsByDefId = new Map();
  virtualEdges = new Set();
  memberUsingsByDefId = new Map();
}

export function captureCppMemberLookupFacts(root: SyntaxNode, filePath: string): void {
  const baseEdges: CapturedBaseEdge[] = [];
  const memberUsings: CapturedMemberUsing[] = [];
  const stack: SyntaxNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
      const childName = classNameOf(node);
      if (childName !== '') {
        const baseClause = directChildOfType(node, 'base_class_clause');
        if (baseClause !== null) captureBaseEdges(baseClause, childName, baseEdges);
        const body = directChildOfType(node, 'field_declaration_list');
        if (body !== null) {
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (child?.type !== 'using_declaration') continue;
            const parsed = parseMemberUsing(child, childName);
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
): CppReceiverMemberResolution | undefined {
  if (callsite.kind !== 'call') return undefined;
  const ownMethods = model.methods.lookupAllByOwner(ownerDef.nodeId, memberName);
  const introduced = memberUsingsByDefId
    .get(ownerDef.nodeId)
    ?.filter((entry) => entry.memberName === memberName);

  if (introduced !== undefined && introduced.length > 0) {
    const candidates = [...ownMethods];
    for (const entry of introduced) {
      candidates.push(...model.methods.lookupAllByOwner(entry.baseDefId, memberName));
    }
    return chooseOverload(candidates, callsite);
  }

  // Direct declarations hide every base declaration. Let the shared path
  // retain its existing overload/static filtering for this common case.
  if (ownMethods.length > 0) return undefined;

  const occurrences = collectInheritedOccurrences(
    ownerDef.nodeId,
    memberName,
    model,
    [],
    undefined,
    new Set(),
  );
  if (occurrences.length === 0) return undefined;

  const undominated = occurrences.filter(
    (candidate) =>
      !occurrences.some(
        (other) =>
          other.ownerDefId !== candidate.ownerDefId &&
          isAncestor(candidate.ownerDefId, other.ownerDefId),
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

  if (groups.size !== 1) {
    return {
      kind: 'ambiguous',
      candidateIds: [
        ...new Set(undominated.flatMap((entry) => entry.definitions.map((d) => d.nodeId))),
      ],
    };
  }

  return chooseOverload(groups.values().next().value?.[0]?.definitions ?? [], callsite);
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
): MemberOccurrence[] {
  if (active.has(ownerDefId)) return [];
  const nextActive = new Set(active);
  nextActive.add(ownerDefId);

  const definitions = model.methods.lookupAllByOwner(ownerDefId, memberName);
  if (definitions.length > 0) {
    return [{ ownerDefId, definitions, path, virtualAnchor }];
  }

  const introduced = memberUsingsByDefId
    .get(ownerDefId)
    ?.filter((entry) => entry.memberName === memberName);
  if (introduced !== undefined && introduced.length > 0) {
    const results: MemberOccurrence[] = [];
    for (const entry of introduced) {
      const imported = model.methods.lookupAllByOwner(entry.baseDefId, memberName);
      if (imported.length > 0) {
        results.push({
          ownerDefId: entry.baseDefId,
          definitions: imported,
          path,
          virtualAnchor,
        });
      }
    }
    if (results.length > 0) return results;
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
      ),
    );
  }
  return results;
}

function chooseOverload(
  candidates: readonly SymbolDefinition[],
  callsite: ReferenceSite,
): CppReceiverMemberResolution | undefined {
  if (candidates.length === 0) return undefined;
  const narrowed = narrowOverloadCandidates(candidates, callsite.arity, callsite.argumentTypes, {
    argumentTypeClasses: callsite.argumentTypeClasses,
    conversionRankFn: cppConversionRank,
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
      const key = `${parsed.filePath}\0${simpleName(def)}`;
      const bucket = defsByFileAndName.get(key);
      if (bucket === undefined) defsByFileAndName.set(key, [def]);
      else bucket.push(def);
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
      for (const child of defsByFileAndName.get(`${parsed.filePath}\0${edge.childName}`) ?? []) {
        const parent = (parents.get(child.nodeId) ?? [])
          .map((id) => defById.get(id))
          .find((def) => def !== undefined && simpleName(def) === edge.baseName);
        if (parent !== undefined) nextVirtualEdges.add(`${child.nodeId}\0${parent.nodeId}`);
      }
    }
    for (const using of captured.memberUsings) {
      for (const child of defsByFileAndName.get(`${parsed.filePath}\0${using.childName}`) ?? []) {
        const baseDefId = (parents.get(child.nodeId) ?? []).find((id) => {
          const def = defById.get(id);
          return def !== undefined && simpleName(def) === using.baseName;
        });
        if (baseDefId === undefined) continue;
        const bucket = nextUsings.get(child.nodeId);
        const entry = { baseDefId, memberName: using.memberName };
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
    const baseName = trailingIdentifier(child.text);
    if (baseName !== '') output.push({ childName, baseName, isVirtual });
  }
}

function parseMemberUsing(node: SyntaxNode, childName: string): CapturedMemberUsing | undefined {
  const qualified = node.namedChildren.find((child) => child.type === 'qualified_identifier');
  if (qualified === undefined) return undefined;
  const parts = qualified.text
    .split('::')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  const memberName = parts.at(-1) ?? '';
  const baseName = trailingIdentifier(parts.at(-2) ?? '');
  if (baseName === '' || memberName === '') return undefined;
  return { childName, baseName, memberName };
}

function classNameOf(node: SyntaxNode): string {
  const name = node.childForFieldName?.('name');
  return name === null || name === undefined ? '' : trailingIdentifier(name.text);
}

function directChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

function trailingIdentifier(value: string): string {
  const withoutTemplates = value.replace(/<.*>/g, '');
  return withoutTemplates.split('::').at(-1)?.trim() ?? '';
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').at(-1) ?? '';
}

function isAncestor(ancestorDefId: string, descendantDefId: string): boolean {
  const queue = [...(directParentsByDefId.get(descendantDefId) ?? [])];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === ancestorDefId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(directParentsByDefId.get(current) ?? []));
  }
  return false;
}
