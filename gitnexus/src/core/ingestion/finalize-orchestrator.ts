/**
 * `finalizeScopeModel` — turn a workspace's `ParsedFile[]` into a
 * materialized `ScopeResolutionIndexes` (RFC §3.2 Phase 2; Ring 2 PKG #921).
 *
 * Thin integration glue, per issue #884's boundary: all algorithmic logic
 * lives in `gitnexus-shared` (finalize algorithm #915, the four per-file
 * indexes #913, the method-dispatch materialization #914, the scope tree
 * #912). This file does three things only:
 *
 *   1. Map `ParsedFile[]` → `FinalizeInput` and call shared `finalize()`.
 *   2. Build the four workspace-wide indexes from the union of per-file
 *      defs/scopes/modules/qualified-names.
 *   3. Bundle the results into `ScopeResolutionIndexes` for
 *      `MutableSemanticModel.attachScopeIndexes(...)`.
 *
 * ## What this module is NOT responsible for
 *
 *   - Invoking tree-sitter or running AST walks. That's the extractor (#919).
 *   - Per-language import-target resolution. Hooks are plumbed through
 *     but default to "unresolved" when no provider supplies them — the
 *     real adapters land with #922.
 *   - Populating `ReferenceIndex`. That's the resolution phase (#925).
 *   - Deciding which language uses registry-primary lookup. That's the
 *     flag reader (#924).
 *
 * ## Empty-input behavior
 *
 * When `parsedFiles` is empty (the common case today — no language has
 * migrated yet), the orchestrator produces a valid but empty bundle: all
 * indexes are zero-sized, the scope tree is empty, and
 * `finalize.stats.totalFiles === 0`. This lets downstream consumers
 * safely consult `model.scopes` without branching on presence.
 */

