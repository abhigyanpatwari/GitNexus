import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { rustProvider } from '../rust.js';
import { rustArityCompatibility, rustMergeBindings, resolveRustImportTarget } from './index.js';
import { populateRustOwners } from './method-owners.js';
import { populateRustRangeBindings } from './range-binding.js';
import {
  isClassLike,
  findClassBindingInScope,
  resolveAmbiguousInheritanceBaseViaImports,
} from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
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
 * Resolution is scope-aware and import-aware, mirroring the shared
 * `preEmitInheritanceEdges` pass: both `S` and `T` resolve from the `impl`
 * block's own scope via `findClassBindingInScope` (scope-chain + single-match
 * fallbacks), then `resolveAmbiguousInheritanceBaseViaImports` for a name that
 * several modules declare (disambiguated by the referencing file's `use`
 * imports). A trait `T` is commonly declared in a different file (e.g. the
 * `rust-traits` fixture imports `Drawable`/`Clickable` from a sibling module);
 * the scope chain reaches it through those `use` bindings. When a name does
 * not resolve to exactly one class-like def — unresolved (e.g. a std trait
 * like `Default`) OR ambiguous across modules (two same-named `struct`s /
 * traits) — NO edge is emitted, restoring the legacy file-scoped path's
 * "a wrong edge is worse than no edge" invariant. (The prior global
 * simple-name index used last-write-wins and could source an `impl` edge from
 * the wrong same-named def across modules.) Idempotent: pre-seeds the dedup
 * set from existing IMPLEMENTS edges so a worker-mode legacy emission (or a
 * re-resolution) is not duplicated.
 */
function emitRustTraitImplEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  scopes: ScopeResolutionIndexes | undefined,
): void {
  if (scopes === undefined) return;

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

      // Scope-aware (+ import-aware) resolution from the impl block's scope.
      // Refuse when either end is unresolved or ambiguous.
      const structDef =
        findClassBindingInScope(site.inScope, structName, scopes) ??
        resolveAmbiguousInheritanceBaseViaImports(site.inScope, structName, scopes);
      const traitDef =
        findClassBindingInScope(site.inScope, traitName, scopes) ??
        resolveAmbiguousInheritanceBaseViaImports(site.inScope, traitName, scopes);
      if (structDef === undefined || traitDef === undefined) continue;

      const structGraphId = resolveDefGraphId(structDef.filePath, structDef, nodeLookup);
      const traitGraphId = resolveDefGraphId(traitDef.filePath, traitDef, nodeLookup);
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

  emitHeritageEdges: (graph, parsedFiles, nodeLookup, scopes) =>
    emitRustTraitImplEdges(graph, parsedFiles, nodeLookup, scopes),

  populateOwners: (parsed: ParsedFile) => populateRustOwners(parsed),

  isSuperReceiver: () => false,

  populateRangeBindings: populateRustRangeBindings,

  fieldFallbackOnMethodLookup: false,
  hoistTypeBindingsToModule: true,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,
};
