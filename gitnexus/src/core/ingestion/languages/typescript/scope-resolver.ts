/**
 * TypeScript `ScopeResolver` registered in `SCOPE_RESOLVERS` and
 * consumed by the generic `runScopeResolution` orchestrator
 * (RFC #909 Ring 3).
 *
 * Third migration after Python and C#. Follows the same minimal
 * wiring-only pattern — per-hook logic lives in the sibling modules
 * (`arity.ts`, `merge-bindings.ts`, `import-target.ts`, etc.).
 *
 * See ./index.ts for the per-module rationale and the full list of
 * known limitations. The canonical capture vocabulary is pinned in
 * ./query.ts (TYPESCRIPT_SCOPE_QUERY constant).
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { simpleKey } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { typescriptProvider } from '../typescript.js';
import { loadTsconfigPaths, type TsconfigPaths } from '../../language-config.js';
import { buildSuffixIndex, type SuffixIndex } from '../../import-resolvers/utils.js';
import {
  typescriptArityCompatibility,
  typescriptMergeBindings,
  resolveTsTarget,
  type TsResolveContext,
} from './index.js';
import { loadNuxtAutoImports, type NuxtAutoImportConfig } from './nuxt-auto-imports.js';

/** Shape the orchestrator threads in via `RunScopeResolutionInput.resolutionConfig`. */
interface TypescriptResolutionConfig {
  readonly tsconfigPaths: TsconfigPaths | null;
  /** Nuxt/Nitro auto-import map. Null for non-Nuxt projects. */
  readonly nuxtAutoImports: NuxtAutoImportConfig | null;
}

/**
 * Build a `resolveImportTarget` adapter that memoizes the workspace
 * file list, the lower-cased file list, and the per-pass `resolveCache`
 * across every import lookup in a single workspace pass. The
 * orchestrator passes the same `ReadonlySet` reference for every call
 * within a pass — we use that identity to detect when the workspace
 * changes and recompute the derived state lazily.
 *
 * Without this memoization, `resolveTsTarget` re-derived
 * `allFileList` and `normalizedFileList` (both O(N_files)) and threw
 * away the `resolveCache` on every import — O(N_files × N_imports)
 * total work for what should be O(N_files + N_imports).
 */
function makeTsResolveImportTarget(): ScopeResolver['resolveImportTarget'] {
  interface PassCache {
    readonly key: ReadonlySet<string>;
    readonly allFilePaths: Set<string>;
    readonly allFileList: readonly string[];
    readonly normalizedFileList: readonly string[];
    readonly index: SuffixIndex;
    readonly resolveCache: Map<string, string | null>;
  }
  let cached: PassCache | null = null;

  return (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    if (cached === null || cached.key !== allFilePaths) {
      const allFileList = Array.from(allFilePaths);
      const normalizedFileList = allFileList.map((f) => f.toLowerCase());
      cached = {
        key: allFilePaths,
        allFilePaths: new Set(allFilePaths),
        allFileList,
        normalizedFileList,
        index: buildSuffixIndex(normalizedFileList, allFileList),
        resolveCache: new Map(),
      };
    }

    const cfg = resolutionConfig as TypescriptResolutionConfig | undefined;
    const ws: TsResolveContext = {
      fromFile,
      allFilePaths: cached.allFilePaths,
      allFileList: cached.allFileList,
      normalizedFileList: cached.normalizedFileList,
      index: cached.index,
      resolveCache: cached.resolveCache,
      tsconfigPaths: cfg?.tsconfigPaths ?? null,
    };
    return resolveTsTarget(targetRaw, ws);
  };
}

