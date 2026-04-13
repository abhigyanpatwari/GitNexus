/**
 * Deterministic Resolution Functions
 *
 * Pure functions that resolve methods across the inheritance hierarchy
 * using only the SemanticModel registries and HeritageMap — NO dependency
 * on resolution-context.ts (circular dependency risk).
 */

import type { SymbolDefinition } from './symbol-table.js';
import type { SemanticModel } from './semantic-model.js';
import type { HeritageMap } from './heritage-map.js';
import type { MroStrategy } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// MRO primitives.
//
// `c3Linearize` and its BFS helper `gatherAncestors` live here so the model
// layer stays a pure leaf — mro-processor.ts (graph-level MRO emission)
// imports `c3Linearize` from this file.
// ---------------------------------------------------------------------------

/**
 * Gather all ancestor IDs in BFS / topological order.
 * Returns the linearized list of ancestor IDs (excluding the class itself).
 */
function gatherAncestors(classId: string, parentMap: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [...(parentMap.get(classId) ?? [])];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    const grandparents = parentMap.get(id);
    if (grandparents) {
      for (const gp of grandparents) {
        if (!visited.has(gp)) queue.push(gp);
      }
    }
  }

  return order;
}

/**
 * Compute C3 linearization for a class given a parentMap.
 * Returns an array of ancestor IDs in C3 order (excluding the class itself),
 * or null if linearization fails (inconsistent or cyclic hierarchy).
 *
 * Used internally by `lookupMethodByOwnerWithMRO` for the Python MRO
 * strategy and re-exported for mro-processor.ts (graph-level MRO emission).
 */
export function c3Linearize(
  classId: string,
  parentMap: Map<string, string[]>,
  cache: Map<string, string[] | null>,
  inProgress?: Set<string>,
): string[] | null {
  if (cache.has(classId)) return cache.get(classId)!;

  // Iterative C3 linearization using an explicit work stack. The recursive
  // version overflows the call stack on deep class hierarchies (10K+
  // levels in large Android/Java codebases).
  //
  // Strategy: maintain a stack of { classId, phase } frames. Each frame
  // goes through two phases:
  //   ENTER (0) – check cache / cycle, push parent frames to compute first
  //   MERGE (1) – all parent linearizations are cached, merge them C3-style

  const visiting = inProgress ?? new Set<string>();

  const ENTER = 0;
  const MERGE = 1;
  const stack: Array<{ id: string; phase: number }> = [{ id: classId, phase: ENTER }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.phase === ENTER) {
      // ── ENTER phase ─────────────────────────────────────────────
      if (cache.has(frame.id)) {
        stack.pop();
        continue;
      }

      if (visiting.has(frame.id)) {
        // Cycle detected
        cache.set(frame.id, null);
        stack.pop();
        continue;
      }
      visiting.add(frame.id);

      const directParents = parentMap.get(frame.id);
      if (!directParents || directParents.length === 0) {
        visiting.delete(frame.id);
        cache.set(frame.id, []);
        stack.pop();
        continue;
      }

      // Switch to MERGE phase and push parents that still need computing
      frame.phase = MERGE;
      let allParentsCached = true;
      for (let i = directParents.length - 1; i >= 0; i--) {
        const pid = directParents[i];
        if (!cache.has(pid)) {
          stack.push({ id: pid, phase: ENTER });
          allParentsCached = false;
        }
      }
      // If all parents are already cached, proceed directly to the MERGE
      // phase below (frame.phase is already MERGE, frame is at stack top).
      // Otherwise, loop back to process the newly-pushed parent frames first.
      if (!allParentsCached) {
        continue;
      }
    }

    // ── MERGE phase ───────────────────────────────────────────────
    // directParents is guaranteed non-empty here — the ENTER phase already
    // handles the empty-parents case and pops the frame before switching
    // to MERGE.
    stack.pop();

    const directParents = parentMap.get(frame.id)!;

    // Build parent linearizations from cache
    const parentLinearizations: string[][] = [];
    let failed = false;
    for (const pid of directParents) {
      const pLin = cache.get(pid);
      if (pLin === undefined) {
        // Should not happen if phases are ordered correctly, but guard anyway
        failed = true;
        break;
      }
      if (pLin === null) {
        // Parent linearization failed (cycle or inconsistent)
        failed = true;
        break;
      }
      parentLinearizations.push([pid, ...pLin]);
    }

    if (failed) {
      visiting.delete(frame.id);
      cache.set(frame.id, null);
      continue;
    }

    // Add the direct parents list as the final sequence
    const sequences = [...parentLinearizations, [...directParents]];
    const result: string[] = [];

    let inconsistent = false;
    while (sequences.some((s) => s.length > 0)) {
      // Find a good head: one that doesn't appear in the tail of any other sequence
      let head: string | null = null;
      for (const seq of sequences) {
        if (seq.length === 0) continue;
        const candidate = seq[0];
        const inTail = sequences.some(
          (other) => other.length > 1 && other.indexOf(candidate, 1) !== -1,
        );
        if (!inTail) {
          head = candidate;
          break;
        }
      }

      if (head === null) {
        inconsistent = true;
        break;
      }

      result.push(head);

      // Remove the chosen head from all sequences
      for (const seq of sequences) {
        if (seq.length > 0 && seq[0] === head) {
          seq.shift();
        }
      }
    }

    visiting.delete(frame.id);
    cache.set(frame.id, inconsistent ? null : result);
  }

  return cache.get(classId) ?? null;
}

