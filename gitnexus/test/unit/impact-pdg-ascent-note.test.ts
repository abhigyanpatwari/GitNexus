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
function descentExec(file: string, summary: Summary): RunPdgImpactDeps['executeParameterized'] {
  const seed = `BasicBlock:${file}:1:0:0`;
  const callBlock = `BasicBlock:${file}:1:0:2`;
  const calleeSeed = `BasicBlock:${file}:5:0:0`;
  const ascentOnly = ascentOnlyBlock(file);
  const helper = `Function:${file}:helper`;
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
      return [{ id: callBlock, calleeIds: helper }];
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
  maxDepth = 3,
) =>
  runImpactPDG({
    repo: { lbugPath: 'repo' },
    sym: { id: `Function:${file}:run`, name: 'run', filePath: file, startLine: 0, endLine: 7 },
    symType: 'Function',
    direction: 'downstream',
    maxDepth,
    limit: 50,
    line: 1,
    executeParameterized: descentExec(file, summary),
    callSummaryAvailable,
  });

const CAVEAT = 'no return-value ascent in this slice';
// The sentence P2-2 flagged: an assertion about what the PERSISTED summaries
// record, which an UNDECODABLE summary contradicts (the codec never throws, so
// an unreadable `reason` is otherwise reported as one recording no return-flow).
const PERSISTED_CLAIM = 'property of the persisted summaries';

const noteOf = (result: Awaited<ReturnType<typeof run>>): string =>
  'affectedStatements' in result ? (result.note ?? '') : '';

const blocksOf = (result: Awaited<ReturnType<typeof run>>): readonly string[] =>
  'reachableBlocks' in result ? result.reachableBlocks : [];

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
