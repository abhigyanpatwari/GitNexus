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
  | 'overload-unknown'
  | 'overload-inapplicable'
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
      /** Public graph identities, kept separate from scope definition IDs. */
      readonly candidateGraphIds?: readonly string[];
      /** Public graph identities of the candidates' declaring types. */
      readonly candidateOwnerIds?: readonly string[];
      /** Public graph identity of the enclosing callable or initializer. */
      readonly callerId?: string;
      /** Candidate inventory and every required graph identity were proven. */
      readonly candidateSetComplete?: boolean;
      readonly detail?: string;
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
    }
  /**
   * The global-name fallback fired: a callable was chosen because its SIMPLE
   * NAME is unique in the workspace, with no import or scope chain leading to
   * it. A labeled low-confidence edge WAS emitted.
   *
   * Separate from `resolved` because it is not a resolution, and separate from
   * `suppressed` because an edge exists. Counting it is the only way a reader
   * can tell how much of a language's call graph rests on name uniqueness — the
   * number that was previously invisible because these edges were emitted with
   * the same reason and confidence as import-resolved ones.
   */
  | {
      readonly kind: 'fallback-guessed';
      readonly targetId: string;
      readonly language?: string;
      readonly phase: string;
      readonly filePath: string;
      readonly name: string;
      readonly range: Range;
    }
  /**
   * A global-name-fallback candidate was REFUSED by the language's plausibility
   * hook: the language's own visibility rules make that call impossible, so no
   * edge was emitted.
   *
   * The counterpart of `fallback-guessed`, and the pair is what makes the
   * refusal auditable — a refusal count with no guess count cannot distinguish
   * "the guard works" from "the guard rejects everything".
   */
  | {
      readonly kind: 'fallback-refused';
      readonly candidateId: string;
      readonly language?: string;
      readonly phase: string;
      readonly filePath: string;
      readonly name: string;
      readonly range: Range;
    }
  /**
   * A barrel re-exported `name` through two or more `export *` sources that
   * each declare it, so the language names no winner. The shared finalize pass
   * REFUSED the binding (see `FinalizeStats.ambiguousWildcardExports`) instead
   * of publishing the first-listed source as `import-resolved`; every importer
   * of `name` through `filePath` stays unresolved. No `range`: the collision
   * belongs to the file's export surface, not to one statement.
   */
  | {
      readonly kind: 'reexport-ambiguous';
      readonly candidateIds: readonly string[];
      readonly phase: string;
      /** The barrel file whose `export *` sources collide. */
      readonly filePath: string;
      readonly name: string;
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

/**
 * Identity of ONE reference site, for withdrawing that site's drop and no
 * other's.
 *
 * Position alone is not enough: `cfg.timeouts` (a read of `timeouts`) and
 * `cfg.timeouts.retry()` (a call of `retry`) both start at `cfg`, so a key of
 * file + line + column names two sites. The kind, member name, and full range
 * separate them, including repeated names such as `res.data.data`.
 */
export function answeredSiteKey(
  filePath: string,
  range: Range,
  siteKind: ReferenceKind,
  name: string,
): string {
  return `${filePath}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}:${siteKind}:${name}`;
}

/**
 * Withdraw every `receiver-unresolved` drop whose site a LATER pass answered
 * with an edge, keyed by {@link answeredSiteKey}. Returns how many it removed.
 *
 * The receiver-bound pass records a drop as soon as its own cases give up, but
 * it is not the last pass to see a read or write: the return-shape and
 * unique-name passes run after it and can still emit an `ACCESSES` edge for the
 * same site. A drop says the site was lost with no candidate, and a site with an
 * edge was not lost. A site those passes also left alone keeps its drop.
 *
 * A drop without a `siteKind` is kept: the key needs the kind, and guessing it
 * would withdraw on a weaker identity than the one the passes recorded.
 * Compacts in place, keeping the survivors in their recorded order.
 */
export function withdrawAnsweredReceiverDrops(
  outcomes: ResolutionOutcome[],
  answered: ReadonlySet<string>,
): number {
  if (answered.size === 0) return 0;
  let kept = 0;
  for (const outcome of outcomes) {
    const isAnsweredDrop =
      outcome.kind === 'suppressed' &&
      outcome.reason === 'receiver-unresolved' &&
      outcome.siteKind !== undefined &&
      answered.has(
        answeredSiteKey(outcome.filePath, outcome.range, outcome.siteKind, outcome.name),
      );
    if (isAnsweredDrop) continue;
    outcomes[kept] = outcome;
    kept++;
  }
  const withdrawn = outcomes.length - kept;
  outcomes.length = kept;
  return withdrawn;
}
