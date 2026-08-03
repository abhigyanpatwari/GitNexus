// U7 — when the CALL_SUMMARY layer is present but none of the callees the slice
// resolved carries a return-flow summary, the impact note says the ascent was
// structurally empty instead of letting the omission read as "ascent ran and
// found nothing".
//
// #2802 — the note keys on the PERSISTED SUMMARIES, never on the criterion's
// language. `pdg-impact.ts` names no language and imports nothing from the
// language layer. The tests below pin that: the note flips on CALL_SUMMARY
// content while the file extension is held constant, and is identical across
// extensions while the CALL_SUMMARY content is held constant.

import { describe, expect, it } from 'vitest';
import { runImpactPDG, type RunPdgImpactDeps } from '../../src/mcp/local/pdg-impact.js';
import { encodeCallSummary } from '../../src/core/ingestion/taint/call-summary-codec.js';
import { CALLEES_TRUNCATED_SENTINEL, CALLEE_ID_SEP } from '../../src/core/ingestion/cfg/emit.js';

/**
 * What the mock's CALL_SUMMARY query returns for `helper`:
 *  - `null`     — no CALL_SUMMARY row at all (a callee whose summary was never
 *                 persisted);
 *  - `'params'` — a real `encodeCallSummary` wire string (the codec is the
 *                 producer, so the round trip is genuine);
 *  - `'raw'`    — a `reason` cell verbatim, used for the UNDECODABLE cases the
 *                 codec must reject without throwing.
 */
type Summary =
  | null
  | { readonly kind: 'params'; readonly params: readonly number[] }
  | { readonly kind: 'raw'; readonly reason: unknown };

const flow = (params: readonly number[]): Summary => ({ kind: 'params', params });
const raw = (reason: unknown): Summary => ({ kind: 'raw', reason });

// The one block reachable ONLY through the U-C4 return-value ascent: the caller
// continuation re-seeded FROM the call block once a callee's CALL_SUMMARY
// licenses the ascent. Its presence in `reachableBlocks` is the direct
// observable of "the ascent fired"; its absence, of "the ascent was withheld".
const ascentOnlyBlock = (file: string): string => `BasicBlock:${file}:1:0:9`;

// The one callee id in the mock's `calleeIds` cell that RESOLVES to a span: a
// `Function` node, which is what `resolveCalleeSpans` matches, so the descent
// enters its body. Every other id a test puts in the cell (P3-7 below) is
// deliberately un-enterable.
const helperCalleeId = (file: string): string => `Function:${file}:helper`;

// P2-5 — the SECOND, DISTINCT callee. It is named ONLY in the `calleeIds` cell of
// `helper`'s own body block, so the descent has to cross a second call boundary
// before it ever sees the id. That is the only shape under which the cross-hop
// accumulators (`calleeReferencesSeen`, and the sticky `anyReturnFlow`) do any
// work — a cell carrying several ids is still one hop, and one hop cannot tell an
// accumulation apart from an overwrite.
const secondCalleeId = (file: string): string => `Function:${file}:helper2`;
// The two callees' 0-based symbol spans. `blockAnchorForResolvedSymbol` binds
// `$symStart = startLine + 1` on the RANGE-anchored per-callee seed fetch, so the
// spans are what route that fetch to each callee's own body block — the descent
// never asks for a body by callee id, only by span.
const HELPER_SPAN = { startLine: 4, endLine: 6 } as const;
const SECOND_SPAN = { startLine: 8, endLine: 10 } as const;
const symStartOf = (span: { readonly startLine: number }): number => span.startLine + 1;
// `helper2`'s body seed — the direct observable of "hop 1 reached new ground",
// which is what separates a genuine second hop from a wider first one.
const secondCalleeSeedBlock = (file: string): string =>
  `BasicBlock:${file}:${symStartOf(SECOND_SPAN)}:0:0`;

