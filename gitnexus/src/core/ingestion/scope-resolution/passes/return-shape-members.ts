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

import type { CallableFlowOperand, ParsedFile, Scope, ScopeId } from 'gitnexus-shared';
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

/**
 * Key a parameter cell by the scope it BINDS IN plus its name.
 *
 * Not by its definition id, which is what the first attempt used: a parameter
 * is not reachable through `findValueBindingInScope` (its predicate
 * `isOwnableValueLabel` lists Const / Variable / Property / Static, because it
 * exists for OWNERSHIP registration and a parameter is owned by nothing), and
 * measured, it is not reachable as a `local` binding either — the join found the
 * formal and then resolved no def at all.
 *
 * The scope plus the name is enough and needs no def: the `formal` site already
 * states the scope its parameter binds in, and a read of that name anywhere
 * inside that scope's subtree refers to it unless something nearer shadows it —
 * which {@link parameterProducerFor} handles by stopping at the first scope that
 * BINDS the name.
 */
function parameterCellKey(scope: ScopeId, name: string): string {
  return `${scope}\u0000${name}`;
}

/**
 * Does `scope` BIND `name` itself — with or without a type or a definition?
 *
 * The question the parameter walk has to ask before it climbs, and it is NOT
 * "does this scope hold a parameter producer", which is what the first attempt
 * asked. A `const`, a `for…of` binder, a catch binding and a parameter are all
 * nearer declarations of the name, and none of them is in the producer map — so
 * a walk that consults only that map climbs straight past the nearer binding and
 * types the shadow from an enclosing parameter's callers.
 *
 * Reads the scope's OWN tables rather than `lookupBindingsAt`, for the same
 * reason `isNamespaceNameShadowed` does: the question here is what this scope
 * declares LOCALLY, and the finalized/augmented import channels answer a
 * different one — routing through them would let a module-level import of the
 * name count as a shadow of itself.
 *
 * `ownedDefs` is consulted alongside `bindings` because a language may register
 * a declaration without a binding entry of its own; the sibling guard reads both
 * for that reason, and here an extra STOP only ever costs an edge.
 */
function scopeBindsName(scope: Scope, name: string): boolean {
  return (
    scope.bindings.has(name) ||
    scope.typeBindings.has(name) ||
    scope.lexicalNames?.has(name) === true ||
    scope.ownedDefs.some((def) => {
      const qualifiedName = def.qualifiedName;
      if (qualifiedName === undefined) return false;
      const dot = qualifiedName.lastIndexOf('.');
      return (dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1)) === name;
    })
  );
}

/**
 * The caller-derived producer for `name` as read at `startScope`, or undefined.
 *
 * A cell is keyed by the scope its parameter BINDS IN, so a read nested below
 * that scope has to climb to reach it — through a nested block, a class body, a
 * `catch`. The climb is the whole reason this walk exists, and it is also the
 * whole risk: every scope crossed is a scope that might declare the name itself.
 *
 * So the walk stops at the FIRST scope that binds the name at all, not at the
 * first scope that happens to hold a producer. `{ const item = rows[0]; …
 * item.wickRatio }` inside `f(item, rows)` is the shape that separates the two:
 * the block declares `item`, the producer map does not know that name, and a
 * producer-only walk climbs past it to the formal and types a value the callers
 * never supplied.
 *
 * A CALLABLE boundary stops the walk even when nothing visible binds the name,
 * because a parameter list is the one binder this pass cannot see through: an
 * anonymous arrow is dropped by `collectFunctions` (it cannot be named), so it
 * emits no `formal` site and `items.map((spike) => spike.wickRatio)` presents a
 * scope that looks EMPTY while in fact rebinding `spike`. Crossing it types an
 * array element from the enclosing parameter's callers, at 0.9. The price is a
 * closure that genuinely reads an enclosing parameter, which now declines — the
 * trade this pass is built to make, since a wrong answer at the precise tier is
 * one no `minConfidence` floor can filter out, while a missing one still falls
 * through to the 0.5 name tier.
 *
 * NO VISITED SET, deliberately, unlike the sibling walks in `walkers.ts`. Those
 * fail closed on a parent cycle; this one cannot meet a cycle to fail on. Both
 * constructions of this tree (`buildScopeTree`, and `TransitionalScopeTree`
 * which validates through it) enforce that a parent's range STRICTLY contains
 * its child's and throw otherwise, and strict containment is well-founded — a
 * cycle would need a scope strictly containing itself. A per-site `Set` here
 * would be defence against a state the builder rejects, allocated once for every
 * read/write site in the repo.
 */
function parameterProducerFor(
  startScope: ScopeId,
  name: string,
  parameterProducers: ReadonlyMap<string, string>,
  indexes: ScopeResolutionIndexes,
): string | undefined {
  let cursor: ScopeId | null = startScope;
  while (cursor !== null) {
    const producer = parameterProducers.get(parameterCellKey(cursor, name));
    if (producer !== undefined && producer.length > 0) return producer;
    const scope = indexes.scopeTree.getScope(cursor);
    if (scope === undefined) return undefined;
    if (scopeBindsName(scope, name)) return undefined;
    if (scope.kind === 'Function') return undefined;
    cursor = scope.parent;
  }
  return undefined;
}

