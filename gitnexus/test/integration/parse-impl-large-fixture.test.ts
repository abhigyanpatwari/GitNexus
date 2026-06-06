/**
 * U6 (B3 from PR #1693 review) — Multi-chunk pipeline integration with a
 * wall-clock budget.
 *
 * The PR's headline claim is "analyze no longer hangs on TS-root-shaped
 * loads". The unit suite already pins each resilience layer individually
 * (worker-pool-resilience.test.ts), the deferred-extraction equivalence
 * (parse-impl-deferred-extraction.test.ts — U7), and the chunk
 * concurrency (parse-impl-chunk-concurrency.test.ts — U1). What was
 * missing: a single end-to-end run that exercises the full chunked
 * parse-and-resolve path on a multi-chunk fixture, BOUNDED by a
 * wall-clock so a regression that re-introduces the hang fails this
 * test loudly instead of slipping past via inequality assertions.
 *
 * This runs the real worker pool (the sole parse path since the sequential
 * parser was removed) on a multi-chunk fixture, BOUNDED by a wall-clock so a
 * regression that re-introduces the hang fails loudly instead of slipping past
 * via inequality assertions. The load-bearing invariants — multi-chunk parsing
 * completes within a bounded budget and produces all expected symbols — catch
 * the bulk of the regressions B3 was concerned about. Needs the dist worker
 * (integration tier).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGINAL_BUDGET = process.env.GITNEXUS_CHUNK_BYTE_BUDGET;
const WALL_CLOCK_BUDGET_MS = 30_000;

function buildFixture(): Record<string, string> {
  const fixture: Record<string, string> = {};
  for (let i = 0; i < 15; i++) {
    fixture[`mod${i}.ts`] = `export function fn${i}(): number {\n  return ${i};\n}\n`;
  }
  // A "realistically dense" file — 30 functions + a class + an interface +
  // a re-export. Stands in for the kind of file that previously stalled the
  // serial-extraction chunk loop. Pure-TS so the parser doesn't choke.
  const complexFnLines = Array.from(
    { length: 30 },
    (_, i) => `export function complex${i}(c: Config): string { return c.name + String(${i}); }`,
  ).join('\n');
  fixture['complex.ts'] = `
export interface Config { name: string; }
export class Service {
  configure(c: Config): void { this.name = c.name; }
  private name: string = '';
  describe(): string { return this.name; }
}
${complexFnLines}
`;
  fixture['index.ts'] =
    'export { Service, type Config } from "./complex";\n' +
    Array.from({ length: 15 }, (_, i) => `export { fn${i} } from "./mod${i}";`).join('\n') +
    '\n';
  return fixture;
}

async function runFixture(): Promise<{
  nodeCount: number;
  relationshipCount: number;
  symbolNames: Set<string>;
  elapsedMs: number;
}> {
  const fixture = buildFixture();
  // Force multi-chunk parsing on the small fixture by lowering the byte
  // budget below each file's size. parse-impl reads the budget at module
  // load — vi.resetModules() forces a fresh module so the env takes effect.
  process.env.GITNEXUS_CHUNK_BYTE_BUDGET = '64';
  vi.resetModules();
  const { runChunkedParseAndResolve } =
    await import('../../src/core/ingestion/pipeline-phases/parse-impl.js');
  const { createKnowledgeGraph } = await import('../../src/core/graph/graph.js');

  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-large-fixture-'));
  try {
    for (const [name, content] of Object.entries(fixture)) {
      fs.writeFileSync(path.join(repoPath, name), content);
    }
    const files = Object.keys(fixture);
    const scanned = files.map((rel) => ({
      path: rel,
      size: fs.statSync(path.join(repoPath, rel)).size,
    }));
    const graph = createKnowledgeGraph();

    // Wrap the run in Promise.race so the wall-clock budget is enforced
    // as an exception, not a >=/<= inequality assertion (DoD §2.7 — a
    // bounds-only count is a regression-mask; a hard timeout is a
    // hang-detector). If the run exceeds the budget, the rejection
    // fails the test with a specific timeout error so the diagnostic
    // surfaces the actual regression class.
    const start = Date.now();
    await Promise.race([
      runChunkedParseAndResolve(graph, scanned, files, files.length, repoPath, start, () => {}, {}),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `runChunkedParseAndResolve exceeded ${WALL_CLOCK_BUDGET_MS}ms wall-clock budget — likely the hang B3 was meant to prevent`,
              ),
            ),
          WALL_CLOCK_BUDGET_MS,
        ),
      ),
    ]);
    const elapsedMs = Date.now() - start;

    const symbolNames = new Set<string>();
    for (const node of graph.nodes.values()) {
      const name = (node.properties as { name?: string } | undefined)?.name;
      if (typeof name === 'string') symbolNames.add(name);
    }

    return {
      nodeCount: graph.nodeCount,
      relationshipCount: graph.relationshipCount,
      symbolNames,
      elapsedMs,
    };
  } finally {
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }
}

describe('parse-impl wall-clock integration on multi-chunk fixture (U6 / B3)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_BUDGET === undefined) {
      delete process.env.GITNEXUS_CHUNK_BYTE_BUDGET;
    } else {
      process.env.GITNEXUS_CHUNK_BYTE_BUDGET = ORIGINAL_BUDGET;
    }
  });

  it('completes a 17-file multi-chunk fixture within wall-clock and indexes every named symbol', async () => {
    const result = await runFixture();

    // Reaching this assertion means the Promise.race did NOT time out —
    // the run completed in under WALL_CLOCK_BUDGET_MS. That alone is the
    // primary B3 invariant: "does not hang on a multi-chunk workload";
    // the race rejection already enforces it. The previous
    // `Math.min(elapsedMs, BUDGET)` form here resolved to
    // `expect(x).toBe(x)` — tautological and catching nothing. The
    // load-bearing wall-clock check lives in the Promise.race above;
    // the per-symbol assertions below catch silent mid-chunk crashes.
    expect(typeof result.elapsedMs).toBe('number');

    // All 15 plain function declarations must show up in the graph.
    for (let i = 0; i < 15; i++) {
      expect(result.symbolNames.has(`fn${i}`)).toBe(true);
    }

    // The complex.ts surfaces: Service class, Config interface, configure
    // method, and a representative sampling of the complex0..complex29
    // functions. Pin specific names (not just a count) so chunk-boundary
    // truncation surfaces as a concrete missing-symbol failure with a
    // specific diagnostic.
    expect(result.symbolNames.has('Service')).toBe(true);
    expect(result.symbolNames.has('Config')).toBe(true);
    expect(result.symbolNames.has('configure')).toBe(true);
    expect(result.symbolNames.has('describe')).toBe(true);
    expect(result.symbolNames.has('complex0')).toBe(true);
    expect(result.symbolNames.has('complex15')).toBe(true);
    expect(result.symbolNames.has('complex29')).toBe(true);
  });
});
