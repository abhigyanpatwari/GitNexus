/**
 * Per-phase wall-clock timing for the search pipeline and similar
 * multi-stage flows. Designed to be called from query() with minimal
 * ceremony and negligible overhead (< 0.1 ms per phase recorded).
 *
 * ### Sequential usage
 *
 * ```ts
 * const t = new PhaseTimer();
 * t.start('bm25'); await bm25Search(...); t.stop();
 * t.start('merge'); doMerge(); t.stop();
 * const phases = t.summary(); // { bm25: 42, merge: 3 }
 * ```
 *
 * ### Concurrent usage (Promise.all)
 *
 * `start`/`stop` assume a single active phase at a time, which is wrong
 * for concurrent work inside `Promise.all` — the second `start` would
 * auto-stop the first and only one of the two would get timed. Use
 * {@link PhaseTimer.time} to wrap each concurrent promise instead:
 *
 * ```ts
 * const [a, b] = await Promise.all([
 *   t.time('bm25', bm25Search(...)),
 *   t.time('vector', semanticSearch(...)),
 * ]);
 * ```
 *
 * ### Pre-measured durations
 *
 * ```ts
 * t.mark('inherited', 12.5);
 * ```
 */
export class PhaseTimer {
  private phases: Map<string, number> = new Map();
  private current: string | null = null;
  private t0 = 0;

  /** Start a new phase. Implicitly stops the previous one, if any. */
  start(phase: string): void {
    this.stop();
    this.current = phase;
    this.t0 = performance.now();
  }

  /** Stop the current phase. No-op if no phase is active. */
  stop(): void {
    if (this.current !== null) {
      const elapsed = performance.now() - this.t0;
      this.phases.set(this.current, (this.phases.get(this.current) ?? 0) + elapsed);
      this.current = null;
    }
  }

  /**
   * Record a pre-measured duration without touching the active phase.
   * Use for concurrent operations inside `Promise.all` where
   * `start`/`stop` would step on each other, or for durations imported
   * from sub-systems. Additive across repeated calls with the same
   * phase name. Ignores negative / non-finite inputs.
   */
  mark(phase: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.phases.set(phase, (this.phases.get(phase) ?? 0) + durationMs);
  }

  /**
   * Wrap a promise with automatic timing. Records wall time via
   * {@link PhaseTimer.mark} regardless of which other phases are
   * active — safe to use inside `Promise.all`.
   */
  async time<T>(phase: string, promise: Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await promise;
    } finally {
      this.mark(phase, performance.now() - t0);
    }
  }

  /**
   * Snapshot of accumulated durations rounded to 0.1 ms. Stops the
   * current phase if one is still running.
   */
  summary(): Record<string, number> {
    this.stop();
    const out: Record<string, number> = {};
    for (const [k, v] of this.phases) out[k] = Math.round(v * 10) / 10;
    return out;
  }

  /**
   * Sum of every recorded phase duration.
   *
   * Note: for phases recorded via {@link PhaseTimer.time} or
   * {@link PhaseTimer.mark} this is the *sum*, not the wall time —
   * concurrent work overlaps and the sum can exceed the end-to-end
   * wall time. Record wall time separately with `mark('wall', …)` if
   * that distinction matters.
   */
  totalMs(): number {
    this.stop();
    let t = 0;
    for (const v of this.phases.values()) t += v;
    return Math.round(t * 10) / 10;
  }
}
