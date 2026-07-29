import type { Range } from 'gitnexus-shared';

export type ResolutionSuppressionReason =
  | 'adl-ordinary-lookup-blocked'
  | 'conversion-rank-tied'
  | 'inline-ns-ambiguous'
  | 'member-lookup-ambiguous'
  | 'selected-callable-deleted'
  | 'overload-ambiguous'
  | 'overload-ambiguous-normalization'
  | 'free-call-instance-ownership'
  /** #2701 — the receiver is rebound by its own scope and has no type
   *  there (a JS/TS ordinary `function`'s `this`), so no enclosing type
   *  can be its type. See `isReceiverOwnedButUnbound`. */
  | 'receiver-owned-but-unbound'
  /** #2744 — the receiver is a compound expression (a call, a chain, a
   *  construction) whose TYPE could not be established, so the member call
   *  was dropped with no candidate at all. Distinct from the ambiguity
   *  reasons above: there is nothing to be ambiguous between. Consumers use
   *  this to report `impact()`/`context()` counts as a lower bound rather
   *  than as exact, since a dropped site's callee is by definition unknown
   *  and cannot be attributed to any target. */
  | 'receiver-unresolved';

export type ResolutionOutcome =
  | {
      readonly kind: 'resolved';
      readonly targetId: string;
      readonly phase: string;
      readonly filePath: string;
      readonly name: string;
      readonly range: Range;
    }
  | {
      readonly kind: 'suppressed';
      readonly reason: ResolutionSuppressionReason;
      /**
       * Scope-resolution definition IDs considered by the suppression decision.
       * For `inline-ns-ambiguous` this is currently empty because the
       * qualified namespace resolver returns only an `ambiguous` sentinel.
       */
      readonly candidateIds: readonly string[];
      readonly phase: string;
      readonly filePath: string;
      readonly name: string;
      readonly range: Range;
    };

export type ResolutionOutcomeRecorder = (outcome: ResolutionOutcome) => void;
