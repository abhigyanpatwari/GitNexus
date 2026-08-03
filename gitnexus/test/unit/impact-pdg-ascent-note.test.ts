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

// A mock that drives ONE real inter-procedural descent hop: the criterion's
// reachable block calls `helper`, the descent resolves helper's span (so
// interproceduralHops > 0 and the note block fires). `summary` decides what
// `helper`'s CALL_SUMMARY row holds — the fact the note now keys on.
//
// The dependence BFS is routed by its bound `$frontier` (never by call order),
// so the ascent re-seed FROM the call block is deterministically distinguishable
// from the intra BFS out of the criterion seed.
function descentExec(
  file: string,
  summary: Summary,
  // P2-4 case 2: emit capped this block's `calleeIds` cell, so the cell carries
  // the truncation sentinel alongside the ids that survived. `splitCalleeIds`
  // strips the sentinel, which is exactly why the dropped callees are invisible
  // to the summary scan and the note's counters.
  calleeCellCapped = false,
): RunPdgImpactDeps['executeParameterized'] {
  const seed = `BasicBlock:${file}:1:0:0`;
  const callBlock = `BasicBlock:${file}:1:0:2`;
  const calleeSeed = `BasicBlock:${file}:5:0:0`;
  const ascentOnly = ascentOnlyBlock(file);
  const helper = `Function:${file}:helper`;
  const calleeCell = calleeCellCapped
    ? `${helper}${CALLEE_ID_SEP}${CALLEES_TRUNCATED_SENTINEL}`
    : helper;
  return async (_repo, query, params: Record<string, unknown>) => {
    // Top-level seed fetch is line-anchored (`a.startLine = $line`); the descent's
    // callee seed fetch is range-anchored — route by that.
    // Matches the seed fetch without pinning the clauses after the projection —
    // #2787 added `ORDER BY a.startLine, id` between the RETURN and the LIMIT.
    if (query.includes('RETURN a.id AS id')) {
      return query.includes('a.startLine = $line') ? [{ id: seed }] : [{ id: calleeSeed }];
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
      return [{ id: callBlock, calleeIds: calleeCell }];
    }
    if (query.includes("r.type = 'CALL_SUMMARY'")) {
      if (summary === null) return [];
      const reason = summary.kind === 'params' ? encodeCallSummary(summary.params) : summary.reason;
      return [{ id: helper, reason }];
    }
    if (query.includes('s.id IN $ids') && query.includes('AS filePath')) {
      return [{ id: helper, filePath: file, startLine: 4, endLine: 6 }];
    }
    if (query.includes('MATCH (b:BasicBlock) WHERE b.id IN $ids')) {
      return [
        { id: seed, line: 1, endLine: 1, text: 'run()' },
        { id: callBlock, line: 3, endLine: 3, text: 'x = helper()' },
        { id: ascentOnly, line: 4, endLine: 4, text: 'y = x + 1' },
        { id: calleeSeed, line: 5, endLine: 5, text: 'return 1' },
      ];
    }
    if (query.includes('MATCH (s:`Function`)')) return [];
    return [];
  };
}

const run = (
  file: string,
  callSummaryAvailable: boolean,
  summary: Summary = null,
  // `1` confines the intra BFS to a single dependence level, so the call block is
  // expanded ONLY by the ascent re-seed — the ascent's observable is then exact.
  // It also leaves the BFS frontier non-empty at the budget, which is how the
  // P2-4 cases below produce a genuinely TRUNCATED traversal.
  maxDepth = 3,
  calleeCellCapped = false,
) =>
  runImpactPDG({
    repo: { lbugPath: 'repo' },
    sym: { id: `Function:${file}:run`, name: 'run', filePath: file, startLine: 0, endLine: 7 },
    symType: 'Function',
    direction: 'downstream',
    maxDepth,
    limit: 50,
    line: 1,
    executeParameterized: descentExec(file, summary, calleeCellCapped),
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
    const result = await run('src/svc.ts', true, null);
    expect('affectedStatements' in result).toBe(true);
    expect(noteOf(result)).toContain(CAVEAT);
  });

  it('callee with a non-empty return-flow summary → no empty-ascent caveat', async () => {
    expect(noteOf(await run('src/svc.ts', true, flow([0])))).not.toContain(CAVEAT);
  });

  // An `r:0` summary decodes cleanly but records no formal→return flow, so the
  // ascent is still structurally empty. Pins that the note keys on the DECODED
  // return-flow rather than on the mere presence of a CALL_SUMMARY edge.
  it('callee with an empty (r:0) return-flow summary → caveat present', async () => {
    expect(noteOf(await run('src/svc.ts', true, flow([])))).toContain(CAVEAT);
  });

  // A cleanly-decoded EMPTY summary is the one case where the note may speak for
  // the persisted data — every summary in the slice was read.
  it('every summary decodes → the note keeps the persisted-summaries claim', async () => {
    expect(noteOf(await run('src/svc.ts', true, flow([])))).toContain(PERSISTED_CLAIM);
  });

  it('v3 index (callSummaryAvailable false) → re-index note, not the empty-ascent caveat', async () => {
    const note = noteOf(await run('src/svc.ts', false, null));
    expect(note).toContain('re-index for CALL_SUMMARY');
    expect(note).not.toContain(CAVEAT);
  });

  // #2802 — the two cases the language check used to get wrong, now impossible
  // to reintroduce: the note cannot vary by extension because nothing in
  // `pdg-impact.ts` reads one.
  it.each(EXTENSIONS)('%s with no return-flow summary → caveat present', async (file) => {
    expect(noteOf(await run(file, true, null))).toContain(CAVEAT);
  });

  it.each(EXTENSIONS)('%s with a return-flow summary → no caveat', async (file) => {
    expect(noteOf(await run(file, true, flow([0])))).not.toContain(CAVEAT);
  });

  // The strongest form of the language-agnosticism claim: hold CALL_SUMMARY
  // content fixed, vary only the extension, and require the note text to be
  // byte-identical modulo the file path the note legitimately echoes.
  it('note text does not vary with the criterion file extension', async () => {
    const notes = await Promise.all(
      EXTENSIONS.map(async (file) =>
        noteOf(await run(file, true, null))
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
    const note = noteOf(await run('src/svc.ts', true, raw(reason)));
    expect(note).toContain(CAVEAT);
    expect(note).not.toContain(PERSISTED_CLAIM);
  });

  it.each(UNDECODABLE)(
    '$label → note reports the undecodable summary + remedy',
    async ({ reason }) => {
      const note = noteOf(await run('src/svc.ts', true, raw(reason)));
      expect(note).toContain('1 callee summary could not be decoded (version skew or corruption)');
      expect(note).toContain('re-run gitnexus analyze --pdg to rebuild them');
    },
  );

  // Soundness, unchanged: an unreadable summary must NEVER license the ascent.
  // `maxDepth: 1` confines the intra BFS to one dependence level, so the
  // ascent-only block is reachable through the U-C4 re-seed and nothing else.
  it.each(UNDECODABLE)('$label → the return-value ascent is still withheld', async ({ reason }) => {
    const result = await run('src/svc.ts', true, raw(reason), 1);
    expect(blocksOf(result)).not.toContain(ascentOnlyBlock('src/svc.ts'));
    expect(noteOf(result)).toContain(CAVEAT);
  });

  // The discriminator for the row above: the SAME mock with a decodable
  // `p0 -> return` summary does re-seed the caller continuation.
  it('a decodable p0->return summary licenses the ascent', async () => {
    const result = await run('src/svc.ts', true, flow([0]), 1);
    expect(blocksOf(result)).toContain(ascentOnlyBlock('src/svc.ts'));
    expect(noteOf(result)).not.toContain(CAVEAT);
  });
});

