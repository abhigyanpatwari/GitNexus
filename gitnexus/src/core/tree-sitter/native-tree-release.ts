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
 * So the releaser also nudges V8: once RSS has grown by
 * `NUDGE_RSS_GROWTH_BYTES` since the last nudge, it replaces one held,
 * never-written 64 MB buffer. V8 counts buffers as external memory; dropping an
 * old one and allocating a new one leaves external memory that only a major GC
 * can release, so V8 runs one. The buffer has to be held: a buffer dropped at
 * once is still young, and V8 frees it with a minor GC that leaves the trees
 * where they are (measured: 20 nudges, no extra major GC). It is allocated
 * without zero-filling and above glibc's largest mmap threshold (32 MB), so
 * its pages are never touched: 0 MB of resident memory on Linux and macOS. With
 * the nudge, the same scan peaked at 0.47-0.92 GB.
 *
 * Await the releaser once per parse, at a point where the loop holds no tree.
 */
export const PARSES_PER_RELEASE = 16;

/** RSS growth since the last nudge that triggers the next one. */
export const NUDGE_RSS_GROWTH_BYTES = 32 * 1024 * 1024;

/** Above glibc's largest mmap threshold, so the allocation is mapped and never touched. */
const NUDGE_BYTES = 64 * 1024 * 1024;

/** Process memory reads and the nudge itself; injectable for tests. */
export interface TreeReleaserDeps {
  readRss: () => number;
  nudge: () => void;
}

// One per process: every releaser replaces the same held buffer.
const nudgeState: { held: Buffer | null } = { held: null };

const defaultDeps: TreeReleaserDeps = {
  readRss: () => process.memoryUsage.rss(),
  nudge: () => {
    nudgeState.held = Buffer.allocUnsafeSlow(NUDGE_BYTES);
  },
};

/**
 * Return a function to `await` once per parse. Every `every`-th call checks
 * RSS, nudges V8 when it has grown by `NUDGE_RSS_GROWTH_BYTES` since the last
 * nudge, and yields one macrotask so pending tree finalizers can run; the
 * other calls resolve without leaving the current turn.
 */
export function createTreeReleaser(
  every: number = PARSES_PER_RELEASE,
  deps: TreeReleaserDeps = defaultDeps,
): () => Promise<void> {
  let parses = 0;
  let rssAtNudge = deps.readRss();
  return async () => {
    parses += 1;
    if (parses % every !== 0) return;
    const rss = deps.readRss();
    if (rss - rssAtNudge > NUDGE_RSS_GROWTH_BYTES) {
      rssAtNudge = rss;
      deps.nudge();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}
