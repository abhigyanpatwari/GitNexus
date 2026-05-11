/**
 * PHP `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3 LANG-php).
 *
 * Third migration after Python and C#. See `pythonScopeResolver` for the
 * canonical shape.
 *
 * ## Circular-import avoidance
 *
 * The old PR had `php/scope-resolver.ts` importing `phpProvider` from
 * `../php.js` while `php.ts` imported `phpScopeResolver` from `./php/index.js`
 * — undefined at module load. The canonical fix (mirroring C#):
 *
 *   - `scope-resolver.ts` imports `phpProvider` from `../php.js` ✓
 *   - `php.ts` imports individual hook FUNCTIONS from `./php/index.js` ✗
 *
 * Node's ESM handles the cycle correctly because `phpProvider` is a named
 * export that is live-binding — by the time `phpScopeResolver` is first
 * read (lazily, at resolution time), `phpProvider` is fully initialized.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import {
  findReceiverTypeBinding,
  populateClassOwnedMembers,
} from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import {
  resolveCallerGraphId,
  resolveDefGraphId,
} from '../../scope-resolution/graph-bridge/ids.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { phpProvider } from '../php.js';
import { phpArityCompatibility, phpMergeBindings } from './index.js';
import { resolvePhpImportTargetInternal, loadPhpComposerConfig } from './import-target.js';
import { populatePhpNamespaceSiblings } from './namespace-siblings.js';

/**
 * PHP MRO builder — extends the generic EXTENDS-only MRO with trait-use
 * relationships encoded as IMPLEMENTS edges.
 *
 * PHP trait-use (`use TraitName;` inside a class body) is recorded in the
 * graph as an IMPLEMENTS edge from the using class to the Trait node. The
 * generic `buildMro` only walks EXTENDS edges, so trait methods are invisible
 * to the MRO-based dispatch index. This variant:
 *
 *   1. Runs the generic `buildMro` (EXTENDS edges, Class defs only).
 *   2. Indexes Trait defs from `parsedFiles` alongside Class defs.
 *   3. Walks IMPLEMENTS edges; for each edge whose target resolves to a
 *      Trait DefId, prepends that Trait DefId to the source class's MRO.
 *
 * Trait methods are searched BEFORE parent-class methods (PHP semantics:
 * a trait method shadows the parent-class method but is overridden by the
 * using class's own methods).
 */
function buildPhpMro(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): Map<string, string[]> {
  // Step 1: run generic MRO (Class-only, EXTENDS-only).
  const mro = buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);

  // Step 2: build a graphId → defId map for ALL class-like defs including Traits.
  // After the `isLinkableLabel` fix, Trait nodes are now indexed in nodeLookup.
  const defIdByGraphId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class' && def.type !== 'Trait') continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) defIdByGraphId.set(graphId, def.nodeId);
    }
  }

  // Step 2b: build a Set of Trait defIds for O(1) trait-vs-interface checks.
  const traitDefIds = new Set<string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type === 'Trait') traitDefIds.add(def.nodeId);
    }
  }

  // Step 3: collect direct trait-use edges (IMPLEMENTS where target is a Trait).
  // Maps class/trait defId → [traitDefId, ...] for direct `use TraitName;`.
  const directTraitUse = new Map<string, string[]>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const sourceDefId = defIdByGraphId.get(rel.sourceId);
    if (sourceDefId === undefined) continue;
    const targetDefId = defIdByGraphId.get(rel.targetId);
    if (targetDefId === undefined) continue;
    if (!traitDefIds.has(targetDefId)) continue;

    let list = directTraitUse.get(sourceDefId);
    if (list === undefined) {
      list = [];
      directTraitUse.set(sourceDefId, list);
    }
    if (!list.includes(targetDefId)) list.push(targetDefId);
  }

  // Step 4: augment every class's MRO by prepending the traits used by
  // any class in its ancestor chain (transitively). PHP semantics:
  // a trait used by a parent class is also visible on the child.
  //
  // For each class, walk its (already-computed) EXTENDS-based MRO and
  // collect all transitively-used traits. Prepend them before the
  // EXTENDS ancestors so the method dispatch index finds trait methods
  // before checking the parent class hierarchy.
  for (const [classDefId, extendsMro] of mro) {
    const allTraits: string[] = [];
    const seen = new Set<string>();

    // Collect traits from this class itself and from each ancestor.
    const ancestorChain = [classDefId, ...extendsMro];
    for (const ancestorId of ancestorChain) {
      for (const traitId of directTraitUse.get(ancestorId) ?? []) {
        if (!seen.has(traitId)) {
          seen.add(traitId);
          allTraits.push(traitId);
          // Traits can use other traits — include transitively.
          for (const transitiveTrait of directTraitUse.get(traitId) ?? []) {
            if (!seen.has(transitiveTrait)) {
              seen.add(transitiveTrait);
              allTraits.push(transitiveTrait);
            }
          }
        }
      }
    }

    if (allTraits.length > 0) {
      // Prepend traits before EXTENDS ancestors: own class's traits first,
      // then parent traits (in ancestor order). This ensures trait methods
      // are found before falling back to the inheritance chain.
      mro.set(classDefId, [...allTraits, ...extendsMro]);
    }
  }

  // Step 5: also insert Trait-only entries for classes that use traits
  // directly but have no EXTENDS parents (not in `mro` yet).
  for (const [classDefId, traits] of directTraitUse) {
    if (!mro.has(classDefId) && !traitDefIds.has(classDefId)) {
      // Class with no EXTENDS but with trait-use — add to MRO map.
      const allTraits: string[] = [];
      const seen = new Set<string>();
      for (const traitId of traits) {
        if (!seen.has(traitId)) {
          seen.add(traitId);
          allTraits.push(traitId);
          for (const transitiveTrait of directTraitUse.get(traitId) ?? []) {
            if (!seen.has(transitiveTrait)) {
              seen.add(transitiveTrait);
              allTraits.push(transitiveTrait);
            }
          }
        }
      }
      mro.set(classDefId, allTraits);
    }
  }

  return mro;
}

