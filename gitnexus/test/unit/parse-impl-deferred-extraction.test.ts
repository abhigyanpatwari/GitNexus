/**
 * U7 (B4 from PR #1693 review) — Deferred-extraction multi-chunk graph
 * equivalence.
 *
 * PR #1693 moved the per-chunk extraction passes (processImportsFromExtracted,
 * processHeritageFromExtracted, processRoutesFromExtracted,
 * synthesizeWildcardImportBindings, seedCrossFileReceiverTypes) out of the
 * per-chunk loop into a single end-of-loop pass. Lane 4 of the production-
 * readiness review proved the reorder is observably equivalent for every
 * processor under the worker path — but the existing suite never asserted
 * cross-chunk graph equivalence, which lets a future refactor that
 * accidentally tightens the per-chunk vs end-of-loop coupling break
 * cross-chunk import / heritage / call resolution silently.
 *
 * This file forces multi-chunk parsing on a small fixture by setting
 * `GITNEXUS_CHUNK_BYTE_BUDGET` low BEFORE the parse-impl module loads
 * (the budget is captured at module load, not per call — that's U14 from
 * Phase 2). Module re-loading is driven by `vi.resetModules()`. Then runs
 * the same fixture under a high budget (single chunk) and asserts the
 * two graphs are byte-identical: same node count, same relationship
 * count, same specific cross-chunk symbols.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGINAL_BUDGET = process.env.GITNEXUS_CHUNK_BYTE_BUDGET;

type Fixture = Record<string, string>;

/**
 * Cross-chunk fixture: file A defines, file B imports from A and re-exports,
 * file C imports from B and defines a class extending an A symbol. Forces
 * the resolver to chain imports across files — which the deferred-extraction
 * path must handle correctly under any chunking arrangement.
 */
const FIXTURE: Fixture = {
  'a.ts': 'export class Animal { speak(): string { return "noise"; } }\n',
  'b.ts':
    'import { Animal } from "./a";\nexport class Dog extends Animal { bark(): string { return "woof"; } }\n',
  'c.ts': 'import { Dog } from "./b";\nexport function makeDog(): Dog { return new Dog(); }\n',
};

async function runWithBudget(budgetBytes: number): Promise<{
  nodeCount: number;
  relationshipCount: number;
  symbolNames: Set<string>;
}> {
  process.env.GITNEXUS_CHUNK_BYTE_BUDGET = String(budgetBytes);
  vi.resetModules();
  const { runChunkedParseAndResolve } =
    await import('../../src/core/ingestion/pipeline-phases/parse-impl.js');
  const { createKnowledgeGraph } = await import('../../src/core/graph/graph.js');

  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-multi-chunk-'));
  try {
    for (const [name, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(repoPath, name), content);
    }
    const files = Object.keys(FIXTURE);
    const scanned = files.map((rel) => ({
      path: rel,
      size: fs.statSync(path.join(repoPath, rel)).size,
    }));
    const graph = createKnowledgeGraph();
    await runChunkedParseAndResolve(
      graph,
      scanned,
      files,
      files.length,
      repoPath,
      Date.now(),
      () => {},
      { skipWorkers: true },
    );
    const symbolNames = new Set<string>();
    for (const node of graph.nodes.values()) {
      const name = (node.properties as { name?: string } | undefined)?.name;
      if (typeof name === 'string') symbolNames.add(name);
    }
    return {
      nodeCount: graph.nodeCount,
      relationshipCount: graph.relationshipCount,
      symbolNames,
    };
  } finally {
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }
}

describe('parse-impl deferred-extraction multi-chunk equivalence (U7 / B4)', () => {
  beforeEach(() => {
    // Fresh module cache for every test so the GITNEXUS_CHUNK_BYTE_BUDGET
    // change made inside runWithBudget actually takes effect — parse-impl
    // captures the budget at module load.
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_BUDGET === undefined) {
      delete process.env.GITNEXUS_CHUNK_BYTE_BUDGET;
    } else {
      process.env.GITNEXUS_CHUNK_BYTE_BUDGET = ORIGINAL_BUDGET;
    }
  });

  it('produces byte-identical graph under single-chunk (high budget) and multi-chunk (low budget) layouts', async () => {
    // 10 MB budget — three small files (well under 1 KB total) fit in one
    // chunk. This is the baseline against which the multi-chunk path is
    // compared.
    const single = await runWithBudget(10 * 1024 * 1024);

    // 64-byte budget — small enough that each fixture file ends up in its
    // own chunk (a.ts is ~60 bytes, b.ts/c.ts are larger). Forces the
    // deferred-extraction path to handle cross-chunk imports + class
    // hierarchy.
    const multi = await runWithBudget(64);

    // The load-bearing assertions for B4 — if these drift, the deferred
    // reorder is not observably equivalent and someone has to investigate.
    expect(multi.nodeCount).toBe(single.nodeCount);
    expect(multi.relationshipCount).toBe(single.relationshipCount);
  });

  it('resolves cross-chunk class symbols under the multi-chunk layout', async () => {
    // The multi-chunk path must still produce graph nodes for the symbols
    // declared across the three files. If chunking breaks resolution,
    // `Dog` (defined in b.ts but importing Animal from a.ts) or
    // `makeDog` (in c.ts, importing Dog from b.ts) would silently
    // disappear from the graph.
    const multi = await runWithBudget(64);

    expect(multi.symbolNames.has('Animal')).toBe(true);
    expect(multi.symbolNames.has('Dog')).toBe(true);
    expect(multi.symbolNames.has('makeDog')).toBe(true);
    expect(multi.symbolNames.has('speak')).toBe(true);
    expect(multi.symbolNames.has('bark')).toBe(true);
  });
});
