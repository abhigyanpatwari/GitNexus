/**
 * `composeEvidence` — translate accumulated raw signals per candidate
 * into a `ResolutionEvidence[]` using the authoritative `EvidenceWeights`
 * map (RFC §4.3 + Appendix A; Ring 2 SHARED #917).
 *
 * Each `RawSignals` record describes what was observed about a candidate
 * during the 7-step walk: where it was found, at what depth, whether
 * anything corroborates it. This module turns those raw facts into the
 * typed evidence list attached to the outgoing `Resolution`.
 *
 * **Every weight comes from `EvidenceWeights`.** No inline magic numbers.
 * Extends issue #429 (centralize hardcoded confidence values).
 *
 * **Confidence compose rule.** Signals add; the sum is capped at 1.0 at
 * the call site (inside `lookupCore`). This module only emits the list;
 * it does NOT compute the capped sum so callers can inspect per-signal
 * contributions for debugging.
 */

import type { BindingRef, ResolutionEvidence } from '../types.js';
import { EvidenceWeights, typeBindingWeightAtDepth } from '../evidence-weights.js';

/**
 * Raw signals observed for a single candidate during the 7-step walk.
 * Optional fields encode "this signal did not fire"; presence encodes
 * "emit an evidence record".
 */
export interface RawSignals {
  // ── Where-found ────────────────────────────────────────────────────────
  /** Visibility origin of the binding that produced this candidate. */
  readonly origin?: BindingRef['origin'] | 'global-qualified' | 'global-name';
  /** Depth at which the binding was found (hops up from start scope). */
  readonly scopeChainDepth?: number;
  /** `ImportEdge` that brought the name in; present when origin is a non-local. */
  readonly viaUnlinkedImport?: boolean;

  // ── Type-binding path ──────────────────────────────────────────────────
  /** Set when the candidate came via the receiver's type-binding MRO walk. */
  readonly typeBindingMroDepth?: number;

  // ── Corroborators ──────────────────────────────────────────────────────
  /** `def.ownerId === resolvedReceiver.def.nodeId`. */
  readonly ownerMatch?: boolean;
  /** Always fires for candidates that pass `acceptedKinds`; weight 0. */
  readonly kindMatch: true;

  // ── Arity ──────────────────────────────────────────────────────────────
  readonly arityVerdict?: 'compatible' | 'unknown' | 'incompatible';

  // ── Dynamic-unresolved passthrough ─────────────────────────────────────
  /** Candidate flows through a `kind: 'dynamic-unresolved'` ImportEdge. */
  readonly dynamicUnresolved?: boolean;
}

/**
 * Compose the raw signals into a stable `ResolutionEvidence[]` list.
 *
 * Emission order mirrors the `EvidenceWeights` layout: where-found →
 * type-binding → corroborators → arity → degraded. Stable order makes
 * the per-signal contributions easy to reason about in tests and in the
 * shadow-mode parity dashboard.
 */
export function composeEvidence(signals: RawSignals): readonly ResolutionEvidence[] {
  const out: ResolutionEvidence[] = [];

  // ── Where-found visibility ─────────────────────────────────────────────
  if (signals.origin !== undefined) {
    const baseWeight = getOriginWeight(signals.origin);
    const capped = signals.viaUnlinkedImport
      ? baseWeight * EvidenceWeights.unlinkedImportMultiplier
      : baseWeight;
    const evidenceKind = whereFoundEvidenceKind(signals.origin);
    out.push({
      kind: evidenceKind,
      weight: capped,
      ...(signals.viaUnlinkedImport
        ? { note: `via unresolved import (${EvidenceWeights.unlinkedImportMultiplier}× cap)` }
        : {}),
    });
  }

  // ── Scope-chain depth deduction (per-hop, only meaningful for lexical
  // hits where scopeChainDepth ≥ 1). Depth 0 = no deduction; depth N ≥ 1
  // emits a single `scope-chain` evidence with the accumulated penalty.
  if (signals.scopeChainDepth !== undefined && signals.scopeChainDepth > 0) {
    out.push({
      kind: 'scope-chain',
      weight: EvidenceWeights.scopeChainPerDepth * signals.scopeChainDepth,
      note: `depth=${signals.scopeChainDepth}`,
    });
  }

  // ── Type-binding / MRO path ────────────────────────────────────────────
  if (signals.typeBindingMroDepth !== undefined) {
    out.push({
      kind: 'type-binding',
      weight: typeBindingWeightAtDepth(signals.typeBindingMroDepth),
      note: `mroDepth=${signals.typeBindingMroDepth}`,
    });
  }

  // ── Owner match (explanatory for debug) ────────────────────────────────
  if (signals.ownerMatch === true) {
    out.push({
      kind: 'owner-match',
      weight: EvidenceWeights.ownerMatch,
    });
  }

  // ── Kind match (always present; weight 0; retained for debuggability) ──
  out.push({
    kind: 'kind-match',
    weight: EvidenceWeights.kindMatch,
  });

  // ── Arity ──────────────────────────────────────────────────────────────
  if (signals.arityVerdict !== undefined) {
    const weight =
      signals.arityVerdict === 'compatible'
        ? EvidenceWeights.arityMatchCompatible
        : signals.arityVerdict === 'incompatible'
          ? EvidenceWeights.arityMatchIncompatible
          : EvidenceWeights.arityMatchUnknown;
    out.push({
      kind: 'arity-match',
      weight,
      note: signals.arityVerdict,
    });
  }

  // ── Dynamic-unresolved (degraded signal) ───────────────────────────────
  if (signals.dynamicUnresolved === true) {
    out.push({
      kind: 'dynamic-import-unresolved',
      weight: EvidenceWeights.dynamicImportUnresolved,
    });
  }

  return out;
}

/**
 * Sum evidence weights and clamp to `[0, 1]`. Separate from `composeEvidence`
 * so tests and the parity dashboard can inspect the raw evidence list.
 */
export function confidenceFromEvidence(evidence: readonly ResolutionEvidence[]): number {
  let sum = 0;
  for (const e of evidence) sum += e.weight;
  if (sum < 0) return 0;
  if (sum > 1) return 1;
  return sum;
}

// ─── Internal ───────────────────────────────────────────────────────────────

function getOriginWeight(origin: NonNullable<RawSignals['origin']>): number {
  switch (origin) {
    case 'local':
      return EvidenceWeights.local;
    case 'import':
      return EvidenceWeights.import;
    case 'reexport':
      return EvidenceWeights.reexport;
    case 'namespace':
      return EvidenceWeights.namespace;
    case 'wildcard':
      return EvidenceWeights.wildcard;
    case 'global-qualified':
      return EvidenceWeights.globalQualified;
    case 'global-name':
      // Reserved for Ring 3 byName global index. `lookupCore` today only
      // emits `'global-qualified'` (via `lookupQualified`, dotted-name
      // fallback); no code path constructs `origin: 'global-name'` yet.
      // Kept here so the Appendix A weight stays live and `composeEvidence`
      // remains exhaustive over the origin union.
      return EvidenceWeights.globalName;
  }
}

function whereFoundEvidenceKind(
  origin: NonNullable<RawSignals['origin']>,
): ResolutionEvidence['kind'] {
  switch (origin) {
    case 'local':
      return 'local';
    case 'import':
    case 'reexport':
    case 'namespace':
    case 'wildcard':
      return 'import';
    case 'global-qualified':
      return 'global-qualified';
    case 'global-name':
      return 'global-name';
  }
}
