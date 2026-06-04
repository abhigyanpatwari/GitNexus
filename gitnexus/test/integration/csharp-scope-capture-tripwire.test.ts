/**
 * C# scope-capture O(n^2) regression tripwire.
 *
 * NOT gated behind GITNEXUS_BENCH and needs no compiled worker — it runs in
 * normal CI and is the actual guard against an O(n^2) re-regression of
 * `emitCsharpScopeCaptures` (the path PR #1918 made linear). It calls the
 * hotpath directly on a ~400-entity generated source. The O(n) path (threading
 * the tree-sitter query's captured node) does this in a few hundred ms; a
 * findNodeAtRange-from-root re-regression would take many seconds at this size.
 * The budget is a coarse tripwire (huge margin over the fixed path, far below a
 * quadratic regression), not a microbenchmark — keep it generous so it never
 * flakes on a loaded CI runner.
 *
 * Mirrors test/integration/python-scope-capture-tripwire.test.ts (issue #1848 /
 * PR #1918).
 */
import { describe, it, expect } from 'vitest';
import { emitCsharpScopeCaptures } from '../../src/core/ingestion/languages/csharp/index.js';

describe('C# scope-capture O(n^2) regression tripwire', () => {
  /**
   * DAO-style source: a namespace + N classes, each carrying fields plus
   * getter/setter methods. Reuses the synthetic DAO unit shape from
   * bench/scope-capture/measure.mjs. Maximizes top-level children AND member
   * matches, which is exactly the O(matches x rootChildren) shape the fix
   * removed.
   */
  function generateCsharpDaoSource(entityCount: number): string {
    let src = 'namespace Generated;\n\n';
    for (let i = 0; i < entityCount; i++) {
      src +=
        `public class Entity${i} {\n` +
        `  public long Id;\n  public string Name;\n` +
        `  public long GetId() { return Id; }\n` +
        `  public void SetName(string v) { Name = v; }\n}\n\n`;
    }
    return src;
  }

  it('parses a 400-entity file in well under the O(n^2) tripwire budget', () => {
    const ENTITY_COUNT = 400;
    const BUDGET_MS = 10_000; // coarse: far over the fixed path, far under a quadratic regression
    const src = generateCsharpDaoSource(ENTITY_COUNT);

    emitCsharpScopeCaptures(src, 'tripwire-warmup.cs'); // warm up the parser/query JIT

    const start = Date.now();
    const matches = emitCsharpScopeCaptures(src, 'tripwire.cs');
    const elapsedMs = Date.now() - start;

    // Sanity: the captures are actually produced (each entity emits many capture
    // groups), so a fast-but-empty result can't pass.
    expect(matches.length).toBeGreaterThan(ENTITY_COUNT * 5);
    // The actual regression guard: a re-regression to O(n^2) blows this budget.
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
