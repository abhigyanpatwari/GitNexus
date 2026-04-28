import { describe, it, expect } from 'vitest';
import { PhaseTimer } from '../../src/core/search/phase-timer.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('PhaseTimer', () => {
  it('start/stop records a single phase', async () => {
    const t = new PhaseTimer();
    t.start('bm25');
    await sleep(20);
    t.stop();

    const phases = t.summary();
    expect(phases.bm25).toBeGreaterThanOrEqual(15); // allow a bit of scheduler slack
    expect(Object.keys(phases)).toEqual(['bm25']);
  });

  it('start implicitly stops the previous phase', async () => {
    const t = new PhaseTimer();
    t.start('a');
    await sleep(10);
    t.start('b'); // auto-stops 'a'
    await sleep(10);
    t.stop();

    const phases = t.summary();
    expect(phases.a).toBeGreaterThanOrEqual(5);
    expect(phases.b).toBeGreaterThanOrEqual(5);
  });

  it('mark accumulates additive durations for the same phase', () => {
    const t = new PhaseTimer();
    t.mark('x', 5);
    t.mark('x', 3);
    t.mark('y', 7);

    const phases = t.summary();
    expect(phases.x).toBe(8);
    expect(phases.y).toBe(7);
  });

  it('time() records concurrent promises independently (Promise.all safe)', async () => {
    const t = new PhaseTimer();
    await Promise.all([t.time('a', sleep(30)), t.time('b', sleep(80))]);

    const phases = t.summary();
    // Both phases recorded independently despite overlapping in time.
    expect(phases.a).toBeGreaterThanOrEqual(25);
    expect(phases.a).toBeLessThan(80);
    expect(phases.b).toBeGreaterThanOrEqual(75);
  });

  it('mark rejects negative or non-finite durations', () => {
    const t = new PhaseTimer();
    t.mark('x', -1);
    t.mark('x', Number.NaN);
    t.mark('x', Number.POSITIVE_INFINITY);

    const phases = t.summary();
    expect(phases.x).toBeUndefined();
  });

  it('totalMs sums all phases and implicitly stops the active one', async () => {
    const t = new PhaseTimer();
    t.mark('a', 10);
    t.mark('b', 15);
    t.start('c');
    await sleep(20);
    // Call totalMs without stopping — it should stop 'c' implicitly.
    const total = t.totalMs();

    expect(total).toBeGreaterThanOrEqual(40); // 10 + 15 + ~20
    const phases = t.summary();
    expect(phases.c).toBeGreaterThanOrEqual(15);
  });
});