// P2-4 — "none of the N resolved callees carry a … return-flow" is a UNIVERSAL
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
    const result = await run('src/svc.ts', true, null, 1);
    expect(truncatedOf(result)).toBe(true);
    expect(noteOf(result)).toContain(CAVEAT);
    expect(noteOf(result)).toContain(BUDGET_REASON);
    expect(noteOf(result)).toContain(QUALIFIER);
  });

  // An `r:0` summary decodes cleanly, so this is the branch that asserts "a
  // property of the persisted summaries" — a whole-slice claim a truncated
  // traversal did not establish.
  it('truncated traversal → the unqualified persisted-summaries claim is dropped', async () => {
    const note = noteOf(await run('src/svc.ts', true, flow([]), 1));
    expect(note).toContain(QUALIFIER);
    expect(note).not.toContain(PERSISTED_CLAIM);
  });

  // The control that keeps the fix from being "always hedge": the SAME mock with
  // a budget large enough to exhaust the frontier keeps the flat claim.
  it('untruncated traversal → the claim stays unqualified', async () => {
    const result = await run('src/svc.ts', true, null);
    expect(truncatedOf(result)).toBe(false);
    expect(noteOf(result)).toContain(CAVEAT);
    expect(noteOf(result)).not.toContain(QUALIFIER);
    expect(noteOf(result)).not.toContain(BUDGET_REASON);
  });

  it('untruncated traversal → the persisted-summaries claim survives', async () => {
    const note = noteOf(await run('src/svc.ts', true, flow([])));
    expect(note).toContain(PERSISTED_CLAIM);
    expect(note).not.toContain(QUALIFIER);
  });

  // Case 2 in isolation: the traversal completes (truncated === false), so the
  // emit-time cap sentinel is the ONLY thing the qualifier can come from.
  it('emit-capped calleeIds cell → the claim is qualified with nothing else truncated', async () => {
    const result = await run('src/svc.ts', true, null, 3, true);
    expect(truncatedOf(result)).toBe(false);
    expect(noteOf(result)).toContain(EMIT_CAP_REASON);
    expect(noteOf(result)).toContain(QUALIFIER);
    expect(noteOf(result)).not.toContain(BUDGET_REASON);
  });

  it('emit-capped calleeIds cell → the unqualified persisted-summaries claim is dropped', async () => {
    const note = noteOf(await run('src/svc.ts', true, flow([]), 3, true));
    expect(note).toContain(QUALIFIER);
    expect(note).not.toContain(PERSISTED_CLAIM);
  });

  // Both mechanisms at once: ONE clause naming both reasons, never two clauses.
  it('both mechanisms → one qualifier clause names both reasons', async () => {
    const note = noteOf(await run('src/svc.ts', true, null, 1, true));
    expect(note).toContain(`(${BUDGET_REASON} and ${EMIT_CAP_REASON}, ${QUALIFIER})`);
    expect(note.split(QUALIFIER)).toHaveLength(2);
  });

  // The undecodable-summary branch carries the same universal quantifier, so it
  // gets the same qualifier — alongside its own (unrelated) P2-2 wording.
  it('undecodable summary + truncated traversal → both qualifications appear', async () => {
    const note = noteOf(await run('src/svc.ts', true, raw('1|r:zz'), 1));
    expect(note).toContain(QUALIFIER);
    expect(note).toContain('could not be decoded (version skew or corruption)');
    expect(note).not.toContain(PERSISTED_CLAIM);
  });
});
