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

// A mock that drives ONE real inter-procedural descent hop: the criterion's
// reachable block calls `helper`, the descent resolves helper's span (so
// interproceduralHops > 0 and the note block fires). `returnFlowParams` decides
// whether `helper` carries a non-empty CALL_SUMMARY return-flow — the fact the
// note now keys on. `null` means no CALL_SUMMARY row at all for that callee.
function descentExec(
  file: string,
  returnFlowParams: readonly number[] | null,
): RunPdgImpactDeps['executeParameterized'] {
  const seed = `BasicBlock:${file}:1:0:0`;
  const callBlock = `BasicBlock:${file}:1:0:2`;
  const calleeSeed = `BasicBlock:${file}:5:0:0`;
  const helper = `Function:${file}:helper`;
  let bfs = 0;
  return async (_repo, query) => {
    // Top-level seed fetch is line-anchored (`a.startLine = $line`); the descent's
    // callee seed fetch is range-anchored — route by that.
    // Matches the seed fetch without pinning the clauses after the projection —
    // #2787 added `ORDER BY a.startLine, id` between the RETURN and the LIMIT.
    if (query.includes('RETURN a.id AS id')) {
      return query.includes('a.startLine = $line') ? [{ id: seed }] : [{ id: calleeSeed }];
    }
    if (query.includes('MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)')) {
      bfs += 1;
      return bfs === 1 ? [{ id: callBlock }] : [];
    }
    if (query.includes('RETURN b.id AS id, b.calleeIds AS calleeIds')) {
      return [{ id: callBlock, calleeIds: helper }];
    }
    if (query.includes("r.type = 'CALL_SUMMARY'")) {
      return returnFlowParams === null
        ? []
        : [{ id: helper, reason: encodeCallSummary(returnFlowParams) }];
    }
    if (query.includes('s.id IN $ids') && query.includes('AS filePath')) {
      return [{ id: helper, filePath: file, startLine: 4, endLine: 6 }];
    }
    if (query.includes('MATCH (b:BasicBlock) WHERE b.id IN $ids')) {
      return [
        { id: seed, line: 1, endLine: 1, text: 'run()' },
        { id: callBlock, line: 3, endLine: 3, text: 'x = helper()' },
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
  returnFlowParams: readonly number[] | null = null,
) =>
  runImpactPDG({
    repo: { lbugPath: 'repo' },
    sym: { id: `Function:${file}:run`, name: 'run', filePath: file, startLine: 0, endLine: 7 },
    symType: 'Function',
    direction: 'downstream',
    maxDepth: 3,
    limit: 50,
    line: 1,
    executeParameterized: descentExec(file, returnFlowParams),
    callSummaryAvailable,
  });

const CAVEAT = 'no return-value ascent in this slice';

const noteOf = (result: Awaited<ReturnType<typeof run>>): string =>
  'affectedStatements' in result ? (result.note ?? '') : '';

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
    expect(noteOf(await run('src/svc.ts', true, [0]))).not.toContain(CAVEAT);
  });

  // An `r:0` summary decodes cleanly but records no formal→return flow, so the
  // ascent is still structurally empty. Pins that the note keys on the DECODED
  // return-flow rather than on the mere presence of a CALL_SUMMARY edge.
  it('callee with an empty (r:0) return-flow summary → caveat present', async () => {
    expect(noteOf(await run('src/svc.ts', true, []))).toContain(CAVEAT);
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
    expect(noteOf(await run(file, true, [0]))).not.toContain(CAVEAT);
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
