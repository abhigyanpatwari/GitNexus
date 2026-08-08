/**
 * PRECISE member resolution through a call result's RETURN SHAPE (R3-5).
 *
 * The last unanswered question from three rounds of blind-spot reports was
 * "who reads `wickRatio`?", where the field is produced by several functions
 * that each return an anonymous object containing it. Name inference must
 * refuse that — a read of `spike.wickRatio` could mean any producer, and a
 * wrong edge in the pre-edit safety gate is worse than a missing one — so no
 * amount of narrowing gets there. It needs EVIDENCE instead of inference.
 *
 * The evidence already exists in two halves that had never been joined:
 *
 *   1. The call-result type binding. `const alert = formatSpikeAlert(row)`
 *      binds `alert` to a `TypeRef` whose `rawName` is the callee. That
 *      machinery predates this work; it simply had nothing to resolve to when
 *      the callee returned an anonymous literal, because an anonymous literal
 *      named nothing.
 *   2. R3-4 gave it a name. A returned literal's keys are now owned by the
 *      producing function, so `formatSpikeAlert.wickRatio` is a real symbol.
 *
 * Joining them turns a refusal into a precise answer:
 *
 *     const alert = formatSpikeAlert(row);
 *     alert.wickRatio            →  Property:…:formatSpikeAlert.wickRatio
 *
 * and it works for exactly the case narrowing cannot: several producers sharing
 * a field name are no longer competitors, because the receiver says WHICH one.
 * That is why this runs before the unique-name fallback and registers its sites
 * as handled — a precise answer must never be second-guessed by a name match.
 *
 * BOUND, deliberately. This only fires where the value is BOUND to a name the
 * type binding could attach to. A field read off a bare parameter
 * (`function f(spike) { return spike.wickRatio }`) still has no receiver type
 * here, because typing it requires the CALLER's type to flow in — that is
 * inter-procedural and genuinely larger. Those reads keep falling through to
 * name inference, and keep being reported when it declines.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { resolveCallerGraphId } from '../graph-bridge/ids.js';
import {
  findCallableBindingInScope,
  findClassBindingInScope,
  findReceiverTypeBinding,
} from '../scope/walkers.js';
import { callableFlowSiteKey } from './callable-value-flow.js';
import type { PropertyNameIndex } from './unique-name-properties.js';

/**
 * Confidence for a return-shape member. This is a PRECISE resolution — the
 * receiver's binding names the producing function and the member is owned by
 * it — so it carries the ordinary emission confidence, not the reduced tier
 * name inference uses. Nothing here is guessed.
 */
const RETURN_SHAPE_CONFIDENCE = 0.9;

const EDGE_REASON = 'scope-resolution: return-shape member';

export interface ReturnShapeMemberStats {
  /** ACCESSES edges resolved through a call result's return shape. */
  readonly emitted: number;
  /**
   * Sites where the receiver WAS typed to a producer but that producer owns no
   * member of this name. Reported rather than dropped: it means the read and
   * the shape disagree, which is either a stale field name or a producer this
   * pass mis-attributed, and both are worth seeing.
   */
  readonly memberNotOnShape: number;
}

/**
 * Does this Property node id name `<owner>.<member>`?
 *
 * Ids carry an optional position suffix for function-local symbols
 * (`…:buildFlat.field@33:4`), so the owner segment is matched up to a `@` or
 * the end rather than by equality.
 */
function idNamesMember(id: string, owner: string, member: string): boolean {
  const needle = `:${owner}.${member}`;
  const at = id.indexOf(needle);
  if (at === -1) return false;
  const after = id.slice(at + needle.length);
  return after.length === 0 || after.startsWith('@');
}

