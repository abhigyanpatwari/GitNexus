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
 *   through an optional `RegistryContext.ownedMembersByOwner` hook when
 *   supplied (`undefined` → fall back to `defs.byId`; `[]` → indexed
 *   miss), otherwise via the compatibility fallback scan over
 *   `defs.byId`; each hit records a raw signal with the owner's
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

import { lookupLexicalName } from '../name-claims.js';
import type { NodeLabel } from '../../graph/types.js';
import type { SymbolDefinition } from '../symbol-definition.js';
import type { BindingRef, Callsite, DefId, LookupParams, Resolution, ScopeId } from '../types.js';
import type { OriginForTieBreak } from '../origin-priority.js';
import { composeEvidence, confidenceFromEvidence, type RawSignals } from './evidence.js';
import { compareByConfidenceWithTiebreaks, type TieBreakKey } from './tie-breaks.js';
import { lookupQualified } from './lookup-qualified.js';
import type { ArityVerdict, OwnerScopedContributor, RegistryContext } from './context.js';
import { CLASS_KINDS } from './context.js';

// ─── Public entry point ─────────────────────────────────────────────────────

/** Extended `LookupParams` narrowing `ownerScopedContributor` to the concrete shape. */
export interface CoreLookupParams extends Omit<LookupParams, 'ownerScopedContributor'> {
  /** A separate namespace whose ownership is determined only by accepted kinds. */
  readonly independentKindNamespace?: boolean;
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
  //
  // SKIPPED for a NAMED explicit receiver. `recv.name` names a MEMBER of
  // whatever `recv` denotes; it is not a lexical reference to `name`, so a
  // binding of the bare tail name in an enclosing scope is never the right
  // answer. Steps 2 and 3 (receiver type / owner members) are the routes.
  //
  // Without this, `options.baseUrl` bound to an unrelated function-local
  // `const baseUrl` in the same file. This is the residual half of the defect
  // JS/TS block scopes narrowed in #2699 — blocks moved nested-block locals
  // off the chain, but a local declared directly in the function body stayed
  // on it, and no amount of extra scopes reaches that case.
  //
  // `this` / `self` are deliberately EXEMPT. For a self-receiver the members
  // and the lexical chain legitimately overlap — a class body is itself a
  // scope that binds its members — so Step 1 is a real resolution route
  // there, not a coincidence. Measured on a 762-file corpus: skipping Step 1
  // for every explicit receiver dropped 711 edges, of which 43 were
  // `this.member` reads reaching their own owner. Exempting the self names
  // keeps those and still removes the 668 named-receiver false positives.
  const skipLexical =
    params.explicitReceiver !== undefined &&
    !IMPLICIT_RECEIVERS.includes(params.explicitReceiver.name);
  const lexicalShadowed = skipLexical
    ? false
    : walkLexicalChain(name, startScope, acceptedKinds, ctx, perCandidate, params);

  // ── Step 2: type-binding / MRO walk (methods/fields) ──────────────────
  if (
    (!lexicalShadowed || perCandidate.size > 0 || skipLexical) &&
    params.useReceiverTypeBinding &&
    ctx.methodDispatch !== undefined
  ) {
    walkReceiverTypeBinding(name, startScope, acceptedKinds, params, ctx, perCandidate);
  }

