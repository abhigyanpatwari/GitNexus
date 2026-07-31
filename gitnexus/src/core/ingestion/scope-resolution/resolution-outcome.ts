import type { Range, ReferenceKind } from 'gitnexus-shared';

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
      /**
       * The reference kind of the site the suppression happened at, when the
       * emitting case knows it.
       *
       * Set for `receiver-unresolved` because Case 0's gate fires on any
       * compound receiver regardless of what the reference *is*, so a property
       * write (`x.argtypes = [...]`) and a property read (`d.source.kind`) land
       * in the same bucket as a genuinely dropped method call. Anything
       * measuring resolver gaps has to separate them, and the site kind is the
       * only authoritative signal — re-deriving it from the source line means
       * regex-classifying the number that gates the work, which is the same
       * textual-shape dispatch the structural-receiver work exists to remove.
       *
       * Diagnostic only. `summarizeUnresolvedReceivers` ignores it, so the
       * persisted `RepoMeta.unresolvedReceiverMembers` artifact is unchanged.
       */
      readonly siteKind?: ReferenceKind;
    };

export type ResolutionOutcomeRecorder = (outcome: ResolutionOutcome) => void;