// The mock's knobs — all orthogonal, each with a safe default.
interface DescentOptions {
  // What `helper`'s CALL_SUMMARY row holds — the fact the note keys on. Default `null`.
  readonly summary?: Summary;
  // P2-4 case 2: emit capped this block's `calleeIds` cell, so the cell carries
  // the truncation sentinel alongside the ids that survived. `splitCalleeIds`
  // strips the sentinel, which is exactly why the dropped callees are invisible
  // to the summary scan and the note's counters.
  readonly calleeCellCapped?: boolean;
  // P3-7 case: the exact id list the call block's `calleeIds` cell carries.
  // Defaults to the single enterable `helper`. A test overrides it to mix in ids
  // the descent can never enter — `resolveCalleeSpans` matches only
  // Function/Method/Constructor, so anything else yields no span and is skipped
  // while still riding the cell (and still being scanned for a CALL_SUMMARY).
  readonly calleeIds?: readonly string[];
  // P2-5 case: what the SECOND, distinct callee's CALL_SUMMARY row holds.
  // OMITTED ⇒ no second hop at all (every case above the P2-5 block). Any
  // `Summary` — including `null`, meaning "a callee with no CALL_SUMMARY row" —
  // puts `helper2` in the cell of HELPER's body block, so the descent reaches it
  // only by crossing a second call boundary.
  readonly secondSummary?: Summary;
}

// A mock that drives ONE real inter-procedural descent hop: the criterion's
// reachable block calls `helper`, the descent resolves helper's span (so
// interproceduralHops > 0 and the note block fires).
//
// The dependence BFS is routed by its bound `$frontier` (never by call order),
// so the ascent re-seed FROM the call block is deterministically distinguishable
// from the intra BFS out of the criterion seed.
function descentExec(
  file: string,
  { summary = null, calleeCellCapped = false, calleeIds, secondSummary }: DescentOptions = {},
): RunPdgImpactDeps['executeParameterized'] {
  const seed = `BasicBlock:${file}:1:0:0`;
  const callBlock = `BasicBlock:${file}:1:0:2`;
  const calleeSeed = `BasicBlock:${file}:${symStartOf(HELPER_SPAN)}:0:0`;
  const secondSeed = secondCalleeSeedBlock(file);
  const ascentOnly = ascentOnlyBlock(file);
  const helper = helperCalleeId(file);
  const second = secondCalleeId(file);
  const cellIds = calleeIds ?? [helper];
  const calleeCell = (
    calleeCellCapped ? [...cellIds, CALLEES_TRUNCATED_SENTINEL] : [...cellIds]
  ).join(CALLEE_ID_SEP);
  // Both the span resolve and the CALL_SUMMARY scan bind the ids they ask about
  // as `$ids`, so the mock answers PER ASKED ID — an id the descent cannot enter
  // must not borrow another callee's span or summary, and `helper2` must not be
  // answerable until the hop that actually asks for it.
  const spans = new Map<string, { readonly startLine: number; readonly endLine: number }>([
    [helper, HELPER_SPAN],
  ]);
  const summaries = new Map<string, Summary>([[helper, summary]]);
  if (secondSummary !== undefined) {
    spans.set(second, SECOND_SPAN);
    summaries.set(second, secondSummary);
  }
  const askedIds = (params: Record<string, unknown>): string[] => {
    const ids = params['ids'];
    return Array.isArray(ids) ? ids.map((id) => String(id)) : [];
  };
  return async (_repo, query, params: Record<string, unknown>) => {
    // Top-level seed fetch is line-anchored (`a.startLine = $line`); the descent's
    // callee seed fetch is range-anchored — route by that.
    // Matches the seed fetch without pinning the clauses after the projection —
    // #2787 added `ORDER BY a.startLine, id` between the RETURN and the LIMIT.
    if (query.includes('RETURN a.id AS id')) {
      if (query.includes('a.startLine = $line')) return [{ id: seed }];
      // Range-anchored, so `$symStart` (= the callee span's startLine + 1) is the
      // only thing distinguishing the two callees' bodies.
      return params['symStart'] === symStartOf(SECOND_SPAN)
        ? [{ id: secondSeed }]
        : [{ id: calleeSeed }];
    }
    if (query.includes('MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)')) {
      const frontier = params['frontier'];
      const ids = Array.isArray(frontier) ? frontier.map((id) => String(id)) : [];
      if (ids.includes(seed)) return [{ id: callBlock }];
      // Only the ascent re-seed (and, at maxDepth > 1, the intra BFS's own next
      // level) expands the call block.
      if (ids.includes(callBlock)) return [{ id: ascentOnly }];
      return [];
    }
    if (query.includes('RETURN b.id AS id, b.calleeIds AS calleeIds')) {
      const asked = askedIds(params);
      // Hop 1 gathers callees from HELPER's body blocks; that cell — and only that
      // cell — carries the second callee, so the second hop cannot be reached by
      // widening the first block's cell.
      if (secondSummary !== undefined && asked.includes(calleeSeed)) {
        return [{ id: calleeSeed, calleeIds: second }];
      }
      return asked.includes(callBlock) ? [{ id: callBlock, calleeIds: calleeCell }] : [];
    }
    if (query.includes("r.type = 'CALL_SUMMARY'")) {
      return askedIds(params).flatMap((id) => {
        const row = summaries.get(id);
        // Not in the table (an id no test gave a callee fixture) or an explicit
        // `null` (a callee whose summary was never persisted) ⇒ no row.
        if (row === undefined || row === null) return [];
        const reason = row.kind === 'params' ? encodeCallSummary(row.params) : row.reason;
        return [{ id, reason }];
      });
    }
    if (query.includes('s.id IN $ids') && query.includes('AS filePath')) {
      return askedIds(params).flatMap((id) => {
        const span = spans.get(id);
        return span === undefined
          ? []
          : [{ id, filePath: file, startLine: span.startLine, endLine: span.endLine }];
      });
    }
    if (query.includes('MATCH (b:BasicBlock) WHERE b.id IN $ids')) {
      return [
        { id: seed, line: 1, endLine: 1, text: 'run()' },
        { id: callBlock, line: 3, endLine: 3, text: 'x = helper()' },
        { id: ascentOnly, line: 4, endLine: 4, text: 'y = x + 1' },
        {
          id: calleeSeed,
          line: 5,
          endLine: 5,
          text: secondSummary === undefined ? 'return 1' : 'return helper2()',
        },
        // Only ever reachable — and so only ever projected — on a second hop.
        {
          id: secondSeed,
          line: symStartOf(SECOND_SPAN),
          endLine: symStartOf(SECOND_SPAN),
          text: 'return 2',
        },
      ];
    }
    if (query.includes('MATCH (s:`Function`)')) return [];
    return [];
  };
}

