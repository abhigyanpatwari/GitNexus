/**
 * Emit CALLS edges for free-call reference sites whose target is
 * imported (or otherwise visible only via post-finalize scope.bindings).
 *
 * The shared `MethodRegistry.lookup` only consults `scope.bindings`
 * (pre-finalize / local-only) for free calls. Cross-file imports land
 * in `indexes.bindings` (post-finalize). Without this fallback, every
 * `from x import f; f()` resolves to "unresolved".
 *
 * **Free-call dedup contract (Contract Invariant I2):** free calls
 * collapse to one CALLS edge per (caller, target) pair regardless of
 * how many call sites the caller contains. Mirrors the legacy DAG's
 * dedup semantics (what the `default-params` / `variadic` / `overload`
 * fixtures expect). Member calls keep position-based dedup elsewhere.
 *
 * Generic; promoted from `languages/python/scope-resolver.ts` per the scope-resolution
 * generalization plan.
 */

import type { ParsedFile, Reference, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { resolveCallerGraphId, resolveDefGraphId } from '../graph-bridge/ids.js';
import { findCallableBindingInScope, findClassBindingInScope } from '../scope/walkers.js';

export function emitFreeCallFallback(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  _referenceIndex: { readonly bySourceScope: ReadonlyMap<ScopeId, readonly Reference[]> },
  handledSites: Set<string>,
  workspaceIndex?: WorkspaceResolutionIndex,
): number {
  let emitted = 0;
  const seen = new Set<string>();

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call') continue;
      if (site.explicitReceiver !== undefined) continue;

      // Constructor form (`new User(...)`): resolve the class, then
      // emit CALLS to its explicit Constructor def (when present) or
      // to the Class node itself (implicit constructor). Legacy emits
      // the same two targets; see test expectations.
      let fnDef: SymbolDefinition | undefined;
      if (site.callForm === 'constructor') {
        const classDef = findClassBindingInScope(site.inScope, site.name, scopes);
        if (classDef !== undefined) {
          fnDef = pickConstructorOrClass(classDef, workspaceIndex);
        }
      }
      if (fnDef === undefined) {
        fnDef = findCallableBindingInScope(site.inScope, site.name, scopes);
      }
      if (fnDef === undefined) continue;

      const callerGraphId = resolveCallerGraphId(site.inScope, scopes, nodeLookup);
      if (callerGraphId === undefined) continue;
      const tgtGraphId = resolveDefGraphId(fnDef.filePath, fnDef, nodeLookup);
      if (tgtGraphId === undefined) continue;
      // Always mark the site as handled — even when the dedup-collapse
      // means we don't add a new edge — so `emit-references` skips its
      // potentially-wrong fallback for the same site.
      handledSites.add(`${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`);
      const relId = `rel:CALLS:${callerGraphId}->${tgtGraphId}`;
      if (seen.has(relId)) continue;
      seen.add(relId);
      graph.addRelationship({
        id: relId,
        sourceId: callerGraphId,
        targetId: tgtGraphId,
        type: 'CALLS',
        confidence: 0.85,
        // Match legacy DAG's reason convention so consumers that
        // assert `reason === 'import-resolved'` keep working.
        reason: fnDef.filePath !== parsed.filePath ? 'import-resolved' : 'local-call',
      });
      emitted++;
    }
  }
  return emitted;
}

/** For a constructor call `new X(...)`, return the X class's explicit
 *  Constructor def (by walking memberByOwner) or the Class def itself
 *  when no explicit Constructor exists. Matches legacy behavior —
 *  tests assert targetLabel === 'Class' for implicit ctors and
 *  targetLabel === 'Constructor' for explicit ones. */
function pickConstructorOrClass(
  classDef: SymbolDefinition,
  workspaceIndex: WorkspaceResolutionIndex | undefined,
): SymbolDefinition {
  if (workspaceIndex === undefined) return classDef;
  const members = workspaceIndex.memberByOwner.get(classDef.nodeId);
  if (members === undefined) return classDef;
  for (const [, def] of members) {
    if (def.type === 'Constructor') return def;
  }
  return classDef;
}
