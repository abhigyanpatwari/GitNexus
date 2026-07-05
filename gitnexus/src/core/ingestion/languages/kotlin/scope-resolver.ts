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
import { clearCompanionScopes } from './companion-scopes.js';
import { applyKotlinCaptureSideChannel } from './capture-side-channel.js';
import { isKotlinStaticOnly } from './owners.js';

/**
 * Kotlin scope resolver for RFC #909 Ring 3.
 *
 * Kotlin resolves via the scope-resolution registry — production
 * resolution flows through the scope-resolution pipeline as the sole
 * call-resolution path.
 *
 * **Coverage:** 208/208 fixtures pass after the migration sub-issues
 * #1758–#1763, the
 * companion/instance dispatch fix #1756, and the lambda scopes
 * fix #1757. Covers core import, receiver, companion, default-param,
 * vararg, constructor, local assignment-chain, collection-iteration,
 * smart casts (`when (x) { is T -> … }` and `if (x is T)` — #1758),
 * cross-file iterable return propagation (#1759), single-level
 * method-chain fixpoint receiver types (#1760), parameter-type-narrowed
 * overload target-id selection (#1761), virtual dispatch via constructor
 * RHS (`val x: Animal = Dog()` — #1762), interface default-method
 * dispatch via implements-split MRO (#1763), companion-object vs
 * instance member dispatch (#1756) via the `isStaticOnly` hook
 * (including named companions and MRO-shadow / chain-typebinding /
 * value-receiver crossover cases), and lambda-body Block scopes
 * with scoped type-bindings for explicit parameters and implicit
 * `it` (#1757) via `synthesizeKotlinLambdaBindings` plus the
 * `(lambda_literal) @scope.block` query rule.
 *
 * **Legacy parity skip list:** `LEGACY_RESOLVER_PARITY_EXPECTED_FAILURES.kotlin`
 * in `test/integration/resolvers/helpers.ts` records scope-resolver-only
 * correctness wins that the legacy DAG cannot replicate. As of #1756 /
 * #1757 there are 8 entries covering: the bare companion-vs-instance
 * crossover, three MRO-shadow / standalone-chain cases, the chained-
 * forEach lambda-scope case, the named-companion crossover, and the
 * Case-0 / Case-3b / Case-5 companion crossovers under
 * `kotlin-companion-other-cases`. Each entry is documented inline with
 * its issue ref and rationale.
 */
export const kotlinScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Kotlin,
  languageProvider: kotlinProvider,
  importEdgeReason: 'kotlin-scope: import',

  loadResolutionConfig: () => {
    // Drop the module-level `companionScopesByFile` table from any
    // prior workspace pass before this run populates it via
    // `emitKotlinScopeCaptures`. Mirrors the C resolver's
    // `clearStaticNames()` call in `loadResolutionConfig` — the
    // orchestrator awaits this hook exactly once per workspace pass
    // (see `pipeline/phase.ts`), making it the right lifecycle seam
    // for clearing per-language side-channel state. Returns
    // `undefined` because Kotlin has no external resolution config
    // to load.
    clearCompanionScopes();
    return undefined;
  },

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

  // Worker-boundary restore (see `ScopeResolver.applyCaptureSideChannel`).
  // `emitKotlinScopeCaptures` records per-file companion-object scope ids
  // (`markCompanionScope` → `companionScopesByFile`) as a SIDE EFFECT — that
  // state is NOT serialized onto the returned ParsedFile's scopes/defs. On the
  // worker path those marks are populated in the worker process and lost across
  // the MessageChannel / disk store; the main thread reuses the serialized
  // ParsedFile and skips `extractParsedFile`, so `isKotlinStaticOnly` and
  // `populateCompanionMembersOnEnclosingClass` (owners.ts) would see an empty
  // map and companion/static dispatch would emit zero CALLS edges. The worker
  // stashed a plain-data snapshot on `parsed.captureSideChannel` via
  // `kotlinProvider.collectCaptureSideChannel`; this restores it into the
  // module map WITHOUT any tree-sitter re-parse (the #1983 fix). The
  // freshly-extracted leg never calls this — its marks were just populated in
  // this process. Runs BEFORE `populateOwners` so the restored companion map is
  // visible to it.
  applyCaptureSideChannel: applyKotlinCaptureSideChannel,

  populateOwners: (parsed: ParsedFile) => populateKotlinOwners(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  isStaticOnly: isKotlinStaticOnly,

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
