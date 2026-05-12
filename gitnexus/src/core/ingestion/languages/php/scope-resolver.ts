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
import { narrowOverloadCandidates } from '../../scope-resolution/passes/overload-narrowing.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SymbolDefinition } from 'gitnexus-shared';
import { phpProvider } from '../php.js';
import { phpArityCompatibility, phpMergeBindings } from './index.js';
import { resolvePhpImportTargetInternal, loadPhpComposerConfig } from './import-target.js';
import { populatePhpNamespaceSiblings, getPhpNamespaceForFile } from './namespace-siblings.js';

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
/**
 * PHP free-call visibility check for `pickUniqueGlobalCallable`. Returns
 * true when the candidate function is reachable from the caller's PHP
 * namespace context, false when the cross-namespace bridge would be a
 * false positive (e.g., `\App\Utils\format` is not visible from `\App`
 * without an explicit `use function App\Utils\format;`).
 *
 * Rules (PHP semantics):
 *   1. Same-namespace candidates are always visible.
 *   2. Global-namespace candidates (no namespace prefix) are visible from
 *      every caller — PHP's global fallback for functions/constants.
 *   3. Candidates in a different namespace are visible only when the
 *      caller has a `use function` import that matches the candidate's
 *      fully-qualified name.
 */
function phpIsCallableVisibleFromCaller(ctx: {
  callerParsed: ParsedFile;
  candidate: SymbolDefinition;
}): boolean {
  const { callerParsed, candidate } = ctx;
  const callerNs = getPhpNamespaceForFile(callerParsed.filePath);
  const candNs = getPhpNamespaceForFile(candidate.filePath);

  // Global-namespace candidate: PHP falls back to global for functions
  // and constants when the local namespace doesn't define them.
  if (candNs === '') return true;

  // Same-namespace: caller can see the candidate without an explicit use.
  if (candNs === callerNs) return true;

  // Cross-namespace: require an explicit `use function` import in the
  // caller's parsedImports that matches the candidate's fully-qualified
  // name. interpret.ts maps `use function Foo\bar` to a named import with
  // localName = 'bar' and targetRaw = 'Foo\\bar'.
  const candQualified =
    candidate.qualifiedName === undefined
      ? ''
      : candNs !== '' && !candidate.qualifiedName.includes('\\')
        ? `${candNs}\\${candidate.qualifiedName}`
        : candidate.qualifiedName;
  if (candQualified === '') return false;
  return callerParsed.parsedImports.some(
    (imp) =>
      imp.kind === 'named' &&
      imp.targetRaw.replace(/^\\+/, '') === candQualified.replace(/^\\+/, ''),
  );
}

/**
 * Compute the EXTENDS-only ancestor chain for every class — no trait
 * augmentation. PHP semantics: `parent::method()` walks this view so
 * that `parent::` resolves to the parent class's method, even when a
 * composed trait shadows the same name.
 *
 * Returns the same shape as `buildPhpMro` so callers can swap views
 * without changing dispatch logic. Just `buildMro` + `defaultLinearize`
 * — no trait IMPLEMENTS edge walk.
 */
function buildPhpExtendsOnlyMro(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): Map<string, string[]> {
  return buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);
}

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
  // any class in its ancestor chain (transitively closed). PHP semantics:
  // a trait used by a parent class is also visible on the child, and a
  // trait-using-trait chain is flattened to a single ancestor set.
  //
  // For each class, walk its (already-computed) EXTENDS-based MRO and
  // collect all transitively-used traits via BFS — `trait A { use B; }
  // trait B { use C; } class X { use A; }` must include C in X's MRO.
  // Prepend them before the EXTENDS ancestors so the method dispatch
  // index finds trait methods before falling back to the parent class
  // hierarchy.
  for (const [classDefId, extendsMro] of mro) {
    const ancestorChain = [classDefId, ...extendsMro];
    const seeds: string[] = [];
    for (const ancestorId of ancestorChain) {
      for (const traitId of directTraitUse.get(ancestorId) ?? []) {
        seeds.push(traitId);
      }
    }
    const allTraits = collectTransitiveTraits(seeds, directTraitUse);

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
      const allTraits = collectTransitiveTraits([...traits], directTraitUse);
      mro.set(classDefId, allTraits);
    }
  }

  return mro;
}

/**
 * Collect the transitive closure of traits reachable from the seed set.
 * BFS over `directTraitUse` until fixpoint. The `seen` set guards against
 * cycles (invalid PHP but defensively handled) and prevents duplicate
 * entries when multiple seeds converge on the same trait. Insertion order
 * is preserved — first-seen wins for MRO ordering.
 */
function collectTransitiveTraits(
  seeds: readonly string[],
  directTraitUse: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...seeds];
  while (queue.length > 0) {
    const t = queue.shift()!;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    for (const next of directTraitUse.get(t) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return out;
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

      // Apply arity narrowing — a unique method name match is not enough
      // when arity says the call is definitively incompatible (e.g., PHP
      // f(int $req, ...$rest) called with zero args). This prevents the
      // fallback from emitting edges that the receiver-bound pass already
      // rejected for arity reasons.
      if (narrowOverloadCandidates([fnDef], site.arity, site.argumentTypes).length === 0) {
        continue;
      }

      // Tighten the fallback further with an EXACT-required-arity gate
      // (Finding 8 / U4): the first-stage `narrowOverloadCandidates`
      // accepts any argCount in `min..max` (or `>= min` when variadic),
      // which over-emits 0.6-confidence edges for common method names
      // whose only workspace candidate has optional / defaulted params.
      // For the fallback path only, require argCount === required for
      // fixed-arity candidates. Variadic candidates keep the relaxed
      // `argCount >= required` semantics (already enforced by the first-
      // stage check, so no extra work here).
      const min = fnDef.requiredParameterCount;
      const hasVarArgs =
        fnDef.parameterTypes !== undefined &&
        fnDef.parameterTypes.some((t) => t === '...' || t.startsWith('...'));
      if (
        min !== undefined &&
        Number.isFinite(site.arity) &&
        site.arity >= 0 &&
        !hasVarArgs &&
        site.arity !== min
      ) {
        continue;
      }

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

  // PHP-specific: parent::method() must walk inheritance only, skipping
  // composed traits. See buildPhpExtendsOnlyMro and the super-branch use
  // in `passes/receiver-bound-calls.ts`.
  buildExtendsOnlyMro: (graph, parsedFiles, nodeLookup) =>
    buildPhpExtendsOnlyMro(graph, parsedFiles, nodeLookup),

  // PHP free-call visibility: cross-namespace candidates are blocked
  // unless explicitly `use function`-imported by the caller. Prevents
  // false-positive CALLS edges between unrelated namespaces sharing a
  // function name. Same-namespace and global-namespace candidates pass
  // unchanged.
  isCallableVisibleFromCaller: phpIsCallableVisibleFromCaller,

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

  // PHP recovers member calls on `mixed`/untyped receivers via a
  // workspace-wide unique-method-name lookup, mirroring the legacy DAG.
  emitUnresolvedReceiverEdges: phpEmitUnresolvedReceiverEdges,
};

export { phpScopeResolver };
