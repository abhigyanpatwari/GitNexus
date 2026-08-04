import type { Range, ReferenceKind } from 'gitnexus-shared';
import type { DecodedReceiverChain } from '../utils/receiver-chain-codec.js';

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
  | 'receiver-unresolved'
  /** Provider-owned, namespaced suppression reason. The shared pipeline keeps
   *  the value opaque so language semantics stay behind resolver hooks. */
  | `${string}: ${string}`;

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
      /**
       * Whether the receiver is rooted INSIDE the analyzed program.
       *
       * The single most important distinction a static-analysis tool can make
       * about a call it did not resolve, and the one this codebase previously
       * collapsed:
       *
       * - `in-program` — the receiver's base is a local, parameter, field or a
       *   type this index knows. Failing to type it is a RESOLVER DEFECT: a real
       *   caller exists in the graph and was lost.
       * - `external` — the base is rooted in code this index does not contain
       *   (`System.out.println`, `fetch(...)`, `os.environ.setdefault`). There is
       *   NO node to point an edge at, so nothing was lost. A compiler resolves
       *   these against the JDK / BCL / lib.d.ts; without those, the honest
       *   answer is "outside the program", not "unknown".
       *
       * Only `in-program` makes an `impact` count a lower bound. Reporting an
       * external target as uncertainty is what made the hedge fire on nearly
       * every real codebase and taught readers to ignore it.
       */
      readonly receiverOrigin?: ReceiverOrigin;
    };

/**
 * How a dropped receiver was spelled, structurally.
 *
 * - `chain-call`   every recorded step is a call — `svc.getUser().save()`
 * - `chain-field`  every recorded step is a field — `h.repo.save()`
 * - `chain-mixed`  the chain interleaves both — `svc.getUser().addr.save()`
 * - `chain-unwrap` the chain contains an `await` or `index` step — the shapes
 *                  this work exists to expose. They were previously counted as
 *                  FIELDS, because the classifier's parameter widened `kind` to
 *                  `string` and they fell into its `else`.
 * - `no-chain`     the site carried no chain, so the receiver was a compound
 *                  expression the capture walk could not reduce to a nameable
 *                  base (it stopped early, or the base was unencodable)
 */

export type ReceiverShape =
  | 'chain-call'
  | 'chain-field'
  | 'chain-mixed'
  | 'chain-unwrap'
  | 'no-chain';

/**
 * Is the receiver rooted inside the analyzed program, or outside it?
 *
 * `unknown` is for a site carrying no usable base at all — neither a chain nor
 * an explicit receiver — where the question cannot be asked. It is treated as
 * `in-program` for hedging purposes, because assuming completeness we cannot
 * demonstrate is the unsafe direction.
 */
export type ReceiverOrigin = 'in-program' | 'external' | 'unknown';

/** Classify a dropped receiver from its encoded chain. `undefined` chain ⇒
 *  `no-chain`; an undecodable one is also `no-chain`, since what we know about
 *  it is exactly that no usable structure survived.
 *
 *  Takes `DecodedReceiverChain` rather than a structural duck-type: widening
 *  `kind` to `string` let `await` and `index` fall into an `else` branch and be
 *  counted as FIELDS, so the two shapes this work exists to expose were
 *  censused as `chain-field`. The discriminated union makes a new step kind a
 *  compile error instead of a silent bucket. */
export function classifyReceiverShape(decoded: DecodedReceiverChain | undefined): ReceiverShape {
  if (decoded === undefined || decoded.steps.length === 0) return 'no-chain';
  let calls = 0;
  let fields = 0;
  let unwraps = 0;
  for (const step of decoded.steps) {
    switch (step.kind) {
      case 'call':
        calls++;
        break;
      case 'field':
        fields++;
        break;
      case 'await':
      case 'index':
        unwraps++;
        break;
    }
  }
  // An unwrap step dominates: a chain containing one fails for reasons a pure
  // field or call chain does not, so folding it into either bucket would
  // misattribute the population a fix has to target.
  if (unwraps > 0) return 'chain-unwrap';
  if (calls > 0 && fields > 0) return 'chain-mixed';
  return calls > 0 ? 'chain-call' : 'chain-field';
}

export type ResolutionOutcomeRecorder = (outcome: ResolutionOutcome) => void;
