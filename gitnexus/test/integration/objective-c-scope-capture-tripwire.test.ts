/**
 * Always-on Objective-C scope-capture scaling tripwire.
 *
 * Block bindings are deliberately shadowed across functions. This keeps both
 * the block seed path and lexical callable invocation path hot while making an
 * accidental block-by-all-calls cross product grow quadratically.
 */
import { describe, expect, it } from 'vitest';

import { emitObjectiveCScopeCaptures } from '../../src/core/ingestion/languages/objective-c/captures.js';

function generateBlockSource(count: number): string {
  const functions: string[] = [];
  for (let index = 0; index < count; index += 1) {
    functions.push(
      `void run${index}(void) {\n` + '  void (^handler)(void) = ^{ };\n' + '  handler();\n' + '}',
    );
  }
  return functions.join('\n');
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function timedEmit(count: number): { readonly elapsedMs: number; readonly captures: number } {
  const source = generateBlockSource(count);
  emitObjectiveCScopeCaptures(source, `warmup-${count}.m`);
  const samples: number[] = [];
  let captures = 0;
  for (let run = 0; run < 3; run += 1) {
    const startedAt = performance.now();
    captures = emitObjectiveCScopeCaptures(source, `tripwire-${count}.m`).length;
    samples.push(performance.now() - startedAt);
  }
  return { elapsedMs: median(samples), captures };
}

describe('Objective-C scope-capture scaling tripwire', () => {
  it('keeps per-block capture cost roughly flat across a fourfold input increase', () => {
    const small = timedEmit(100);
    const large = timedEmit(400);

    expect(small.captures).toBeGreaterThan(600);
    expect(large.captures).toBeGreaterThan(2_400);
    // Linear work grows ~4x. The 8x ceiling leaves wide CI headroom while a
    // block-by-all-calls cross product grows ~16x and reliably trips the guard.
    expect(large.elapsedMs / Math.max(small.elapsedMs, 0.001)).toBeLessThan(8);
  }, 20_000);
});
