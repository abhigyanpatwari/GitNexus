/**
 * R post-parse hooks.
 *
 * R classes are expressed as function calls (`R6::R6Class("Name", ...)`,
 * `setClass("Name", ...)`, `setMethod("fn", "ClassName", ...)`) rather than
 * tree-sitter class syntax, so the worker cannot always find the enclosing
 * class node via a parent walk. When that happens, the worker stores the
 * owner name as an `ownerNameHint` string on the symbol/graph node.
 *
 * After parsing is complete and the TypeRegistry is fully populated, we
 * resolve every `ownerNameHint` to a real `ownerId` and:
 *   1. Patch `node.properties.ownerId`
 *   2. Mutate the SymbolDefinition's `ownerId` (shared ref across registries)
 *   3. Register the symbol into MutableMethodRegistry / MutableFieldRegistry
 *   4. Emit the HAS_METHOD / HAS_PROPERTY graph edge
 *
 * NAMESPACE-aware export refinement also runs here — ExportChecker doesn't have
 * a file-path context, so it defaults all R symbols to public. Once we know
 * which package directory each file lives in, we flip `isExported` to false
 * for symbols that aren't in the NAMESPACE exports.
 */

import type { KnowledgeGraph } from '../graph/types.js';
import type { MutableSemanticModel } from './model/semantic-model.js';
import type { RPackageConfig } from './language-config.js';
import type { GraphNode } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { generateId } from '../../lib/utils.js';

type EdgeLabel = 'HAS_METHOD' | 'HAS_PROPERTY';

/**
 * Resolve R deferred owner hints into ownerIds. Runs post-parse, after all
 * Class symbols have been registered into the TypeRegistry.
 */
export const attachDeferredROwners = (
  graph: KnowledgeGraph,
  model: MutableSemanticModel,
  nodeLabel: 'Method' | 'Property',
  edgeType: EdgeLabel,
): void => {
  graph.forEachNode((node: GraphNode) => {
    if (node.label !== nodeLabel) return;

    // If we already have a resolved ownerId, the hint is redundant — drop it.
    if (typeof node.properties.ownerId === 'string') {
      delete node.properties.ownerNameHint;
      return;
    }

    const ownerNameHint =
      typeof node.properties.ownerNameHint === 'string' ? node.properties.ownerNameHint : null;
    if (!ownerNameHint) return;

    const classDefs = model.types.lookupClassByName(ownerNameHint);
    if (classDefs.length !== 1) return; // ambiguous or not found — leave hint for debugging
    const ownerId = classDefs[0].nodeId;

    // 1. Patch the graph node.
    node.properties.ownerId = ownerId;
    delete node.properties.ownerNameHint;

    // 2. Mutate the SymbolDefinition in place (shared ref across indexes).
    const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
    const name = typeof node.properties.name === 'string' ? node.properties.name : '';
    const defs = model.symbols.lookupExactAll(filePath, name);
    const def = defs.find((d) => d.nodeId === node.id);
    if (def) {
      def.ownerId = ownerId;

      // 3. Explicitly register into the owner-scoped registry so resolveMemberCall
      //    can find the symbol via MethodRegistry / FieldRegistry.
      if (nodeLabel === 'Method') {
        model.methods.register(ownerId, name, def);
      } else {
        model.fields.register(ownerId, name, def);
      }
    }

    // 4. Emit the HAS_METHOD / HAS_PROPERTY edge.
    graph.addRelationship({
      id: generateId(edgeType, `${ownerId}->${node.id}`),
      sourceId: ownerId,
      targetId: node.id,
      type: edgeType,
      confidence: 1.0,
      reason: '',
    });
  });
};

/**
 * Refine R export status based on NAMESPACE files. Nodes whose package has a
 * NAMESPACE file but whose symbol name is not in the exports list get flipped
 * to `isExported: false`. Packages without a NAMESPACE keep the default
 * public behavior.
 */
export const refineRExportStatus = (
  graph: KnowledgeGraph,
  rPackageConfig: RPackageConfig | null,
): void => {
  if (!rPackageConfig || rPackageConfig.namespaceInfoByPackageDir.size === 0) return;

  // Sort package directories by length descending so the most specific
  // (deepest) match wins for nested packages.
  const pkgDirs = [...rPackageConfig.namespaceInfoByPackageDir.keys()].sort(
    (a, b) => b.length - a.length,
  );

  graph.forEachNode((node: GraphNode) => {
    if (node.properties.language !== SupportedLanguages.R) return;
    const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
    if (!filePath) return;

    const normalizedPath = filePath.replace(/\\/g, '/');
    const pkgDir = pkgDirs.find(
      (dir) => normalizedPath === dir || normalizedPath.startsWith(dir + '/'),
    );
    if (!pkgDir) return;

    const nsInfo = rPackageConfig.namespaceInfoByPackageDir.get(pkgDir);
    if (!nsInfo || !nsInfo.hasNamespaceFile) return;

    const name = typeof node.properties.name === 'string' ? node.properties.name : '';
    if (!name) return;

    if (nsInfo.namedExports.has(name)) return; // explicit export — keep public
    const matched = nsInfo.exportPatterns.some((pattern) => {
      try {
        return new RegExp(pattern).test(name);
      } catch {
        return false;
      }
    });
    if (matched) return;

    // Not in NAMESPACE → not exported.
    node.properties.isExported = false;
  });
};
