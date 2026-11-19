/**
 * Which resolution outcomes the R receiver tests count as real drops.
 *
 * Since the shared receiver pass (DART-11), an untyped function-local receiver also records a
 * `suppressed` outcome with reason `receiver-type-unresolved`. That note is informational: it adds
 * no edge, and no drop count includes it (see the doc comment on the reason in
 * `src/core/ingestion/scope-resolution/resolution-outcome.ts`: diagnostic only, not counted by
 * `summarizeUnresolvedReceivers`). The R tests therefore count a site as dropped only when its
 * outcome is a suppression that is not informational.
 *
 * The classification is keyed on `reason` alone, never on `declineDetail`, `binderScopeId`, the
 * number of notes or which sites carry one, so a change to the upstream walk costs at most one
 * line in this file.
 */
import type { ResolutionOutcome } from '../../src/core/ingestion/scope-resolution/resolution-outcome.js';

type Suppressed = Extract<ResolutionOutcome, { kind: 'suppressed' }>;

export const INFORMATIONAL_REASONS: ReadonlySet<string> = new Set(['receiver-type-unresolved']);

/** A suppressed outcome that only notes why a receiver stayed untyped. */
export const isInformational = (o: ResolutionOutcome): o is Suppressed =>
  o.kind === 'suppressed' && INFORMATIONAL_REASONS.has(o.reason);

/** A suppressed outcome that counts as a dropped site. */
export const isCountedDrop = (o: ResolutionOutcome): o is Suppressed =>
  o.kind === 'suppressed' && !INFORMATIONAL_REASONS.has(o.reason);
