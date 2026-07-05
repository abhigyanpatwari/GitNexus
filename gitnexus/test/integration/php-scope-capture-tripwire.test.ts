/**
 * PHP scope-capture O(n^2) regression tripwire.
 *
 * NOT gated behind GITNEXUS_BENCH and needs no compiled worker — it runs in
 * normal CI and is the actual guard against an O(n^2) re-regression of
 * `emitPhpScopeCaptures`. It calls the hotpath directly on a ~400-entity
 * generated source. The O(n) path (threading the tree-sitter query's captured
 * node) does this in a few hundred ms; the old findNodeAtRange-from-root
 * behaviour took multiple seconds+ at this size. The budget is a coarse tripwire
 * (huge margin over the fixed path, far below a quadratic regression), not a
 * microbenchmark — keep it generous so it never flakes on a loaded CI runner.
 *
 * Mirrors test/integration/python-scope-capture-tripwire.test.ts (PR #1918).
 */
import { describe, it, expect } from 'vitest';
import { emitPhpScopeCaptures } from '../../src/core/ingestion/languages/php/index.js';

describe('PHP scope-capture O(n^2) regression tripwire', () => {
  /**
   * DAO-style source: top-level `<?php` header + N classes, each with fields and
   * methods. Maximizes top-level children AND member matches, which is exactly
   * the O(matches x rootChildren) shape the fix removed. Reuses the synthetic
   * unit shape from bench/scope-capture/measure.mjs.
   */
  function generatePhpDaoSource(entityCount: number): string {
    let src = '<?php\n\n';
    for (let i = 0; i < entityCount; i++) {
      src +=
        `class Entity${i} {\n` +
        `  public $id;\n  public $name;\n` +
        `  function getId() { return $this->id; }\n` +
        `  function setName($v) { $this->name = $v; }\n}\n\n`;
    }
    return src;
  }

  it('parses a 400-entity file in well under the O(n^2) tripwire budget', () => {
    const ENTITY_COUNT = 400;
    const BUDGET_MS = 10_000; // coarse: far over the fixed path, far under a quadratic regression
    const src = generatePhpDaoSource(ENTITY_COUNT);

    emitPhpScopeCaptures(src, 'tripwire-warmup.php'); // warm up the parser/query JIT

    const start = Date.now();
    const matches = emitPhpScopeCaptures(src, 'tripwire.php');
    const elapsedMs = Date.now() - start;

    // Sanity: the captures are actually produced (each entity emits many capture
    // groups), so a fast-but-empty result can't pass.
    expect(matches.length).toBeGreaterThan(ENTITY_COUNT * 5);
    // The actual regression guard: a re-regression to O(n^2) blows this budget.
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
