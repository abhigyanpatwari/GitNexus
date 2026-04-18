/**
 * `ModuleScopeIndex` — O(1) `filePath → moduleScopeId` lookup.
 *
 * Every file parsed produces exactly one `Module` scope at its root. The
 * finalize algorithm needs to resolve `ImportEdge.targetFile` to a concrete
 * module scope id in constant time during the link pass; this index is that
 * mapping.
 *
 * Part of RFC #909 Ring 2 SHARED — #913.
 *
 * Consumed by: #915 (SCC finalize link pass), #923 (shadow harness when
 * resolving callsite file → enclosing module).
 */

import type { ScopeId } from './types.js';

export interface ModuleScopeIndex {
  readonly byFilePath: ReadonlyMap<string, ScopeId>;
  readonly size: number;
  get(filePath: string): ScopeId | undefined;
  has(filePath: string): boolean;
}

export interface ModuleScopeEntry {
  readonly filePath: string;
  readonly moduleScopeId: ScopeId;
}

/**
 * Build a `ModuleScopeIndex` from a flat list of `{ filePath, moduleScopeId }`
 * pairs.
 *
 * **Collision policy: first-write-wins.** A file should appear exactly once
 * in a single ingestion run; collisions indicate the same file was parsed
 * twice or a `filePath` normalization bug upstream. Dropping the later
 * entry preserves the first-stable id the rest of the pipeline may already
 * have registered against.
 *
 * Pure function — safe to call repeatedly; no side effects.
 */
export function buildModuleScopeIndex(entries: readonly ModuleScopeEntry[]): ModuleScopeIndex {
  const byFilePath = new Map<string, ScopeId>();
  for (const { filePath, moduleScopeId } of entries) {
    if (byFilePath.has(filePath)) continue; // first-write-wins
    byFilePath.set(filePath, moduleScopeId);
  }
  return freezeIndex(byFilePath);
}

// ─── Internal ───────────────────────────────────────────────────────────────

function freezeIndex(byFilePath: Map<string, ScopeId>): ModuleScopeIndex {
  return {
    byFilePath,
    get size() {
      return byFilePath.size;
    },
    get(filePath: string): ScopeId | undefined {
      return byFilePath.get(filePath);
    },
    has(filePath: string): boolean {
      return byFilePath.has(filePath);
    },
  };
}
