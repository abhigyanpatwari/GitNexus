/**
 * Python scope-capture O(n^2) regression tripwire.
 *
 * NOT gated behind GITNEXUS_BENCH and needs no compiled worker — it runs in
 * normal CI and is the actual guard against an O(n^2) re-regression of
 * `emitPythonScopeCaptures`. It calls the hotpath directly on a ~400-entity
 * generated source. The O(n) path (threading the tree-sitter query's captured
 * node) does this in a few hundred ms; the old findNodeAtRange-from-root
 * behaviour took ~25s+ at this size. The budget is a coarse tripwire (huge
 * margin over the fixed path, far below a quadratic regression), not a
 * microbenchmark — keep it generous so it never flakes on a loaded CI runner.
 *
 * Mirrors test/integration/go-pipeline-benchmark.test.ts's "O(n^2) regression
 * tripwire" suite (issue #1848).
 */
import { describe, it, expect } from 'vitest';
import { emitPythonScopeCaptures } from '../../src/core/ingestion/languages/python/index.js';

describe('Python scope-capture O(n^2) regression tripwire', () => {
  /**
   * DAO-style source: top-level imports + N classes (each with methods) + N
   * module functions. Maximizes top-level children AND function matches, which
   * is exactly the O(matches x rootChildren) shape the fix removed.
   */
  function generatePythonDaoSource(entityCount: number): string {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(`from pkg.mod${i} import alpha${i}, beta${i}, gamma${i} as g${i}`);
      lines.push(`import top.level.module${i}`);
    }
    lines.push('');
    for (let i = 0; i < entityCount; i++) {
      const n = String(i).padStart(4, '0');
      lines.push(
        `class Entity${n}:`,
        `    def __init__(self, id: int, name: str):`,
        `        self.id = id`,
        `        self.name = name`,
        `    def get_id(self) -> int:`,
        `        return self.id`,
        `    def set_name(self, name: str) -> None:`,
        `        self.name = name`,
        `    @classmethod`,
        `    def make(cls, id: int):`,
        `        return cls(id, "x")`,
        '',
        `def build_entity${n}(id: int, name: str) -> Entity${n}:`,
        `    return Entity${n}(id, name)`,
        '',
      );
    }
    return lines.join('\n');
  }

  it('parses a 400-entity file in well under the O(n^2) tripwire budget', () => {
    const ENTITY_COUNT = 400;
    const BUDGET_MS = 10_000; // coarse: ~30x the fixed path, far under a quadratic regression
    const src = generatePythonDaoSource(ENTITY_COUNT);

    emitPythonScopeCaptures(src, 'tripwire-warmup.py'); // warm up the parser/query JIT

    const start = Date.now();
    const matches = emitPythonScopeCaptures(src, 'tripwire.py');
    const elapsedMs = Date.now() - start;

    // Sanity: the captures are actually produced (each entity emits many capture
    // groups), so a fast-but-empty result can't pass.
    expect(matches.length).toBeGreaterThan(ENTITY_COUNT * 10);
    // The actual regression guard: a re-regression to O(n^2) blows this budget.
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
