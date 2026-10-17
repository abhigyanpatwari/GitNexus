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
 * which package's `R/` directory each file lives in, we flip `isExported` to false
 * for symbols that aren't in the NAMESPACE exports.
 */

import type { KnowledgeGraph } from '../../../graph/types.js';
import type { MutableSemanticModel } from '../../model/semantic-model.js';
import type { PostParseContext } from '../../language-provider.js';
import {
  loadRPackageConfig,
  reportRExportPatternProblems,
  rExportPatternMatches,
  type RNamespaceInfo,
  type RPackageConfig,
} from './package-config.js';
import { rBareName } from './bare-name.js';
import { rOwningPackageDir } from './namespace-imports.js';
import type { GraphNode, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import { logger } from '../../../logger.js';

type EdgeLabel = 'HAS_METHOD' | 'HAS_PROPERTY';

/** Most class names quoted in the warning for owner hints that stay ambiguous. */
const MAX_LISTED_AMBIGUOUS_OWNERS = 5;

/**
 * The R classes named `name`, one per graph node. The class registry is shared by every
 * language, so a Python `Circle` next to an R `Circle` must not make the name ambiguous, nor
 * stand in for an R class that is absent. It also appends without de-duplication: a class
 * defined twice in one file (a script re-defining it, `if (x) Foo <- R6Class(...) else Foo <-
 * R6Class(...)`, a factory called from two places) registers the same node twice, which is
 * one class, not an ambiguity.
 */
const distinctRClassDefs = (
  graph: KnowledgeGraph,
  model: MutableSemanticModel,
  name: string,
): SymbolDefinition[] => {
  const byNode = new Map<string, SymbolDefinition>();
  for (const def of model.types.lookupClassByName(name)) {
    if (byNode.has(def.nodeId)) continue;
    if (graph.getNode(def.nodeId)?.properties.language !== SupportedLanguages.R) continue;
    byNode.set(def.nodeId, def);
  }
  return [...byNode.values()];
};

/**
 * The class a member's owner hint names. A single class wins. When several distinct classes
 * share the name (the same helper in `R/` and `tests/`, a package copied into a second
 * directory), the one defined in the member's own file wins: a method or field written inside
 * `Foo <- R6Class(...)` always belongs to the `Foo` of that file, and a `setMethod()` next to
 * its `setClass()` does too. When the member's file defines none of them, or several, the owner is
 * undecidable from the name and the member stays unowned.
 */
const pickOwnerClass = (
  graph: KnowledgeGraph,
  classDefs: readonly SymbolDefinition[],
  memberFilePath: string,
): SymbolDefinition | undefined => {
  if (classDefs.length === 1) return classDefs[0];
  const sameFile = classDefs.filter(
    (def) => graph.getNode(def.nodeId)?.properties.filePath === memberFilePath,
  );
  return sameFile.length === 1 ? sameFile[0] : undefined;
};

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
  const ambiguousOwners = new Set<string>();
  graph.forEachNode((node: GraphNode) => {
    // Skip immediately for non-R nodes — avoids doing any further work per node
    // in this full-graph traversal for repos with no R files at all.
    if (node.properties.language !== SupportedLanguages.R) return;
    if (node.label !== nodeLabel) return;

    // If we already have a resolved ownerId, the hint is redundant — drop it.
    if (typeof node.properties.ownerId === 'string') {
      delete node.properties.ownerNameHint;
      return;
    }

    const ownerNameHint =
      typeof node.properties.ownerNameHint === 'string' ? node.properties.ownerNameHint : null;
    if (!ownerNameHint) return;

    const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
    const classDefs = distinctRClassDefs(graph, model, ownerNameHint);
    const owner = pickOwnerClass(graph, classDefs, filePath);
    if (owner === undefined) {
      // Not found, or several classes of this name that the member's own file cannot tell apart:
      // leave the hint for debugging and report the second case once per call.
      if (classDefs.length > 1) ambiguousOwners.add(ownerNameHint);
      return;
    }
    const ownerId = owner.nodeId;

    // 1. Patch the graph node.
    node.properties.ownerId = ownerId;
    delete node.properties.ownerNameHint;

    // 2. Mutate the SymbolDefinition in place (shared ref across indexes).
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

  if (ambiguousOwners.size > 0) {
    const names = [...ambiguousOwners].sort();
    const listed = names.slice(0, MAX_LISTED_AMBIGUOUS_OWNERS).map((n) => JSON.stringify(n));
    const more = names.length - listed.length;
    logger.warn(
      `R: ${nodeLabel} nodes of ${names.length} class name(s) were left without an owner because ` +
        `several classes share the name and the member's own file does not define exactly one ` +
        `of them (${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''})`,
    );
  }
};

/**
 * Refine R export status based on NAMESPACE files. A file belongs to the package whose
 * `R/` directory contains it (the nearest enclosing discovered package; R loads nothing else
 * into a package namespace), so only `R/` symbols are tested against that package's NAMESPACE:
 * a symbol that package does not export is flipped to `isExported: false`. Files outside every
 * package's `R/` (`tests/`, `vignettes/`, `inst/`, scripts, ...) and packages without a
 * NAMESPACE file keep the default public behaviour; a nested package without a NAMESPACE does
 * not inherit its enclosing package's.
 */
export const refineRExportStatus = (
  graph: KnowledgeGraph,
  rPackageConfig: RPackageConfig | null,
): void => {
  if (!rPackageConfig || rPackageConfig.namespaceInfoByPackageDir.size === 0) return;

  // Nodes of one file share an owner; resolve it once per file.
  const ownerByFile = new Map<string, RNamespaceInfo | undefined>();
  const namespaceInfoFor = (filePath: string): RNamespaceInfo | undefined => {
    if (ownerByFile.has(filePath)) return ownerByFile.get(filePath);
    const pkgDir = rOwningPackageDir(filePath, rPackageConfig);
    const info =
      pkgDir === undefined ? undefined : rPackageConfig.namespaceInfoByPackageDir.get(pkgDir);
    ownerByFile.set(filePath, info);
    return info;
  };

  graph.forEachNode((node: GraphNode) => {
    if (node.properties.language !== SupportedLanguages.R) return;
    const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
    if (!filePath) return;

    const nsInfo = namespaceInfoFor(filePath);
    if (!nsInfo || !nsInfo.hasNamespaceFile) return;

    const name = typeof node.properties.name === 'string' ? node.properties.name : '';
    if (!name) return;

    // NAMESPACE writes the symbol (`export(`%+%`)`); the node keeps the definition's spelling.
    const symbol = rBareName(name);
    if (nsInfo.namedExports.has(symbol)) return; // explicit export — keep public
    // exportPatterns are precompiled linear-time matchers (see loadRPackageConfig) — no per-node recompile.
    const matched = rExportPatternMatches(nsInfo, symbol);
    if (matched) return;

    // Not in NAMESPACE → not exported.
    node.properties.isExported = false;
  });
};

/**
 * R's `LanguageProvider.postParse` hook: deferred owner attach for methods and
 * properties, then NAMESPACE-driven export refinement. Runs once per analyze,
 * after every chunk is merged and before scope resolution.
 */
export const rPostParse = async (ctx: PostParseContext): Promise<void> => {
  attachDeferredROwners(ctx.graph, ctx.model, 'Method', 'HAS_METHOD');
  attachDeferredROwners(ctx.graph, ctx.model, 'Property', 'HAS_PROPERTY');
  const config = await loadRPackageConfig(ctx.repoPath);
  refineRExportStatus(ctx.graph, config);
  reportRExportPatternProblems(config);
};
