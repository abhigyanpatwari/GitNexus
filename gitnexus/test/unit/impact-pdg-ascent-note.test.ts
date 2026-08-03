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
import {
  runImpactPDG,
  type PdgAscentCoverage,
  type PdgAscentIncompleteReason,
  type RunPdgImpactDeps,
} from '../../src/mcp/local/pdg-impact.js';
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

// P1 — `helper`'s body as a straight dependence CHAIN hanging off its seed block
// (`calleeSeed` → C1 → C2 → C3 → C4, one dependence level per link). The
// per-callee BFS runs under the same depth clamp as the top-level intra pass, so
// at the production default `maxDepth: 3` it spends its whole budget on C1..C3 and
// never reaches C4. That is the only shape in which a callee's OWN traversal, and
// nothing else, is what stops the slice.
const CALLEE_CHAIN_LENGTH = 4;
const calleeChainBlock = (file: string, step: number): string =>
  `BasicBlock:${file}:${symStartOf(HELPER_SPAN)}:0:${step}`;
// The callee named ONLY in the deepest chain block's cell, carrying a REAL
// `encodeCallSummary([0])` return-flow. It is what makes "was the set examined?"
// observable: reach C4 and `returnFlowFound` flips to true, so a run that reports
// `examinedComplete: true` without reaching it is publishing a false all-clear.
const deepCalleeId = (file: string): string => `Function:${file}:deep`;

// A callee id no fixture gives a span or a summary — it can be SCANNED but never
// entered, so it moves the coverage population without moving the slice.
const hiddenCalleeId = (file: string): string => `Function:${file}:hidden`;

