/**
 * Topological level sort for file-level import graphs.
 *
 * Groups files into topological levels where files within the same level
 * have no mutual import dependencies and can be processed in parallel.
 * Files involved in import cycles are appended as a final group and
 * processed last in an undefined order (best-effort propagation).
 *
 * Used by cross-file binding propagation to process files in the correct
 * order — upstream exports must be resolved before downstream importers.
 *
 * @module
 */

/** A group of files with no mutual dependencies, safe to process in parallel. */
export type IndependentFileGroup = readonly string[];

/**
 * Groups files by topological level using Kahn's algorithm on the **reverse**
 * import graph.
 *
 * Files in the same level have no mutual dependencies — safe to process in parallel.
 * Files involved in import cycles are appended as a final level and processed
 * last in an undefined order (best-effort propagation, no ordering guarantees).
 *
 * ## Why the counter is named `pendingImportsPerFile` (not `inDegree`)
 *
 * Cross-file binding propagation must process **leaves first** — a file's
 * imports must be resolved before the file itself is re-resolved. To get
 * leaves first from Kahn's algorithm, we run Kahn's on the **reverse** of
 * the import graph:
 *
 * - `importMap` is `importer → {imports}` (forward edges point at deps).
 * - The reverse graph has edges `dep → {importers}`, materialized in
 *   `reverseDeps`.
 * - On the reverse graph, "in-degree of node X" equals "number of imports X
 *   has in the forward graph" — i.e. X's forward **out-degree**.
 *
 * So `pendingImportsPerFile.get(file)` counts how many of `file`'s imports
 * are still un-emitted. A file is ready (level 0 / appended to `currentLevel`)
 * once all its imports have been emitted in earlier levels — that is, once
 * its pending-imports count drops to 0. Pairing this counter with
 * `reverseDeps` (dep → importers) is the standard Kahn's-on-the-reverse-graph
 * formulation; it is **not** a bug to be "fixed" by counting forward
 * in-degree (importers per file).
 *
 * **Do not rename this back to `inDegree` and do not invert the counting
 * direction.** Doing either flips the emission order from leaves-first to
 * roots-first, which silently breaks cross-file binding propagation
 * (downstream files would be re-resolved before their upstream exports
 * are available).
 *
 * @param importMap  Map of file → set of files it imports (forward graph)
 * @returns          Levels (topologically ordered groups, leaves first)
 *                   and count of files in cycles
 */
export function topologicalLevelSort(importMap: ReadonlyMap<string, ReadonlySet<string>>): {
  levels: readonly IndependentFileGroup[];
  cycleCount: number;
} {
  // Per-file count of imports that have not yet been emitted in an earlier
  // level. See JSDoc above for why this is **not** standard `inDegree`.
  const pendingImportsPerFile = new Map<string, number>();
  const reverseDeps = new Map<string, string[]>();

  for (const [file, deps] of importMap) {
    if (!pendingImportsPerFile.has(file)) pendingImportsPerFile.set(file, 0);
    for (const dep of deps) {
      if (!pendingImportsPerFile.has(dep)) pendingImportsPerFile.set(dep, 0);
      pendingImportsPerFile.set(file, (pendingImportsPerFile.get(file) ?? 0) + 1);
      let rev = reverseDeps.get(dep);
      if (!rev) {
        rev = [];
        reverseDeps.set(dep, rev);
      }
      rev.push(file);
    }
  }

  const levels: string[][] = [];
  // Level 0: files with no un-emitted imports (true leaves of the import graph).
  let currentLevel = [...pendingImportsPerFile.entries()]
    .filter(([, d]) => d === 0)
    .map(([f]) => f);

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    const nextLevel: string[] = [];
    for (const file of currentLevel) {
      // For each importer of `file`, one of its pending imports just got
      // emitted — decrement the importer's pending count. If it hits 0,
      // the importer is ready for the next level.
      for (const dependent of reverseDeps.get(file) ?? []) {
        const newPending = (pendingImportsPerFile.get(dependent) ?? 1) - 1;
        pendingImportsPerFile.set(dependent, newPending);
        if (newPending === 0) nextLevel.push(dependent);
      }
    }
    currentLevel = nextLevel;
  }

  // Anything still > 0 participates in a cycle — append in undefined order.
  const cycleFiles = [...pendingImportsPerFile.entries()].filter(([, d]) => d > 0).map(([f]) => f);
  if (cycleFiles.length > 0) {
    levels.push(cycleFiles);
  }

  return { levels, cycleCount: cycleFiles.length };
}
