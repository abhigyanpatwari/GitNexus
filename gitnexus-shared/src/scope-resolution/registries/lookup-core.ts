/**
 * `lookupCore` — the shared 7-step canonical resolution algorithm
 * (RFC §4.2; Ring 2 SHARED #917).
 *
 * Pure function. Given a name, a starting scope, and per-kind parameters,
 * walks lexical scopes + optional type-binding MRO + optional owner
 * contributor + global qualified-name fallback, and returns a ranked
 * `Resolution[]` with per-candidate evidence.
 *
 * All three public registries (`ClassRegistry` / `MethodRegistry` /
 * `FieldRegistry`) dispatch into this function, differing only in the
 * parameters they pass. The CHOICE of which steps fire is expressed
 * through `LookupParams`, not through different algorithms per kind.
 *
 * ## Algorithm (RFC §4.2, verbatim names)
 *
 * **Step 1 — Lexical scope-chain walk.** From `startScope`, walk
 *   parent-ward. At each scope, consult `scope.bindings.get(name)`:
 *     - Filter candidates whose `def.type ∈ acceptedKinds`.
 *     - For each surviving candidate, record a raw signal with the
 *       binding's origin + the current scope-chain depth.
 *     - **Hard shadow.** If `bindings.get(name)` is non-empty (including
 *       non-kind-matching candidates), stop walking. The name is
 *       lexically bound here; outer scopes are not consulted.
 *
 * **Step 2 — Type-binding resolution.** When `useReceiverTypeBinding`
 *   is true, resolve the receiver's type at `startScope` (from
 *   `scope.typeBindings`), then walk the MRO via
 *   `MethodDispatchIndex.mroFor(ownerDefId)`. Membership per owner comes
 *   through `RegistryContext.methodDispatch` + owner lookups into
 *   `scope.ownedDefs`; each hit records a raw signal with the owner's
 *   MRO depth.
 *
 * **Step 3 — Owner-scoped contributor.** When
 *   `params.ownerScopedContributor` is present, merge its `byName(name)`
 *   hits with `origin: 'local'` (they are declared directly on the
 *   receiver). Distinct from Step 2 — Step 2 walks the MRO; Step 3 only
 *   looks at the directly-declared owner members.
 *
 * **Step 4 — Kind filter (emit `kind-match` evidence).** Already
 *   applied during Steps 1-3; this step just adds a `kind-match` signal
 *   at weight 0 to every candidate for debuggability (so the evidence
 *   array is self-describing).
 *
 * **Step 5 — Arity filter.** Call `providers.arityCompatibility(callsite,
 *   def)` per surviving candidate. Verdicts: `compatible` / `unknown` /
 *   `incompatible`. If at least one candidate is `compatible`, drop
 *   `incompatible` ones. Otherwise keep all (the penalty weight alone
 *   will rank them lower but they remain in the result).
 *
 * **Step 6 — Global fallback.** When Steps 1-3 produced **no**
 *   candidates and the name contains a `.`, consult the
 *   `QualifiedNameIndex` via `lookupQualified` — see §4.5. The `scope`
 *   argument is NOT passed here because global lookup is scope-agnostic.
 *
 * **Step 7 — Rank + tie-break.** Compose evidence, compute confidence
 *   (sum capped at 1.0), sort by the RFC Appendix B cascade.
 *
 * ## What this module does NOT do
 *
 *   - No AST reads (pure data in, pure data out).
 *   - No `gitnexus/` imports.
 *   - No language switches. Language-specific behavior flows exclusively
 *     through `providers.*` and the `params` object.
 *   - No caching. Callers that want memoization can wrap this function.
 */

import type { NodeLabel } from '../../graph/types.js';
import type { SymbolDefinition } from '../symbol-definition.js';
import type {
  BindingRef,
  Callsite,
  DefId,
  LookupParams,
  Resolution,
  Scope,
  ScopeId,
} from '../types.js';
import type { OriginForTieBreak } from '../origin-priority.js';
import { composeEvidence, confidenceFromEvidence, type RawSignals } from './evidence.js';
import { compareByConfidenceWithTiebreaks, type TieBreakKey } from './tie-breaks.js';
import { lookupQualified } from './lookup-qualified.js';
import type { ArityVerdict, OwnerScopedContributor, RegistryContext } from './context.js';

