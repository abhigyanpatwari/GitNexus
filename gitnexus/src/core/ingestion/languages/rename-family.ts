import type { SymbolDefinition } from 'gitnexus-shared';
import type { RenameIssue, RenameSemanticContext } from '../rename-provider.js';
import { buildGraphNodeLookup } from '../scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../scope-resolution/graph-bridge/ids.js';

export interface RenameFamilyPolicy {
  /** A possible language-level coupling; absence of proof for this pair refuses. */
  readonly matches: (left: SymbolDefinition, right: SymbolDefinition) => boolean;
  /** Validate provider syntax (visibility, staticness, signature) for a graph pair. */
  readonly canCouple?: (left: SymbolDefinition, right: SymbolDefinition) => boolean;
  /** Multiple declarations of one symbol, established by the provider. */
  readonly sameDeclarationGroup?: (left: SymbolDefinition, right: SymbolDefinition) => boolean;
}

/** Follow explicit method identity edges; an owner hierarchy alone never proves an override. */
export function graphRenameFamily(
  context: RenameSemanticContext,
  policy: RenameFamilyPolicy,
): readonly SymbolDefinition[] | RenameIssue {
  const { definitions, target, graph, indexes } = context;
  const lookup = buildGraphNodeLookup(graph);
  const graphDefs = new Map<string, SymbolDefinition[]>();
  for (const def of definitions) {
    const graphId = resolveDefGraphId(def.filePath, def, lookup);
    if (!graphId) continue;
    graphDefs.set(graphId, [...(graphDefs.get(graphId) ?? []), def]);
  }
  const pairs: Array<readonly [SymbolDefinition, SymbolDefinition]> = [];
  const uncertain = new Set<string>();
  for (const edge of graph.iterRelationships()) {
    if (edge.type !== 'METHOD_OVERRIDES' && edge.type !== 'METHOD_IMPLEMENTS') continue;
    const targets = graphDefs.get(edge.targetId) ?? [];
    const sources = graphDefs.get(edge.sourceId) ?? [];
    for (const destination of targets) {
      const direct = sources.filter((source) => policy.matches(source, destination));
      // Override edges can originate at an owning class. Resolve that endpoint
      // to exactly one written declaration, never to the first same-name method.
      const candidates = direct.length
        ? direct
        : definitions.filter(
            (def) =>
              sources.some((owner) => def.ownerId === owner.nodeId) &&
              policy.matches(def, destination),
          );
      if (
        candidates.length !== 1 ||
        (policy.canCouple && !policy.canCouple(candidates[0]!, destination))
      ) {
        uncertain.add(destination.nodeId);
        for (const candidate of candidates) uncertain.add(candidate.nodeId);
        continue;
      }
      pairs.push([candidates[0]!, destination]);
    }
  }
  const selected = new Map([[target.nodeId, target]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of pairs) {
      if (selected.has(left.nodeId) === selected.has(right.nodeId)) continue;
      selected.set(left.nodeId, left);
      selected.set(right.nodeId, right);
      changed = true;
    }
    if (policy.sameDeclarationGroup) {
      for (const def of definitions) {
        if (selected.has(def.nodeId)) continue;
        if ([...selected.values()].some((member) => policy.sameDeclarationGroup!(member, def))) {
          selected.set(def.nodeId, def);
          changed = true;
        }
      }
    }
  }
  const relatedOwners = (left: string, right: string) =>
    left === right ||
    indexes.methodDispatch.mroFor(left).includes(right) ||
    indexes.methodDispatch.mroFor(right).includes(left) ||
    indexes.methodDispatch.implementorsOf(left).includes(right) ||
    indexes.methodDispatch.implementorsOf(right).includes(left);
  for (const member of selected.values()) {
    if (uncertain.has(member.nodeId)) return incompleteFamily();
    if (!member.ownerId) continue;
    for (const candidate of definitions) {
      if (
        selected.has(candidate.nodeId) ||
        !candidate.ownerId ||
        !policy.matches(member, candidate)
      )
        continue;
      if (relatedOwners(member.ownerId, candidate.ownerId)) return incompleteFamily();
    }
  }
  return [...selected.values()];
}

function incompleteFamily(): RenameIssue {
  return {
    code: 'unsupported_symbol_family',
    status: 'unsupported',
    message: 'The semantic graph does not prove a complete declaration and override family.',
  };
}
