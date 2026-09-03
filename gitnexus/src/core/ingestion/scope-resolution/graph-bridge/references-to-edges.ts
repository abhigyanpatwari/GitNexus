/**
 * Translate the resolved `ReferenceIndex` into legacy graph edges.
 *
 * Per reference:
 *   1. Resolve `fromScope` → caller graph-node id by walking the scope
 *      chain looking for an enclosing Function/Method/Class.
 *   2. Resolve `toDef` → target graph-node id via `nodeLookup`.
 *   3. Emit the edge (`CALLS` / `READS` / `WRITES` / `EXTENDS` / `USES`)
 *      with the standard reason format (`referenceEdgeReason`).
 *
 * Skips (without throwing) when either side fails to map — either side
 * may legitimately not exist as a graph node (e.g. a resolved target
 * lives in an external file that wasn't ingested into the graph).
 *
 * Next-consumer contract: this function is the canonical bridge from
 * a shared `ReferenceIndex` into per-language graph edges. Every
 * registry-primary language provider calls this exactly once with its
 * `referenceIndex` output and its own `nodeLookup`.
 */

import type { Reference, ScopeId } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveCallerGraphId, resolveDefGraphId } from '../graph-bridge/ids.js';
import { mapReferenceKindToEdgeType } from '../graph-bridge/edges.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { CalleeIdSink } from '../graph-bridge/callee-id-sink.js';
import { isValueDefinitionLabel } from '../../utils/ast-helpers.js';

/**
 * Optional opaque skip key — providers may pre-emit edges (e.g. via
 * receiver-bound post-passes) and want this loop to skip references at
 * the same source position so the shared resolver's potentially-wrong
 * fallback resolution doesn't fight the precise emission. The key is
 * `${filePath}:${startLine}:${startCol}`.
 */
type ReferenceSiteSkipSet = ReadonlySet<string>;

export interface EmitReferencesOptions {
  /** When true, a constructor-form call site's edge gets ` (constructor)`
   *  appended to its reason. See `ScopeResolver.markConstructionSites`. */
  readonly markConstructionSites?: boolean;
}

/**
 * `reason` of the edge a resolved reference emits: `scope-resolution: <kind>`,
 * plus ` (constructor)` for a construction site when the provider opted in —
 * a struct literal (`T{…}` in Zig, `T { .. }` in Rust, `T{}` in Go) or a
 * `new T()` resolves to the type (or its constructor) as a CALLS edge exactly
 * like an invocation does, and nothing else on the edge tells the two apart
 * (PR #1432 review).
 *
 * The marker rides in `reason` because relationships carry no arbitrary
 * properties — adding one would change the relation DDL and move
 * SCHEMA_FINGERPRINT (see the IMPLEMENTS `-pointer` precedent in
 * `pipeline/run.ts`). The plain `scope-resolution: call` prefix is kept, so a
 * consumer matching the prefix still sees every call; one matching the exact
 * string sees invocations only.
 */
export function referenceEdgeReason(
  ref: Pick<Reference, 'kind' | 'callForm'>,
  markConstructionSites: boolean | undefined,
): string {
  return markConstructionSites === true && ref.kind === 'call' && ref.callForm === 'constructor'
    ? 'scope-resolution: call (constructor)'
    : `scope-resolution: ${ref.kind}`;
}

/**
 * Value labels whose defs MAY be function-local. A reference to one of these is
 * dropped only when the def is positively identified as living inside a function
 * body — see `functionLocalValueDefIds`. Everything else, including a class
 * member in a language that keeps no values at module scope, is emitted.
 */

