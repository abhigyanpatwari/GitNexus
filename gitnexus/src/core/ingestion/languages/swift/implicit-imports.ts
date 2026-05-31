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
 * Module identity: Swift has no in-source `package X` marker. We
 * approximate module membership by the file's immediate containing
 * directory — the same directory-grouping proxy `populateSwiftTargetSiblings`
 * (`target-siblings.ts`) uses for sibling binding visibility. Every pair
 * of distinct `.swift` files in the same directory gets a directed
 * IMPORTS edge in both directions (whole-module visibility is symmetric).
 *
 * Node identity + edge construction mirror the generic `emitImportEdges`
 * convention (`graph-bridge/imports-to-edges.ts`): `generateId('File', path)`
 * for endpoints and `generateId('IMPORTS', key)` for the relationship id,
 * deduped by `(sourceFile -> targetFile)`.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { generateId } from '../../../../lib/utils.js';

export function emitSwiftImplicitImportEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  _nodeLookup: GraphNodeLookup,
): void {
  // Group files by immediate containing directory (the module proxy).
  const filesByDir = new Map<string, string[]>();
  for (const parsed of parsedFiles) {
    const dir = containingDir(parsed.filePath);
    const list = filesByDir.get(dir) ?? [];
    list.push(parsed.filePath);
    filesByDir.set(dir, list);
  }

  // Dedup so each ordered (source -> target) pair emits at most once even
  // if the hook is invoked more than once during re-resolution.
  const seen = new Set<string>();

  for (const [, files] of filesByDir) {
    if (files.length < 2) continue; // no siblings to import
    for (const source of files) {
      for (const target of files) {
        if (source === target) continue; // no self-import
        const dedupKey = `${source}->${target}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        graph.addRelationship({
          id: generateId('IMPORTS', dedupKey),
          sourceId: generateId('File', source),
          targetId: generateId('File', target),
          type: 'IMPORTS',
          confidence: 1.0,
          reason: 'swift-scope: implicit module visibility',
        });
      }
    }
  }
}

function containingDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}
