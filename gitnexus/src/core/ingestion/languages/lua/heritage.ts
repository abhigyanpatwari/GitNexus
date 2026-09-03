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
import { type ParsedFile, type NodeLabel, type SymbolDefinition } from 'gitnexus-shared';
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
  const parsedByFile = new Map(parsedFiles.map((parsed) => [parsed.filePath, parsed]));

  const resolveImportedClass = (
    parsed: ParsedFile,
    parent: string,
  ): SymbolDefinition | undefined => {
    if (scopes === undefined) return undefined;
    const [importName, exportName] = parent.split('.', 2);
    const matches = (scopes.imports.get(parsed.moduleScope) ?? []).filter(
      (edge) => edge.localName === importName && edge.targetFile !== null,
    );
    if (matches.length !== 1) return undefined;
    const targetFile = matches[0]?.targetFile;
    if (targetFile === null || targetFile === undefined) return undefined;
    const target = parsedByFile.get(targetFile);
    if (target === undefined) return undefined;
    const classes = target.localDefs.filter((def) => isClassLike(def.type));
    const returnedNames = target.captureSideChannel as LuaCaptureSideChannel | undefined;
    const returnedClassNames = exportName
      ? (returnedNames?.returnedFields ?? [])
          .filter((field) => field.exportName === exportName)
          .map((field) => field.localName)
      : (returnedNames?.returnedNames ?? []);
    const returnedClasses = returnedClassNames
      .flatMap((name) =>
        classes.filter(
          (def) => def.qualifiedName === name || def.qualifiedName?.endsWith(`.${name}`),
        ),
      )
      .filter((def, index, all) => all.indexOf(def) === index);
    if (exportName !== undefined) {
      return returnedClasses.length === 1 ? returnedClasses[0] : undefined;
    }
    if (returnedClasses.length === 1) return returnedClasses[0];
    return classes.length === 1 ? classes[0] : undefined;
  };

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
      const parentDef = parent.includes('.')
        ? resolveImportedClass(parsed, parent)
        : (resolveInheritanceBaseInScope(parsed.moduleScope, parent, scopes) ??
          resolveImportedClass(parsed, parent));
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
    for (const { owner, method, defRow, defEndRow } of channel.methodOwners) {
      const classGid = graphIdByFileAndName.get(`${parsed.filePath}::${owner}`);
      if (classGid === undefined) continue;
      // Resolve the Method graph node by position (0-based row + simple name).
      const methodGid = nodeLookup.get(
        positionKey(parsed.filePath, 'Method' as NodeLabel, defRow, method),
      );
      const resolvedMethodGid =
        methodGid ?? generateId('Method', `${parsed.filePath}:${owner}.${method}`);
      if (methodGid === undefined) {
        graph.addNode({
          id: resolvedMethodGid,
          label: 'Method',
          properties: {
            name: method,
            filePath: parsed.filePath,
            qualifiedName: `${owner}.${method}`,
            startLine: defRow + 1,
            endLine: defEndRow + 1,
            language: 'lua',
            isExported: true,
          },
        });
      }
      const edgeKey = `${classGid}->${resolvedMethodGid}`;
      if (emittedHasMethod.has(edgeKey)) continue;
      emittedHasMethod.add(edgeKey);
      graph.addRelationship({
        id: generateId('HAS_METHOD', edgeKey),
        sourceId: classGid,
        targetId: resolvedMethodGid,
        type: 'HAS_METHOD',
        confidence: 0.85,
        reason: 'lua-scope: middleclass method owner',
      });
    }
  }
}