// `run`'s own knobs on top of the mock's; the rest pass through untouched, so
// every default is written once, at the function that consumes it.
interface RunOptions extends DescentOptions {
  // `false` ⇒ a v3 index with no CALL_SUMMARY layer, which gets the re-index note
  // instead of the empty-ascent caveat. Defaults to `true`.
  readonly callSummaryAvailable?: boolean;
  // `1` confines the intra BFS to a single dependence level, so the call block is
  // expanded ONLY by the ascent re-seed — the ascent's observable is then exact.
  // It also leaves the BFS frontier non-empty at the budget, which is how the
  // P2-4 cases below produce a genuinely TRUNCATED traversal. Defaults to `3`.
  readonly maxDepth?: number;
}

const run = (
  file: string,
  { callSummaryAvailable = true, maxDepth = 3, ...descent }: RunOptions = {},
) =>
  runImpactPDG({
    repo: { lbugPath: 'repo' },
    sym: { id: `Function:${file}:run`, name: 'run', filePath: file, startLine: 0, endLine: 7 },
    symType: 'Function',
    direction: 'downstream',
    maxDepth,
    limit: 50,
    line: 1,
    executeParameterized: descentExec(file, descent),
    callSummaryAvailable,
  });

const CAVEAT = 'no return-value ascent in this slice';
// The sentence P2-2 flagged: an assertion about what the PERSISTED summaries
// record, which an UNDECODABLE summary contradicts (the codec never throws, so
// an unreadable `reason` is otherwise reported as one recording no return-flow).
const PERSISTED_CLAIM = 'property of the persisted summaries';

