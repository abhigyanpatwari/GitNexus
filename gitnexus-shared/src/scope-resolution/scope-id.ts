/**
 * `ScopeId` canonical constructor + string intern pool
 * (RFC §2.2; Ring 2 SHARED #912).
 *
 * `ScopeId` is a deterministic string derived from the scope's file path,
 * byte range, and kind:
 *
 *   scope:{filePath}#{startLine}:{startCol}-{endLine}:{endCol}:{kind}
 *
 * Two scopes produced by reparsing the same file at the same positions are
 * `===`-equal as strings. Beyond the canonical shape, `makeScopeId` also
 * **interns** the string through a process-local pool, so repeated calls
 * with structurally identical inputs return the same string reference —
 * making `Map<ScopeId, ...>` lookups and cache keys identity-fast.
 *
 * The intern pool is unbounded. The number of distinct `ScopeId`s across a
 * single indexing run is O(total scopes in workspace), which is bounded by
 * source-text size and already in memory; interning adds no asymptotic
 * pressure. `clearScopeIdInternPool` is exported for test isolation.
 */

import type { Range } from './types.js';
import type { ScopeId, ScopeKind } from './types.js';

/** Inputs required to construct a canonical `ScopeId`. */
export interface ScopeIdInput {
  readonly filePath: string;
  readonly range: Range;
  readonly kind: ScopeKind;
}

/**
 * Build a canonical `ScopeId` from its structural parts and intern it.
 *
 * Pure + referentially transparent: given the same input shape, always
 * returns the same string reference for the lifetime of the pool.
 */
export function makeScopeId(input: ScopeIdInput): ScopeId {
  const raw = `scope:${input.filePath}#${input.range.startLine}:${input.range.startCol}-${input.range.endLine}:${input.range.endCol}:${input.kind}`;
  const existing = INTERN_POOL.get(raw);
  if (existing !== undefined) return existing;
  INTERN_POOL.set(raw, raw);
  return raw;
}

/**
 * Drop the intern pool. Intended for test setup/teardown — production code
 * should not need this, since the pool's memory usage is bounded by the
 * number of live scopes and cleaning it mid-run would break identity
 * equality for existing scope ids.
 */
export function clearScopeIdInternPool(): void {
  INTERN_POOL.clear();
}

/** Internal: shared intern pool (process-local). */
const INTERN_POOL = new Map<string, string>();
