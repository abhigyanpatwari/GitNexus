/**
 * Lua middleclass heritage edges — EXTENDS + HAS_METHOD.
 *
 * middleclass has no syntactic class body — `class("Name", Parent)` is a plain
 * call, and methods are file-top-level `function Name:method()`. So neither
 * lexical heritage nor lexical HAS_METHOD applies. This hook reads the
 * heritage pairs that `emitLuaScopeCaptures` stashed onto
 * `ParsedFile.captureSideChannel` (collected in the parse worker where the AST
 * was live) and emits:
 *   - EXTENDS from the child Class node to the parent Class node, and
 *   - HAS_METHOD from a class's Class node to its file-top-level Method nodes.
 * Both resolve via `nodeLookup` and finalized scope bindings. NO file re-read or re-parse
 * (#1983 no-main-thread-re-parse contract).
 *
 * Mirrors `emitRubyMixinEdges` (the only other `emitHeritageEdges` impl), but
 * the heritage pair arrives via the capture side channel rather than threaded
 * through `parsedImports` — middleclass's single-arg form needs no marker
 * decomposition, and the parent is a bare identifier in the source.
 */
import { type ParsedFile, type NodeLabel } from 'gitnexus-shared';
import {
  isClassLike,
  resolveInheritanceBaseInScope,
} from '../../scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import {
  positionKey,
  type GraphNodeLookup,
} from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';
import type { LuaCaptureSideChannel } from './capture-side-channel.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

export function emitLuaHeritageEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  scopes?: ScopeResolutionIndexes,
): void {
  // (filePath, name) → graphId (per-file, for child resolution).
  const graphIdByFileAndName = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const gid = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (gid === undefined) continue;
      const qn = def.qualifiedName ?? '';
      if (qn.length > 0) {
        graphIdByFileAndName.set(`${parsed.filePath}::${qn}`, gid);
      }
    }
  }

  const emittedExtends = new Set<string>();
  const emittedHasMethod = new Set<string>();
  for (const parsed of parsedFiles) {
    const channel = parsed.captureSideChannel as LuaCaptureSideChannel | undefined;
    if (channel === undefined || channel.kind !== 'lua') continue;

    // ── EXTENDS: class("Name", Parent) ──────────────────────────────────────
    for (const { child, parent } of channel.extendsPairs) {
      const childGid = graphIdByFileAndName.get(`${parsed.filePath}::${child}`);
      if (childGid === undefined || scopes === undefined) continue;
      const parentDef = resolveInheritanceBaseInScope(parsed.moduleScope, parent, scopes);
      if (parentDef === undefined) continue;
      const parentGid = resolveDefGraphId(parentDef.filePath, parentDef, nodeLookup);
      if (parentGid === undefined) continue;
      const edgeKey = `${childGid}->${parentGid}`;
      if (emittedExtends.has(edgeKey)) continue;
      emittedExtends.add(edgeKey);
      graph.addRelationship({
        id: generateId('EXTENDS', edgeKey),
        sourceId: childGid,
        targetId: parentGid,
        type: 'EXTENDS',
        confidence: 0.85,
        reason: 'lua-scope: middleclass inherits',
      });
    }

    // ── HAS_METHOD: function ClassName:method() / function ClassName.method() ─
    for (const { owner, method, defRow } of channel.methodOwners) {
      const classGid = graphIdByFileAndName.get(`${parsed.filePath}::${owner}`);
      if (classGid === undefined) continue;
      // Resolve the Method graph node by position (0-based row + simple name).
      const methodGid = nodeLookup.get(
        positionKey(parsed.filePath, 'Method' as NodeLabel, defRow, method),
      );
      if (methodGid === undefined) continue;
      const edgeKey = `${classGid}->${methodGid}`;
      if (emittedHasMethod.has(edgeKey)) continue;
      emittedHasMethod.add(edgeKey);
      graph.addRelationship({
        id: generateId('HAS_METHOD', edgeKey),
        sourceId: classGid,
        targetId: methodGid,
        type: 'HAS_METHOD',
        confidence: 0.85,
        reason: 'lua-scope: middleclass method owner',
      });
    }
  }
}
