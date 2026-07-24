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
