/**
 * Regression tests for the safePushAll helper and the pipeline call sites
 * that must use it instead of `array.push(...largeArray)`.
 *
 * The spread operator converts every element into a V8 call-stack argument.
 * At ~65k+ elements a single `push(...arr)` call overflows the stack.
 *
 * Two layers of defense:
 * 1. Unit tests — safePushAll itself works at scale.
 * 2. Static analysis — pipeline.ts contains no `.push(...` in the
 *    chunk-accumulation section, catching future reintroductions.
 */
import { describe, it, expect } from 'vitest';
import { safePushAll } from '../../src/core/ingestion/array-utils.js';
import fs from 'fs';
import path from 'path';

/** Size well above V8's ~65k call-stack argument limit. */
const OVERFLOW_SIZE = 200_000;

describe('safePushAll', () => {
  it('appends elements in order for a small array', () => {
    const target = [1, 2, 3];
    safePushAll(target, [4, 5, 6]);
    expect(target).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('handles an empty source array', () => {
    const target = [1];
    safePushAll(target, []);
    expect(target).toEqual([1]);
  });

  it('handles an empty target array', () => {
    const target: number[] = [];
    safePushAll(target, [1, 2]);
    expect(target).toEqual([1, 2]);
  });

  it(`handles ${OVERFLOW_SIZE.toLocaleString()} elements without stack overflow`, () => {
    const source = new Array<number>(OVERFLOW_SIZE);
    for (let i = 0; i < OVERFLOW_SIZE; i++) source[i] = i;

    const target: number[] = [];
    safePushAll(target, source);

    expect(target.length).toBe(OVERFLOW_SIZE);
    expect(target[0]).toBe(0);
    expect(target[OVERFLOW_SIZE - 1]).toBe(OVERFLOW_SIZE - 1);
  });
});

describe('pipeline.ts has no spread-push in chunk accumulation', () => {
  const pipelinePath = path.resolve(__dirname, '../../src/core/ingestion/pipeline.ts');
  const source = fs.readFileSync(pipelinePath, 'utf-8');
  const lines = source.split('\n');

  it('does not use .push(...) on deferred accumulation arrays', () => {
    // These are the arrays that accumulate per-chunk worker results.
    // Any .push(...) on them will overflow on large repos.
    const accumulatorNames = [
      'deferredWorkerCalls',
      'deferredWorkerHeritage',
      'deferredConstructorBindings',
      'deferredAssignments',
      'workerTypeEnvBindings',
      'allFetchCalls',
      'allExtractedRoutes',
      'allDecoratorRoutes',
      'allToolDefs',
      'allORMQueries',
    ];

    const spreadPushPattern = /\.push\(\.\.\./;
    const violations: string[] = [];

    lines.forEach((line, idx) => {
      if (spreadPushPattern.test(line)) {
        const trimmed = line.trim();
        // Check if the push target is one of the known accumulator arrays
        if (accumulatorNames.some((name) => trimmed.startsWith(`${name}.push(`))) {
          violations.push(`line ${idx + 1}: ${trimmed}`);
        }
      }
    });

    expect(
      violations,
      'Found .push(...) on chunk-accumulation arrays in pipeline.ts. ' +
        'Use safePushAll() instead to avoid V8 stack overflow on large repos.',
    ).toEqual([]);
  });
});
