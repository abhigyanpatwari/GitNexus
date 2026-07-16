// U7 — the impact result note tells a non-TypeScript/JavaScript user that
// return-value ascent (FU-C) is currently TS/JS-only, instead of silently
// suppressing the guidance because the CALL_SUMMARY layer flag is set. Only the
// TS/JS harvester records the formal-index ascent needs, so for any other
// language the ascent is structurally empty.

import { describe, expect, it } from 'vitest';
import { runImpactPDG, type RunPdgImpactDeps } from '../../src/mcp/local/pdg-impact.js';

// A mock that drives ONE real inter-procedural descent hop: the criterion's
// reachable block calls `helper`, the descent resolves helper's span (so
// interproceduralHops > 0 and the note block fires). The criterion file's
// extension selects the language the U7 note keys on.
function descentExec(file: string): RunPdgImpactDeps['executeParameterized'] {
  const seed = `BasicBlock:${file}:1:0:0`;
  const callBlock = `BasicBlock:${file}:1:0:2`;
  const calleeSeed = `BasicBlock:${file}:5:0:0`;
  let bfs = 0;
  return async (_repo, query) => {
    // Top-level seed fetch is line-anchored (`a.startLine = $line`); the descent's
    // callee seed fetch is range-anchored — route by that.
    if (query.includes('RETURN a.id AS id LIMIT')) {
      return query.includes('a.startLine = $line') ? [{ id: seed }] : [{ id: calleeSeed }];
    }
    if (query.includes('MATCH (a:BasicBlock)-[r:CodeRelation]->(b:BasicBlock)')) {
      bfs += 1;
      return bfs === 1 ? [{ id: callBlock }] : [];
    }
    if (query.includes('RETURN b.id AS id, b.calleeIds AS calleeIds')) {
      return [{ id: callBlock, calleeIds: `Function:${file}:helper` }];
    }
    if (query.includes("r.type = 'CALL_SUMMARY'")) return [];
    if (query.includes('s.id IN $ids') && query.includes('AS filePath')) {
      return [{ id: `Function:${file}:helper`, filePath: file, startLine: 4, endLine: 6 }];
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

const run = (file: string, callSummaryAvailable: boolean) =>
  runImpactPDG({
    repo: { lbugPath: 'repo' },
    sym: { id: `Function:${file}:run`, name: 'run', filePath: file, startLine: 0, endLine: 7 },
    symType: 'Function',
    direction: 'downstream',
    maxDepth: 3,
    limit: 50,
    line: 1,
    executeParameterized: descentExec(file),
    callSummaryAvailable,
  });

const CAVEAT = 'return-value ascent is currently TypeScript/JavaScript-only';

describe('runImpactPDG — TS/JS-only ascent note (U7)', () => {
  it('non-TS/JS (.py) criterion with CALL_SUMMARY present → notes ascent is TS/JS-only', async () => {
    const result = await run('src/svc.py', true);
    expect('affectedStatements' in result).toBe(true);
    const note = 'affectedStatements' in result ? (result.note ?? '') : '';
    expect(note).toContain(CAVEAT);
  });

  it('TypeScript (.ts) criterion → no TS/JS-only caveat (ascent applies)', async () => {
    const result = await run('src/svc.ts', true);
    const note = 'affectedStatements' in result ? (result.note ?? '') : '';
    expect(note).not.toContain(CAVEAT);
  });

  it('JavaScript (.js) criterion → no TS/JS-only caveat (JS also sets formalIndex)', async () => {
    const result = await run('src/svc.js', true);
    const note = 'affectedStatements' in result ? (result.note ?? '') : '';
    expect(note).not.toContain(CAVEAT);
  });

  it('v3 index (callSummaryAvailable false) → re-index note, not the language caveat', async () => {
    const result = await run('src/svc.py', false);
    const note = 'affectedStatements' in result ? (result.note ?? '') : '';
    expect(note).toContain('re-index for CALL_SUMMARY');
    expect(note).not.toContain(CAVEAT);
  });
});