// P2-4 — the qualifier the note must carry whenever the callee set the descent
// EXAMINED is known to be a strict subset of the slice's real one, plus the two
// reasons that can put it there.
const QUALIFIER = 'so callees past the examined set were not checked';
const BUDGET_REASON = 'the traversal stopped at its depth/size budget';
const EMIT_CAP_REASON = "a slice block's call-site list was capped at emit";

const noteOf = (result: Awaited<ReturnType<typeof run>>): string =>
  'affectedStatements' in result ? (result.note ?? '') : '';

const blocksOf = (result: Awaited<ReturnType<typeof run>>): readonly string[] =>
  'reachableBlocks' in result ? result.reachableBlocks : [];

// The traversal-truncation premise of the P2-4 cases, asserted directly so a
// mock drift that stops truncating fails loudly instead of quietly turning the
// "qualifier appears" cases into copies of the "claim stays flat" ones.
const truncatedOf = (result: Awaited<ReturnType<typeof run>>): boolean =>
  'reachableBlocks' in result && result.truncated === true;

// Held constant across the language-agnosticism cases below. One per language
// family the analyzer supports parsing, including the module-suffix variants the
// old provider-registry lookup did not recognise.
const EXTENSIONS = [
  'src/svc.ts',
  'src/svc.js',
  'src/svc.mts',
  'src/svc.cjs',
  'src/svc.py',
  'src/svc.go',
  'src/svc.rs',
  'src/svc.java',
  'src/svc.zzz',
];

describe('runImpactPDG — empty-ascent note (U7)', () => {
  it('callees with no CALL_SUMMARY row → notes the ascent was structurally empty', async () => {
    const result = await run('src/svc.ts');
    expect('affectedStatements' in result).toBe(true);
    expect(noteOf(result)).toContain(CAVEAT);
  });

  it('callee with a non-empty return-flow summary → no empty-ascent caveat', async () => {
    expect(noteOf(await run('src/svc.ts', { summary: flow([0]) }))).not.toContain(CAVEAT);
  });

  // An `r:0` summary decodes cleanly but records no formal→return flow, so the
  // ascent is still structurally empty. Pins that the note keys on the DECODED
  // return-flow rather than on the mere presence of a CALL_SUMMARY edge.
  it('callee with an empty (r:0) return-flow summary → caveat present', async () => {
    expect(noteOf(await run('src/svc.ts', { summary: flow([]) }))).toContain(CAVEAT);
  });

  // A cleanly-decoded EMPTY summary is the one case where the note may speak for
  // the persisted data — every summary in the slice was read.
  it('every summary decodes → the note keeps the persisted-summaries claim', async () => {
    expect(noteOf(await run('src/svc.ts', { summary: flow([]) }))).toContain(PERSISTED_CLAIM);
  });

  it('v3 index (callSummaryAvailable false) → re-index note, not the empty-ascent caveat', async () => {
    const note = noteOf(await run('src/svc.ts', { callSummaryAvailable: false }));
    expect(note).toContain('re-index for CALL_SUMMARY');
    expect(note).not.toContain(CAVEAT);
  });

  // #2802 — the two cases the language check used to get wrong, now impossible
  // to reintroduce: the note cannot vary by extension because nothing in
  // `pdg-impact.ts` reads one.
  it.each(EXTENSIONS)('%s with no return-flow summary → caveat present', async (file) => {
    expect(noteOf(await run(file))).toContain(CAVEAT);
  });

  it.each(EXTENSIONS)('%s with a return-flow summary → no caveat', async (file) => {
    expect(noteOf(await run(file, { summary: flow([0]) }))).not.toContain(CAVEAT);
  });

  // The strongest form of the language-agnosticism claim: hold CALL_SUMMARY
  // content fixed, vary only the extension, and require the note text to be
  // byte-identical modulo the file path the note legitimately echoes.
  it('note text does not vary with the criterion file extension', async () => {
    const notes = await Promise.all(
      EXTENSIONS.map(async (file) =>
        noteOf(await run(file))
          .split(file)
          .join('<FILE>'),
      ),
    );
    expect(new Set(notes).size).toBe(1);
  });
});

