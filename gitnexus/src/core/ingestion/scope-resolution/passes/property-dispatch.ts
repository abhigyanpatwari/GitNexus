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
 * sites and this pass resolves them post-finalize (see
 * `resolveValueRefTarget` — Function/Method/Constructor only, the callable
 * gate that keeps `{ port: DEFAULT_PORT }` from emitting anything, and
 * receiver-aware so a qualified reference binds the owner it was written
 * with).
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

import type { ParsedFile, ReferenceSite, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { tryEmitEdge, type CalleeIdCaptureCtx } from '../graph-bridge/edges.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { CalleeIdSink } from '../graph-bridge/callee-id-sink.js';
import {
  findCallableBindingInScope,
  findClassBindingInScope,
  findOwnedMember,
  isNamespaceNameShadowed,
  isOwnerNameShadowedBySomethingElse,
} from '../scope/walkers.js';
import { VALUE_REF_EDGE_REASON } from '../value-ref-edges.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import { CALL_TARGET_TYPES } from '../../model/symbol-table.js';

/**
 * Keys registered by more than this many distinct functions are skipped —
 * dispatch through such a name says nothing about which function runs.
 * Calibrated on this repo's own provider tables: `emitScopeCaptures` has 16
 * legitimate registrations (one per language provider), so the cap sits at
 * 2× that — dropping the motivating key was the failure the first value (8)
 * had. ponytail: flat cap; revisit with per-receiver narrowing if real
 * repos show useful keys being dropped (§12 of the #2437 plan).
 *
 * Override via `GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT` env var for repos with
 * legitimate high-fanout property keys (e.g. large Vue codebases where
 * `validator` exceeds the default).
 */
export const MAX_PROPERTY_DISPATCH_FANOUT = (() => {
  const env = Number(process.env.GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT);
  return Number.isInteger(env) && env >= 1 ? env : 32;
})();

/** Below the 0.85 resolved baseline; same discount idea as interface-dispatch. */
export const PROPERTY_DISPATCH_CONFIDENCE = 0.7;

/**
 * Resolve a `value-ref` site to the callable it names.
 *
 * Two shapes, and the difference matters:
 *
 *   - BARE (`{ handler: onClick }`, `register(onTick)`) — the name is resolved
 *     up the lexical chain, which is what an unqualified name means. Be exact
 *     about what that walk does, because it is not a plain lexical lookup:
 *     `findCallableBindingInScope` applies the callable predicate WHILE walking,
 *     so a scope binding the name to a parameter or a local contributes nothing
 *     and the walk continues outward. A nearer non-callable binding is stepped
 *     over — the same shape the qualified path guards against below, unguarded
 *     here. Pre-existing (#2437) and out of scope for #3399; reachable in JS/TS
 *     (`function outer(handler) { return { h: handler }; }` beside a top-level
 *     `function handler`), and narrow in Zig, which rejects a local shadowing a
 *     container declaration.
 *
 *   - QUALIFIED (`bridge.accessor(Element.getNamespaceUri, …)`) — the source
 *     WROTE the owner, so the lexical chain is the wrong instrument. It gives
 *     local bindings precedence (`walkScopeChain`), so a nested container
 *     holding its own `getNamespaceUri` answers first and the registration is
 *     attached to a DIFFERENT function than the one written. That is a wrong
 *     edge, not a missing one — strictly worse for a tool whose value is that
 *     its edges can be trusted — and it is reachable in any language that
 *     allows a same-named callable in a nested container, Zig included.
 *
 * So a qualified site resolves through its receiver: name the owner, then take
 * the member off that owner. An owner is either a MODULE or a CLASS-like
 * container — `utils.compare` and `Element.getNamespaceUri` are the same shape
 * written against the two kinds of namespace a language has, and the member-call
 * path already resolves both (receiver-bound-calls Case 1 / Case 2). Both are
 * tried here, MODULE FIRST: see `findNamespaceValueRefTarget` for why a module
 * receiver cannot simply be declined, and the comment on the call below for why
 * the container channel must not go first.
 *
 * If neither channel names the owner, or the owner is named but owns no such
 * callable, this DECLINES rather than falling back to the lexical walk.
 *
 * Be precise about what declining costs, because it is more than one reference:
 * a site that emits NO edge leaves no evidence for `impact`'s value-reference
 * probe to read, so the target keeps `epistemic: "exact"` — silence, not a
 * hedge. That is why the module channel above exists rather than being waved
 * through as "just a decline". What remains declined is the case where the
 * written receiver names nothing this index knows at all (a Zig `@This()` alias
 * whose name differs from its container's, an owner from outside the workspace):
 * there the alternative is not a hedge either, it is a confident edge to a
 * lexically-nearer function that the source did not name, and a wrong edge is
 * strictly worse than a missing one for a tool whose value is that its edges can
 * be trusted.
 *
 * `CALL_TARGET_TYPES`, not a hand-rolled label set: `findOwnedMember` also
 * answers with FIELDS, and a field named like the member would otherwise
 * register as if it were the callable.
 */
function resolveValueRefTarget(
  site: ReferenceSite,
  filePath: string,
  scopes: ScopeResolutionIndexes,
  model: SemanticModel,
): SymbolDefinition | undefined {
  const receiverName = site.explicitReceiver?.name;
  if (receiverName === undefined) {
    return findCallableBindingInScope(site.inScope, site.name, scopes);
  }
  // NAMESPACE FIRST, and the order is load-bearing. `findClassBindingInScope`
  // does not stop at the scope chain: when its `isClassLike` walk misses — and a
  // namespace handle binds a Module, so it always misses — it falls back to
  // `scopes.qualifiedNames`, a WORKSPACE-wide index, and answers with the unique
  // def of that name anywhere in the repo. Trying it first therefore lets a
  // same-named container in a file this one never imported preempt the `@import`
  // this file actually wrote:
  //
  //     const dom_utils = @import("dom_utils.zig");   // namespace-only module
  //     … bridge.accessor(dom_utils.compare, …)       // → decoy.zig's compare
  //
  // The shadow guard below cannot catch it: the import binds at MODULE scope,
  // which the guard treats as the floor. An import written in this file is the
  // strongest statement about what the name means here, so it outranks a global
  // guess — and when the handle is not an import of this file, this answers
  // nothing and the container channel runs exactly as before.
  const viaNamespace = findNamespaceValueRefTarget(site, filePath, receiverName, scopes);
  if (viaNamespace !== undefined) return viaNamespace;

  const owner = findClassBindingInScope(site.inScope, receiverName, scopes);
  if (owner !== undefined) {
    // The container lookup is a CLASS-ONLY walk: `walkScopeChain` filters by
    // `isClassLike`, so it steps over a nearer binding that is a value and keeps
    // climbing — and past the scope chain entirely, into a qualified-name
    // fallback that answers with the unique workspace definition of the name.
    // `fn f(Ticker: u8) { register(Ticker.fire) }` in a file that neither
    // declares nor imports `Ticker` therefore resolves to some other file's
    // `Ticker` container. That is the wrong-edge failure R1-2 exists to prevent,
    // arriving through the class channel instead of the lexical one, and a
    // registration pointing at a function the source never named is worse than
    // no registration at all.
    //
    // So the name has to still MEAN that container at this site. The namespace
    // channel below asks the same question through `isNamespaceNameShadowed`;
    // a container needs the variant that exempts the container ITSELF, because
    // `fn make() { const Local = struct {…}; register(Local.go); }` binds the
    // name locally to the very def we resolved, and reading that as its own
    // shadow would suppress the resolutions this path exists to make.
    if (isOwnerNameShadowedBySomethingElse(receiverName, owner, site.inScope, scopes))
      return undefined;
    const member = findOwnedMember(owner.nodeId, site.name, model);
    if (member === undefined || !CALL_TARGET_TYPES.has(member.type)) return undefined;
    return member;
  }
  return undefined;
}

/**
 * The second kind of owner: a namespace handle.
 *
 * `const utils = @import("utils.zig"); register(utils.compare);` — `utils` is a
 * MODULE, not a class, so `findClassBindingInScope` answers nothing and the
 * class path above declines. Declining here would be a silent hole rather than
 * a conservative one: no USES edge is emitted, so
 * `callableValueReferenceBoundaries` measures a real zero and `impact` on
 * `compare` republishes `exact` — the very claim this feature exists to stop
 * making. Nothing downstream can hedge on evidence that was never recorded.
 *
 * So resolve it, through the SAME channel the member-CALL path already trusts
 * for `utils.compare()` (receiver-bound-calls Case 1): the file's namespace
 * import edges name the target module, and the target module's own local
 * module-scope bindings name its members. `utils.compare` and `utils.compare()`
 * disagreeing about what `utils` is would be the anomaly.
 *
 * The same three guards Case 1 applies, for the same reasons:
 *   - a LOCAL declaration shadowing the handle suppresses the resolution
 *     (`isNamespaceNameShadowed`) — `fn f(utils: Decoy) { register(utils.compare) }`
 *     names the parameter's member, and resolving through the import would be a
 *     wrong edge rather than a missing one;
 *   - `origin === 'local'` only, so a name the target file merely IMPORTED is
 *     not published as its own member here (the `namespaceExportsIncludeImportedNames`
 *     hub opt-in is a provider decision this language-neutral pass does not make);
 *   - two distinct defs under one name resolve NOTHING. Never guess a namespace
 *     member — the whole point of reading the written receiver is precision.
 *
 * `CALL_TARGET_TYPES` gates the answer for the same reason the class path needs
 * it: `utils.DEFAULT_PORT` is a module-scope binding too, and a registration
 * table full of constants must keep emitting nothing.
 */
function findNamespaceValueRefTarget(
  site: ReferenceSite,
  filePath: string,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  const moduleScopeId = scopes.moduleScopes.get(filePath);
  if (moduleScopeId === undefined) return undefined;
  const targetFiles: string[] = [];
  for (const edge of scopes.imports.get(moduleScopeId) ?? []) {
    if (edge.kind !== 'namespace' || edge.localName !== receiverName) continue;
    if (edge.targetFile === null) continue;
    if (!targetFiles.includes(edge.targetFile)) targetFiles.push(edge.targetFile);
  }
  if (targetFiles.length === 0) return undefined;
  if (isNamespaceNameShadowed(receiverName, site.inScope, scopes)) return undefined;

  let picked: SymbolDefinition | undefined;
  for (const targetFile of targetFiles) {
    const targetScopeId = scopes.moduleScopes.get(targetFile);
    if (targetScopeId === undefined) continue;
    const refs = scopes.bindings.get(targetScopeId)?.get(site.name);
    if (refs === undefined) continue;
    for (const ref of refs) {
      if (ref.origin !== 'local' || !CALL_TARGET_TYPES.has(ref.def.type)) continue;
      if (picked !== undefined && picked.nodeId !== ref.def.nodeId) return undefined;
      picked = ref.def;
    }
  }
  return picked;
}

export function emitPropertyDispatchCalls(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  model: SemanticModel,
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
      const def = resolveValueRefTarget(site, parsed.filePath, scopes, model);
      if (def === undefined) continue;

      const ok = tryEmitEdge(graph, scopes, nodeLookup, site, def, VALUE_REF_EDGE_REASON, seen);
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