/**
 * Producer names for PARAMETERS, derived from what their callers pass (W2-2).
 *
 * `function f(spike) { return spike.wickRatio }` has nothing to type `spike`
 * from — that is the standing limit of R3-5 and the reason the 0.5 name tier
 * exists at all. Measured on the reporting repo, it is also the LARGEST one:
 * 11,012 of 13,672 property edges (81%) rest on that name guess.
 *
 * The two facts needed to answer it were already being extracted, for a
 * different purpose. `callable-flow-captures` synthesizes, for JS and TS among
 * others:
 *
 *   formal    owner=f  binding=spike  parameter-index=0
 *   argument  source=s  parameter-index=0  direct-callee-name=f
 *
 * so joining them on `(callee, parameterIndex)` says which cell reaches which
 * parameter, and the argument's own binding is typed by the same
 * `findReceiverTypeBinding` used for a directly-bound receiver. No new capture,
 * no parse-time change, and deliberately NOT a change to the callable-value-flow
 * solver that owns these sites — that pass is guarded by a fingerprint
 * correctness gate, so this reads the same facts and computes its own map.
 *
 * A parameter with callers passing DIFFERENT producers resolves to nothing.
 * Picking one would fabricate at the 0.9 PRECISE tier, which no `minConfidence`
 * floor can filter out — the same reason `buildConstantMap` drops an ambiguous
 * constant instead of taking the first.
 *
 * COVERAGE, measured rather than assumed. The synthesis skips an argument that
 * is itself a call result (`f(makeSignal())` emits no argument site, by an
 * explicit `continue` in `callable-flow-captures`), so only the bound spelling
 * `const s = makeSignal(); f(s)` is served. That looked fatal until counted: in
 * the reporting repo bare-identifier arguments outnumber call-result arguments
 * 2,563 to 50. The captured spelling is the dominant one by 51:1.
 */
function buildParameterProducers(
  indexes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
): ReadonlyMap<string, string> {
  /** parameter def id -> producer name, or CONFLICT once callers disagree. */
  const producers = new Map<string, string>();
  const conflicted = new Set<string>();

  // Formals keyed by the file that declares them, so two same-named functions
  // in different files cannot answer for each other — the same file identity
  // the member join below relies on.
  //
  // AMBIGUITY IS REFUSED HERE TOO, not settled by arrival order. The file is
  // only one of the two axes a name can collide on: `ownerName` is a BARE
  // identifier, and `emitFormalFacts` emits one `formal` per parameter of every
  // callable it collects — nested functions and class methods included. So a
  // free `parse` and a `parse` nested inside it, or a free `apply` and
  // `Runner.apply`, key this map identically within ONE file. A plain `.set`
  // lets the last one visited win, which hands a caller's producer to a
  // parameter that caller never reached; the edge that follows is emitted at the
  // 0.9 PRECISE tier, above every `minConfidence` floor, while the genuine
  // consumer is left untyped. Poisoning the key costs both callables their edge
  // and fabricates neither — the same discipline the `producers` map applies to
  // disagreeing callers thirty lines below.
  const formals = new Map<string, CallableFlowOperand>();
  /** Formal keys claimed by two DIFFERENT parameters — unable to answer. */
  const ambiguousFormals = new Set<string>();
  for (const parsed of parsedFiles) {
    for (const flow of parsed.callableFlowSites ?? []) {
      if (flow.kind !== 'formal') continue;
      const formalKey = `${parsed.filePath}\u0000${flow.ownerName}\u0000${flow.parameterIndex}`;
      if (ambiguousFormals.has(formalKey)) continue;
      const claimed = formals.get(formalKey);
      if (claimed !== undefined) {
        // The same cell restated is not a disagreement — only a formal naming a
        // DIFFERENT parameter leaves the key unable to answer.
        if (claimed.inScope === flow.binding.inScope && claimed.name === flow.binding.name) {
          continue;
        }
        formals.delete(formalKey);
        ambiguousFormals.add(formalKey);
        continue;
      }
      formals.set(formalKey, flow.binding);
    }
  }
  if (formals.size === 0) return producers;

  for (const parsed of parsedFiles) {
    for (const flow of parsed.callableFlowSites ?? []) {
      if (flow.kind !== 'argument') continue;
      const callee = flow.directCalleeName;
      if (callee === undefined || callee.length === 0) continue;

      // Resolve the callee from the CALL SITE, so the formal is looked up in the
      // file that actually declares the function rather than the one calling it.
      const calleeDef = findCallableBindingInScope(flow.source.inScope, callee, indexes);
      if (calleeDef?.filePath === undefined) continue;

      const binding = formals.get(
        `${calleeDef.filePath}\u0000${callee}\u0000${flow.parameterIndex}`,
      );
      if (binding === undefined) continue;

      const cell = parameterCellKey(binding.inScope, binding.name);
      if (conflicted.has(cell)) continue;

      const producer = findReceiverTypeBinding(
        flow.source.inScope,
        flow.source.name,
        indexes,
      )?.rawName;
      if (producer === undefined || producer.length === 0) continue;

      const existing = producers.get(cell);
      if (existing !== undefined && existing !== producer) {
        // Two callers, two producers. Which shape this parameter holds depends
        // on the call, and this pass answers at the precise tier or not at all.
        producers.delete(cell);
        conflicted.add(cell);
        continue;
      }
      producers.set(cell, producer);
    }
  }
  return producers;
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

  // Caller-derived parameter types (W2-2) — see `buildParameterProducers`.
  const parameterProducers = buildParameterProducers(indexes, parsedFiles);

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
      let producerRef = typeRef?.rawName;

      // W2-2. A receiver with no binding of its own may still be a PARAMETER
      // whose callers all pass the same producer. Consulted only where the
      // direct binding declined, so a receiver that already had a type keeps it.
      if (producerRef === undefined || producerRef.length === 0) {
        producerRef = parameterProducerFor(site.inScope, receiver, parameterProducers, indexes);
      }
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