export function emitReferencesViaLookup(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  referenceIndex: { readonly bySourceScope: ReadonlyMap<ScopeId, readonly Reference[]> },
  nodeLookup: GraphNodeLookup,
  skipSites?: ReferenceSiteSkipSet,
  /** Resolved-callee-id capture sink (#2227 U2). Threaded in only under
   *  `--pdg`; `undefined` ⇒ zero overhead, byte-identity (R4). Captured at the
   *  CALLS emit below BEFORE this loop's `seen` dedup (KTD6/R8). */
  calleeIdSink?: CalleeIdSink,
  /**
   * Def ids of value symbols bound inside a FUNCTION body. When supplied, a
   * read/write whose target is a `Const`/`Variable`/`Static` in this set emits
   * no edge.
   *
   * Bare-identifier reads (A2) made module-scope constants answerable, but the
   * same capture also matches a read of a BLOCK-LOCAL `const`. An edge to one
   * of those keeps alive precisely the inert local symbols `pruneLocalSymbols`
   * exists to drop — turning a pruned node into a retained node plus an edge,
   * in every function of every indexed repo. "Who uses this constant?" is a
   * question about a module's surface; a local's uses are the three lines
   * around it.
   *
   * A BLOCKLIST, not an allowlist, and the direction is the point. Asking
   * "is this def module-level?" silently excludes class members — Java/C#
   * fields, Python class attributes — which are neither module-level nor local.
   * Asking "is this def function-local?" excludes only what it can positively
   * identify, so an unrecognised or uninspected def is emitted. A stray inert
   * local is recoverable; a deleted edge class reads as "nothing uses this".
   *
   * Optional so callers that never capture bare identifiers are unchanged.
   */
  functionLocalValueDefIds?: ReadonlySet<string>,
  options?: EmitReferencesOptions,
): { emitted: number; skipped: number } {
  let emitted = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const [fromScope, refs] of referenceIndex.bySourceScope) {
    const callerGraphId = resolveCallerGraphId(fromScope, scopes, nodeLookup);
    if (callerGraphId === undefined) {
      skipped += refs.length;
      continue;
    }
    const fromScopeMeta = scopes.scopeTree.getScope(fromScope);
    const fromFilePath = fromScopeMeta?.filePath;

    for (const ref of refs) {
      if (skipSites !== undefined && fromFilePath !== undefined) {
        const siteKey = `${fromFilePath}:${ref.atRange.startLine}:${ref.atRange.startCol}`;
        if (skipSites.has(siteKey)) {
          skipped++;
          continue;
        }
      }

      const targetDef = scopes.defs.get(ref.toDef);
      if (targetDef === undefined) {
        skipped++;
        continue;
      }
      const targetGraphId = resolveDefGraphId(targetDef.filePath, targetDef, nodeLookup);
      if (targetGraphId === undefined) {
        skipped++;
        continue;
      }

      const edgeType = mapReferenceKindToEdgeType(ref.kind);
      if (edgeType === undefined) {
        skipped++;
        continue;
      }

      // Function-local value reference — see `functionLocalValueDefIds`.
      if (
        functionLocalValueDefIds !== undefined &&
        edgeType === 'ACCESSES' &&
        isValueDefinitionLabel(targetDef.type) &&
        functionLocalValueDefIds.has(targetDef.nodeId)
      ) {
        skipped++;
        continue;
      }

      // Resolved-callee-id capture (#2227 U2/KTD6/R8): record this CALLS site's
      // resolved target BEFORE the `seen` dedup, keyed on `ref.atRange`
      // (byte-equal to U1's SiteRecord.at: 1-based line / 0-based col). Only
      // CALLS from real call sites feeds the bridge; ACCESSES/USES/EXTENDS are
      // skipped, and so are value-ref CALLS (#2437) — a property-value
      // reference is not a call site U1 could have stamped. `fromFilePath`
      // is the call-site (caller) file — the same file U1 stamps the site on.
      if (
        calleeIdSink !== undefined &&
        edgeType === 'CALLS' &&
        ref.kind === 'call' &&
        fromFilePath !== undefined
      ) {
        calleeIdSink.add(fromFilePath, ref.atRange.startLine, ref.atRange.startCol, targetGraphId);
      }

      const dedupKey = `${edgeType}:${callerGraphId}->${targetGraphId}:${ref.atRange.startLine}:${ref.atRange.startCol}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      graph.addRelationship({
        id: `rel:${dedupKey}`,
        sourceId: callerGraphId,
        targetId: targetGraphId,
        type: edgeType,
        confidence: ref.confidence,
        reason: referenceEdgeReason(ref, options?.markConstructionSites),
      });
      emitted++;
    }
  }
  return { emitted, skipped };
}
