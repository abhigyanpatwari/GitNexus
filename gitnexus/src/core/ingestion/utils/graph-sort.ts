/**
 * Topological level sort for file-level import graphs.
 *
 * Groups files into topological levels where files within the same level
 * have no mutual import dependencies and can be processed in parallel.
 * Files involved in import cycles are collected into a final group.
 *
 * Used by cross-file binding propagation to process files in the correct
 * order — upstream exports must be resolved before downstream importers.
 *
 * @module
 */

/** A group of files with no mutual dependencies, safe to process in parallel. */
export type IndependentFileGroup = readonly string[];

/**
 * Groups files by topological level using Kahn's algorithm.
 *
 * Files in the same level have no mutual dependencies — safe to process in parallel.
 * Files involved in import cycles are appended as a final level and processed
 * last in an undefined order (best-effort propagation, no ordering guarantees).
 *
 * @param importMap  Map of file → set of files it imports
 * @returns          Levels (topologically ordered groups) and count of files in cycles
 */
export function topologicalLevelSort(importMap: ReadonlyMap<string, ReadonlySet<string>>): {
  levels: readonly IndependentFileGroup[];
  cycleCount: number;
} {
  const inDegree = new Map<string, number>();
  const reverseDeps = new Map<string, string[]>();

  for (const [file, deps] of importMap) {
    if (!inDegree.has(file)) inDegree.set(file, 0);
    for (const dep of deps) {
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
      inDegree.set(file, (inDegree.get(file) ?? 0) + 1);
      let rev = reverseDeps.get(dep);
      if (!rev) {
        rev = [];
        reverseDeps.set(dep, rev);
      }
      rev.push(file);
    }
  }

  const levels: string[][] = [];
  let currentLevel = [...inDegree.entries()].filter(([, d]) => d === 0).map(([f]) => f);

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    const nextLevel: string[] = [];
    for (const file of currentLevel) {
      for (const dependent of reverseDeps.get(file) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) nextLevel.push(dependent);
      }
    }
    currentLevel = nextLevel;
  }

  const cycleFiles = [...inDegree.entries()].filter(([, d]) => d > 0).map(([f]) => f);
  if (cycleFiles.length > 0) {
    levels.push(cycleFiles);
  }

  return { levels, cycleCount: cycleFiles.length };
}