// `gatherAncestors` is exported so mro-processor.ts can reuse the same
// BFS traversal for graph-level MRO emission.
export { gatherAncestors };

// ---------------------------------------------------------------------------
// C3 linearization cache (per HeritageMap, auto-drained via WeakMap)
// ---------------------------------------------------------------------------

/**
 * Per-HeritageMap cache of C3 linearization results keyed by owner nodeId.
 *
 * HeritageMap instances are immutable after construction, so C3 output is
 * stable for the lifetime of a HeritageMap. WeakMap lets the cache auto-drain
 * when the HeritageMap is garbage collected (end of ingestion run), so we
 * never need to manually invalidate it.
 *
 * `null` is a sentinel for "C3 failed for this owner" (cyclic or inconsistent
 * hierarchy) so we don't re-run the expensive linearization repeatedly.
 */
const c3LinearizationCache = new WeakMap<HeritageMap, Map<string, readonly string[] | null>>();

const getCachedC3Linearization = (
  ownerNodeId: string,
  heritageMap: HeritageMap,
): readonly string[] | null => {
  let perHmCache = c3LinearizationCache.get(heritageMap);
  if (!perHmCache) {
    perHmCache = new Map();
    c3LinearizationCache.set(heritageMap, perHmCache);
  }
  const cached = perHmCache.get(ownerNodeId);
  if (cached !== undefined) return cached;
  const parentMap = buildParentMapFromHeritage(ownerNodeId, heritageMap);
  const result = c3Linearize(ownerNodeId, parentMap, new Map()) ?? null;
  perHmCache.set(ownerNodeId, result);
  return result;
};

// ---------------------------------------------------------------------------
// Heritage → parentMap conversion
// ---------------------------------------------------------------------------

/**
 * Build a parentMap from HeritageMap for use with c3Linearize.
 * Traverses the parent chain starting from startNodeId, collecting all
 * parent→children relationships into a Map<string, string[]>.
 *
 * Uses a head-pointer BFS (queue[head++]) instead of Array.shift() to avoid
 * O(n) per-dequeue re-indexing. For wide/shallow hierarchies common in
 * large Java/C# codebases this keeps the walk linear in ancestor count.
 */
