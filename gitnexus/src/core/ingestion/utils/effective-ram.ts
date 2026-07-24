import os from 'node:os';

/**
 * Effective RAM in bytes: physical total, or a REAL smaller cgroup limit
 * (#2649). `process.constrainedMemory()` returns a huge sentinel when
 * unconstrained, and only the leaf cgroup's limit is visible (parent-slice
 * caps are not) — so a smaller-than-physical value is trusted and anything
 * else falls back to `os.totalmem()`. Mirrors `computeHeapCapMb`'s
 * constrained handling in `cli/analyze.ts`; container-blind sizing told
 * users "this machine has more memory" inside an 8GB-limited container on
 * a 64GB host, and sized worker heap caps past the whole container.
 */
export function effectiveRamBytes(): number {
  const total = os.totalmem();
  const constrained =
    typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : undefined;
  return typeof constrained === 'number' && constrained > 0 && constrained < total
    ? constrained
    : total;
}

/** Historical floor for the auto heap cap — applied only up to 0.80 × RAM
 *  (a floor at or above physical memory swap-thrashes instead of OOMing,
 *  #2649). */
const HEAP_FLOOR_MB = 16384;

/**
 * The RAM-aware heap cap formula (#2649), single-sourced here so the CLI
 * respawn (`computeHeapCapMb` in `cli/analyze.ts`), and the server's
 * analyze fork size from the same rule: `0.75 × effective RAM`, raised to
 * the floor when RAM allows, never above `0.80 × effective RAM`.
 */
export function heapCapMbFor(effectiveBytes: number): number {
  const effectiveMb = Math.floor(effectiveBytes / (1024 * 1024));
  return Math.min(
    Math.max(HEAP_FLOOR_MB, Math.floor(0.75 * effectiveMb)),
    Math.floor(0.8 * effectiveMb),
  );
}

/** The cap for THIS machine/container: `heapCapMbFor(effectiveRamBytes())`. */
export function autoHeapCapMb(): number {
  return heapCapMbFor(effectiveRamBytes());
}
