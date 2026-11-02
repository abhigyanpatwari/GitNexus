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

/**
 * True when the operator has turned GitNexus's memory autopilot off
 * (`GITNEXUS_MEMORY=off`).
 *
 * One switch for one concern. Memory management has two automatic behaviours —
 * re-running analyze with a RAM-aware heap cap, and aborting the parse before
 * V8's ineffective-mark-compact death spiral — and an operator who wants to
 * drive manually wants both off, not one. They were previously two separate
 * variables (`GITNEXUS_AUTO_HEAP`, `GITNEXUS_HEAP_GUARD`), which is three knobs
 * for one intent once the worker-heap override is counted; neither had shipped,
 * so this consolidates them rather than deprecating anything.
 *
 * Note the ordinary way to pin the heap is Node's own `--max-old-space-size`,
 * which `ensureHeap` already honours as the operator's decision. This switch is
 * for declining the autopilot WITHOUT naming a size.
 *
 * Lives here beside the cap formula so policy and its escape hatch are
 * single-sourced. Read every call (not memoized) so tests can stub the env.
 */
export function memoryAutopilotDisabled(): boolean {
  return process.env.GITNEXUS_MEMORY === 'off';
}

/** The cap for THIS machine/container: `heapCapMbFor(effectiveRamBytes())`. */
export function autoHeapCapMb(): number {
  return heapCapMbFor(effectiveRamBytes());
}

/**
 * Env var `ensureHeap` sets to record where the main-thread heap limit came
 * from (#3137): `budget` (`--memory-budget`) or `auto` (the RAM-aware cap).
 * Unset means a `--max-old-space-size` pin or `GITNEXUS_MEMORY=off` without
 * a budget. A budget-respawned child inherits it, which is how it knows not
 * to log the heap decision a second time.
 */
export const HEAP_LIMIT_SOURCE_ENV = 'GITNEXUS_HEAP_LIMIT_SOURCE';

export type HeapLimitSource = 'budget' | 'auto';

/**
 * The ONE action a user should take when this repository doesn't fit the
 * current heap (#2649). Users hitting memory limits are already frustrated —
 * a menu of env knobs at that moment is noise. Branch on whether the machine
 * itself has more memory to give: if this process's limit sits well below
 * what the RAM-aware auto-sizer would grant, the fix is whatever set the
 * smaller limit — raise `--memory-budget` when the budget set it (#3137),
 * otherwise drop the NODE_OPTIONS / node-flag pin so gitnexus sizes itself.
 * Otherwise the machine is the ceiling and only scope or hardware helps.
 * Escape hatches (GITNEXUS_MEMORY etc.) stay in the README env table.
 */
export function heapPressureRemedy(
  heapLimitBytes: number,
  source: string | undefined = process.env[HEAP_LIMIT_SOURCE_ENV],
): string {
  // Effective RAM honors a real cgroup limit — raw os.totalmem() told users
  // inside an 8GB-limited container on a 64GB host that "this machine has
  // more memory available", an advice loop with no exit (#2649 review).
  const autoCapBytes = autoHeapCapMb() * 1024 * 1024;
  if (heapLimitBytes < autoCapBytes * 0.9) {
    if (source === 'budget') {
      return (
        `This machine has more memory available: raise --memory-budget, or omit it ` +
        `so gitnexus sizes its heap to the machine automatically.`
      );
    }
    if (source === undefined && memoryAutopilotDisabled()) {
      return (
        `This machine has more memory available: GITNEXUS_MEMORY=off keeps Node's default ` +
        `heap — unset it, or pass --memory-budget <mb>.`
      );
    }
    return (
      `This machine has more memory available: re-run without the --max-old-space-size ` +
      `pin (NODE_OPTIONS or node flag) — gitnexus sizes its heap to the machine automatically.`
    );
  }
  return (
    `This machine is at its memory ceiling: exclude generated or vendored directories ` +
    `via .gitnexusignore, or analyze on a machine with more memory.`
  );
}
