import { describe, expect, it } from 'vitest';
import { embedInputRanges } from '../../src/core/embeddings/embedding-pipeline.js';
import { HttpEmbeddingError } from '../../src/core/embeddings/http-client.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Provider whose requests stay open until the test releases them. */
function heldProvider() {
  const open: Array<{ texts: string[]; release: () => void }> = [];
  let active = 0;
  let peak = 0;
  const provider = async (texts: string[]) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((release) => open.push({ texts, release }));
    active--;
    return texts.map((text) => Float32Array.of(Number(text)));
  };
  return { provider, open, peak: () => peak };
}

const texts = Array.from({ length: 10 }, (_, i) => String(i));

describe('embedInputRanges provider concurrency (#3870)', () => {
  it.each([
    [undefined, 1],
    [3, 3],
  ])('with concurrency %s keeps %i requests in flight', async (concurrency, expected) => {
    const held = heldProvider();
    const ranges: number[][] = [];
    const consumed = (async () => {
      for await (const range of embedInputRanges(texts, 2, undefined, held.provider, concurrency))
        ranges.push([range.start, range.end]);
    })();
    await tick();
    expect(held.open).toHaveLength(expected);
    // Release every request, newest first, until all five sub-batches finish.
    for (let released = 0; released < 5; ) {
      const request = held.open.pop();
      request?.release();
      released += request ? 1 : 0;
      await tick();
    }
    await consumed;
    expect(held.peak()).toBe(expected);
    // Out-of-order completion never reorders results: a node's chunks must
    // reach the vector store contiguously.
    expect(ranges).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
      [6, 8],
      [8, 10],
    ]);
  });

  it('bisects a rejected sub-batch in place while its neighbours proceed', async () => {
    const provider = async (batch: string[]) => {
      await tick();
      if (batch.includes('5')) throw new HttpEmbeddingError('input too long', { status: 413 });
      return batch.map((text) => Float32Array.of(Number(text)));
    };
    const results: Array<[number, number, boolean]> = [];
    for await (const range of embedInputRanges(texts, 4, undefined, provider, 3))
      results.push([range.start, range.end, 'error' in range]);
    expect(results).toEqual([
      [0, 4, false],
      [4, 5, false],
      [5, 6, true],
      [6, 8, false],
      [8, 10, false],
    ]);
  });

  it('settles in-flight requests before surfacing a cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    let settled = 0;
    const provider = async (batch: string[]) => {
      await tick();
      if (batch[0] === '0') controller.abort(reason);
      await tick();
      settled++;
      if (controller.signal.aborted) throw reason;
      return batch.map((text) => Float32Array.of(Number(text)));
    };
    const consume = async () => {
      for await (const range of embedInputRanges(texts, 2, controller.signal, provider, 3))
        expect(range.start).toBeGreaterThanOrEqual(0);
    };
    await expect(consume()).rejects.toBe(reason);
    expect(settled).toBe(3);
  });
});
