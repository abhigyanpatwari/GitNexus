/**
 * Swift same-module implicit IMPORTS for the `emitImplicitImportEdges` hook.
 *
 * Swift gives every file in a module visibility of every other file's
 * top-level declarations WITHOUT any `import` statement (whole-module
 * visibility). There is no syntactic `import`, so the finalized-ImportEdge
 * pipeline (`emitImportEdges`) has nothing to materialize; this hook records
 * module membership directly.
 *
 * Representation: one `Module` node per Swift module with at least two member
 * files, and one File → Module IMPORTS edge per member, reason
 * `MODULE_MEMBERSHIP_REASON`. This is how the compiler sees it — a file
 * imports its own module — and it is linear. The earlier File → File form
 * wrote n·(n−1) edges per module and exhausted V8's 2^24 Map limit on a 5,200
 * file module (#3355). "Files that see file B" is now "files with a
 * membership edge to a Module that B also has one to"; incremental importer
 * expansion follows that rule (`queryImportersBatch`).
 *
 * A file compiled into several Xcode targets gets an edge to each module.
 *
 * The Module node's `filePath` is the target directory (SwiftPM), the
 * `.xcodeproj` bundle (Xcode), or '.' (`__default__`). Incremental writeback
 * keys rows by `filePath`: a rewritten member file pulls that key into the
 * write set across its membership edge, so the Module node and every
 * membership edge are deleted and rewritten together.
 *
 * Idempotent: node and edge ids are derived from the module key and the
 * member path, and `graph.addNode` / `graph.addRelationship` dedupe by id.
 */

import { SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { MODULE_MEMBERSHIP_REASON } from '../../../graph/edge-reasons.js';
import { generateId } from '../../../../lib/utils.js';
import {
  DEFAULT_SWIFT_MODULE,
  groupSwiftFilesByModule,
  swiftModuleSpecOf,
} from './target-grouping.js';

/** Graph id of the `Module` node for a Swift module key. */
export function swiftModuleNodeId(moduleKey: string): string {
  return generateId('Module', `swift:${moduleKey}`);
}

export function emitSwiftImplicitImportEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  _nodeLookup: GraphNodeLookup,
  resolutionConfig?: unknown,
): void {
  const modules = groupSwiftFilesByModule(
    parsedFiles,
    (parsed) => parsed.filePath,
    resolutionConfig,
    { allMemberships: true },
  );

  for (const [moduleKey, members] of modules) {
    if (members.length < 2) continue;
    const spec = swiftModuleSpecOf(moduleKey, resolutionConfig);
    const moduleId = swiftModuleNodeId(moduleKey);
    graph.addNode({
      id: moduleId,
      label: 'Module',
      properties: {
        name: spec?.name ?? DEFAULT_SWIFT_MODULE,
        filePath: moduleFilePath(moduleKey, spec?.dir),
        language: SupportedLanguages.Swift,
        isExported: spec?.importable ?? false,
      },
    });
    for (const member of members) {
      graph.addRelationship({
        id: generateId('IMPORTS', `${member.filePath}->${moduleId}`),
        sourceId: generateId('File', member.filePath),
        targetId: moduleId,
        type: 'IMPORTS',
        confidence: 1.0,
        reason: MODULE_MEMBERSHIP_REASON,
      });
    }
  }
}

/** Incremental-writeback key for a module node: see the file header. */
function moduleFilePath(moduleKey: string, dir: string | undefined): string {
  if (dir !== undefined) return dir === '' ? '.' : dir;
  if (moduleKey.startsWith('xcode:'))
    return moduleKey.slice('xcode:'.length, moduleKey.lastIndexOf(':'));
  return '.';
}
