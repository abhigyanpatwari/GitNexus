/**
 * Heritage Map
 *
 * Provides MRO-aware parent lookup from accumulated {@link ExtractedHeritage}
 * records, built **after all chunks complete** (between chunk processing and
 * call resolution). Follows the `buildImplementorMap` pattern — consumes
 * `ExtractedHeritage[]` and resolves type names to nodeIds via
 * `lookupClassByName`, NOT graph-edge queries.
 *
 * The map enables method lookup by inheritance chain without requiring
 * graph-edge traversal at call-resolution time.
 */

import type { ExtractedHeritage } from './workers/parse-worker.js';
import type { ResolutionContext } from './resolution-context.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Maximum ancestor chain depth to prevent runaway traversal. */
const MAX_ANCESTOR_DEPTH = 32;

export interface HeritageMap {
  /** Direct parents of `childNodeId` (extends + implements + trait-impl). */
  getParents(childNodeId: string): string[];
  /** Full ancestor chain (BFS, bounded depth, cycle-safe). */
  getAncestors(childNodeId: string): string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a HeritageMap from accumulated ExtractedHeritage records.
 *
 * Resolves class/interface/struct/trait names to nodeIds via
 * `ctx.symbols.lookupClassByName`. When a name resolves to multiple
 * candidates, all are recorded (partial-class / cross-file scenario).
 * Unresolvable names are silently skipped — a missing parent is better
 * than a wrong edge.
 */
export const buildHeritageMap = (
  heritage: readonly ExtractedHeritage[],
  ctx: ResolutionContext,
): HeritageMap => {
  // childNodeId → Set<parentNodeId>  (Set to deduplicate cross-chunk duplicates)
  const directParents = new Map<string, Set<string>>();

  for (const h of heritage) {
    const childDefs = ctx.symbols.lookupClassByName(h.className);
    const parentDefs = ctx.symbols.lookupClassByName(h.parentName);

    if (childDefs.length === 0 || parentDefs.length === 0) continue;

    for (const child of childDefs) {
      for (const parent of parentDefs) {
        // Skip self-references
        if (child.nodeId === parent.nodeId) continue;

        let parents = directParents.get(child.nodeId);
        if (!parents) {
          parents = new Set();
          directParents.set(child.nodeId, parents);
        }
        parents.add(parent.nodeId);
      }
    }
  }

  // --- Public API ---------------------------------------------------

  const getParents = (childNodeId: string): string[] => {
    const parents = directParents.get(childNodeId);
    return parents ? [...parents] : [];
  };

  const getAncestors = (childNodeId: string): string[] => {
    const result: string[] = [];
    const visited = new Set<string>();
    visited.add(childNodeId); // prevent cycles through the start node

    // BFS with bounded depth
    let frontier = getParents(childNodeId);
    let depth = 0;

    while (frontier.length > 0 && depth < MAX_ANCESTOR_DEPTH) {
      const nextFrontier: string[] = [];
      for (const parentId of frontier) {
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        result.push(parentId);
        // Expand parent's own parents for next level
        const grandparents = directParents.get(parentId);
        if (grandparents) {
          for (const gp of grandparents) {
            if (!visited.has(gp)) nextFrontier.push(gp);
          }
        }
      }
      frontier = nextFrontier;
      depth++;
    }

    return result;
  };

  return { getParents, getAncestors };
};
