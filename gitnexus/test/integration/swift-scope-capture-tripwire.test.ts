/**
 * Tripwire: emitSwiftScopeCaptures must stay O(n) in entity count.
 *
 * #1848 (Go) was an O(n²) scope-capture regression: each capture re-derived
 * its node via findNodeAtRange(tree.rootNode, …), so capture extraction went
 * quadratic on big files. Swift threads the captured node through directly
 * (issue #937, RFC #909 Ring 3). This guards against a re-introduction by
 * asserting the per-entity cost stays roughly flat across a 4× size increase.
 *
 * Complements bench/scope-capture/measure.mjs (which pins a fingerprint + a
 * 1.5× scaling budget for the `--check` CI job): this always-on test fails the
 * normal suite — no GITNEXUS_BENCH gate, no committed baseline — if the path
 * regresses to quadratic.
 *
 * Swift is an optional dependency; skips gracefully if the grammar isn't built.
 *
 * Kept out of the unit suite's tight timeout: lives in integration where a few
 * hundred ms of generated-source parsing is acceptable. Pattern mirrors
 * test/integration/csharp-scope-capture-tripwire.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { emitSwiftScopeCaptures } from '../../src/core/ingestion/languages/swift/index.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

/** Generate a Swift source file with `n` DAO-style classes. */
function generateSource(n: number): string {
  const classes: string[] = [];
  for (let i = 0; i < n; i++) {
    classes.push(
      `class Entity${i} {\n` +
        `  var id: Int64 = 0\n` +
        `  var name: String = ""\n` +
        `  func getId() -> Int64 { return self.id }\n` +
        `  func setName(_ v: String) { self.name = v }\n` +
        `}`,
    );
  }
  return classes.join('\n\n');
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median elapsed ms to run `emitSwiftScopeCaptures` over `reps` runs. */
function timeEmit(n: number, reps: number): number {
  const src = generateSource(n);
  // Warm up parser/query compilation so the first run's JIT cost is excluded.
  emitSwiftScopeCaptures(src, 'warmup.swift');
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    emitSwiftScopeCaptures(src, `bench-${n}.swift`);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return median(samples);
}

describe.skipIf(!swiftAvailable)('swift scope-capture scaling (O(n) tripwire)', () => {
  it('emits at least one capture per entity', () => {
    const matches = emitSwiftScopeCaptures(generateSource(250), 'count.swift');
    expect(matches.length).toBeGreaterThan(250);
  });

  it('per-entity cost stays roughly flat from 250 to 1000 entities', () => {
    const reps = 5;
    const tSmall = timeEmit(250, reps);
    const tLarge = timeEmit(1000, reps);

    // Linear would be ~4× (4× the entities). Allow generous headroom for noise
    // and parser variance; quadratic would be ~16×, so 8× cleanly separates them.
    const ratio = tLarge / Math.max(tSmall, 0.001);
    expect(ratio).toBeLessThan(8);
  });
});
