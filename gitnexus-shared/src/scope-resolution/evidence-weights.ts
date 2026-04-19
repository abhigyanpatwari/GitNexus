/**
 * `EvidenceWeights` — RFC Appendix A (authoritative values).
 *
 * Starting calibration for scope-based resolution. Shadow-first rollout
 * tunes these against legacy DAG parity. Every `ResolutionEvidence.weight`
 * value in the codebase MUST reference this map; inline magic numbers are a
 * lint violation. Extends issue #429 (centralize hardcoded confidence values).
 *
 * Evidence composes additively inside `composeEvidence`; the sum is capped
 * at 1.0 in `Resolution.confidence`.
 */

/**
 * Authoritative weight map. Keys are a mix of `ResolutionEvidence.kind`
 * values and special modifiers (scope-chain depth, MRO depth decay,
 * unlinked-import multiplicative cap).
 */
export const EvidenceWeights = {
  // ─── Where-found signals (visibility) ─────────────────────────────────────
  /** `BindingRef.origin === 'local'` */
  local: 0.55,
  /** `BindingRef.origin === 'import'` */
  import: 0.45,
  /** `BindingRef.origin === 'reexport'` */
  reexport: 0.4,
  /** `BindingRef.origin === 'namespace'` */
  namespace: 0.4,
  /** `BindingRef.origin === 'wildcard'` */
  wildcard: 0.3,

  // ─── Scope-chain deduction (per-hop) ──────────────────────────────────────
  /** Deducted per parent-hop taken (depth-0 = 0, depth-1 = −0.02, …). */
  scopeChainPerDepth: -0.02,

  // ─── Receiver-type-binding signal (decays by MRO depth) ───────────────────
  /**
   * Weight applied when the receiver's type binding resolves to a class that
   * declares the candidate as a method/field. Decays by MRO depth: direct
   * class = index 0; 1 parent hop = index 1; etc. Falls back to the last
   * value for depths beyond the table.
   */
  typeBindingByMroDepth: [0.5, 0.42, 0.36, 0.32, 0.3] as const,

  // ─── Corroborating signals ────────────────────────────────────────────────
  /** `def.ownerId === resolvedReceiver.def.id` (exact owner match). */
  ownerMatch: 0.2,
  /** Explanatory only — retained for debuggability. Never discriminates
   *  because surviving candidates already passed `acceptedKinds`. */
  kindMatch: 0.0,

  // ─── Arity compatibility (from `provider.arityCompatibility`) ─────────────
  /** `provider.arityCompatibility(...) === 'compatible'` */
  arityMatchCompatible: 0.1,
  /** `provider.arityCompatibility(...) === 'unknown'` */
  arityMatchUnknown: 0.0,
  /** `provider.arityCompatibility(...) === 'incompatible'` — penalizes;
   *  candidates filtered only when a compatible candidate exists. */
  arityMatchIncompatible: -0.15,

  // ─── Global fallback (only when nothing lexically visible) ────────────────
  /** Hit via `QualifiedNameIndex.byQualifiedName`. */
  globalQualified: 0.35,
  /** Fallback hit in a `byName` index (and nothing was lexically visible). */
  globalName: 0.1,

  // ─── Degraded signals ─────────────────────────────────────────────────────
  /** Call/reference flowing through a `dynamic-unresolved` edge. */
  dynamicImportUnresolved: 0.02,

  // ─── Unresolved-import cap (multiplicative, applied per-signal) ───────────
  /**
   * Multiplicative cap on the edge-derived evidence signal
   * (`import`/`wildcard`/`reexport`/`namespace`) when
   * `ImportEdge.linkStatus === 'unresolved'`. Independent corroborating
   * signals on the same candidate (`owner-match`, `arity-match`,
   * `type-binding`) are NOT penalized.
   */
  unlinkedImportMultiplier: 0.5,
} as const;

/**
 * Look up the `type-binding` signal weight for a given MRO depth, falling
 * back to the last tabulated value for depths beyond the table.
 */
export function typeBindingWeightAtDepth(mroDepth: number): number {
  const table = EvidenceWeights.typeBindingByMroDepth;
  if (mroDepth < 0) return table[0];
  if (mroDepth >= table.length) return table[table.length - 1];
  return table[mroDepth];
}