// P2-2 — `decodeCallSummary` NEVER throws, so an unreadable `reason` yields no
// entry, indistinguishable from a cleanly-decoded empty summary. Each row below
// is a CALL_SUMMARY that DOES record `p0 -> return`, in a form this reader cannot
// unpack. The note must therefore stop asserting what the persisted summaries
// record — while the ascent stays withheld (a decode failure means "no usable
// ascent fact", never a claimed return-flow).
const UNDECODABLE: ReadonlyArray<{ label: string; reason: unknown }> = [
  // Future codec version, same `r:1` payload `encodeCallSummary([0])` emits today.
  { label: 'version skew (2|r:1)', reason: '2|r:1' },
  // Version 1, non-hex payload.
  { label: 'corrupt payload (1|r:zz)', reason: '1|r:zz' },
  // A NULL `reason` cell.
  { label: 'NULL reason', reason: null },
];

describe('runImpactPDG — undecodable CALL_SUMMARY (P2-2)', () => {
  it.each(UNDECODABLE)('$label → note drops the persisted-summaries claim', async ({ reason }) => {
    const note = noteOf(await run('src/svc.ts', { summary: raw(reason) }));
    expect(note).toContain(CAVEAT);
    expect(note).not.toContain(PERSISTED_CLAIM);
  });

  it.each(UNDECODABLE)(
    '$label → note reports the undecodable summary + remedy',
    async ({ reason }) => {
      const note = noteOf(await run('src/svc.ts', { summary: raw(reason) }));
      expect(note).toContain('1 callee summary could not be decoded (version skew or corruption)');
      expect(note).toContain('re-run gitnexus analyze --pdg to rebuild them');
    },
  );

  // Soundness, unchanged: an unreadable summary must NEVER license the ascent.
  // `maxDepth: 1` confines the intra BFS to one dependence level, so the
  // ascent-only block is reachable through the U-C4 re-seed and nothing else.
  it.each(UNDECODABLE)('$label → the return-value ascent is still withheld', async ({ reason }) => {
    const result = await run('src/svc.ts', { summary: raw(reason), maxDepth: 1 });
    expect(blocksOf(result)).not.toContain(ascentOnlyBlock('src/svc.ts'));
    expect(noteOf(result)).toContain(CAVEAT);
  });

  // The discriminator for the row above: the SAME mock with a decodable
  // `p0 -> return` summary does re-seed the caller continuation.
  it('a decodable p0->return summary licenses the ascent', async () => {
    const result = await run('src/svc.ts', { summary: flow([0]), maxDepth: 1 });
    expect(blocksOf(result)).toContain(ascentOnlyBlock('src/svc.ts'));
    expect(noteOf(result)).not.toContain(CAVEAT);
  });
});

