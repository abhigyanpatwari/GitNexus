import { graphRenameFamily as proveRenameFamily, type RenameFamilyPolicy } from 'gitnexus-shared';
export type { RenameFamilyPolicy } from 'gitnexus-shared';
import type { SymbolDefinition } from 'gitnexus-shared';
import type { RenameIssue, RenameSemanticContext } from '../rename-provider.js';
import { buildGraphNodeLookup } from '../scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../scope-resolution/graph-bridge/ids.js';
import { findEnclosingClassDef } from '../scope-resolution/scope/walkers.js';

/** Follow explicit method identity edges; an owner hierarchy alone never proves an override. */
export function graphRenameFamily(
  context: RenameSemanticContext,
  policy: RenameFamilyPolicy,
): readonly SymbolDefinition[] | RenameIssue {
  const { definitions, target, graph, indexes } = context;
  // A missing base cannot prove the absence of an override. Preserve the
  // unresolved heritage facts, including those on a transitively indexed base.
  const incompleteOwners = new Set<string>();
  const derivedOwners = new Map<string, string[]>();
  for (const site of indexes.referenceSites) {
    if (site.kind !== 'inherits') continue;
    const owner = findEnclosingClassDef(site.inScope, indexes);
    if (!owner) continue;
    const binding = context.referenceBindings.get(site);
    if (binding?.status !== 'resolved' || binding.targetDefIds.length !== 1) {
      incompleteOwners.add(owner.nodeId);
      continue;
    }
    const baseId = binding.targetDefIds[0]!;
    const derived = derivedOwners.get(baseId) ?? [];
    derived.push(owner.nodeId);
    derivedOwners.set(baseId, derived);
  }
  for (const ownerId of incompleteOwners) {
    for (const derivedId of derivedOwners.get(ownerId) ?? []) incompleteOwners.add(derivedId);
  }
  const lookup = buildGraphNodeLookup(graph);
  const graphDefs = new Map<string, SymbolDefinition[]>();
  for (const def of definitions) {
    const graphId = resolveDefGraphId(def.filePath, def, lookup);
    if (!graphId) continue;
    graphDefs.set(graphId, [...(graphDefs.get(graphId) ?? []), def]);
  }
  return proveRenameFamily(
    {
      target,
      definitions,
      graphDefs,
      relationships: graph.iterRelationships(),
      incompleteOwners,
      methodDispatch: indexes.methodDispatch,
    },
    policy,
  );
}
