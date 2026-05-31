/**
 * Swift `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3,
 * issue #937 — the final per-language migration).
 *
 * Closest reference: C# (`csharpScopeResolver`) — both are OOP with
 * classes, structs, interfaces/protocols, and explicit instance
 * receivers. MRO follows Kotlin's shape (single superclass + multiple
 * protocol conformance).
 *
 * ## Swift specifics
 *
 *   - **Extensions** add members to an existing type. `emitSwiftScopeCaptures`
 *     re-keys an `extension Foo { … }` to a `class_declaration`-style def
 *     named `Foo`, so its members land on `Foo`'s scope and the shared
 *     `populateClassOwnedMembers` stamps them with `Foo`'s ownerId — the
 *     same mechanism C# uses for `partial class`. No separate hoist pass.
 *   - **Labeled arguments** narrow by ARITY only (count-primary, labels
 *     soft) — see `arity.ts`. Label-precise dispatch is deferred to the
 *     type-binding layer.
 *   - **Same-module visibility**: every file in an SPM target sees its
 *     siblings' top-level defs without an `import`. Modeled via
 *     `populateSwiftTargetSiblings`, grouped by the SPM target *subtree*
 *     (`Sources/<Target>/…`) via `groupSwiftFilesBySpmTarget` fed from the
 *     `loadResolutionConfig` SPM map, mirroring Go's package siblings. With
 *     no scanned source dir (no `Sources/`/`Package/Sources/`/`src/`) the
 *     map is null and all files form one `__default__` module.
 *   - **`super`** is the superclass receiver (`super.method()`); plain
 *     `self` is the instance receiver. Both synthesized in
 *     `receiver-binding.ts`.
 *
 * ## Known limitations (conscious migration trade-offs; parity gate flags
 * anything that matters in the corpus)
 *
 *   1. **Protocol associated types / generic constraints** (`extension
 *      Array where Element: Equatable`) are not narrowed — the `Self`
 *      type of a protocol method resolves to the protocol, not the
 *      conforming type.
 *   2. **Cross-module `import` resolution** is still directory-segment
 *      based (`import Foo` → files under a `Foo/` dir); explicit imports do
 *      not yet consult the SPM target map (follow-up, tracked under #1935).
 *      Same-target visibility (the common case) IS SPM-target-subtree
 *      accurate — handled by sibling augmentation grouped via
 *      `groupSwiftFilesBySpmTarget`, not by explicit imports.
 *   3. **Operator / subscript overloads** dispatch by name only.
 *   4. **`@_exported import` re-exports** are treated as plain imports.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { loadSwiftPackageConfig } from '../../language-config.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers, isClassLike } from '../../scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { swiftProvider } from '../swift.js';
import {
  swiftArityCompatibility,
  swiftMergeBindings,
  interpretSwiftImport,
  resolveSwiftImportTarget,
  populateSwiftTargetSiblings,
  emitSwiftImplicitImportEdges,
  mirrorSwiftSiblingTypeBindings,
  type SwiftResolveContext,
} from './index.js';

const ZERO_RANGE = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 } as const;

const swiftScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Swift,
  languageProvider: swiftProvider,
  importEdgeReason: 'swift-scope: import',

  // Load the SPM target map (Sources/<Target>/ subtree mapping) once per
  // workspace pass. Threaded through the orchestrator as `resolutionConfig`
  // and consumed by the three same-module grouping hooks
  // (`emitImplicitImportEdges`, `populateNamespaceSiblings`,
  // `mirrorNamespaceTypeBindings`) via `coerceSwiftTargets` so they group by
  // the SPM target subtree, not the immediate directory. Mirrors
  // `goScopeResolver`'s `loadGoModulePath`.
  loadResolutionConfig: (repoPath: string) => loadSwiftPackageConfig(repoPath),

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    const ws: SwiftResolveContext = { fromFile, allFilePaths };
    return resolveSwiftImportTarget(
      interpretSwiftImport({
        '@import.source': { name: '@import.source', text: targetRaw, range: ZERO_RANGE },
      }) ?? { kind: 'namespace', localName: targetRaw, importedName: targetRaw, targetRaw },
      ws,
    );
  },

  // Swift shadowing: local declarations hide imports.
  mergeBindings: (existing, incoming) => [...swiftMergeBindings([...existing, ...incoming])],

  // Adapter: swiftArityCompatibility uses (def, callsite); contract is (callsite, def).
  arityCompatibility: (callsite, def) => swiftArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) => buildSwiftMro(graph, parsedFiles, nodeLookup),

  // Methods/properties/init are owned by their enclosing class/struct/
  // extension(→extended type)/protocol. Extension members hoist for free
  // because captures.ts re-keys the extension to a Class def named after
  // the extended type.
  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // `super.method()` dispatches through the superclass chain.
  isSuperReceiver: (text) => text.trim() === 'super',

  // Whole-module same-target visibility without `import`.
  populateNamespaceSiblings: populateSwiftTargetSiblings,

  // Same-target File→File IMPORTS edges (no syntactic `import`). The
  // generic finalized-ImportEdge pipeline has nothing to emit here, so
  // these whole-module-visibility edges are emitted directly.
  emitImplicitImportEdges: emitSwiftImplicitImportEdges,

  // Mirror sibling files' return-type typeBindings into each file's
  // module scope so cross-file chains (`let u = siblingFn(); u.m()`)
  // resolve. Whole-module visibility has no import edge for
  // `propagateImportedReturnTypes` to follow, so this directory-sibling
  // mirror feeds it (mirrors Go's namespace-typeBinding mirror).
  mirrorNamespaceTypeBindings: mirrorSwiftSiblingTypeBindings,

  // Swift is statically typed — type info is reliable; the field-fallback
  // heuristic over-connects, so keep it off. Return-type propagation on.
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,

  // Swift has no `new` keyword: `UserService()` is a bare call that
  // resolves to the type's Constructor/Class. With whole-module sibling
  // visibility, the callee is reachable workspace-wide, so allow the
  // global free-call fallback (as Python/Go/Ruby/COBOL do for the same
  // no-`new` constructor + cross-file free-call shape).
  allowGlobalFreeCallFallback: true,

  // Swift's call graph models `Type(...)` as a reference to the type
  // itself, not its `init` — both the legacy DAG and this test suite link
  // `Foo()` to the Class node even when an explicit `init` exists.
  constructorCallTargetsClass: true,
};

export { swiftScopeResolver };

/**
 * Swift MRO — `defaultLinearize` (EXTENDS-only superclass chain) extended
 * with protocol ancestors discovered via `IMPLEMENTS` edges. Protocols
 * with default method implementations (via protocol extensions) are
 * inherited by conforming types without an explicit `override`; the
 * generic EXTENDS-only MRO would miss them because the conformer has no
 * EXTENDS link to the protocol.
 *
 * Mirrors `buildKotlinMro`: append protocols after the superclass chain
 * (Swift requires an explicit implementation on ambiguity, so first-seen
 * ordering approximates method lookup). Transitive protocol inheritance
 * (`protocol A: B`) is closed via BFS.
 */
function buildSwiftMro(
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

  for (const [classDefId, extendsMro] of mro) {
    const ancestorChain = [classDefId, ...extendsMro];
    const seeds: string[] = [];
    for (const ancestorId of ancestorChain) {
      for (const ifaceId of directImpls.get(ancestorId) ?? []) seeds.push(ifaceId);
    }
    if (seeds.length === 0) continue;
    const protocols = closeProtocols(seeds, directImpls);
    mro.set(classDefId, [...extendsMro, ...protocols.filter((i) => !extendsMro.includes(i))]);
  }

  // Types that only conform to protocols (no superclass) still need an MRO.
  for (const [classDefId, ifaces] of directImpls) {
    if (mro.has(classDefId)) continue;
    mro.set(classDefId, closeProtocols([...ifaces], directImpls));
  }

  return mro;
}

function closeProtocols(
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
