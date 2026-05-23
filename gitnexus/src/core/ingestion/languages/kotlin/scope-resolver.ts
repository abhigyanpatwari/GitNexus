import { SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { kotlinProvider } from '../kotlin.js';
import {
  kotlinArityCompatibility,
  kotlinMergeBindings,
  populateKotlinOwners,
  resolveKotlinImportTarget,
  type KotlinResolveContext,
} from './index.js';

/**
 * Kotlin scope resolver for RFC #909 Ring 3.
 *
 * Kotlin is intentionally registered but not yet listed in
 * `MIGRATED_LANGUAGES`, matching the Java migration pattern from #1482:
 * the resolver can run in shadow/forced mode, while production default
 * stays on the legacy DAG until the RFC flip criteria in #1746 are met.
 *
 * **Forced-mode parity (`REGISTRY_PRIMARY_KOTLIN=1`):** 175/175 fixtures
 * after the migration sub-issues #1758–#1763 closed. Covers core
 * import, receiver, companion, default-param, vararg, constructor,
 * local assignment-chain, collection-iteration, smart casts
 * (`when (x) { is T -> … }` and `if (x is T)` — #1758), cross-file
 * iterable return propagation (#1759), single-level method-chain
 * fixpoint receiver types (#1760), parameter-type-narrowed overload
 * target-id selection (#1761), virtual dispatch via constructor RHS
 * (`val x: Animal = Dog()` — #1762), and interface default-method
 * dispatch via implements-split MRO (#1763).
 *
 * **Remaining pre-flip blockers (#1746):** #1755 (forced-mode preview
 * CI workflow — obviated once Kotlin lands in `MIGRATED_LANGUAGES`
 * because the existing scope-parity matrix auto-discovers it), #1756
 * (companion vs instance member dispatch), and #1757 (lambda scopes
 * and lambda-parameter bindings). The flip PR adds
 * `SupportedLanguages.Kotlin` to `MIGRATED_LANGUAGES` after the named
 * blockers close.
 */
export const kotlinScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Kotlin,
  languageProvider: kotlinProvider,
  importEdgeReason: 'kotlin-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    const ws: KotlinResolveContext = { fromFile, allFilePaths };
    return resolveKotlinImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  mergeBindings: (existing, incoming) => [...kotlinMergeBindings([...existing, ...incoming])],

  arityCompatibility: (callsite, def) => kotlinArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) => buildKotlinMro(graph, parsedFiles, nodeLookup),

  populateOwners: (parsed: ParsedFile) => populateKotlinOwners(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,
  collapseMemberCallsByCallerTarget: false,
  hoistTypeBindingsToModule: true,
};

/**
 * Kotlin MRO builder — extends `defaultLinearize` (EXTENDS-only) with
 * interface ancestors discovered via `IMPLEMENTS` edges. Interface
 * default methods (`interface Validator { fun validate(): Boolean = true }`)
 * are inherited by implementing classes without an explicit override;
 * the generic MRO would not surface them because the implementor has
 * no `EXTENDS` link to the interface (#1763).
 *
 * Interfaces are appended after the EXTENDS chain (Kotlin resolves
 * conflicts by requiring an explicit override, so first-seen-in-MRO
 * ordering is a reasonable approximation for method lookup). Transitive
 * interface inheritance (`interface A : B`) is closed via BFS.
 */
function buildKotlinMro(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): Map<string, string[]> {
  const mro = buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);

  const defIdByGraphId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) defIdByGraphId.set(graphId, def.nodeId);
    }
  }

  // Direct IMPLEMENTS targets per class-like def.
  const directImpls = new Map<string, string[]>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const source = defIdByGraphId.get(rel.sourceId);
    const target = defIdByGraphId.get(rel.targetId);
    if (source === undefined || target === undefined) continue;
    let list = directImpls.get(source);
    if (list === undefined) {
      list = [];
      directImpls.set(source, list);
    }
    if (!list.includes(target)) list.push(target);
  }

  // For each class, append the transitive closure of interfaces reachable
  // through its own + ancestor classes' IMPLEMENTS edges. Walking
  // ancestors picks up interfaces inherited via the EXTENDS chain
  // (e.g. `class C : B; class B : A; interface A` — C inherits A's
  // interface methods through B).
  for (const [classDefId, extendsMro] of mro) {
    const ancestorChain = [classDefId, ...extendsMro];
    const seeds: string[] = [];
    for (const ancestorId of ancestorChain) {
      for (const ifaceId of directImpls.get(ancestorId) ?? []) {
        seeds.push(ifaceId);
      }
    }
    if (seeds.length === 0) continue;
    const interfaces = closeInterfaces(seeds, directImpls);
    mro.set(classDefId, [...extendsMro, ...interfaces.filter((i) => !extendsMro.includes(i))]);
  }

  // Classes with no EXTENDS still need an MRO entry when they implement
  // interfaces (e.g. `class User : Validator` — no `mro` entry from the
  // EXTENDS-only pass because no EXTENDS edges exist).
  for (const [classDefId, ifaces] of directImpls) {
    if (mro.has(classDefId)) continue;
    mro.set(classDefId, closeInterfaces([...ifaces], directImpls));
  }

  return mro;
}

function closeInterfaces(
  seeds: readonly string[],
  directImpls: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [...seeds];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const next of directImpls.get(cur) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return out;
}