// ─── Public entry point ─────────────────────────────────────────────────────

/** Extended `LookupParams` narrowing `ownerScopedContributor` to the concrete shape. */
export interface CoreLookupParams extends Omit<LookupParams, 'ownerScopedContributor'> {
  readonly ownerScopedContributor: OwnerScopedContributor | null;
  /** Call-site description forwarded to `arityCompatibility`. Optional — for non-call lookups. */
  readonly callsite?: Callsite;
}

/**
 * Run the 7-step lookup. Returns a non-empty `Resolution[]` when any
 * candidate was found; an empty array otherwise. Callers consume `[0]`
 * for the best answer and optionally inspect the rest for alternates.
 */
export function lookupCore(
  name: string,
  startScope: ScopeId,
  params: CoreLookupParams,
  ctx: RegistryContext,
): readonly Resolution[] {
  const acceptedKinds = new Set<NodeLabel>(params.acceptedKinds);
  const perCandidate = new Map<DefId, CandidateState>();

  // ── Step 1: lexical scope-chain walk ──────────────────────────────────
  const lexicalShadowed = walkLexicalChain(name, startScope, acceptedKinds, ctx, perCandidate);

  // ── Step 2: type-binding / MRO walk (methods/fields) ──────────────────
  if (params.useReceiverTypeBinding && ctx.methodDispatch !== undefined) {
    walkReceiverTypeBinding(name, startScope, acceptedKinds, params, ctx, perCandidate);
  }

  // ── Step 3: owner-scoped contributor ──────────────────────────────────
  if (params.ownerScopedContributor !== null) {
    seedFromOwnerScopedContributor(
      name,
      params.ownerScopedContributor,
      acceptedKinds,
      perCandidate,
    );
  }

  // ── Step 4: kind-match evidence (emitted by composeEvidence directly) ──
  // Handled inside `composeEvidence`.

  // ── Step 5: arity filter ──────────────────────────────────────────────
  if (params.callsite !== undefined) {
    applyArityFilter(params.callsite, perCandidate, ctx);
  }

  // ── Step 6: global fallback (only when Steps 1-3 produced nothing) ──
  if (perCandidate.size === 0 && !lexicalShadowed && name.includes('.')) {
    const globals = lookupQualified(name, { acceptedKinds: params.acceptedKinds }, ctx);
    if (globals.length > 0) return globals;
  }

  if (perCandidate.size === 0) return EMPTY;

  // ── Step 7: compose evidence + rank ──────────────────────────────────
  return rankCandidates(perCandidate);
}

// ─── Internal state ────────────────────────────────────────────────────────

interface CandidateState {
  readonly def: SymbolDefinition;
  readonly signals: MutableRawSignals;
  readonly tieBreakKey: MutableTieBreakKey;
}

interface MutableRawSignals {
  origin?: BindingRef['origin'] | 'global-qualified' | 'global-name';
  scopeChainDepth?: number;
  viaUnlinkedImport?: boolean;
  typeBindingMroDepth?: number;
  ownerMatch?: boolean;
  kindMatch: true;
  arityVerdict?: ArityVerdict;
  dynamicUnresolved?: boolean;
}

interface MutableTieBreakKey {
  scopeDepth: number;
  mroDepth: number;
  origin: OriginForTieBreak;
}

function ensureCandidate(
  perCandidate: Map<DefId, CandidateState>,
  def: SymbolDefinition,
): CandidateState {
  const existing = perCandidate.get(def.nodeId);
  if (existing !== undefined) return existing;
  const fresh: CandidateState = {
    def,
    signals: { kindMatch: true },
    tieBreakKey: { scopeDepth: 0, mroDepth: 0, origin: 'local' },
  };
  perCandidate.set(def.nodeId, fresh);
  return fresh;
}

// ─── Step 1 implementation ─────────────────────────────────────────────────

/**
 * Walk the lexical scope chain from `startScope` upward. Returns `true`
 * iff a scope with any `bindings.get(name)` entries was found — the
 * caller uses this to decide whether to run the global fallback.
 */
