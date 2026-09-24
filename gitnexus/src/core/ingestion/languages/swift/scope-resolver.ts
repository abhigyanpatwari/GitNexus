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
 *     same mechanism C# uses for `partial class`. Cross-file extensions
 *     that mint no type def are reconciled by `populateWorkspaceOwners`.
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
 *   2. **Cross-module `import` resolution** uses a Package.swift
 *      declaration map when one is present, otherwise the directory-segment
 *      index minus well-known SDK module names (#2964). Same-target
 *      visibility (the common case) is SPM-target-subtree grouping via
 *      `groupSwiftFilesBySpmTarget`, not explicit imports.
 *   3. **Operator / subscript overloads** dispatch by name only.
 *   4. **`@_exported import`** is `ParsedImport` `kind: 'reexport'` and
 *      in-repo modules are closed transitively at resolve time. `public
 *      import` is not a re-export.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
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
import { stripSwiftTypePreservingDecoration } from './interpret.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';
import { swiftIsGlobalNameFallbackPlausible } from './name-fallback-visibility.js';

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

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig, context) => {
    const ws: SwiftResolveContext = {
      fromFile,
      allFilePaths,
      resolutionConfig,
      parsedFiles: context?.parsedFiles,
    };
    return resolveSwiftImportTarget(
      context?.parsedImport ??
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
  implicitThisWalksMro: true,
  stripTypePreservingDecoration: stripSwiftTypePreservingDecoration,

  // Methods/properties/init are owned by their enclosing class/struct/
  // extension(→extended type)/protocol. Extension members hoist for free
  // because captures.ts re-keys the extension to a Class def named after
  // the extended type.
  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // An extension has its own Class scope but deliberately does not mint a
  // second type def. Its members therefore leave the per-file owner walk with
  // a qualified name (`ExtendedType.member`) but no ownerId. Reconcile those
  // members after all files are available so extensions declared in sibling
  // files work as well as extensions beside the original type.
  populateWorkspaceOwners: populateSwiftExtensionOwners,

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
  isGlobalNameFallbackPlausible: swiftIsGlobalNameFallbackPlausible,

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

function populateSwiftExtensionOwners(
  parsedFiles: readonly ParsedFile[],
  ctx?: { readonly fileContents: ReadonlyMap<string, string>; readonly resolutionConfig?: unknown },
): void {
  const filesByTarget = groupSwiftFilesBySpmTarget(
    parsedFiles,
    (parsed) => parsed.filePath,
    coerceSwiftTargets(ctx?.resolutionConfig),
  );
  for (const files of filesByTarget.values()) {
    stampSwiftExtensionOwnersInTarget(files);
  }
}

function stampSwiftExtensionOwnersInTarget(parsedFiles: readonly ParsedFile[]): void {
  const ownersByName = new Map<string, SymbolDefinition[]>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type) || def.qualifiedName === undefined) continue;
      const bucket = ownersByName.get(def.qualifiedName);
      if (bucket === undefined) ownersByName.set(def.qualifiedName, [def]);
      else bucket.push(def);
    }
  }

  // Extension members are Function-owned defs whose parent Class minted no
  // type def. Nested locals are Function-owned defs whose parent is another
  // Function — leave those ownerless so they cannot enter implicit-self CALLS.
  for (const parsed of parsedFiles) {
    const byId = new Map(parsed.scopes.map((scope) => [scope.id, scope]));
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Function') continue;
      const parent = scope.parent === null ? undefined : byId.get(scope.parent);
      if (parent?.kind !== 'Class') continue;
      // A type-decl Class owns the type that opened it (same start line).
      // Nested types inside an `extension` are also class-like and live on
      // that Class scope — they are not the extended type, so they must
      // not suppress stamping `func added` onto `Foo`.
      if (parent.ownedDefs.some((d) => isClassLike(d.type) && defDeclaresThisClassScope(parent, d)))
        continue;
      for (const def of scope.ownedDefs) {
        if (def.ownerId !== undefined || def.qualifiedName === undefined) continue;
        const dot = def.qualifiedName.lastIndexOf('.');
        if (dot <= 0) continue;
        const owner = uniqueOwnerForExtensionPrefix(ownersByName, def.qualifiedName.slice(0, dot));
        if (owner !== undefined) {
          (def as { ownerId?: string }).ownerId = owner.nodeId;
        }
      }
    }
  }
}

function defDeclaresThisClassScope(
  parent: { readonly range: { readonly startLine: number } },
  def: SymbolDefinition,
): boolean {
  const line = /#(\d+):/.exec(def.nodeId);
  if (line === null) return true;
  return Number(line[1]) === parent.range.startLine;
}

function uniqueOwnerForExtensionPrefix(
  ownersByName: ReadonlyMap<string, readonly SymbolDefinition[]>,
  prefix: string,
): SymbolDefinition | undefined {
  const seen = new Set<string>();
  const matches: SymbolDefinition[] = [];
  const consider = (defs: readonly SymbolDefinition[] | undefined): void => {
    if (defs === undefined) return;
    for (const def of defs) {
      if (seen.has(def.nodeId)) continue;
      seen.add(def.nodeId);
      matches.push(def);
    }
  };
  consider(ownersByName.get(prefix));
  if (!prefix.includes('.')) {
    for (const [qn, defs] of ownersByName) {
      if (qn !== prefix && qn.endsWith('.' + prefix)) consider(defs);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
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