// P2-4 — "none of the N … callee references carry a … return-flow" is a UNIVERSAL
// claim over the callees the descent actually examined, and so is "this is a
// property of the persisted summaries". Two mechanisms make that examined set a
// strict subset of the slice's real callee list, and under either the note must
// describe what it examined rather than assert a property of the whole slice:
//  1. the traversal stopped at a depth/size budget — a callee that DOES carry a
//     return-flow can sit past the frontier;
//  2. a block's `calleeIds` cell was capped at emit — `splitCalleeIds` strips the
//     sentinel, so those callees reach neither the summary scan nor the counters.
describe('runImpactPDG — empty-ascent note over an incomplete callee set (P2-4)', () => {
  // `maxDepth: 1` leaves the intra BFS frontier non-empty at the budget, which is
  // a genuinely truncated traversal (asserted, not assumed).
  it('truncated traversal → the empty-ascent claim is qualified', async () => {
    const result = await run('src/svc.ts', { maxDepth: 1 });
    expect(truncatedOf(result)).toBe(true);
    expect(noteOf(result)).toContain(CAVEAT);
    expect(noteOf(result)).toContain(BUDGET_REASON);
    expect(noteOf(result)).toContain(QUALIFIER);
  });

  // An `r:0` summary decodes cleanly, so this is the branch that asserts "a
  // property of the persisted summaries" — a whole-slice claim a truncated
  // traversal did not establish.
  it('truncated traversal → the unqualified persisted-summaries claim is dropped', async () => {
    const note = noteOf(await run('src/svc.ts', { summary: flow([]), maxDepth: 1 }));
    expect(note).toContain(QUALIFIER);
    expect(note).not.toContain(PERSISTED_CLAIM);
  });

  // The control that keeps the fix from being "always hedge": the SAME mock with
  // a budget large enough to exhaust the frontier keeps the flat claim.
  it('untruncated traversal → the claim stays unqualified', async () => {
    const result = await run('src/svc.ts');
    expect(truncatedOf(result)).toBe(false);
    expect(noteOf(result)).toContain(CAVEAT);
    expect(noteOf(result)).not.toContain(QUALIFIER);
    expect(noteOf(result)).not.toContain(BUDGET_REASON);
  });

  it('untruncated traversal → the persisted-summaries claim survives', async () => {
    const note = noteOf(await run('src/svc.ts', { summary: flow([]) }));
    expect(note).toContain(PERSISTED_CLAIM);
    expect(note).not.toContain(QUALIFIER);
  });

  // Case 2 in isolation: the traversal completes (truncated === false), so the
  // emit-time cap sentinel is the ONLY thing the qualifier can come from.
  it('emit-capped calleeIds cell → the claim is qualified with nothing else truncated', async () => {
    const result = await run('src/svc.ts', { calleeCellCapped: true });
    expect(truncatedOf(result)).toBe(false);
    expect(noteOf(result)).toContain(EMIT_CAP_REASON);
    expect(noteOf(result)).toContain(QUALIFIER);
    expect(noteOf(result)).not.toContain(BUDGET_REASON);
  });

  it('emit-capped calleeIds cell → the unqualified persisted-summaries claim is dropped', async () => {
    const note = noteOf(await run('src/svc.ts', { summary: flow([]), calleeCellCapped: true }));
    expect(note).toContain(QUALIFIER);
    expect(note).not.toContain(PERSISTED_CLAIM);
  });

  // Both mechanisms at once: ONE clause naming both reasons, never two clauses.
  it('both mechanisms → one qualifier clause names both reasons', async () => {
    const note = noteOf(await run('src/svc.ts', { maxDepth: 1, calleeCellCapped: true }));
    expect(note).toContain(`(${BUDGET_REASON} and ${EMIT_CAP_REASON}, ${QUALIFIER})`);
    expect(note.split(QUALIFIER)).toHaveLength(2);
  });

  // The undecodable-summary branch carries the same universal quantifier, so it
  // gets the same qualifier — alongside its own (unrelated) P2-2 wording.
  it('undecodable summary + truncated traversal → both qualifications appear', async () => {
    const note = noteOf(await run('src/svc.ts', { summary: raw('1|r:zz'), maxDepth: 1 }));
    expect(note).toContain(QUALIFIER);
    expect(note).toContain('could not be decoded (version skew or corruption)');
    expect(note).not.toContain(PERSISTED_CLAIM);
  });
});

// P3-7 — the number the empty-ascent sentence quotes is the count of CALL-SITE
// callee REFERENCES the descent scanned for a CALL_SUMMARY (the raw `calleeIds`
// ids), NOT the count of callees it resolved to a body and descended into. The
// two differ whenever a cell carries an id `resolveCalleeSpans` does not match:
// an out-of-repo target, an interface method, or a node kind with no CFG body.
// The scan really is run over all of them, so the claim is exact at reference
// granularity — but calling them "resolved" asserted a symbol-table lookup that
// never happened, and the old formals parenthetical ("no formal parameter is
// recorded as flowing to its return value") asserted a FORMALS-level property
// about symbols that were never resolved to a body at all.
const FILE = 'src/svc.ts';
// Ids a real `calleeIds` cell genuinely carries and the descent can never enter.
// The `Class:` id is the reproduced case — a `new Outer()` call site contributes
// it (see test/integration/cfg/pdg-chained-receiver-callees.test.ts), which is
// what inflated the quoted number from 1 to 3 there.
const UNENTERABLE_CALLEES = [`Class:${FILE}:Outer`, `Interface:${FILE}:Sink.write`] as const;
const MIXED_CALLEES = [helperCalleeId(FILE), ...UNENTERABLE_CALLEES] as const;