  // ── Step 3: owner-scoped contributor ──────────────────────────────────
  if (
    (!lexicalShadowed || perCandidate.size > 0 || skipLexical) &&
    params.ownerScopedContributor !== null
  ) {
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
  params: CoreLookupParams,
): boolean {
  if (params.independentKindNamespace === true) {
    let id: ScopeId | null = startScope;
    let depth = 0;
    const visited = new Set<ScopeId>();
    while (id !== null && !visited.has(id)) {
      visited.add(id);
      const scope = ctx.scopes.getScope(id);
      if (scope === undefined) return true;
      const bindings = (scope.bindings.get(name) ?? []).filter((binding) =>
        acceptedKinds.has(binding.def.type),
      );
      if (bindings.length > 0) {
        for (const binding of bindings) recordLexicalHit(perCandidate, binding, depth);
        return true;
      }
      id = scope.lookupPolicy?.parentScope ?? scope.parent;
      depth++;
    }
    return id !== null;
  }
  const options = { position: params.lookupPosition, purpose: params.lookupPurpose };
  const claim = lookupLexicalName(startScope, name, { scopes: ctx.scopes }, options);
  if (claim.status !== 'absent') {
    let depth = 0;
    let owner = ctx.scopes.getScope(startScope);
    const visited = new Set<ScopeId>();
    while (owner !== undefined && owner.id !== claim.scope?.id && !visited.has(owner.id)) {
      visited.add(owner.id);
      const parent = owner.lookupPolicy?.parentScope ?? owner.parent;
      owner = parent === null ? undefined : ctx.scopes.getScope(parent);
      depth++;
    }
    for (const binding of claim.bindings) {
      if (acceptedKinds.has(binding.def.type)) recordLexicalHit(perCandidate, binding, depth);
    }
    return true;
  }
  const rootName = name.split('.', 1)[0]!;
  return (
    rootName !== name &&
    lookupLexicalName(startScope, rootName, { scopes: ctx.scopes }, options).status !== 'absent'
  );
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

  let mroDepth = 0;
  for (const currentOwnerId of walk) {
    const members = collectOwnedMembers(currentOwnerId, name, ctx);
    for (const def of members) {
      if (!acceptedKinds.has(def.type)) continue;
      recordTypeBindingHit(perCandidate, def, mroDepth, ownerDefId);
    }
    mroDepth++;
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
    return lookupReceiverType(startScope, params.explicitReceiver.name, ctx, params);
  }

  // Implicit `self` / `this` — the scope's typeBindings should carry it.
  for (const implicitName of IMPLICIT_RECEIVERS) {
    const owner = lookupReceiverType(startScope, implicitName, ctx, params);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

/**
 * Names that denote the enclosing instance rather than an arbitrary object.
 *
 * Two consumers, and both want the same set: `resolveReceiverOwner` above
 * tries them when no explicit receiver is present, and the Step-1 skip in
 * `lookupCore` exempts them because for a SELF receiver the members and the
 * lexical chain legitimately overlap — a class body is itself a scope that
 * binds its members — whereas for a named receiver they never do.
 *
 * `$this` is matched because the receiver name arrives as the reference node's
 * RAW SOURCE TEXT (`extractExplicitReceiver` returns `cap.text` verbatim), so
 * PHP's `$this->x` presents as `"$this"`, sigil included. Listing the spelling
 * keeps this a data table rather than a language switch — this module resolves
 * language behaviour through `providers.*` and `params` only (see the header)
 * — and it follows the ingestion-side twin, `THIS_RECEIVERS` in
 * `gitnexus/src/core/ingestion/type-env.ts`, which has always listed the
 * sigil'd spelling rather than stripping it. Stripping would carry the same
 * false-positive surface anyway (a JS variable literally named `$this`).
 *
 * That twin also lists `Me`, deliberately NOT mirrored here: no entry in
 * `SupportedLanguages` uses it, so it can only ever exempt a variable that
 * happens to be called `Me`. The two lists are otherwise the same set, and
 * that equality — plus the `Me` exemption in both directions — is now ENFORCED
 * by `gitnexus/test/unit/receiver-twin-list-drift.test.ts`. Editing either list
 * without the other fails there.
 */
const IMPLICIT_RECEIVERS: readonly string[] = Object.freeze(['self', 'this', '$this']);

function lookupReceiverType(
  startScope: ScopeId,
  receiverName: string,
  ctx: RegistryContext,
  params: CoreLookupParams,
): DefId | undefined {
  const claim = lookupLexicalName(
    startScope,
    receiverName,
    { scopes: ctx.scopes },
    {
      position: params.lookupPosition,
      purpose: 'value',
    },
  );
  const typeRef = claim.typeBinding;
  if (typeRef === undefined) return undefined;
  const typeClaim = lookupLexicalName(
    typeRef.declaredAtScope,
    typeRef.rawName,
    { scopes: ctx.scopes },
    {
      position: typeRef.lookupPosition,
      purpose: typeRef.lookupPurpose ?? 'type',
    },
  );
  if (typeClaim.status !== 'absent') {
    const candidates = new Map(
      typeClaim.bindings
        .filter((binding) => CLASS_KINDS.includes(binding.def.type))
        .map((binding) => [binding.def.nodeId, binding.def]),
    );
    return candidates.size === 1 ? candidates.keys().next().value : undefined;
  }
  const candidateIds = ctx.qualifiedNames.get(typeRef.rawName);
  return candidateIds.length === 1 ? candidateIds[0] : undefined;
}

function collectOwnedMembers(
  ownerDefId: DefId,
  memberName: string,
  ctx: RegistryContext,
): readonly SymbolDefinition[] {
  return ctx.ownedMembersByOwner(ownerDefId, memberName);
}

function recordTypeBindingHit(
  perCandidate: Map<DefId, CandidateState>,
  def: SymbolDefinition,
  mroDepth: number,
  receiverOwner: DefId,
): void {
  const state = ensureCandidate(perCandidate, def);
  const existingMroDepth = state.signals.typeBindingMroDepth;
  const firstHit = existingMroDepth === undefined;
  // Only replace if this hit is shallower (smaller MRO depth). The local
  // const lets TS narrow to `number` in the `else` branch so no `!`
  // assertion is needed.
  if (firstHit || mroDepth < existingMroDepth) {
    state.signals.typeBindingMroDepth = mroDepth;
    state.tieBreakKey.mroDepth = mroDepth;
  }
  if (def.ownerId === receiverOwner) {
    state.signals.ownerMatch = true;
  }
  // Pure type-binding candidates (no lexical hit) would otherwise keep the
  // `ensureCandidate` default `tieBreakKey.origin === 'local'`, making the
  // Appendix B cascade lump them with local-origin candidates. Demote them
  // to `'import'` — the strongest non-local origin — only when no earlier
  // phase set an origin for this candidate. Lexical hits from Step 1 set
  // `signals.origin` before Step 2 runs, so the guard skips them; Step 3
  // (`seedFromOwnerScopedContributor`) runs AFTER Step 2 and unconditionally
  // overrides `tieBreakKey.origin` back to `'local'` for direct-owner
  // members, so any same-def overlap still ends up ranked correctly.
  if (firstHit && state.signals.origin === undefined) {
    state.tieBreakKey.origin = 'import';
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
  let anyUnknown = false;
  for (const state of perCandidate.values()) {
    const verdict = arityFn(callsite, state.def);
    state.signals.arityVerdict = verdict;
    if (verdict === 'compatible') anyCompatible = true;
    else if (verdict === 'unknown') anyUnknown = true;
  }

  // When ALL candidates are 'incompatible' (none compatible, none unknown),
  // the call is genuinely arity-broken — drop every candidate so the
  // registry returns no resolution. This matches the PHP variadic case
  // f(int $req, ...$rest) called with zero args: every candidate definitively
  // rejects, and emitting an edge to a definitively-rejected callable is
  // a false positive. When some candidates are 'unknown' (missing metadata),
  // keep the set so downstream evidence can break the tie — that's the
  // original safety-fallback behavior.
  if (!anyCompatible) {
    if (!anyUnknown) {
      for (const defId of perCandidate.keys()) {
        perCandidate.delete(defId);
      }
    }
    return;
  }

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
