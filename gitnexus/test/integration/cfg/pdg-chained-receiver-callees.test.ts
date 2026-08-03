/**
 * The PDG inter-procedural descent hops through `BasicBlock.calleeIds`, so it
 * can only cross a call boundary that the RESOLVER managed to resolve. Chained
 * receiver calls (`out.inner().compute(x)`) are resolved by the receiver-typing
 * pass, whose resolved ids reach `calleeIds` through a separate sink from the
 * plain-call path — which means the chain could regress there without any
 * plain-call test noticing.
 *
 * This pins the resolver -> PDG seam for a chain: the block holding the chained
 * statement must carry the id of BOTH links, not just the first. The descent's
 * behaviour once the ids are present is covered by impact-pdg-interproc and
 * impact-pdg-fullchain-e2e; what those cannot catch is the chain's SECOND link
 * silently missing from the column they both read.
 *
 * Self-contained fixture rather than an addition to `fixtures/pdg-repo` — that
 * fixture is shared by eight suites including a snapshot test, so growing it to
 * cover one seam churns unrelated expectations.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';

// `run` calls `out.inner()`, and calls `.compute()` on ITS RESULT — the second
// call has no named receiver, so it resolves only if the receiver's type is
// carried through the chain.
const CHAINED_SOURCE = `export class Inner {
  compute(v: number): number {
    return v * 2;
  }
}

export class Outer {
  inner(): Inner {
    return new Inner();
  }
}

export function run(x: number): number {
  const out = new Outer();
  const r = out.inner().compute(x);
  return r;
}
`;

const tmpDirs: string[] = [];
function chainedRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-pdg-chain-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), CHAINED_SOURCE);
  tmpDirs.push(dir);
  return dir;
}

describe('PDG calleeIds — chained receiver calls (#2802 follow-up)', () => {
  afterAll(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('records BOTH links of a chained call on the calling block', async () => {
    const result = await runPipelineFromRepo(chainedRepo(), () => {}, { pdg: true });

    const chainedBlocks: string[] = [];
    result.graph.forEachNode((n) => {
      if (n.label !== 'BasicBlock') return;
      const text = typeof n.properties.text === 'string' ? n.properties.text : '';
      if (!text.includes('out.inner().compute(')) return;
      chainedBlocks.push(typeof n.properties.calleeIds === 'string' ? n.properties.calleeIds : '');
    });

    // Exactly one block spans the chained statement; a fixture drift that split
    // or dropped it would otherwise make the assertions below vacuous.
    expect(chainedBlocks).toHaveLength(1);
    const calleeIds = chainedBlocks[0];

    // First link — resolves from a named receiver (`out`), the plain path.
    expect(calleeIds).toContain('Outer.inner');
    // Second link — resolves ONLY through the chain's carried receiver type.
    // This is the assertion that fails if chained resolution stops reaching the
    // PDG, which would silently make the descent unable to cross into `compute`.
    expect(calleeIds).toContain('Inner.compute');
  }, 60000);
});
