import { LRUCache } from 'lru-cache';
import Parser from 'tree-sitter';

/**
 * Minimal structural shape consumers need when reading Trees back
 * through a phase-dependency boundary. Declared here so phases that
 * receive ASTCache via `getPhaseOutput<...>` don't hand-roll their
 * own inline structural types that silently drift when ASTCache's
 * contract changes.
 *
 * Typed as `unknown` at the Tree boundary because consumers on the
 * other side of the phase-output map don't share tree-sitter's type
 * graph (e.g. COBOL's standalone processor).
 */
export interface ASTCacheReader {
  get(filePath: string): unknown;
  clear(): void;
}

// Define the interface for the Cache
export interface ASTCache extends ASTCacheReader {
  get: (filePath: string) => Parser.Tree | undefined;
  set: (filePath: string, tree: Parser.Tree) => void;
  clear: () => void;
  stats: () => { size: number; maxSize: number };
}

export const createASTCache = (maxSize: number = 50): ASTCache => {
  const effectiveMax = Math.max(maxSize, 1);
  // Initialize the cache with a 'dispose' handler
  // This is the magic: When an item is evicted (dropped), this runs automatically.
  const cache = new LRUCache<string, Parser.Tree>({
    max: effectiveMax,
    dispose: (tree) => {
      try {
        // NOTE: web-tree-sitter has tree.delete(); native tree-sitter
        // trees are GC-managed and .delete is absent (no-op here).
        //
        // Single-owner invariant (load-bearing under WASM): a given
        // Parser.Tree reference must live in AT MOST ONE ASTCache
        // that disposes. The parse-phase chunk-local cache clears
        // between chunks; the cross-phase `scopeTreeCache` (also an
        // ASTCache today) holds the same Tree by reference. Under
        // native tree-sitter this is benign (dispose is a no-op).
        // If/when GitNexus adopts web-tree-sitter for sequential
        // parsing, the cross-phase cache must either (a) skip
        // writing Trees that are already owned by a disposing cache,
        // or (b) use tree.copy() per entry. Failing to pick one
        // will hand freed memory to scope-resolution.
        (tree as unknown as { delete?: () => void }).delete?.();
      } catch (e) {
        console.warn('Failed to delete tree from WASM memory', e);
      }
    },
  });

  return {
    get: (filePath: string) => {
      const tree = cache.get(filePath);
      return tree; // Returns undefined if not found
    },

    set: (filePath: string, tree: Parser.Tree) => {
      cache.set(filePath, tree);
    },

    clear: () => {
      cache.clear();
    },

    stats: () => ({
      size: cache.size,
      maxSize: effectiveMax,
    }),
  };
};
