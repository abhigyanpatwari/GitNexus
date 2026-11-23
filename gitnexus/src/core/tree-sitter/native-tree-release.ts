/**
 * node-tree-sitter frees a Tree's native memory in an N-API finalizer, and
 * Node runs those finalizers from a `setImmediate` after the GC that found the
 * wrapper dead. A parse loop that never yields to the event loop — or only
 * awaits already-resolved promises — never reaches that phase, so dropping
 * each tree does not lower RSS: every tree's native memory stays until the
 * loop ends. Measured over 4,000 Kotlin files: 4.4 GB peak with every tree
 * dropped, 0.13 GB when the loop yields a macrotask every 16 parses.
 *
 * Call the releaser after each parse, once the tree is no longer referenced.
 */
export const PARSES_PER_RELEASE = 16;

/**
 * Return a function to `await` after each parse. Every `every`-th call yields
 * one macrotask so pending tree finalizers can run; the other calls resolve
 * without leaving the current turn.
 */
export function createTreeReleaser(every: number = PARSES_PER_RELEASE): () => Promise<void> {
  let parses = 0;
  return async () => {
    parses += 1;
    if (parses % every !== 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}
