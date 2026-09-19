/**
 * Swift same-module implicit IMPORTS-edge emission for the
 * `emitImplicitImportEdges` hook.
 *
 * Swift gives every file in a module (an SPM target) visibility of every
 * other file's top-level declarations WITHOUT any `import` statement
 * (whole-module visibility). The legacy DAG models this with File→File
 * IMPORTS edges via `wireSwiftImplicitImports`; under registry-primary
 * that wirer's `addImportEdge` is gated off, and the scope-resolution
 * import pipeline (`emitImportEdges`) only materializes edges from
 * finalized `ImportEdge`s — of which there are none here, because there
 * is no syntactic `import`. This hook emits the missing edges directly.
 *
 * Module identity: Swift has no in-source `package X` marker. Module
 * membership is the SPM target *subtree* (`Sources/<Target>/…`), threaded
 * in via the SPM target map (`resolutionConfig` → `coerceSwiftTargets`)
 * and grouped by `groupSwiftFilesBySpmTarget`. The helper preserves the
 * legacy `groupSwiftFilesByTarget` bucketing contract for ordinary layouts
 * while intentionally fixing #2931's repeated-prefix edge case. With no
 * target map (no Package.swift and no scanned `Sources/*`) the map is null
 * and all files form one `__default__` module (single-Xcode-project
 * assumption). An inferred folder map must keep sibling folders isolated.
 * Every pair of distinct `.swift`
 * files in the same module gets a directed IMPORTS edge in both directions
 * (whole-module visibility is symmetric).
 *
 * Node identity + edge construction mirror the generic `emitImportEdges`
 * convention (`graph-bridge/imports-to-edges.ts`): `generateId('File', path)`
 * for endpoints and `generateId('IMPORTS', key)` for the relationship id,
 * deduped by `(sourceFile -> targetFile)`. Re-invocation idempotency comes
 * from `graph.addRelationship` id-dedup (the same `IMPORTS` id is produced
 * for a given ordered pair), so no local `seen` set is needed.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { generateId } from '../../../../lib/utils.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';
import { expandSwiftReexportFiles } from './import-target.js';

export function emitSwiftImplicitImportEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  _nodeLookup: GraphNodeLookup,
  resolutionConfig?: unknown,
): void {
  // Group files by SPM target subtree (the module). No-source-dir → all
  // files in one `__default__` bucket.
  const targets = coerceSwiftTargets(resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(
    parsedFiles,
    (parsed) => parsed.filePath,
    targets,
  );

  const allFilePaths = new Set(parsedFiles.map((parsed) => parsed.filePath));

  for (const [, group] of filesByTarget) {
    const reexported = expandSwiftReexportFiles(
      group.map((parsed) => parsed.filePath),
      {
        fromFile: '',
        allFilePaths,
        resolutionConfig,
        parsedFiles,
      },
    );
    const visible = new Set(group.map((parsed) => parsed.filePath));
    for (const dest of reexported) visible.add(dest);

    if (visible.size < 2) continue;
    for (const source of group) {
      for (const dest of visible) {
        if (source.filePath === dest) continue;
        const dedupKey = `${source.filePath}->${dest}`;
        graph.addRelationship({
          id: generateId('IMPORTS', dedupKey),
          sourceId: generateId('File', source.filePath),
          targetId: generateId('File', dest),
          type: 'IMPORTS',
          confidence: 1.0,
          reason: 'swift-scope: implicit module visibility',
        });
      }
    }
  }
}