export function emitReturnShapeMemberAccesses(
  graph: KnowledgeGraph,
  indexes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  /** Sites a precise pass already owns — never re-resolved here. */
  skipSites: ReadonlySet<string>,
  propertyNameIndex: PropertyNameIndex,
  /** Sites this pass resolves, so the name fallback leaves them alone. */
  handledSink: Set<string>,
): ReturnShapeMemberStats {
  let emitted = 0;
  let memberNotOnShape = 0;
  const seen = new Set<string>();

  // The files of the language being resolved. `parsedFiles` is already scoped to
  // it, so this needs no new plumbing — it is the same restriction the sibling
  // unique-name pass gets from `candidatesForLanguage`.
  //
  // The file guard below is not sufficient on its own, and the reason is worth
  // keeping: a receiver typed by CONSTRUCTION (`const cfg = new Loyalty()`)
  // resolves `Loyalty` through the shared class registry, which is polyglot. The
  // producer then legitimately resolves to `Loyalty.java`, its members
  // legitimately live in that same file, and a file-equality check waves the
  // cross-language edge straight through. Restricting to the current language's
  // own files is what actually closes it.
  const ownFilePaths = new Set(parsedFiles.map((p) => p.filePath));

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'read' && site.kind !== 'write') continue;
      const receiver = site.explicitReceiver?.name;
      if (receiver === undefined || receiver.length === 0) continue;
      const siteKey = callableFlowSiteKey(parsed.filePath, site.atRange);
      if (skipSites.has(siteKey)) continue;

      // The receiver's binding names the PRODUCER, not a class. That is the
      // whole point: `formatSpikeAlert` is a function, and before R3-4 there
      // was nothing named after it to look a member up on.
      const typeRef = findReceiverTypeBinding(site.inScope, receiver, indexes);
      const producerRef = typeRef?.rawName;
      if (producerRef === undefined || producerRef.length === 0) continue;

      // R3-4 qualifies a returned key by the producing function's own name, so
      // the owner segment to match is the LAST one. For a plain producer this is
      // a no-op.
      let producer = producerRef.slice(producerRef.lastIndexOf('.') + 1);
      if (producer.length === 0) continue;

      // Resolve the producer to a real definition and keep only members that
      // live in ITS file.
      //
      // Without this the join is textual over a whole-graph index: any node
      // whose id happens to read `<producer>.<member>` matches, in any file and
      // any LANGUAGE. Measured, that fabricated a 0.9-confidence edge from a JS
      // component to a Java field — and 0.9 is the precise tier, so a
      // `minConfidence` floor cannot filter it out. The sibling unique-name pass
      // was given a per-language restriction for exactly this; this pass
      // consumes the same shared index and had none.
      //
      // The file identity is the evidence, not a heuristic: R3-4 anchors a
      // returned literal's keys to the function that returns them, so the
      // member's node necessarily sits in the same file as that function. A
      // candidate elsewhere is a different symbol wearing the same name.
      // A CALLABLE lookup, not a value one: the producer is the function whose
      // return shape owns the member. It also resolves through finalized import
      // bindings, so a producer imported from another file still yields its own
      // file — the guard restricts to the RIGHT file, it does not force same-file.
      // Three guards, and they catch different shapes — none is redundant:
      //
      //   producerDef  — the producer must RESOLVE. This is the one that stops
      //                  the measured cross-language leak: `new Loyalty()` in JS
      //                  yields `producerRef = 'Loyalty'`, and a Java class does
      //                  not resolve as a callable from a JS scope, so the pass
      //                  declines instead of name-matching into `Loyalty.java`.
      //                  Mutation-verified by `polyglot-property-isolation`.
      //   filePath     — among same-named producers, keep the members of the one
      //                  actually resolved. Defence in depth for the case where
      //                  the producer DOES resolve and a same-named function
      //                  exists in another file.
      //   ownFilePaths — a receiver typed by construction resolves through the
      //                  shared, POLYGLOT class registry, so a producer can
      //                  resolve into another language with its members
      //                  legitimately in that same file. File equality passes
      //                  there; only the language restriction closes it.
      const producerDef = findCallableBindingInScope(site.inScope, producerRef, indexes);
      let producerFile = producerDef?.filePath;

      // MEMBER-CALL PRODUCERS (W2-1). Tried only where the callable lookup above
      // DECLINED, so every reference that resolved before resolves identically —
      // this adds a case, it does not reroute the existing one.
      //
      // `const r = svc.make()` binds the spelling `svc.make`. Slicing that to its
      // last segment leaves `make`, which is a METHOD and so never a callable
      // binding in scope; the lookup failed and the pass declined. The limit was
      // documented as needing inter-procedural receiver typing, but measured, the
      // pipeline had already done the hard part: `svc.make()` resolves to its
      // Method node as an ordinary CALLS edge, and R3-4 anchors the returned
      // literal's keys to that method, so `SignalService.make.secretFlag` already
      // existed as a node. Only this join was missing.
      //
      // Nothing new is inferred. The receiver is typed by the SAME predicate that
      // typed `r` above, and it must resolve to a class of its own — a receiver
      // that cannot be typed still declines. The owner segment is then TWO parts
      // (`SignalService.make`) rather than one, which is exactly how R3-4
      // qualifies a key returned from a method, and it is what separates two
      // methods on one class that return the same key name from each other and
      // from a free function of that name.
      if (producerFile === undefined) {
        const dotAt = producerRef.lastIndexOf('.');
        if (dotAt <= 0) continue;
        const receiverExpr = producerRef.slice(0, dotAt);
        const methodName = producerRef.slice(dotAt + 1);
        if (methodName.length === 0) continue;
        const ownerType = findReceiverTypeBinding(site.inScope, receiverExpr, indexes)?.rawName;
        if (ownerType === undefined || ownerType.length === 0) continue;
        const ownerDef = findClassBindingInScope(site.inScope, ownerType, indexes);
        if (ownerDef === undefined) continue;
        producer = `${ownerType}.${methodName}`;
        producerFile = ownerDef.filePath;
      }

      if (producerFile === undefined) continue;
      if (!ownFilePaths.has(producerFile)) continue;

      const candidates = propertyNameIndex.get(site.name);
      if (candidates === undefined) continue;
      const owned = candidates.filter(
        (c) => c.filePath === producerFile && idNamesMember(c.id, producer, site.name),
      );
      // Exactly one, or nothing. Two nodes claiming `<producer>.<member>` would
      // mean the id qualifier failed to separate them, and picking between them
      // would be the guess this pass exists to avoid.
      if (owned.length !== 1) {
        if (owned.length === 0) {
          memberNotOnShape++;
          // CLAIM THE SITE ANYWAY. This branch is the strongest NEGATIVE
          // evidence the pipeline can produce: the receiver is typed to a
          // producer, that producer's shape is known, and it owns no member of
          // this name. Falling through let the 0.5 name fallback answer a
          // question the precise pass had just DISPROVED — measured, it linked
          // a read to an unrelated same-named key in another file. Disproving a
          // member and then inventing it one pass later is worse than either
          // answer alone.
          handledSink.add(siteKey);
        }
        continue;
      }
      const target = owned[0]!;

      const callerGraphId = resolveCallerGraphId(site.inScope, indexes, nodeLookup, site.atRange);
      if (callerGraphId === undefined) continue;
      if (callerGraphId === target.id) continue;

      const dedupKey = `ACCESSES:${callerGraphId}->${target.id}:${site.atRange.startLine}:${site.atRange.startCol}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      graph.addRelationship({
        id: `rel:${dedupKey}`,
        sourceId: callerGraphId,
        targetId: target.id,
        type: 'ACCESSES',
        confidence: RETURN_SHAPE_CONFIDENCE,
        reason: `${EDGE_REASON}: ${site.kind}`,
        evidence: [],
      });
      // Claim the site so the name fallback cannot re-answer it differently.
      handledSink.add(siteKey);
      emitted++;
    }
  }

  return { emitted, memberNotOnShape };
}
