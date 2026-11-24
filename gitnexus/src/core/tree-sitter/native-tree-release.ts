/**
 * node-tree-sitter frees a Tree's native memory in an N-API finalizer, and
 * Node runs those finalizers from a `setImmediate` after the GC that found the
 * wrapper dead. A parse loop that never yields to the event loop — or only
 * awaits already-resolved promises — never reaches that phase, so dropping
 * each tree does not lower RSS: every tree's native memory stays until the
 * loop ends. Measured over 4,000 Kotlin files: 4.4 GB peak with every tree
 * dropped, 0.13 GB when the loop yields a macrotask every 16 parses.
 *
 * Yielding is not enough on its own. The binding never reports a tree's
 * native memory to V8, so V8 sees only a small wrapper object. A wrapper that
 * lives through two young-generation collections while its file is scanned
 * moves to the old generation, and only a major GC frees it, which V8 starts
 * on JS heap growth alone. Over 6,300 Java, Kotlin and TypeScript files the
 * HTTP scan ran 3-4 major GCs, left about 6,700 of 7,200 dropped trees
 * uncollected, and reached 1.2-3.7 GB RSS with about 350 MB of JS heap.
 *
 * So the releaser also nudges V8 by replacing one held, never-written 64 MB
 * buffer. V8 counts buffers as external memory; dropping an old one and
 * allocating a new one leaves external memory that only a major GC can
 * release, so V8 runs one. The buffer has to be held: a buffer dropped at once
 * is still young, and V8 frees it with a minor GC that leaves the trees where
 * they are (measured: 20 nudges, no extra major GC). It is allocated without
 * zero-filling and above glibc's largest mmap threshold (32 MB), so its pages
 * are never touched: 0 MB of resident memory on Linux and macOS.
 *
 * The releaser nudges when RSS has grown by `NUDGE_RSS_GROWTH_BYTES` above the
 * lowest RSS seen since the last nudge, and at least every
 * `MAX_YIELDS_PER_NUDGE` yields. Measuring from the RSS at the last nudge
 * instead let the bar ratchet up with every nudge (one 6,300-file scan reached
 * 2.3 GB). The cap bounds the dead trees between nudges to 128 parses of one
 * scan where RSS cannot show them, for example after glibc has reused freed
 * memory. The count is per releaser, so it holds per scan, not across scans: a
 * scan of fewer than 128 files never reaches it. On the same scan this peaks at
 * 0.47 GB. Four times the files ran about 400 major GCs; that left wall time
 * unchanged on a many-core host, but cost about 8 % on a single CPU, where the
 * GC work competes with parsing.
 *
 * Await the releaser once per parse, at a point where the loop holds no tree.
 */
export const PARSES_PER_RELEASE = 16;

/** RSS growth above the lowest RSS since the last nudge that triggers the next one. */
export const NUDGE_RSS_GROWTH_BYTES = 32 * 1024 * 1024;

/** Nudge at least this often (in yields), whatever RSS shows. */
export const MAX_YIELDS_PER_NUDGE = 8;

/** Above glibc's largest mmap threshold, so the allocation is mapped and never touched. */
const NUDGE_BYTES = 64 * 1024 * 1024;

/**
 * Under `--zero-fill-buffers`, `Buffer.allocUnsafeSlow` zero-fills too, and a
 * failed allocation aborts the process instead of throwing. `new ArrayBuffer`
 * throws a `RangeError` in both modes, so it is used in that mode. Node accepts
 * the flag with dashes or underscores, in its arguments and in NODE_OPTIONS.
 */
const ZERO_FILL_BUFFERS = [
  ...process.execArgv,
  ...(process.env.NODE_OPTIONS ?? '').split(/\s+/),
].some((arg) => arg.replace(/_/g, '-') === '--zero-fill-buffers');

// One per process: every releaser replaces the same held buffer.
const nudgeState: { held: ArrayBuffer | Buffer | null } = { held: null };

/** Replace the held buffer, so that V8 runs a major GC. May throw if the allocation fails. */
export function nudgeV8(): void {
  // Drop the old buffer before allocating the new one. Its memory is freed only
  // by the GC this allocation starts, so both are allocated until then: 128 MB
  // of address space, none of it touched.
  nudgeState.held = null;
  nudgeState.held = ZERO_FILL_BUFFERS
    ? new ArrayBuffer(NUDGE_BYTES)
    : Buffer.allocUnsafeSlow(NUDGE_BYTES);
}

/** Process memory reads and the nudge itself; injectable for tests. */
export interface TreeReleaserDeps {
  readRss: () => number;
  nudge: () => void;
}

const defaultDeps: TreeReleaserDeps = {
  readRss: () => process.memoryUsage.rss(),
  nudge: nudgeV8,
};

/**
 * Return a function to `await` once per parse. Every `every`-th call checks
 * RSS, nudges V8 when it is due (see above), and yields one macrotask so
 * pending tree finalizers can run; the other calls resolve without leaving the
 * current turn.
 */
export function createTreeReleaser(
  every: number = PARSES_PER_RELEASE,
  deps: TreeReleaserDeps = defaultDeps,
): () => Promise<void> {
  let parses = 0;
  let yieldsSinceNudge = 0;
  let rssFloor = deps.readRss();
  return async () => {
    parses += 1;
    if (parses % every !== 0) return;
    yieldsSinceNudge += 1;
    const rss = deps.readRss();
    rssFloor = Math.min(rssFloor, rss);
    if (rss - rssFloor > NUDGE_RSS_GROWTH_BYTES || yieldsSinceNudge >= MAX_YIELDS_PER_NUDGE) {
      yieldsSinceNudge = 0;
      // Re-read the floor on the next yield, after the GC this nudge starts.
      rssFloor = Number.POSITIVE_INFINITY;
      try {
        deps.nudge();
      } catch {
        // Only a hint to the GC: if the buffer cannot be allocated, parsing
        // goes on without it.
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}