function walkLexicalChain(
  name: string,
  startScope: ScopeId,
  acceptedKinds: ReadonlySet<NodeLabel>,
  ctx: RegistryContext,
  perCandidate: Map<DefId, CandidateState>,
): boolean {
  let currentId: ScopeId | null = startScope;
  let depth = 0;
  const visited = new Set<ScopeId>();

  while (currentId !== null) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);

    const scope: Scope | undefined = ctx.scopes.getScope(currentId);
    if (scope === undefined) return false;

    const bindings = scope.bindings.get(name);
    if (bindings !== undefined && bindings.length > 0) {
      for (const binding of bindings) {
        if (!acceptedKinds.has(binding.def.type)) continue;
        recordLexicalHit(perCandidate, binding, depth);
      }
      return true; // hard shadow regardless of kind-filter survivorship
    }

    currentId = scope.parent;
    depth++;
  }

  return false;
}

function recordLexicalHit(
  perCandidate: Map<DefId, CandidateState>,
  binding: BindingRef,
  scopeChainDepth: number,
): void {
  const state = ensureCandidate(perCandidate, binding.def);
  state.signals.origin = binding.origin;
  state.signals.scopeChainDepth = scopeChainDepth;
  if (binding.via?.linkStatus === 'unresolved') {
    state.signals.viaUnlinkedImport = true;
  }
  if (binding.via?.kind === 'dynamic-unresolved') {
    state.signals.dynamicUnresolved = true;
  }
  state.tieBreakKey.scopeDepth = scopeChainDepth;
  state.tieBreakKey.origin = binding.origin as OriginForTieBreak;
}

// ─── Step 2 implementation ─────────────────────────────────────────────────

function walkReceiverTypeBinding(
  name: string,
  startScope: ScopeId,
  acceptedKinds: ReadonlySet<NodeLabel>,
  params: CoreLookupParams,
  ctx: RegistryContext,
  perCandidate: Map<DefId, CandidateState>,
): void {
  const ownerDefId = resolveReceiverOwner(startScope, params, ctx);
  if (ownerDefId === undefined) return;

  if (ctx.methodDispatch === undefined) return;

  const ownerDef = ctx.defs.get(ownerDefId);
  if (ownerDef === undefined) return;

  // Walk the owner itself at depth 0, then its MRO chain.
  const walk: DefId[] = [ownerDefId, ...ctx.methodDispatch.mroFor(ownerDefId)];

  for (let mroDepth = 0; mroDepth < walk.length; mroDepth++) {
    const currentOwnerId = walk[mroDepth]!;
    const members = collectOwnedMembers(currentOwnerId, name, ctx);
    for (const def of members) {
      if (!acceptedKinds.has(def.type)) continue;
      recordTypeBindingHit(perCandidate, def, mroDepth, ownerDefId);
    }
  }
}

function resolveReceiverOwner(
  startScope: ScopeId,
  params: CoreLookupParams,
  ctx: RegistryContext,
): DefId | undefined {
  // Explicit receiver: consult the callsite scope's typeBindings for the
  // named receiver; the attached TypeRef identifies the owner. Without a
  // ready resolveTypeRef call (that module is separate), we do a direct
  // lookup and trust the caller to have populated the binding.
  if (params.explicitReceiver !== undefined) {
    return lookupReceiverType(startScope, params.explicitReceiver.name, ctx);
  }

  // Implicit `self` / `this` — the scope's typeBindings should carry it.
  for (const implicitName of IMPLICIT_RECEIVERS) {
    const owner = lookupReceiverType(startScope, implicitName, ctx);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

const IMPLICIT_RECEIVERS: readonly string[] = Object.freeze(['self', 'this']);

function lookupReceiverType(
  startScope: ScopeId,
  receiverName: string,
  ctx: RegistryContext,
): DefId | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);

    const scope = ctx.scopes.getScope(currentId);
    if (scope === undefined) return undefined;

    const typeRef = scope.typeBindings.get(receiverName);
    if (typeRef !== undefined) {
      // rawName must resolve to a def via qualifiedNames; if it doesn't, we
      // can't claim the receiver type. No fallback — that's what
      // `resolveTypeRef` would do, but we keep this path lean and let
      // callers pre-resolve if they want the richer semantics.
      const candidateIds = ctx.qualifiedNames.get(typeRef.rawName);
      if (candidateIds.length === 1) return candidateIds[0];
      // If ambiguous or missing, try a name-match among class-like defs —
      // but only when the rawName has no dots (simple name).
      return undefined;
    }
    currentId = scope.parent;
  }
  return undefined;
}