describe('runImpactPDG — the empty-ascent count is call-site references (P3-7)', () => {
  it('un-enterable callee ids count, and the note names them as call-site references', async () => {
    expect(noteOf(await run(FILE, { calleeIds: MIXED_CALLEES }))).toContain(
      'none of the 3 call-site callee references carry a CALL_SUMMARY return-flow',
    );
  });

  // The same slice with only the enterable callee: the number tracks the CELL,
  // and the singular form agrees with it.
  it('dropping the un-enterable ids drops the quoted number to 1', async () => {
    expect(noteOf(await run(FILE))).toContain(
      'none of the 1 call-site callee reference carries a CALL_SUMMARY return-flow',
    );
  });

  // The load-bearing discriminator: the two extra ids raise the quoted number by
  // 2 while adding NOTHING to the traversal — the descent resolved no span for
  // them, so it entered no body. That gap is exactly what "resolved" papered over.
  it('the un-enterable ids add to the number without adding any reach', async () => {
    const [mixed, helperOnly] = await Promise.all([
      run(FILE, { calleeIds: MIXED_CALLEES }),
      run(FILE),
    ]);
    // Same slice, byte-identical reach — the descent entered exactly one body in
    // both runs …
    expect(blocksOf(mixed).length).toBeGreaterThan(0);
    expect(blocksOf(mixed)).toEqual(blocksOf(helperOnly));
    // … while the quoted number moved 1 → 3, which is only honest because the
    // note quotes call-site references rather than resolved callees.
    expect(noteOf(mixed)).toContain('none of the 3 call-site callee references carry');
    expect(noteOf(helperOnly)).toContain('none of the 1 call-site callee reference carries');
  });

  it('the note no longer calls the counted ids resolved callees', async () => {
    expect(noteOf(await run(FILE, { calleeIds: MIXED_CALLEES }))).not.toContain('resolved callee');
  });

  it('the note drops the formals parenthetical', async () => {
    expect(noteOf(await run(FILE, { calleeIds: MIXED_CALLEES }))).not.toContain(
      'no formal parameter is recorded',
    );
  });

  // The undecodable branch quotes the same count and needed the same rewording.
  it('undecodable branch → same call-site wording over the same count', async () => {
    const note = noteOf(await run(FILE, { summary: raw('1|r:zz'), calleeIds: MIXED_CALLEES }));
    expect(note).toContain(
      'none of the 3 call-site callee references carry a decodable CALL_SUMMARY return-flow',
    );
    expect(note).not.toContain('resolved callee');
  });

  // GATE: the sentence fires on the descent having CROSSED a hop, never on the
  // reference count. A cell whose ids are ALL un-enterable resolves no span, so
  // no hop is taken and no ascent sentence is emitted — even though the reference
  // count is 2. Pinned so re-seeding the count from the resolved spans cannot
  // silently change WHEN the note fires.
  it('a cell with no enterable callee takes no hop, so no ascent sentence fires', async () => {
    const note = noteOf(await run(FILE, { calleeIds: UNENTERABLE_CALLEES }));
    expect(note).not.toContain('inter-procedural hop');
    expect(note).not.toContain(CAVEAT);
  });
});

// P2-5 — what the note quotes is CROSS-HOP: `calleeReferencesSeen` in
// `interproceduralDescent` is a union of every hop's callee set, and
// `anyReturnFlow` is a flag that sticks once ANY hop found a return-flow. Both are
// accumulated once per hop and read only after the hop loop ends. Every case above
// takes exactly ONE hop, so none of them can tell that accumulation from a per-hop
// overwrite: with one hop both produce the same numbers. The cases below take TWO
// hops reaching DIFFERENT callees — `helper` on hop 0, `helper2` (named only in
// helper's own body block) on hop 1 — which is the only shape where the two
// implementations disagree.
//
// They also pin the MIXED boundary. The empty-ascent sentence is gated on
// `anyReturnFlow` being false, so a single return-flowing callee silences the note
// entirely — no caveat, no "1 of 3" partial figure, not even the
// undecodable-summary remedy. That binary behavior is deliberate (partial-coverage
// reporting was considered and dropped); pinned here so changing it is a decision
// rather than an accident.
const TWO_HOPS = 'crosses 2 inter-procedural hops';

