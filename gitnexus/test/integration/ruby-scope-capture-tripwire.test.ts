/**
 * Ruby scope-capture O(n^2) regression tripwire.
 *
 * NOT gated behind GITNEXUS_BENCH and needs no compiled worker — it runs in
 * normal CI and is the actual guard against an O(n^2) re-regression of
 * `emitRubyScopeCaptures`. It calls the hotpath directly on a ~400-entity
 * generated source. The O(n) path (PR #1918, threading the tree-sitter query's
 * captured node) does this in a few hundred ms; the old
 * findNodeAtRange-from-root behaviour scaled quadratically at this size. The
 * budget is a coarse tripwire (huge margin over the fixed path, far below a
 * quadratic regression), not a microbenchmark — keep it generous so it never
 * flakes on a loaded CI runner.
 *
 * Mirrors test/integration/python-scope-capture-tripwire.test.ts (issue #1848).
 */
import { describe, it, expect } from 'vitest';
import { emitRubyScopeCaptures } from '../../src/core/ingestion/languages/ruby/index.js';

describe('Ruby scope-capture O(n^2) regression tripwire', () => {
  /**
   * DAO-style source: N classes, each with two methods. Maximizes top-level
   * children AND method matches, which is exactly the O(matches x rootChildren)
   * shape the fix removed. Mirrors the `ruby` unit shape in
   * bench/scope-capture/measure.mjs.
   */
  function generateRubyDaoSource(entityCount: number): string {
    let src = '';
    for (let i = 0; i < entityCount; i++) {
      src +=
        `class Entity${i}\n` +
        `  def get_id\n    @id\n  end\n` +
        `  def set_name(v)\n    @name = v\n  end\nend\n\n`;
    }
    return src;
  }

  it('parses a 400-entity file in well under the O(n^2) tripwire budget', () => {
    const ENTITY_COUNT = 400;
    const BUDGET_MS = 10_000; // coarse: many x the fixed path, far under a quadratic regression
    const src = generateRubyDaoSource(ENTITY_COUNT);

    emitRubyScopeCaptures(src, 'tripwire-warmup.rb'); // warm up the parser/query JIT

    const start = Date.now();
    const matches = emitRubyScopeCaptures(src, 'tripwire.rb');
    const elapsedMs = Date.now() - start;

    // Sanity: the captures are actually produced (each entity emits many capture
    // groups), so a fast-but-empty result can't pass.
    expect(matches.length).toBeGreaterThan(ENTITY_COUNT * 5);
    // The actual regression guard: a re-regression to O(n^2) blows this budget.
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
