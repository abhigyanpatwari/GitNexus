/**
 * U4 (M2) — Monotonic progress through the parse + deferred-extraction phases.
 *
 * Before this fix, parse-impl emitted `percent: 82` for every progress
 * update during the deferred resolution stages (imports, heritage, routes,
 * calls). The UI sat at 82 for the duration of the deferred work — on real
 * repos, several seconds to minutes — looking exactly like a hang, which is
 * the user-facing symptom PR #1693 set out to fix.
 *
 * After M2, parse phase covers 20-70 and deferred extraction covers 70-95
 * across four labelled sub-bands. This test runs `runChunkedParseAndResolve`
 * on a small temp repo via the deterministic sequential-fallback path
 * (`skipWorkers: true`) and asserts the recorded percent stream is strictly
 * non-decreasing AND reaches the deferred band (>=70) before returning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

function makeTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-impl-progress-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function scanned(repo: string, files: string[]) {
  return files.map((rel) => ({
    path: rel,
    size: fs.statSync(path.join(repo, rel)).size,
  }));
}

describe('parse-impl progress monotonicity (U4 M2)', () => {
  let repoPath = '';

  beforeEach(() => {
    repoPath = makeTempRepo({
      'a.ts': `export function foo() { return 1; }\n`,
      'b.ts': `import { foo } from './a';\nexport function bar() { return foo(); }\n`,
      'c.ts': `import { bar } from './b';\nexport class Baz { run() { return bar(); } }\n`,
    });
  });

  afterEach(() => {
    if (repoPath && fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('emits a strictly non-decreasing percent stream and reaches the deferred band', async () => {
    const graph = createKnowledgeGraph();
    const files = ['a.ts', 'b.ts', 'c.ts'];
    const percents: number[] = [];

    await runChunkedParseAndResolve(
      graph,
      scanned(repoPath, files),
      files,
      files.length,
      repoPath,
      Date.now(),
      (p) => {
        if (typeof p.percent === 'number') percents.push(p.percent);
      },
      { skipWorkers: true },
    );

    // The stream MUST be non-empty (a regression that stops emitting
    // progress should fail this test). Express via exact-equality
    // negation rather than a bound.
    expect(percents).not.toEqual([]);

    // Strict monotonic non-decreasing across the whole stream. Direct
    // comparison — the previous `Math.max(prev, cur)` form resolved to
    // `expect(cur).toBe(cur)` which is a tautology.
    for (let i = 1; i < percents.length; i++) {
      if (percents[i] < percents[i - 1]) {
        throw new Error(
          `progress regressed: percents[${i}]=${percents[i]} < percents[${i - 1}]=${percents[i - 1]}`,
        );
      }
    }

    // The parse phase advances through 20-70; the deferred extraction band
    // covers 70-95. On a 3-file fixture with imports + heritage + calls,
    // we should observe at least one percent value in the 70-95 band so the
    // monotonic-advance behavior is exercised, not just the parse half.
    const reachedDeferredBand = percents.some((p) => p >= 70 && p <= 95);
    expect(reachedDeferredBand).toBe(true);

    // On this 3-file fixture in skipWorkers mode the deferred band
    // advances exactly to 70 (the start of the band). The orchestrator
    // (run-analyze) drives 70-100 itself once cross-chunk extraction
    // finishes. Pinning the exact observed value catches both an
    // upper-bound regression (anything >70 would unexpectedly land in
    // the band) AND a lower-bound regression (anything <70 would mean
    // the parse phase didn't complete).
    expect(percents[percents.length - 1]).toBe(70);
  });

  it('emits percent 95 (not 82) when there are no parseable files to skip past the parse band', async () => {
    const graph = createKnowledgeGraph();
    // No parseable files: empty scanned list, empty parseable list.
    const percents: number[] = [];

    await runChunkedParseAndResolve(
      graph,
      [],
      [],
      0,
      repoPath,
      Date.now(),
      (p) => {
        if (typeof p.percent === 'number') percents.push(p.percent);
      },
      { skipWorkers: true },
    );

    // The early-return path must emit 95 (the new post-deferred ceiling),
    // not the stale 82 it used before M2 — otherwise downstream phases
    // would visibly regress percent on the next update.
    expect(percents).toEqual([95]);
  });
});