describe('runImpactPDG — cross-hop accumulation and mixed return-flow (P2-5)', () => {
  it('two hops over DISTINCT callees → the reference count is their UNION', async () => {
    const result = await run(FILE, { secondSummary: null });
    // Premise, asserted rather than assumed: the descent crossed TWO call
    // boundaries and the second one reached ground the first did not.
    expect(noteOf(result)).toContain(TWO_HOPS);
    expect(blocksOf(result)).toContain(secondCalleeSeedBlock(FILE));
    // Nothing truncated, so the count is quoted flat and the P2-4 qualifier is
    // not what is being read here.
    expect(truncatedOf(result)).toBe(false);
    expect(noteOf(result)).not.toContain(QUALIFIER);
    // hop 0 contributes {helper}, hop 1 contributes {helper2} ⇒ 2. A per-hop
    // overwrite ends holding only hop 1's set and quotes 1.
    expect(noteOf(result)).toContain(
      'none of the 2 call-site callee references carry a CALL_SUMMARY return-flow',
    );
  });

  it('a return-flow found on hop 0 survives a later hop that finds none', async () => {
    const result = await run(FILE, { summary: flow([0]), secondSummary: null });
    expect(noteOf(result)).toContain(TWO_HOPS);
    expect(blocksOf(result)).toContain(secondCalleeSeedBlock(FILE));
    // `helper` return-flows, `helper2` does not. The flag raised on hop 0 sticks,
    // so the note stays silent; a per-hop overwrite would end on hop 1's EMPTY
    // result and wrongly emit the caveat over 2 references.
    expect(noteOf(result)).not.toContain(CAVEAT);
  });

  it('a return-flow found only on hop 1 also silences the note', async () => {
    const result = await run(FILE, { secondSummary: flow([0]) });
    expect(noteOf(result)).toContain(TWO_HOPS);
    expect(blocksOf(result)).toContain(secondCalleeSeedBlock(FILE));
    // The mirror image of the row above: hop 0 found nothing, hop 1 did. The note
    // keys on the ACCUMULATED flag, never on the first hop's view of it.
    expect(noteOf(result)).not.toContain(CAVEAT);
  });

  it('mixed callees in ONE examined set → the note goes silent, never partial', async () => {
    const [mixed, none] = await Promise.all([
      run(FILE, { summary: flow([0]), calleeIds: MIXED_CALLEES }),
      run(FILE, { calleeIds: MIXED_CALLEES }),
    ]);
    // Same 3 call-site references in both runs; only `helper`'s summary differs.
    // One return-flow raises `anyReturnFlow`, which is enough to close the gate, so
    // NO empty-ascent sentence is emitted — the note quotes no count at all rather
    // than reporting "1 of 3 carried a return-flow".
    expect(noteOf(mixed)).not.toContain(CAVEAT);
    expect(noteOf(mixed)).not.toContain('call-site callee reference');
    // The discriminator that makes the silence load-bearing: drop that one
    // return-flow and the SAME 3 references do produce the sentence.
    expect(noteOf(none)).toContain('none of the 3 call-site callee references carry');
  });

  it('a return-flowing callee alongside an UNDECODABLE one → not even the decode remedy', async () => {
    const note = noteOf(await run(FILE, { summary: flow([0]), secondSummary: raw('1|r:zz') }));
    expect(note).toContain(TWO_HOPS);
    // The empty-ascent sentence — and so both of its tails — is gated on
    // `anyReturnFlow`, so the hop-1 undecodable summary, normally reported with a
    // rebuild remedy, is suppressed by the hop-0 return-flow. Silent end to end.
    expect(note).not.toContain(CAVEAT);
    expect(note).not.toContain('could not be decoded');
  });
});
