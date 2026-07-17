/**
 * `emitPropertyDispatchCalls` — value-ref registration edges + field-based
 * dispatch for functions registered as object-literal property values
 * (#2437).
 *
 * A provider-hook registration (`{ emitScopeCaptures: emitCppScopeCaptures }`)
 * emits a USES reference edge — a registration is not an invocation (Kythe
 * `ref` vs `ref/call`; Joern `METHOD_REF`). The invocation happens later
 * through the property (`provider.emitScopeCaptures(...)`) — a dispatch the
 * receiver-bound pass cannot resolve because object literals are not
 * IMPLEMENTS-linked implementors. This pass closes that soundness gap the
 * field-based way (Feldthaus et al., ICSE'13; CodeQL `impliedReceiverStep`):
 * key registrations by property name and connect every member-call site
 * `x.<key>(...)` to every function registered under `<key>`.
 *
 * This pass is the SINGLE owner of `value-ref` resolution. The shared
 * registries only consult pre-finalize local bindings — imported names live
 * in finalized bindings (the same reason free calls need
 * `emitFreeCallFallback`) — so `resolveReferenceSites` skips `value-ref`
 * sites and this pass resolves them post-finalize via
 * `findCallableBindingInScope` (Function/Method/Constructor only — the
 * callable gate that keeps `{ port: DEFAULT_PORT }` from emitting anything).
 *
 * Precision posture (mirrors `emitInterfaceDispatchFor`):
 *   - reason `'property-dispatch'` keeps synthesized CALLS auditable;
 *   - dispatch confidence 0.7 sits below the 0.85 resolved baseline;
 *   - a per-key fan-out cap drops promiscuous names (`handler`, `callback`)
 *     entirely rather than truncating silently — property-name collisions
 *     across unrelated objects are the documented field-based failure mode.
 *
 * Ordering: runs AFTER the precise emit passes. `graph.addRelationship` is
 * first-write-wins on the position-keyed edge id, so a site that already
 * resolved precisely to the same target keeps its precise edge.
 *
 * Language-neutral: consumes only `value-ref` sites (any language that
 * emits the capture participates) and generic member-call sites.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { tryEmitEdge, type CalleeIdCaptureCtx } from '../graph-bridge/edges.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { CalleeIdSink } from '../graph-bridge/callee-id-sink.js';
import { findCallableBindingInScope } from '../scope/walkers.js';

/**
 * Keys registered by more than this many distinct functions are skipped —
 * dispatch through such a name says nothing about which function runs.
 * Calibrated on this repo's own provider tables: `emitScopeCaptures` has 16
 * legitimate registrations (one per language provider), so the cap sits at
 * 2× that — dropping the motivating key was the failure the first value (8)
 * had. ponytail: flat cap; revisit with per-receiver narrowing if real
 * repos show useful keys being dropped (§12 of the #2437 plan).
 */
export const MAX_PROPERTY_DISPATCH_FANOUT = 32;

/** Below the 0.85 resolved baseline; same discount idea as interface-dispatch. */
export const PROPERTY_DISPATCH_CONFIDENCE = 0.7;

export function emitPropertyDispatchCalls(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  calleeIdSink?: CalleeIdSink,
): {
  usesEmitted: number;
  callsEmitted: number;
  skippedKeys: number;
  skippedKeyNames: readonly string[];
} {
  const seen = new Set<string>();
  let usesEmitted = 0;

  // Sweep 1 — resolve every value-ref site: emit the USES registration edge
  // and index dispatchable registrations by property key.
  const registrations = new Map<string, Map<string, SymbolDefinition>>();
  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'value-ref') continue;
      const def = findCallableBindingInScope(site.inScope, site.name, scopes);
      if (def === undefined) continue;

      const ok = tryEmitEdge(
        graph,
        scopes,
        nodeLookup,
        site,
        def,
        'scope-resolution: value-ref',
        seen,
      );
      if (ok) usesEmitted++;

      if (site.propertyKey === undefined) continue;
      let byDef = registrations.get(site.propertyKey);
      if (byDef === undefined) {
        byDef = new Map<string, SymbolDefinition>();
        registrations.set(site.propertyKey, byDef);
      }
      byDef.set(def.nodeId, def);
    }
  }

  // Keep the dropped key NAMES (bounded) — an over-cap key means no CALLS
  // are synthesized through it, and a count alone leaves the operator unable
  // to tell WHICH hook table lost coverage (#2522 review).
  let skippedKeys = 0;
  const skippedKeyNames: string[] = [];
  for (const [key, defs] of registrations) {
    if (defs.size > MAX_PROPERTY_DISPATCH_FANOUT) {
      registrations.delete(key);
      skippedKeys++;
      if (skippedKeyNames.length < 20) skippedKeyNames.push(key);
    }
  }

  // Sweep 2 — synthesize CALLS from member-call sites through registered keys.
  let callsEmitted = 0;
  if (registrations.size > 0) {
    for (const parsed of parsedFiles) {
      const calleeCapture: CalleeIdCaptureCtx | undefined =
        calleeIdSink !== undefined ? { sink: calleeIdSink, filePath: parsed.filePath } : undefined;
      for (const site of parsed.referenceSites) {
        if (site.kind !== 'call' || site.callForm !== 'member') continue;
        const defs = registrations.get(site.name);
        if (defs === undefined) continue;
        for (const def of defs.values()) {
          const ok = tryEmitEdge(
            graph,
            scopes,
            nodeLookup,
            site,
            def,
            'property-dispatch',
            seen,
            PROPERTY_DISPATCH_CONFIDENCE,
            false,
            calleeCapture,
          );
          if (ok) callsEmitted++;
        }
      }
    }
  }
  return { usesEmitted, callsEmitted, skippedKeys, skippedKeyNames };
}