/**
 * Emit CALLS edges for PHP member-call sites whose receiver has no type
 * binding (e.g. `mixed`-typed parameters, untyped variables).
 *
 * PHP is dynamically typed: a parameter declared as `mixed` (or with no
 * type hint) cannot be resolved by the generic receiver-bound pass, which
 * requires a `TypeRef` in scope. This hook does a workspace-wide method
 * name lookup: when exactly one def in the workspace matches the called
 * method name, emit the CALLS edge.
 *
 * Only fires for sites that are NOT already in `handledSites` and whose
 * receiver has no type binding in the scope chain. Unique-name-match
 * constraint avoids false positives for common method names.
 */
function phpEmitUnresolvedReceiverEdges(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  handledSites: Set<string>,
  model: SemanticModel,
): number {
  let emitted = 0;
  const seen = new Set<string>();

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call') continue;
      if (site.explicitReceiver === undefined) continue;

      const siteKey = `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`;
      if (handledSites.has(siteKey)) continue;

      // Only proceed when the receiver has NO type binding — it's unresolvable
      // by the generic pass. This is the `mixed` / unannotated case.
      const typeRef = findReceiverTypeBinding(site.inScope, site.explicitReceiver.name, scopes);
      if (typeRef !== undefined) continue;

      // Workspace-wide lookup: collect all methods matching the called name.
      // Filter out defs with no qualifiedName (legacy parse stubs without full
      // metadata) and deduplicate by nodeId so reconcileOwnership double-registration
      // doesn't inflate the count.
      const allCandidates = model.methods.lookupMethodByName(site.name);
      const seen2 = new Set<string>();
      const candidates = allCandidates.filter((c) => {
        if (c.qualifiedName === undefined) return false;
        if (seen2.has(c.nodeId)) return false;
        seen2.add(c.nodeId);
        return true;
      });
      if (candidates.length !== 1) continue; // ambiguous or missing — skip

      const fnDef = candidates[0];
      if (fnDef === undefined) continue;

      const callerGraphId = resolveCallerGraphId(site.inScope, scopes, nodeLookup);
      if (callerGraphId === undefined) continue;
      const tgtGraphId = resolveDefGraphId(fnDef.filePath, fnDef, nodeLookup);
      if (tgtGraphId === undefined) continue;

      handledSites.add(siteKey);
      const relId = `rel:CALLS:${callerGraphId}->${tgtGraphId}`;
      if (seen.has(relId)) continue;
      seen.add(relId);
      graph.addRelationship({
        id: relId,
        sourceId: callerGraphId,
        targetId: tgtGraphId,
        type: 'CALLS',
        confidence: 0.6,
        reason: 'php-unresolved-receiver-fallback',
      });
      emitted++;
    }
  }
  return emitted;
}

const phpScopeResolver: ScopeResolver = {
  language: SupportedLanguages.PHP,
  languageProvider: phpProvider,
  importEdgeReason: 'php-scope: use',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolvePhpImportTargetInternal(targetRaw, fromFile, allFilePaths, resolutionConfig),

  loadResolutionConfig: (repoPath) => loadPhpComposerConfig(repoPath),

  // PHP LEGB-like precedence: local > import/namespace/reexport > wildcard.
  // The per-scope id is unused by phpMergeBindings (tier ordering computed
  // purely from BindingRef.origin), so we don't synthesize a Scope.
  mergeBindings: (existing, incoming) => [...phpMergeBindings([...existing, ...incoming])],

  // Adapter: phpArityCompatibility uses (def, callsite); the contract is (callsite, def).
  arityCompatibility: (callsite, def) => phpArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) => buildPhpMro(graph, parsedFiles, nodeLookup),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // PHP same-namespace cross-file visibility — classes in the same
  // PHP namespace are visible without explicit `use` statements.
  // Mirrors C#'s `populateNamespaceSiblings`.
  populateNamespaceSiblings: populatePhpNamespaceSiblings,

  // PHP uses `parent` for super-class dispatch (not `super()`).
  isSuperReceiver: (text) => text.trim() === 'parent',

  // PHP is dynamically typed — field-fallback heuristic on so that
  // method calls on `mixed`-typed receivers (no annotation) fall back
  // to a workspace-wide name search rather than silently dropping the edge.
  fieldFallbackOnMethodLookup: true,

  // PHP: allow free-call fallback to unique workspace-wide callable when
  // lexical/import bindings miss. Needed for two cases:
  //   1. `use function` imports where PSR-4 directory resolution is
  //      non-deterministic (multiple .php files in same namespace dir).
  //   2. Unimported free calls within the same namespace (same-namespace
  //      visibility without an explicit use statement, e.g. test fixtures).
  allowGlobalFreeCallFallback: true,

  // Return-type propagation on — PHP method signatures are authoritative
  // enough for cross-file chain-follow.
  propagatesReturnTypesAcrossImports: true,

  // PHP hoists method return-type bindings to the Module scope so
  // `propagateImportedReturnTypes` can pick them up across files.
  hoistTypeBindingsToModule: true,
};

export { phpScopeResolver };