function collectOwnedMembers(
  ownerDefId: DefId,
  memberName: string,
  ctx: RegistryContext,
): readonly SymbolDefinition[] {
  // An owner's members are defs whose `ownerId === ownerDefId` and whose
  // simple name matches `memberName`. We iterate `defs.byId` — O(D) per
  // call today. A future by-owner index would make this O(K); tracked as
  // a follow-up optimization before Ring 3 flips go production.
  const out: SymbolDefinition[] = [];
  for (const def of ctx.defs.byId.values()) {
    if (def.ownerId !== ownerDefId) continue;
    if (simpleNameOf(def) !== memberName) continue;
    out.push(def);
  }
  return out;
}

function simpleNameOf(def: SymbolDefinition): string | undefined {
  if (def.qualifiedName === undefined || def.qualifiedName.length === 0) return undefined;
  const dot = def.qualifiedName.lastIndexOf('.');
  return dot === -1 ? def.qualifiedName : def.qualifiedName.slice(dot + 1);
}

function recordTypeBindingHit(
  perCandidate: Map<DefId, CandidateState>,
  def: SymbolDefinition,
  mroDepth: number,
  receiverOwner: DefId,
): void {
  const state = ensureCandidate(perCandidate, def);
  // Only replace if this hit is shallower (smaller MRO depth).
  if (
    state.signals.typeBindingMroDepth === undefined ||
    mroDepth < state.signals.typeBindingMroDepth
  ) {
    state.signals.typeBindingMroDepth = mroDepth;
    state.tieBreakKey.mroDepth = mroDepth;
  }
  if (def.ownerId === receiverOwner) {
    state.signals.ownerMatch = true;
  }
}

// ─── Step 3 implementation ─────────────────────────────────────────────────

function seedFromOwnerScopedContributor(
  name: string,
  contributor: OwnerScopedContributor,
  acceptedKinds: ReadonlySet<NodeLabel>,
  perCandidate: Map<DefId, CandidateState>,
): void {
  for (const def of contributor.byName(name)) {
    if (!acceptedKinds.has(def.type)) continue;
    const state = ensureCandidate(perCandidate, def);
    // Treat the contributor's direct membership as `origin: 'local'` —
    // strongest visibility, no scope-chain penalty.
    state.signals.origin = 'local';
    state.signals.scopeChainDepth = 0;
    state.signals.ownerMatch = def.ownerId === contributor.ownerDefId;
    state.tieBreakKey.origin = 'local';
  }
}

// ─── Step 5 implementation ─────────────────────────────────────────────────

function applyArityFilter(
  callsite: Callsite,
  perCandidate: Map<DefId, CandidateState>,
  ctx: RegistryContext,
): void {
  const arityFn = ctx.providers.arityCompatibility;
  if (arityFn === undefined) {
    // No provider → record 'unknown' for every candidate; keeps signal
    // shape uniform for composeEvidence.
    for (const state of perCandidate.values()) {
      state.signals.arityVerdict = 'unknown';
    }
    return;
  }

  let anyCompatible = false;
  for (const state of perCandidate.values()) {
    const verdict = arityFn(callsite, state.def);
    state.signals.arityVerdict = verdict;
    if (verdict === 'compatible') anyCompatible = true;
  }

  if (!anyCompatible) return;

  // Filter: when at least one compatible candidate exists, drop incompatibles.
  for (const [defId, state] of perCandidate) {
    if (state.signals.arityVerdict === 'incompatible') {
      perCandidate.delete(defId);
    }
  }
}

// ─── Step 7 implementation ─────────────────────────────────────────────────

function rankCandidates(perCandidate: Map<DefId, CandidateState>): readonly Resolution[] {
  const resolutions: Resolution[] = [];
  const tieKeys = new Map<string, TieBreakKey>();

  for (const state of perCandidate.values()) {
    const evidence = composeEvidence(state.signals as RawSignals);
    const confidence = confidenceFromEvidence(evidence);
    resolutions.push({ def: state.def, confidence, evidence });
    tieKeys.set(state.def.nodeId, { ...state.tieBreakKey });
  }

  resolutions.sort((a, b) => compareByConfidenceWithTiebreaks(a, b, tieKeys));
  return Object.freeze(resolutions);
}

// ─── Constants ──────────────────────────────────────────────────────────────

const EMPTY: readonly Resolution[] = Object.freeze([]);
