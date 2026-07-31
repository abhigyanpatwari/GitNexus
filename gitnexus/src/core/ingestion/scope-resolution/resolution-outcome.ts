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
      /**
       * Structural shape of the receiver whose type could not be established.
       *
       * Derived from the site's ENCODED RECEIVER CHAIN — the compact string the
       * capture emitters mint by walking the real AST — never from the source
       * line. Re-deriving a shape textually would mean regex-classifying the
       * number that gates this work, which is exactly the textual-shape dispatch
       * the structural-receiver line of work exists to remove.
       *
       * Lets a consumer ask "which KIND of receiver are we losing?" instead of
       * only "how many". Without it, `callDropsByExtension` is the finest
       * available split and a language's bucket says nothing about whether the
       * cause is one defect or five.
       *
       * NOTE ON COVERAGE: only drops that REACH the recorder carry a shape, and
       * Case 0's gate fires on receiver punctuation, so shapes that mint no
       * reference site at all (`?.`, explicit type args, subscript) are absent
       * from this breakdown entirely — they are the INVISIBLE-GAP population the
       * bench shape arm exists to see. A shape census here is a census of the
       * VISIBLE drops, not of all lost calls.
       *
       * Diagnostic only. `summarizeUnresolvedReceivers` ignores it, so the
       * persisted `RepoMeta.unresolvedReceiverMembers` artifact is unchanged.
       */
      readonly receiverShape?: ReceiverShape;
    };

/**
 * How a dropped receiver was spelled, structurally.
 *
 * - `chain-call`   every recorded step is a call — `svc.getUser().save()`
 * - `chain-field`  every recorded step is a field — `h.repo.save()`
 * - `chain-mixed`  the chain interleaves both — `svc.getUser().addr.save()`
 * - `no-chain`     the site carried no chain, so the receiver was a compound
 *                  expression the capture walk could not reduce to a nameable
 *                  base (it stopped early, or the base was unencodable)
 */
export type ReceiverShape = 'chain-call' | 'chain-field' | 'chain-mixed' | 'no-chain';

/** Classify a dropped receiver from its encoded chain. `undefined` chain ⇒
 *  `no-chain`; an undecodable one is also `no-chain`, since what we know about
 *  it is exactly that no usable structure survived. */
export function classifyReceiverShape(
  decoded: { readonly steps: readonly { readonly kind: string }[] } | undefined,
): ReceiverShape {
  if (decoded === undefined || decoded.steps.length === 0) return 'no-chain';
  let calls = 0;
  let fields = 0;
  for (const step of decoded.steps) {
    if (step.kind === 'call') calls++;
    else fields++;
  }
  if (calls > 0 && fields > 0) return 'chain-mixed';
  return calls > 0 ? 'chain-call' : 'chain-field';
}

export type ResolutionOutcomeRecorder = (outcome: ResolutionOutcome) => void;