import type {
  BindingRef,
  FinalizeFile,
  FinalizeHooks,
  ParsedFile,
  Scope,
  ScopeId,
  SymbolDefinition,
  WorkspaceIndex,
} from 'gitnexus-shared';
import {
  buildDefIndex,
  buildMethodDispatchIndex,
  buildModuleScopeIndex,
  buildQualifiedNameIndex,
  buildScopeTree,
  finalize,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from './model/scope-resolution-indexes.js';

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Options forwarded to the orchestrator. All fields optional so callers
 * that don't yet have per-language hooks (today) get sensible defaults;
 * #922 will populate `hooks.resolveImportTarget` + friends per language.
 */
export interface FinalizeOrchestratorOptions {
  /**
   * Hooks forwarded to shared `finalize()`. Any omitted field gets a
   * no-op default: unresolved targets, empty wildcard expansion, append
   * merge for bindings.
   */
  readonly hooks?: Partial<FinalizeHooks>;
  /**
   * Opaque workspace context forwarded to hooks. `undefined` today; Ring
   * 2 PKG #922 populates this with a real cross-file index for the
   * per-language resolvers.
   */
  readonly workspaceIndex?: WorkspaceIndex;
}

/**
 * Produce a fully materialized `ScopeResolutionIndexes` from the
 * workspace's per-file artifacts.
 *
 * Pure function (given pure hooks). No I/O, no globals consulted. The
 * pipeline calls this once per ingestion run and hands the result to
 * `MutableSemanticModel.attachScopeIndexes`.
 */
export function finalizeScopeModel(
  parsedFiles: readonly ParsedFile[],
  options: FinalizeOrchestratorOptions = {},
): ScopeResolutionIndexes {
  const hooks = withDefaultHooks(options.hooks ?? {});
  const workspaceIndex: WorkspaceIndex = options.workspaceIndex ?? undefined;

  // ── Step 1: Shared finalize — runs SCC-aware cross-file link + binding
  // materialization. Returns linked imports + merged bindings per module
  // scope + SCC condensation + stats.
  const finalizeInput = {
    files: parsedFiles.map(toFinalizeFile),
    workspaceIndex,
  };
  const finalizeOut = finalize(finalizeInput, hooks);

  // ── Step 2: Workspace-wide indexes built from the per-file unions.
  // These are pure aggregations — no algorithm beyond what the builders
  // in gitnexus-shared already encapsulate (first-write-wins, qname
  // collision buckets, etc.).

  const allScopes: Scope[] = [];
  const allDefs: SymbolDefinition[] = [];
  const moduleEntries: { filePath: string; moduleScopeId: ScopeId }[] = [];
  const allReferenceSites = [] as ReturnType<typeof collectReferenceSites>;

  for (const file of parsedFiles) {
    for (const s of file.scopes) allScopes.push(s);
    for (const d of file.localDefs) allDefs.push(d);
    moduleEntries.push({ filePath: file.filePath, moduleScopeId: file.moduleScope });
  }
  // References kept out of the loop above to centralize list-init.
  allReferenceSites.push(...collectReferenceSites(parsedFiles));

  const scopeTree = buildScopeTree(allScopes);
  const defs = buildDefIndex(allDefs);
  const qualifiedNames = buildQualifiedNameIndex(allDefs);
  const moduleScopes = buildModuleScopeIndex(moduleEntries);

  // ── Step 3: MethodDispatchIndex. Today we lack per-language MRO
  // strategies wired into this orchestrator (that belongs with the
  // HeritageMap bridge, a separate piece of work). Ship an EMPTY index
  // so the bundle shape is consistent; the callbacks return `[]` for
  // every owner and `implementsOf` returns `[]`. Populating this
  // properly is tracked alongside the per-language provider hooks.
  const methodDispatch = buildMethodDispatchIndex({
    owners: [], // empty → no MRO entries; `mroFor(x)` returns the frozen empty array
    computeMro: () => [],
    implementsOf: () => [],
  });

  return {
    scopeTree,
    defs,
    qualifiedNames,
    moduleScopes,
    methodDispatch,
    imports: finalizeOut.imports,
    bindings: finalizeOut.bindings,
    referenceSites: Object.freeze([...allReferenceSites]),
    sccs: finalizeOut.sccs,
    stats: finalizeOut.stats,
  };
}

// ─── Internal ───────────────────────────────────────────────────────────────

/** Shape-reduce a `ParsedFile` to the narrower `FinalizeFile` the shared
 *  algorithm reads. The subset is stable — `FinalizeFile` is a proper
 *  subset of `ParsedFile`. */
function toFinalizeFile(file: ParsedFile): FinalizeFile {
  return {
    filePath: file.filePath,
    moduleScope: file.moduleScope,
    parsedImports: file.parsedImports,
    localDefs: file.localDefs,
  };
}

/** Flatten every file's reference sites into one list. Order reflects
 *  input-file order, then capture order inside each file. Deterministic. */
function collectReferenceSites(parsedFiles: readonly ParsedFile[]) {
  const out: ParsedFile['referenceSites'][number][] = [];
  for (const file of parsedFiles) {
    for (const site of file.referenceSites) out.push(site);
  }
  return out;
}

/**
 * Fill in no-op defaults for any omitted hook. Keeps `finalize()`
 * behavior well-defined for the zero-provider case today:
 *
 *   - `resolveImportTarget: () => null` — every import edge ends up
 *     `linkStatus: 'unresolved'` (or dynamic-unresolved pass-through).
 *   - `expandsWildcardTo: () => []` — wildcards don't materialize.
 *   - `mergeBindings: (existing, incoming) => [...existing, ...incoming]`
 *     — append without precedence; providers override to implement local-
 *     shadows-import and similar rules.
 */
function withDefaultHooks(partial: Partial<FinalizeHooks>): FinalizeHooks {
  return {
    resolveImportTarget: partial.resolveImportTarget ?? (() => null),
    expandsWildcardTo: partial.expandsWildcardTo ?? (() => []),
    mergeBindings:
      partial.mergeBindings ??
      ((
        existing: readonly BindingRef[],
        incoming: readonly BindingRef[],
      ): readonly BindingRef[] => [...existing, ...incoming]),
  };
}