const typescriptScopeResolver: ScopeResolver = {
  language: SupportedLanguages.TypeScript,
  languageProvider: typescriptProvider,
  importEdgeReason: 'typescript-scope: import',

  resolveImportTarget: makeTsResolveImportTarget(),

  // Threaded into `resolveImportTarget` so tsconfig path aliases
  // (`@/services/user`, `~/x`, ...) resolve through the same standard
  // resolver branch the legacy DAG uses. One I/O round-trip per
  // workspace pass; the orchestrator awaits this once.
  // `nuxtAutoImports` is null for non-Nuxt projects (no .nuxt/imports.d.ts),
  // so this adds zero overhead to ordinary TypeScript repos.
  loadResolutionConfig: async (repoPath: string) => ({
    tsconfigPaths: await loadTsconfigPaths(repoPath),
    nuxtAutoImports: await loadNuxtAutoImports(repoPath),
  }),

  // TypeScript declaration merging + LEGB: local > import > wildcard,
  // separated by declaration space (value / type / namespace). The
  // per-scope id is unused (shadowing is computed from origin + def.type),
  // so we don't need to synthesize a Scope here.
  mergeBindings: (existing, incoming) => [...typescriptMergeBindings([...existing, ...incoming])],

  // Adapter: typescriptArityCompatibility uses (def, callsite); the
  // ScopeResolver contract is (callsite, def).
  arityCompatibility: (callsite, def) => typescriptArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // TypeScript uses `super` for super-class dispatch as a plain
  // identifier or as `super()` in constructors. Match both — `super`
  // on its own (`super.foo`, `super[x]`) and `super(...)` (constructor
  // chain). This also correctly rejects identifiers that merely
  // contain the substring `super` (e.g. `superman`).
  isSuperReceiver: (text) => /^super(\s*\(|\s*\.|\s*\[|\s*$)/.test(text.trim()),

  // TypeScript is statically typed — field-fallback heuristic off
  // (the type-binding layer produces precise owner types). Return-
  // type propagation across imports on (matches the legacy DAG's
  // behavior: explicit return-type annotations flow across `export`
  // boundaries and resolve chained member calls).
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,

  // TypeScript uses `.values()` / `.keys()` method-call syntax for
  // collection views -- no property-style accessors like C#'s
  // `Dictionary<K,V>.Values`. Leave `unwrapCollectionAccessor`
  // undefined and let the regular member-call branch handle them.
  //
  // `collapseMemberCallsByCallerTarget` left undefined (= false) --
  // TypeScript legacy DAG emits one edge per call site, so
  // per-site dedup is the parity target.
  //
  // `populateNamespaceSiblings` left undefined -- TypeScript requires
  // an explicit `import` / namespace augmentation for cross-file
  // visibility; there's no implicit same-namespace sibling rule
  // like C#'s.
  //
  // `hoistTypeBindingsToModule` -- `tsBindingScopeFor` DOES hoist
  // method return-type bindings to the enclosing Module scope
  // (mirrors C#), so enable the walk-up that lets the compound-
  // receiver resolver find them.
  hoistTypeBindingsToModule: true,

  /**
   * Emit CALLS edges for Nuxt/Nitro auto-imported symbols that are used
   * without an explicit import statement.
   *
   * Nuxt makes composables and server utils available project-wide via its
   * auto-import system. Because no `import` statement exists, the standard
   * scope-resolution passes cannot create call-graph edges for these symbols.
   * This hook recovers those edges after all normal resolution has run.
   *
   * For each TypeScript file the hook:
   *   1. Builds the set of files already explicitly imported (to avoid
   *      creating duplicate edges for symbols imported conventionally).
   *   2. Scans the raw source for identifier call-patterns (`name(`) and
   *      checks each against the auto-import map.
   *   3. For each hit that is not already explicitly imported, emits a CALLS
   *      edge from the file's File node to the target function node, and an
   *      IMPORTS edge from the caller file to the source file (once per pair).
   *
   * Confidence is 0.75 (below the 0.9 used for fully resolved edges) to
   * signal that these edges are heuristic: the content scanner does not
   * filter string literals or comments.
   */
  emitPostResolutionEdges(graph, parsedFiles, nodeLookup, indexes, ctx) {
    const cfg = ctx.resolutionConfig as TypescriptResolutionConfig | undefined;
    const autoImports = cfg?.nuxtAutoImports;
    if (!autoImports || autoImports.byLocalName.size === 0) return;

    // Pre-index: localName -> entry for fast lookup during content scan.
    const { byLocalName } = autoImports;

    // Pre-build a file -> explicit-import-targets index so the per-file
    // lookup below is O(1) rather than scanning all import edges every iteration.
    const explicitImportsByFile = new Map<string, Set<string>>();
    for (const [scopeId, edges] of indexes.imports) {
      const scope = indexes.scopeTree.getScope(scopeId);
      if (!scope?.filePath) continue;
      let targets = explicitImportsByFile.get(scope.filePath);
      if (!targets) {
        targets = new Set<string>();
        explicitImportsByFile.set(scope.filePath, targets);
      }
      for (const edge of edges) {
        if (edge.targetFile !== null) targets.add(edge.targetFile);
      }
    }

    // Regex matches bare identifier call sites: word-boundary + name + "(".
    // Excludes `new X(` (constructor calls are not free-function auto-imports).
    const CALL_RE = /(?<![.\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

    for (const parsedFile of parsedFiles) {
      const { filePath } = parsedFile;
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) continue;

      const content = ctx.fileContents.get(filePath);
      if (!content) continue;

      const explicitImports = explicitImportsByFile.get(filePath) ?? new Set<string>();

      const fileId = generateId('File', filePath);
      // Track (sourceFile) pairs already handled for this caller to avoid
      // emitting duplicate IMPORTS edges and duplicate CALLS edges per symbol.
      const emittedImports = new Set<string>();
      const emittedCalls = new Set<string>();

      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(content)) !== null) {
        const localName = m[1]!;
        const entry = byLocalName.get(localName);
        if (!entry) continue;

        const { exportName, sourceFile } = entry;

        // Skip when the file already has an explicit import from this source,
        // or when the file IS the source (a file cannot auto-import itself).
        if (explicitImports.has(sourceFile) || sourceFile === filePath) continue;

        // Emit one IMPORTS edge per (caller, sourceFile) pair.
        if (!emittedImports.has(sourceFile)) {
          emittedImports.add(sourceFile);
          const targetFileId = generateId('File', sourceFile);
          if (graph.getNode(targetFileId)) {
            graph.addRelationship({
              id: generateId('IMPORTS', `${fileId}->nuxt-auto-import->${targetFileId}`),
              sourceId: fileId,
              targetId: targetFileId,
              type: 'IMPORTS',
              confidence: 0.75,
              reason: 'nuxt-auto-import-file',
            });
          }
        }

        // Emit one CALLS edge per (caller, symbol) pair.
        const callKey = `${sourceFile}::${localName}`;
        if (emittedCalls.has(callKey)) continue;
        emittedCalls.add(callKey);

        // Look up the graph node by export name first, fall back to local name.
        // The fallback handles `default as X` where the function is named X.
        const targetNodeId =
          nodeLookup.get(simpleKey(sourceFile, exportName)) ??
          (exportName !== localName ? nodeLookup.get(simpleKey(sourceFile, localName)) : undefined);

        if (!targetNodeId || !graph.getNode(targetNodeId)) continue;

        graph.addRelationship({
          id: generateId('CALLS', `${fileId}:nuxt-auto-import:${localName}->${targetNodeId}`),
          sourceId: fileId,
          targetId: targetNodeId,
          type: 'CALLS',
          confidence: 0.75,
          reason: 'nuxt-auto-import',
        });
      }
    }
  },
};

export { typescriptScopeResolver };