const buildParentMapFromHeritage = (
  startNodeId: string,
  heritageMap: HeritageMap,
): Map<string, string[]> => {
  const parentMap = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue: string[] = [startNodeId];
  let head = 0;

  while (head < queue.length) {
    const nodeId = queue[head++]!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const parents = heritageMap.getParents(nodeId);
    if (parents.length > 0) {
      parentMap.set(nodeId, parents);
      for (const p of parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
  }

  return parentMap;
};

// ---------------------------------------------------------------------------
// MRO-aware method lookup
// ---------------------------------------------------------------------------

/**
 * Look up a method on an owner class, walking the parent chain via HeritageMap
 * when the method isn't found on the direct owner.
 *
 * Respects the 5 per-language MRO strategies:
 * - `first-wins`:       BFS ancestor walk, first match wins (default)
 * - `leftmost-base`:    BFS ancestor walk, leftmost base in declaration order wins (C++);
 *                        HeritageMap preserves insertion order matching source declaration,
 *                        so BFS order is equivalent to leftmost-base semantics
 * - `c3`:               C3-linearized ancestor order, first match wins (Python)
 * - `implements-split`: BFS ancestor walk, first match wins (Java/C#) —
 *                        full ambiguity detection for multiple interface defaults
 *                        is handled by computeMRO at graph level
 * - `qualified-syntax`: No auto-resolution (Rust) — returns undefined
 *
 * Uses the `c3Linearize` defined in this file (also consumed by
 * mro-processor.ts for graph-level MRO emission) for the `c3` strategy.
 *
 * Depends only on {@link SemanticModel} + {@link HeritageMap} + an
 * {@link MroStrategy} literal — NO dependency on SymbolTable, the language
 * registry, or resolution-context, which keeps the `model/` module free of
 * cross-layer imports. Callers derive the strategy from their language
 * provider before invoking this function.
 *
 * @internal This is the low-level MRO walker. Exported so call-processor's
 * higher-level resolvers (and unit tests) can invoke it directly. Callers
 * outside `core/ingestion/` should use the higher-level resolvers in
 * call-processor.ts instead of depending on this function.
 */
export const lookupMethodByOwnerWithMRO = (
  ownerNodeId: string,
  methodName: string,
  heritageMap: HeritageMap,
  model: SemanticModel,
  strategy: MroStrategy,
  argCount?: number,
): SymbolDefinition | undefined => {
  // Direct lookup first (child override — no walk needed).
  // argCount is threaded through so arity-differing overloads on the direct
  // owner can be disambiguated before the MRO walk starts.
  const direct = model.methods.lookupMethodByOwner(ownerNodeId, methodName, argCount);
  if (direct) return direct;

  // Rust: requires qualified syntax (<Type as Trait>::method), no auto-resolution
  if (strategy === 'qualified-syntax') return undefined;

  // Determine ancestor walk order based on MRO strategy.
  // readonly to accept the cached (frozen) c3 linearization without copying.
  let ancestors: readonly string[];
  if (strategy === 'c3') {
    // C3 linearization (memoized per HeritageMap
    // so repeated calls for the same owner within an ingestion run reuse the
    // linearization instead of rebuilding the parent map and re-running C3).
    // c3Linearize returns ancestors only (excludes the owner itself),
    // matching heritageMap.getAncestors() semantics.
    const c3Result = getCachedC3Linearization(ownerNodeId, heritageMap);
    // Fall back to BFS order if C3 fails (cyclic or inconsistent hierarchy).
    // Note: BFS order may not preserve Python MRO semantics in these edge
    // cases, but cyclic/inconsistent hierarchies are invalid in Python anyway.
    ancestors = c3Result ?? heritageMap.getAncestors(ownerNodeId);
  } else {
    // first-wins, leftmost-base, implements-split: BFS order via HeritageMap
    ancestors = heritageMap.getAncestors(ownerNodeId);
  }

  // Walk ancestors in MRO order — first match wins.
  // argCount narrows overloaded ancestors the same way as the direct lookup.
  for (const ancestorId of ancestors) {
    const method = model.methods.lookupMethodByOwner(ancestorId, methodName, argCount);
    if (method) return method;
  }

  return undefined;
};
