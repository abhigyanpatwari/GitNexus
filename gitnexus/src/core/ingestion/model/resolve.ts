/**
 * MRO primitives.
 *
 * `c3Linearize` and its BFS helper `gatherAncestors` are pure functions over a
 * `parentMap` (classId → parent ids). They carry no dependency on the semantic
 * model or graph, so the model layer stays a pure leaf — `mro-processor.ts`
 * (graph-level MRO emission) imports `c3Linearize` / `gatherAncestors` from here.
 */

/**
 * Gather all ancestor IDs in BFS / topological order.
 * Returns the linearized list of ancestor IDs (excluding the class itself).
 *
 * Uses a head-pointer BFS (`queue[head++]`) instead of `Array.shift()` to
 * avoid O(n) per-dequeue re-indexing.
 */
function gatherAncestors(classId: string, parentMap: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [...(parentMap.get(classId) ?? [])];
  let head = 0;

  while (head < queue.length) {
    const id = queue[head++]!;
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
 * Re-exported for mro-processor.ts (graph-level MRO emission).
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
    const heads = new Uint32Array(sequences.length); // head pointer per sequence
    const result: string[] = [];

    // Tail-count map: how many sequences contain this id at index > head.
    // O(1) membership check replaces O(n) indexOf scans.
    const tailCount = new Map<string, number>();
    for (const seq of sequences) {
      for (let i = 1; i < seq.length; i++) {
        tailCount.set(seq[i], (tailCount.get(seq[i]) ?? 0) + 1);
      }
    }

    let remaining = sequences.reduce((n, s) => n + s.length, 0);
    let inconsistent = false;

    while (remaining > 0) {
      let head: string | null = null;
      for (let si = 0; si < sequences.length; si++) {
        if (heads[si] >= sequences[si].length) continue;
        const candidate = sequences[si][heads[si]];
        if ((tailCount.get(candidate) ?? 0) === 0) {
          head = candidate;
          break;
        }
      }

      if (head === null) {
        inconsistent = true;
        break;
      }

      result.push(head);

      // Advance head pointers past the chosen head; update tail counts
      for (let si = 0; si < sequences.length; si++) {
        if (heads[si] >= sequences[si].length) continue;
        if (sequences[si][heads[si]] === head) {
          heads[si]++;
          remaining--;
          // promoted was in this sequence's active tail; now it's the new head — remove from tailCount
          if (heads[si] < sequences[si].length) {
            const promoted = sequences[si][heads[si]];
            const prev = tailCount.get(promoted)!;
            if (prev <= 1) tailCount.delete(promoted);
            else tailCount.set(promoted, prev - 1);
          }
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
