import { LRUCache } from 'lru-cache';
import Parser from 'tree-sitter';

// Define the interface for the Cache
export interface ASTCache {
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
        // NOTE: web-tree-sitter has tree.delete(); native tree-sitter trees are GC-managed.
        // Keep this try/catch so we don't crash on either runtime.
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