// The mock's knobs — all orthogonal, each with a safe default.
interface DescentOptions {
  // What `helper`'s CALL_SUMMARY row holds — the fact the note keys on. Default `null`.
  readonly summary?: Summary;
  // P2-4 case 2: emit capped this block's `calleeIds` cell, so the cell carries
  // the truncation sentinel alongside the ids that survived. `splitCalleeIds`
  // strips the sentinel, which is exactly why the dropped callees are invisible
  // to the summary scan and the note's counters.
  readonly calleeCellCapped?: boolean;
  // The OTHER way a block's call sites leave the population: `calleeIdsOfBlock`
  // writes an EMPTY `calleeIds` cell for a whole file whose resolved-id map is
  // absent, while the sibling `callees` NAME cell still records the call sites.
  // An empty cell carries no sentinel, so `calleeCellCapped` cannot report it.
  readonly calleeCellIdless?: boolean;
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
  // P1: give `helper` the deep body chain described above.
  readonly calleeChain?: boolean;
  // The `calleeIds` cell the U-C4 ASCENT-reached block carries. OMITTED ⇒ that
  // block has no cell at all (the historical fixture). A block reached only by
  // the ascent is still a slice block, so its call sites must join the scanned
  // population exactly like a descent-reached block's.
  readonly ascentBlockCallees?: readonly string[];
  // How that cell was written: `'capped'` ⇒ ids + the emit sentinel, `'idless'` ⇒
  // an empty id cell with the NAME cell still populated.
  readonly ascentBlockCell?: 'capped' | 'idless';
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
  {
    summary = null,
    calleeCellCapped = false,
    calleeCellIdless = false,
    calleeIds,
    secondSummary,
    calleeChain = false,
    ascentBlockCallees,
    ascentBlockCell,
  }: DescentOptions = {},
): RunPdgImpactDeps['executeParameterized'] {
  const seed = `BasicBlock:${file}:1:0:0`;
  const callBlock = `BasicBlock:${file}:1:0:2`;
  const calleeSeed = `BasicBlock:${file}:${symStartOf(HELPER_SPAN)}:0:0`;
  const secondSeed = secondCalleeSeedBlock(file);
  const ascentOnly = ascentOnlyBlock(file);
  const helper = helperCalleeId(file);
  const second = secondCalleeId(file);
  const deep = deepCalleeId(file);
  const chainTail = calleeChainBlock(file, CALLEE_CHAIN_LENGTH);
  const cellIds = calleeIds ?? [helper];
  // A `calleeIds` cell exactly as the emitter writes it, plus the sibling `callees`
  // NAME cell it always writes alongside. `'idless'` is the shape the emitter
  // produces for a file with no resolved-id map — names, no ids, no sentinel.
  const cellOf = (
    ids: readonly string[],
    written?: 'capped' | 'idless',
  ): { calleeIds: string; callees: string } => ({
    calleeIds:
      written === 'idless'
        ? ''
        : (written === 'capped' ? [...ids, CALLEES_TRUNCATED_SENTINEL] : [...ids]).join(
            CALLEE_ID_SEP,
          ),
    callees: ids.map((id) => id.slice(id.lastIndexOf(':') + 1)).join(' '),
  });
  const calleeCell = cellOf(
    cellIds,
    calleeCellIdless ? 'idless' : calleeCellCapped ? 'capped' : undefined,
  );
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
  // No span for `deep`: it is scanned for its summary, never entered, so the only
  // thing reaching C4 changes is whether that return-flow was EXAMINED.
  if (calleeChain) summaries.set(deep, flow([0]));
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
      // `helper`'s own body chain — one dependence level per step, so the callee's
      // BFS needs CALLEE_CHAIN_LENGTH levels of budget to walk it all.
      for (let step = 0; calleeChain && step < CALLEE_CHAIN_LENGTH; step++) {
        const from = step === 0 ? calleeSeed : calleeChainBlock(file, step);
        if (ids.includes(from)) return [{ id: calleeChainBlock(file, step + 1) }];
      }
      return [];
    }
    if (query.includes('RETURN b.id AS id, b.calleeIds AS calleeIds')) {
      const asked = askedIds(params);
      const rows: Array<{ id: string; calleeIds: string; callees: string }> = [];
      if (asked.includes(callBlock)) rows.push({ id: callBlock, ...calleeCell });
      // The ascent-reached block's own cell. It is only ever ASKED about once the
      // block is in the descent's slice, which is the whole point of the case.
      if (ascentBlockCallees !== undefined && asked.includes(ascentOnly)) {
        rows.push({ id: ascentOnly, ...cellOf(ascentBlockCallees, ascentBlockCell) });
      }
      // Hop 1 gathers callees from HELPER's body blocks; that cell — and only that
      // cell — carries the second callee, so the second hop cannot be reached by
      // widening the first block's cell.
      if (secondSummary !== undefined && asked.includes(calleeSeed)) {
        rows.push({ id: calleeSeed, ...cellOf([second]) });
      }
      // The DEEPEST chain block's cell: askable only once the callee's own BFS had
      // the budget to reach C4.
      if (calleeChain && asked.includes(chainTail)) rows.push({ id: chainTail, ...cellOf([deep]) });
      return rows;
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
// EXAMINED is known to be a strict subset of the slice's real one, plus the three
// reasons that can put it there.
const QUALIFIER = 'so callees past the examined set were not checked';
const BUDGET_REASON = 'the traversal stopped at its depth/size budget';
const EMIT_CAP_REASON = "a slice block's call-site list was capped at emit";
const IDLESS_REASON = 'a slice block records call sites but no resolved callee ids';

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

  // #2802 — THE language-agnosticism pin, and the only test carrying it: the whole
  // observable (note text AND reachable blocks) must be byte-identical across every
  // extension once the path it legitimately echoes is masked — on BOTH sides of the
  // caveat gate, since the CALL_SUMMARY content is the only thing allowed to flip
  // the note. That SUBSUMES the per-extension caveat sweeps it replaces: identity
  // across EXTENSIONS plus the two single-extension content assertions above
  // entails "every extension gets the caveat" / "no extension gets it", and entails
  // it more strongly — a `.py`-only note change that still CONTAINED the caveat
  // slips past a substring sweep and fails here.
  it.each([
    { label: 'no return-flow summary (caveat branch)', options: {} },
    { label: 'a return-flow summary (silent branch)', options: { summary: flow([0]) } },
  ])(
    'note and reach do not vary with the criterion file extension — $label',
    async ({ options }) => {
      const fingerprints = await Promise.all(
        EXTENSIONS.map(async (file) => {
          const result = await run(file, options);
          return [noteOf(result), ...blocksOf(result)].join('\n').split(file).join('<FILE>');
        }),
      );
      expect(new Set(fingerprints).size).toBe(1);
    },
  );
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

// P2-4 — "none of the N distinct callees carry a … return-flow" is a UNIVERSAL
// claim over the callees the descent actually examined, and so is "this is a
// property of the persisted summaries". Four premises make that examined set a
// strict subset of the slice's real callee list, and under any of them the note
// must describe what it examined rather than assert a property of the whole slice:
//  1. the TOP-LEVEL traversal stopped at a depth/size budget (`maxDepth: 1` below
//     leaves the intra BFS frontier non-empty) — a callee that DOES carry a
//     return-flow can sit past the frontier;
//  2. a CALLEE's OWN traversal stopped at the same depth budget (`calleeChain`
//     below, at the PRODUCTION DEFAULT `maxDepth: 3`, with the top-level intra BFS
//     completing so the callee's frontier is the only source left). The per-callee
//     BFS is clamped by the same `maxDepth`, so a callee whose dependence chain
//     outruns it hides its deeper call sites exactly the way case 1 does — and the
//     hidden callee here carries a REAL `encodeCallSummary([0])` return-flow, so
//     "the set was not fully examined" is not a hypothetical;
//  3. a block's `calleeIds` cell was capped at emit (`calleeCellCapped` below,
//     with the traversal COMPLETING so the cap is the only source left) —
//     `splitCalleeIds` strips the sentinel, so those callees reach neither the
//     summary scan nor the counters;
//  4. a block records call SITES but no resolved callee ids (`'idless'` below) —
//     an empty cell carries no sentinel, so case 3's flag cannot see it either.
// Those four, plus none of them (the control that keeps the fix from being "always
// hedge"), are the premise rows below, each crossed with the two assertions the
// note owes: is the qualifier clause present, and does the unqualified
// persisted-summaries claim survive. `reasons` is the EXACT phrase set the clause
// must name, so a row also asserts the absence of every phrase it omits;
// `truncated` is the premise's own observable, asserted rather than assumed so a
// mock drift that stops truncating fails loudly.
const REASON_PHRASES = [BUDGET_REASON, EMIT_CAP_REASON, IDLESS_REASON] as const;
const INCOMPLETENESS_PREMISES: ReadonlyArray<{
  readonly label: string;
  readonly premise: RunOptions;
  readonly truncated: boolean;
  readonly reasons: readonly string[];
}> = [
  { label: 'depth budget', premise: { maxDepth: 1 }, truncated: true, reasons: [BUDGET_REASON] },
  {
    // The production default is the point: no caller has to opt into a small
    // maxDepth for a callee's own chain to outrun the budget.
    label: "a callee's own depth budget at the default maxDepth 3",
    premise: { calleeChain: true },
    truncated: true,
    reasons: [BUDGET_REASON],
  },
  {
    label: 'emit-capped calleeIds cell',
    premise: { calleeCellCapped: true },
    truncated: false,
    reasons: [EMIT_CAP_REASON],
  },
  {
    label: 'a slice block with call sites but no resolved callee ids',
    premise: {
      ascentBlockCallees: [hiddenCalleeId('src/svc.ts')],
      ascentBlockCell: 'idless',
    },
    truncated: false,
    reasons: [IDLESS_REASON],
  },
  { label: 'neither mechanism', premise: {}, truncated: false, reasons: [] },
];

describe('runImpactPDG — empty-ascent note over an incomplete callee set (P2-4)', () => {
  it.each(INCOMPLETENESS_PREMISES)(
    '$label → the qualifier clause names exactly this premise',
    async ({ premise, truncated, reasons }) => {
      const result = await run('src/svc.ts', premise);
      expect(truncatedOf(result)).toBe(truncated);
      const note = noteOf(result);
      expect(note).toContain(CAVEAT);
      expect(note.includes(QUALIFIER)).toBe(reasons.length > 0);
      expect(REASON_PHRASES.filter((phrase) => note.includes(phrase))).toEqual(reasons);
    },
  );

  // An `r:0` summary decodes cleanly, so this is the branch that asserts "a
  // property of the persisted summaries" — a whole-slice claim an incomplete
  // examined set did not establish, and a complete one did.
  it.each(INCOMPLETENESS_PREMISES)(
    '$label → the unqualified persisted-summaries claim survives iff the set is complete',
    async ({ premise, reasons }) => {
      const note = noteOf(await run('src/svc.ts', { ...premise, summary: flow([]) }));
      expect(note.includes(QUALIFIER)).toBe(reasons.length > 0);
      expect(note.includes(PERSISTED_CLAIM)).toBe(reasons.length === 0);
    },
  );

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

// P3-7 — the number the empty-ascent sentence quotes is the count of DISTINCT
// CALLEES the descent scanned for a CALL_SUMMARY (the raw `calleeIds` ids,
// accumulated into a Set), NOT the count of callees it resolved to a body and
// descended into, and NOT a count of call SITES. Two ways the three differ:
//  - resolved-to-a-body: a cell can carry an id `resolveCalleeSpans` does not
//    match (an out-of-repo target, an interface method, a node kind with no CFG
//    body). The scan really is run over all of them, so the claim is exact at
//    this granularity — but calling them "resolved" asserted a symbol-table
//    lookup that never happened, and the old formals parenthetical ("no formal
//    parameter is recorded as flowing to its return value") asserted a
//    FORMALS-level property about symbols never resolved to a body at all;
//  - call SITES: the accumulator is a Set of ids, so two blocks calling the same
//    callee are ONE member. The earlier "call-site callee reference(s)" wording
//    described the value as a site count it never was — pinned below.
const FILE = 'src/svc.ts';
// Ids a real `calleeIds` cell genuinely carries and the descent can never enter.
// The `Class:` id is the reproduced case — a `new Outer()` call site contributes
// it (see test/integration/cfg/pdg-chained-receiver-callees.test.ts), which is
// what inflated the quoted number from 1 to 3 there.
const UNENTERABLE_CALLEES = [`Class:${FILE}:Outer`, `Interface:${FILE}:Sink.write`] as const;
const MIXED_CALLEES = [helperCalleeId(FILE), ...UNENTERABLE_CALLEES] as const;

describe('runImpactPDG — the empty-ascent count is distinct callees (P3-7)', () => {
  // One render, four readings of it: the wording the note must now carry, plus
  // the three it must have dropped (all explained in the block comment above).
  it('un-enterable callee ids count, and the note names them as distinct callees', async () => {
    const note = noteOf(await run(FILE, { calleeIds: MIXED_CALLEES }));
    expect(note).toContain('none of the 3 distinct callees carry a CALL_SUMMARY return-flow');
    expect(note).not.toContain('resolved callee');
    expect(note).not.toContain('no formal parameter is recorded');
    expect(note).not.toContain('call-site callee reference');
  });

  // The call-SITE distinction, which the old wording got backwards: TWO slice
  // blocks each recording a call to `helper` are ONE distinct callee, and the
  // note quotes 1 — because a CALL_SUMMARY is a property of the callee, so
  // scanning the same id twice could not change the answer.
  it('two call sites to the SAME callee are one distinct callee, not two', async () => {
    const result = await run(FILE, { ascentBlockCallees: [helperCalleeId(FILE)] });
    // Premise: a SECOND slice block, distinct from the criterion's call block,
    // is in the slice and records its own call to `helper`.
    expect(blocksOf(result)).toContain(ascentOnlyBlock(FILE));
    expect(ascentOf(result)).toMatchObject({ referencesScanned: 1 });
    expect(noteOf(result)).toContain('none of the 1 distinct callee carries');
    // The discriminator that keeps the 1 from being vacuous: three DISTINCT ids,
    // in a SINGLE block's cell, do quote 3. The tally counts callees — neither
    // the blocks nor the cells they sit in.
    expect(noteOf(await run(FILE, { calleeIds: MIXED_CALLEES }))).toContain(
      'none of the 3 distinct callees carry',
    );
  });

  // The same slice with only the enterable callee: the number tracks the CELL,
  // and the singular form agrees with it.
  it('dropping the un-enterable ids drops the quoted number to 1', async () => {
    expect(noteOf(await run(FILE))).toContain(
      'none of the 1 distinct callee carries a CALL_SUMMARY return-flow',
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
    // note quotes the distinct ids scanned rather than the callees resolved.
    expect(noteOf(mixed)).toContain('none of the 3 distinct callees carry');
    expect(noteOf(helperOnly)).toContain('none of the 1 distinct callee carries');
  });

  // The undecodable branch quotes the same count and needed the same rewording.
  it('undecodable branch → same distinct-callee wording over the same count', async () => {
    const note = noteOf(await run(FILE, { summary: raw('1|r:zz'), calleeIds: MIXED_CALLEES }));
    expect(note).toContain(
      'none of the 3 distinct callees carry a decodable CALL_SUMMARY return-flow',
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
      'none of the 2 distinct callees carry a CALL_SUMMARY return-flow',
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
    expect(noteOf(mixed)).not.toContain('distinct callee');
    // The discriminator that makes the silence load-bearing: drop that one
    // return-flow and the SAME 3 references do produce the sentence.
    expect(noteOf(none)).toContain('none of the 3 distinct callees carry');
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

// ── Structured ascent coverage: pdgEvidence.ascent ───────────────────────────
// Every fact the note interpolates into English is ALSO published structurally.
// This is MCP output read by AGENTS, not only humans: the only way to ask "was
// the ascent complete, and if not why" must not be a regex over prose. The
// branch already proved the cost — a pure rewording ("resolved callees" →
// "call-site callee references", P3-7 above) moved ~30 assertions and would have
// silently broken any consumer keyed on the old phrase.
//
// The field is ADDITIVE: every prose assertion above is unchanged, and the cases
// below are the same scenarios read through the structured surface instead.
const ascentOf = (result: Awaited<ReturnType<typeof run>>): PdgAscentCoverage | undefined =>
  'pdgEvidence' in result ? result.pdgEvidence?.ascent : undefined;

// How each structured reason code is expected to READ in the note. The
// production mapping (`ASCENT_INCOMPLETE_PHRASE`) is module-private by design —
// the codes are the contract, the phrasing is a rendering — so this table is
// where the two surfaces are compared, and a reworded phrase fails HERE rather
// than drifting apart unnoticed.
const REASON_PHRASE: Readonly<Record<PdgAscentIncompleteReason, string>> = {
  'traversal-truncated': BUDGET_REASON,
  'callee-list-capped': EMIT_CAP_REASON,
  'callee-ids-unrecorded': IDLESS_REASON,
};

// The `run` helper above is downstream-only (the descent's direction gate). An
// UPSTREAM slice never runs the descent at all, which is the case the field has
// to distinguish from "the descent ran and scanned nothing".
const runUpstream = (file: string, options: DescentOptions = {}) =>
  runImpactPDG({
    repo: { lbugPath: 'repo' },
    sym: { id: `Function:${file}:run`, name: 'run', filePath: file, startLine: 0, endLine: 7 },
    symType: 'Function',
    direction: 'upstream',
    maxDepth: 3,
    limit: 50,
    line: 1,
    executeParameterized: descentExec(file, options),
    callSummaryAvailable: true,
  });

// A slice whose seed block has NO outgoing dependence edge, yet DOES record a call
// site — the shape that routes `runImpactPDG` through its empty-slice exit with a
// descent already behind it. The single callee id is deliberately un-enterable, so
// the descent scans it for a `CALL_SUMMARY` and adds no block: `reachableBlocks`
// stays empty while the coverage is a real, non-zero reading.
const runEmptySlice = (file: string) => {
  const seed = `BasicBlock:${file}:1:0:0`;
  const exec: RunPdgImpactDeps['executeParameterized'] = async (_repo, query, params) => {
    if (query.includes('RETURN a.id AS id')) {
      return query.includes('a.startLine = $line') ? [{ id: seed }] : [];
    }
    if (query.includes('RETURN b.id AS id, b.calleeIds AS calleeIds')) {
      const ids = (params as Record<string, unknown>)['ids'];
      const asked = Array.isArray(ids) ? ids.map((id) => String(id)) : [];
      return asked.includes(seed)
        ? [{ id: seed, calleeIds: `Class:${file}:Outer`, callees: 'Outer' }]
        : [];
    }
    // No dependence edges, no CALL_SUMMARY rows, no resolvable callee spans.
    return [];
  };
  return runImpactPDG({
    repo: { lbugPath: 'repo' },
    sym: { id: `Function:${file}:run`, name: 'run', filePath: file, startLine: 0, endLine: 7 },
    symType: 'Function',
    direction: 'downstream',
    maxDepth: 3,
    limit: 50,
    line: 1,
    executeParameterized: exec,
    callSummaryAvailable: true,
  });
};

describe('runImpactPDG — structured ascent coverage (pdgEvidence.ascent)', () => {
  // The whole record is pinned with toEqual rather than toMatchObject: the point
  // of the field is that a consumer can read it without a fallback, so an
  // omitted member is a contract break, not a detail.
  //
  // FIXTURE NOTE: at maxDepth 3 the block the U-C4 re-seed targets is ALREADY
  // intra-reachable, so what this row pins is a return-flow being FOUND over a
  // COMPLETE population — not the ascent adding ground. It is given a `calleeIds`
  // cell so the population is a real reading of two blocks' cells (2: `helper`
  // from the criterion's call block, `hidden` from the ascent target) instead of a
  // vacuous 1 over a block carrying nothing. The case where the ascent adds ground
  // — and where that block's own call sites have to join the population — is the
  // separate row below, which is the only shape where the two differ.
  it('ascent fired → returnFlowFound over a complete examined set', async () => {
    const result = await run(FILE, {
      summary: flow([0]),
      ascentBlockCallees: [hiddenCalleeId(FILE)],
    });
    // Premise: this is exactly the run whose note carries NO caveat.
    expect(noteOf(result)).not.toContain(CAVEAT);
    expect(blocksOf(result)).toContain(ascentOnlyBlock(FILE));
    expect(ascentOf(result)).toEqual({
      referencesScanned: 2,
      returnFlowFound: true,
      undecodableSummaryCount: 0,
      examinedComplete: true,
      incompleteReasons: [],
      callSummaryLayerPresent: true,
    });
  });

  // P3 — a block the descent reaches ONLY through the U-C4 re-seed is still a
  // slice block: it is published in `reachableBlocks`, so its own call sites must
  // reach the CALL_SUMMARY scan, the distinct-callee tally, AND the emit-cap flag.
  // `maxDepth: 1` is what makes it ascent-only: the intra BFS stops at the call
  // block, so nothing but the ascent can put the next block in the slice.
  it('a block reached only by the ascent contributes its call sites to the scan', async () => {
    const cell = {
      ascentBlockCallees: [hiddenCalleeId(FILE)],
      ascentBlockCell: 'idless',
    } as const;
    const [ascended, withheld] = await Promise.all([
      run(FILE, { maxDepth: 1, summary: flow([0]), ...cell, ascentBlockCell: 'capped' }),
      run(FILE, { maxDepth: 1, ...cell, ascentBlockCell: 'capped' }),
    ]);
    // Premise: the block below is in the slice ONLY because the ascent fired —
    // withhold the return-flow and it is gone.
    expect(blocksOf(ascended)).toContain(ascentOnlyBlock(FILE));
    expect(blocksOf(withheld)).not.toContain(ascentOnlyBlock(FILE));
    // So its cell has to be read: `hidden` joins the population (1 → 2) and the
    // cell's emit-cap sentinel is reported, neither of which the descent-visited
    // blocks could have contributed.
    expect(ascentOf(ascended)).toEqual({
      referencesScanned: 2,
      returnFlowFound: true,
      undecodableSummaryCount: 0,
      examinedComplete: false,
      incompleteReasons: ['traversal-truncated', 'callee-list-capped'],
      callSummaryLayerPresent: true,
    });
    // The discriminator that makes the reading load-bearing: with the ascent
    // withheld that block is not in the slice, so its call sites are correctly
    // absent and the cap it carries is correctly unreported.
    expect(ascentOf(withheld)).toEqual({
      referencesScanned: 1,
      returnFlowFound: false,
      undecodableSummaryCount: 0,
      examinedComplete: false,
      incompleteReasons: ['traversal-truncated'],
      callSummaryLayerPresent: true,
    });
  });

  // P1 — the per-callee BFS's OWN depth exhaustion, at the production default.
  // `helper`'s body is a 4-link dependence chain whose deepest block calls a
  // callee carrying a real `encodeCallSummary([0])` return-flow; at maxDepth 3 the
  // callee's BFS stops one link short, so that return-flow is never examined. The
  // top-level intra BFS completes here, so the callee's frontier is the ONLY thing
  // cutting the slice — and `examinedComplete` must not read as an all-clear.
  it('a callee whose own BFS runs out of depth → examinedComplete false', async () => {
    const result = await run(FILE, { calleeChain: true });
    expect(truncatedOf(result)).toBe(true);
    expect(ascentOf(result)).toEqual({
      referencesScanned: 1,
      returnFlowFound: false,
      undecodableSummaryCount: 0,
      examinedComplete: false,
      incompleteReasons: ['traversal-truncated'],
      callSummaryLayerPresent: true,
    });
  });

  // The discriminator for the row above: the SAME fixture with budget to walk the
  // whole chain DOES reach the deepest block, scans the callee it calls, and finds
  // its return-flow. So maxDepth 3 was hiding a real answer, not an empty region —
  // which is exactly why publishing `examinedComplete: true` there was false.
  it('with budget to walk the chain the hidden return-flow IS found', async () => {
    const result = await run(FILE, { calleeChain: true, maxDepth: CALLEE_CHAIN_LENGTH + 1 });
    expect(truncatedOf(result)).toBe(false);
    expect(ascentOf(result)).toEqual({
      referencesScanned: 2,
      returnFlowFound: true,
      undecodableSummaryCount: 0,
      examinedComplete: true,
      incompleteReasons: [],
      callSummaryLayerPresent: true,
    });
  });

  // A block that records call SITES but no resolved callee ids shrinks the
  // population silently: nothing is dropped at emit, so no sentinel exists to
  // raise the cap flag. Here EVERY id is missing, so the scan's population is
  // empty — and a zeroed record claiming completeness would be the strongest form
  // of the false all-clear.
  it('call sites with no resolved ids → the empty population is reported, not claimed complete', async () => {
    const [idless, recorded] = await Promise.all([
      run(FILE, { calleeCellIdless: true }),
      run(FILE),
    ]);
    expect(ascentOf(idless)).toEqual({
      referencesScanned: 0,
      returnFlowFound: false,
      undecodableSummaryCount: 0,
      examinedComplete: false,
      incompleteReasons: ['callee-ids-unrecorded'],
      callSummaryLayerPresent: true,
    });
    // The discriminator: the SAME block with its ids recorded scans 1 callee and
    // is genuinely complete, so the flag tracks the missing ids and not the mock.
    expect(ascentOf(recorded)).toMatchObject({
      referencesScanned: 1,
      examinedComplete: true,
      incompleteReasons: [],
    });
  });

  it('nothing flowed → the same scanned set with returnFlowFound false', async () => {
    const result = await run(FILE);
    expect(noteOf(result)).toContain(CAVEAT);
    expect(ascentOf(result)).toEqual({
      referencesScanned: 1,
      returnFlowFound: false,
      undecodableSummaryCount: 0,
      examinedComplete: true,
      incompleteReasons: [],
      callSummaryLayerPresent: true,
    });
  });

  // The P2-2 fact, structurally: a non-zero count is what tells a consumer that
  // `returnFlowFound: false` is NOT a statement about what the summaries record.
  it.each(UNDECODABLE)('$label → undecodableSummaryCount reports it', async ({ reason }) => {
    expect(ascentOf(await run(FILE, { summary: raw(reason) }))).toEqual({
      referencesScanned: 1,
      returnFlowFound: false,
      undecodableSummaryCount: 1,
      examinedComplete: true,
      incompleteReasons: [],
      callSummaryLayerPresent: true,
    });
  });

  // P2-4 case 1, structurally — the reason is a CODE, not a sentence.
  it('incomplete via budget truncation → examinedComplete false + traversal-truncated', async () => {
    const result = await run(FILE, { maxDepth: 1 });
    expect(truncatedOf(result)).toBe(true);
    expect(ascentOf(result)).toEqual({
      referencesScanned: 1,
      returnFlowFound: false,
      undecodableSummaryCount: 0,
      examinedComplete: false,
      incompleteReasons: ['traversal-truncated'],
      callSummaryLayerPresent: true,
    });
  });

  // P2-4 case 2 in isolation: the traversal COMPLETED, so the emit-time cap is
  // the only thing that can make the examined set a prefix — and it is a
  // mechanism the result's own `truncated` flag cannot express.
  it('incomplete via emit cap → callee-list-capped with nothing else truncated', async () => {
    const result = await run(FILE, { calleeCellCapped: true });
    expect(truncatedOf(result)).toBe(false);
    expect(ascentOf(result)).toEqual({
      referencesScanned: 1,
      returnFlowFound: false,
      undecodableSummaryCount: 0,
      examinedComplete: false,
      incompleteReasons: ['callee-list-capped'],
      callSummaryLayerPresent: true,
    });
  });

  it('both mechanisms → both codes, budget first', async () => {
    const result = await run(FILE, { maxDepth: 1, calleeCellCapped: true });
    expect(ascentOf(result)).toMatchObject({
      examinedComplete: false,
      incompleteReasons: ['traversal-truncated', 'callee-list-capped'],
    });
  });

  // The two surfaces are rendered from ONE array, so the note's clause is
  // exactly the published codes mapped through REASON_PHRASE, in code order.
  // This is what makes a future third reason a rendering decision instead of a
  // contract change.
  it('the note clause is exactly the published codes, in order', async () => {
    const result = await run(FILE, { maxDepth: 1, calleeCellCapped: true });
    const codes = ascentOf(result)?.incompleteReasons ?? [];
    expect(codes).toEqual(['traversal-truncated', 'callee-list-capped']);
    expect(noteOf(result)).toContain(
      `(${codes.map((code) => REASON_PHRASE[code]).join(' and ')}, ${QUALIFIER})`,
    );
  });

  // The false-safe guard. On a PRE-FU-C (v3) index the scan runs and finds
  // nothing because the layer that records return-flows does not exist — a
  // consumer reading only `returnFlowFound: false` would conclude "these callees
  // record no return-flow", which is exactly the misreading the note's re-index
  // sentence exists to prevent for humans.
  it('v3 index → callSummaryLayerPresent false alongside returnFlowFound false', async () => {
    const result = await run(FILE, { callSummaryAvailable: false });
    expect(noteOf(result)).toContain('re-index for CALL_SUMMARY');
    expect(ascentOf(result)).toEqual({
      referencesScanned: 1,
      returnFlowFound: false,
      undecodableSummaryCount: 0,
      examinedComplete: true,
      incompleteReasons: [],
      callSummaryLayerPresent: false,
    });
  });

  // "Nothing was scanned" ≠ "we scanned and found nothing". An upstream slice
  // never runs the descent, so the field is ABSENT rather than a zeroed record
  // that would read as a completed, empty scan.
  it('upstream slice → the descent never ran, so no coverage is published', async () => {
    const [upstream, downstream] = await Promise.all([runUpstream(FILE), run(FILE)]);
    // The evidence namespace itself is present — only the ascent member is not.
    expect('pdgEvidence' in upstream && upstream.pdgEvidence?.statements).toBe('local-dependence');
    expect(ascentOf(upstream)).toBeUndefined();
    // The discriminator that makes the absence load-bearing rather than vacuous:
    // the SAME mock run downstream DOES publish coverage, so `undefined` above is
    // the descent-did-not-run signal and not simply "the field does not exist".
    expect(ascentOf(downstream)).toMatchObject({ referencesScanned: 1 });
  });

  // The mirror of the row above, and the case the contract sentence "present iff
  // the inter-procedural descent RAN" is easiest to break on: a criterion line
  // whose only dependent is the callee it invokes DIRECTLY reaches no distinct
  // downstream block, so `runImpactPDG` returns through its empty-slice exit —
  // which sits BEFORE the result assembler and so has to publish the coverage
  // itself. The descent ran and scanned; absence here would say it did not.
  it('empty slice → the descent that already ran is still published', async () => {
    const result = await runEmptySlice(FILE);
    // Premise: this really is the empty-slice exit, not the assembled result.
    expect(blocksOf(result)).toEqual([]);
    // … and the descent really did scan the seed block's call site before it.
    expect(ascentOf(result)).toEqual({
      referencesScanned: 1,
      returnFlowFound: false,
      undecodableSummaryCount: 0,
      examinedComplete: true,
      incompleteReasons: [],
      callSummaryLayerPresent: true,
    });
  });

  // The strongest case for the structured surface: the note is SILENT (the
  // ascent sentence is gated on a hop being crossed, and a cell of un-enterable
  // ids resolves no span) while the descent did scan 2 references. Prose reports
  // nothing here; the field reports exactly what was examined.
  it('no hop crossed → note silent, coverage still reports the scan', async () => {
    const result = await run(FILE, { calleeIds: UNENTERABLE_CALLEES });
    expect(noteOf(result)).not.toContain('inter-procedural hop');
    expect(noteOf(result)).not.toContain(CAVEAT);
    expect(ascentOf(result)).toMatchObject({
      referencesScanned: 2,
      returnFlowFound: false,
      examinedComplete: true,
    });
  });

  // P2-5's mixed boundary: one return-flow silences the note entirely, so the
  // prose quotes no count at all. The structured surface still carries both the
  // population and the outcome.
  it('mixed callees → note quotes no count, coverage still carries it', async () => {
    const result = await run(FILE, { summary: flow([0]), calleeIds: MIXED_CALLEES });
    expect(noteOf(result)).not.toContain('distinct callee');
    expect(ascentOf(result)).toMatchObject({ referencesScanned: 3, returnFlowFound: true });
  });

  // Cross-hop accumulation (P2-5) read structurally: hop 0 contributes {helper},
  // hop 1 contributes {helper2} ⇒ 2. A per-hop overwrite would publish 1.
  it('two hops over DISTINCT callees → referencesScanned is their union', async () => {
    const result = await run(FILE, { secondSummary: null });
    expect(noteOf(result)).toContain(TWO_HOPS);
    expect(ascentOf(result)).toMatchObject({ referencesScanned: 2, returnFlowFound: false });
  });
});
