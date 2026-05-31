import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { rustProvider } from '../rust.js';
import { rustArityCompatibility, rustMergeBindings, resolveRustImportTarget } from './index.js';
import { populateRustOwners } from './method-owners.js';
import { populateRustRangeBindings } from './range-binding.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';

/**
 * Emit Rust `S IMPLEMENTS T` edges from `impl T for S` trait implementations.
 *
 * Rust inheritance is not a base list on the type declaration — it lives on
 * `impl_item { trait: T, type: S }`. The shared `preEmitInheritanceEdges` pass
 * derives an `@reference.inherits` site's edge SOURCE from the enclosing class
 * def, but an `impl_item` scope owns no class-like def, so that pass cannot
 * produce these edges (it only marks the sites handled). The `@reference.inherits`
 * sites synthesized in `captures.ts` carry the trait `T` as `site.name` (target)
 * and the struct `S` as `site.explicitReceiver.name` (source); this hook reads
 * them back and emits the IMPLEMENTS edge with source `S`, target `T`, and the
 * legacy `'trait-impl'` reason — matching the legacy `@heritage` DAG (#1951).
 *
 * Resolution is workspace-wide (mirrors the legacy `ctx.resolve(name, ...)`
 * symbol resolution and Ruby's `emitRubyMixinEdges`): a trait `T` is commonly
 * declared in a different file from the `impl` block (e.g. the `rust-traits`
 * fixture imports `Drawable`/`Clickable` from a sibling module), so both `S`
 * and `T` are matched against every parsed file's class-like defs by simple
 * name. Unresolved bases (e.g. a std trait like `Default`) emit no edge, the
 * one place this path diverges from the legacy synthetic-node fallback — the
 * resolver tests assert exact IMPLEMENTS counts only for locally-declared
 * traits, so parity holds. Idempotent: pre-seeds the dedup set from existing
 * IMPLEMENTS edges so a worker-mode legacy emission (or a re-resolution) is
 * not duplicated.
 */
function emitRustTraitImplEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  // Workspace-wide class-like graph-id index keyed by simple name. Rust
  // qualified names use `.` as the separator (e.g. `models.User`).
  const graphIdByName = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId === undefined) continue;
      const simpleName = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
      if (simpleName !== '') graphIdByName.set(simpleName, graphId);
    }
  }
  if (graphIdByName.size === 0) return;

  const emitted = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    emitted.add(`${rel.sourceId}->${rel.targetId}`);
  }

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'inherits') continue;
      const structName = site.explicitReceiver?.name;
      const traitName = site.name;
      if (structName === undefined || structName === '' || traitName === '') continue;

      const structGraphId = graphIdByName.get(structName);
      const traitGraphId = graphIdByName.get(traitName);
      if (structGraphId === undefined || traitGraphId === undefined) continue;

      const edgeKey = `${structGraphId}->${traitGraphId}`;
      if (emitted.has(edgeKey)) continue;
      emitted.add(edgeKey);

      graph.addRelationship({
        id: generateId('IMPLEMENTS', `${edgeKey}:trait-impl`),
        sourceId: structGraphId,
        targetId: traitGraphId,
        type: 'IMPLEMENTS',
        confidence: 0.85,
        reason: 'trait-impl',
      });
    }
  }
}

function buildRustMro(
  graph: Parameters<ScopeResolver['buildMro']>[0],
  parsedFiles: readonly ParsedFile[],
  nodeLookup: Parameters<ScopeResolver['buildMro']>[2],
): Map<string, string[]> {
  const baseMro = buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);

  const defIdByGraphId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) defIdByGraphId.set(graphId, def.nodeId);
    }
  }

  const fileByDefId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      fileByDefId.set(def.nodeId, parsed.filePath);
    }
  }

  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const childDefId = defIdByGraphId.get(rel.sourceId);
    const parentDefId = defIdByGraphId.get(rel.targetId);
    if (childDefId === undefined || parentDefId === undefined) continue;

    const childFile = fileByDefId.get(childDefId);
    const parentFile = fileByDefId.get(parentDefId);
    if (childFile !== parentFile) continue;

    const existing = baseMro.get(childDefId);
    if (existing !== undefined) {
      if (!existing.includes(parentDefId)) existing.push(parentDefId);
    } else {
      baseMro.set(childDefId, [parentDefId]);
    }
  }

  return baseMro;
}

export const rustScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Rust,
  languageProvider: rustProvider,
  importEdgeReason: 'rust-scope: use',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveRustImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  mergeBindings: (existing, incoming, scopeId) => rustMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => rustArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) => buildRustMro(graph, parsedFiles, nodeLookup),

  emitHeritageEdges: (graph, parsedFiles, nodeLookup) =>
    emitRustTraitImplEdges(graph, parsedFiles, nodeLookup),

  populateOwners: (parsed: ParsedFile) => populateRustOwners(parsed),

  isSuperReceiver: () => false,

  populateRangeBindings: populateRustRangeBindings,

  fieldFallbackOnMethodLookup: false,
  hoistTypeBindingsToModule: true,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,
};
