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
 * they are (measured: 20 nudges, no extra major GC). By default it is allocated
 * without zero-filling and above glibc's largest mmap threshold (32 MB), so its
 * pages are never touched: 0 MB of resident memory on Linux and macOS. Under
 * `--zero-fill-buffers` it is zero-filled (see `ZERO_FILL_BUFFERS`); that stays
 * untouched on Linux, but on macOS about 130 MB becomes resident.
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

/**
 * Above glibc's largest mmap threshold, so the allocation is mapped and, unless
 * zero-filled on macOS (see `ZERO_FILL_BUFFERS`), never touched.
 */
const NUDGE_BYTES = 64 * 1024 * 1024;

/**
 * Any mention of `--zero-fill-buffers` (either spelling), or of a Node config
 * file, which can turn it on too.
 */
const ZERO_FILL_MENTION =
  /--zero[-_]fill[-_]buffers|--experimental[-_](?:default[-_])?config[-_]file/;

/**
 * Whether Node may run with `--zero-fill-buffers`. Errs towards yes: a wrong
 * yes only costs the macOS residency described below, while a wrong no picks
 * the allocation that aborts the process when it fails. So any mention of the
 * flag on the command line or in `NODE_OPTIONS` counts, with any value and
 * wherever it sits, even where Node ignores it or a later
 * `--no-zero-fill-buffers` turns it off; so does a config file. Node drops
 * the double quotes in `NODE_OPTIONS`, and the backslashes inside them, when it
 * splits the value; dropping both everywhere before matching can only add
 * matches.
 */
export function zeroFillBuffersRequested(
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): boolean {
  return [...execArgv, (nodeOptions ?? '').replace(/["\\]/g, '')].some((arg) =>
    ZERO_FILL_MENTION.test(arg),
  );
}

/**
 * Under `--zero-fill-buffers`, `Buffer.allocUnsafeSlow` zero-fills too, and a
 * failed allocation aborts the process instead of throwing. `new ArrayBuffer`
 * throws a `RangeError` in both modes, so it is used whenever that mode may be
 * on (see `zeroFillBuffersRequested`). It is not used always: on macOS its
 * zero-filled pages become resident when the allocator reuses a freed buffer
 * (about 130 MB held after repeated nudges), while `allocUnsafeSlow` stays
 * untouched.
 */
const ZERO_FILL_BUFFERS = zeroFillBuffersRequested(process.execArgv, process.env.NODE_OPTIONS);

// One per process: every releaser replaces the same held buffer, which is
// dropped when the last open hold ends (see `holdNudgeBuffer`).
const nudgeState: { held: ArrayBuffer | Buffer | null; holds: number } = {
  held: null,
  holds: 0,
};

/**
 * Open a hold on the nudge buffer for a stretch of work that runs tree
 * releasers, such as a group sync's contract extraction, and return the
 * function that ends it. When the last open hold ends the buffer is dropped,
 * so a long-lived process does not keep it after its last scan. Releasers run
 * outside any hold keep the buffer until a hold ends.
 */
export function holdNudgeBuffer(): () => void {
  nudgeState.holds += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    nudgeState.holds -= 1;
    if (nudgeState.holds === 0) nudgeState.held = null;
  };
}

/** Replace the held buffer, so that V8 runs a major GC. May throw if the allocation fails. */
export function nudgeV8(): void {
  // Drop the old buffer before allocating the new one. Its memory is freed only
  // by the GC this allocation starts, so both are allocated until then: 128 MB
  // of address space, untouched except for zero-filled buffers on macOS.
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
