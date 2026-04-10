/**
 * BindingAccumulator — read-append-only accumulator that collects TypeEnv
 * bindings across files in the GitNexus analyzer pipeline.
 *
 * **Current behavior (both execution paths):** The accumulator carries only
 * file-scope (`scope = ''`) entries. Function-scope bindings are stripped
 * at both write sites:
 *
 * - **Worker path**: `parse-worker.ts` serializes only
 *   `typeEnv.fileScope()` entries across the IPC boundary.
 * - **Sequential path**: `type-env.ts::flush()` iterates only the FILE_SCOPE
 *   entry of the env map and writes `BindingEntry` records with
 *   `scope: ''` hardcoded.
 *
 * The narrowing exists because function-scope bindings have zero downstream
 * consumers today and were previously costing ~4.9 MB of heap + IPC on
 * every pipeline run. See `type-env.ts::flush()` and the `FileScopeBindings`
 * JSDoc in `parse-worker.ts` for the paired Phase 9 reversion checklist.
 *
 * **Historical quality asymmetry (Phase 9 consideration):** Even though
 * both paths now carry only file-scope data, the two paths were built
 * under different resolution capabilities, and a future Phase 9 reverter
 * that widens them back to all scopes will inherit that asymmetry:
 *
 * - **Sequential path** had (and would regain) access to the full
 *   `SymbolTable` and `importedBindings`, so its bindings benefit from
 *   Tier 2 cross-file propagation.
 * - **Worker path** runs without `SymbolTable` / `importedBindings` and
 *   can only produce Tier 0 (annotation-declared) and local Tier 1
 *   (same-file constructor inference) bindings.
 *
 * Phase 9 consumers that trust every entry equally will silently produce
 * worse results for large repos (worker-dominant) than small ones
 * (sequential-dominant). If Phase 9 needs homogeneous quality, either
 * (a) tag entries with their tier at insert time so consumers can filter,
 * or (b) post-process worker-path entries through a follow-up resolution
 * pass after the main-thread `SymbolTable` is complete.
 *
 * **Lifecycle contract**: `append → finalize → consume → dispose`. See
 * `finalize()` and `dispose()` for the state machine. Disposal is
 * orthogonal to finalization: either order is legal.
 */

export interface BindingEntry {
  readonly scope: string; // '' for file-level, 'funcName@startIndex' for function-local
  readonly varName: string;
  readonly typeName: string;
}

/**
 * Minimal graph-node shape required by `enrichExportedTypeMap()`. Intentionally
 * narrower than the full `GraphNode` type in `graph/types.ts` so tests can
 * construct a minimal mock without depending on the full graph module, and
 * so the enrichment logic is a pure function over this contract.
 *
 * Matches the shape of the real `KnowledgeGraph` node's `properties.isExported`
 * access path — tests that use a different shape silently pass while
 * production fails.
 */
export interface EnrichmentGraphNode {
  readonly id: string;
  readonly properties?: { readonly isExported?: boolean } | undefined;
}

/**
 * Minimal graph lookup interface used by `enrichExportedTypeMap()`.
 * Consumes only the method the enrichment loop actually calls.
 */
export interface EnrichmentGraphLookup {
  getNode(id: string): EnrichmentGraphNode | undefined;
}

/**
 * Merge file-scope bindings from a (finalized) `BindingAccumulator` into an
 * `exportedTypeMap` for symbols whose graph nodes are marked as exported.
 *
 * This is the single source of truth for the worker-path ExportedTypeMap
 * enrichment loop. Previously the logic lived inline in `pipeline.ts` and
 * the test suite reimplemented it as a `runEnrichmentLoop` helper — a
 * drift-prone pattern that meant tests could pass while production regressed.
 * Extracting it here makes the production code call the same function the
 * tests call.
 *
 * **Node ID candidate order**: `Function:{filePath}:{name}` →
 * `Variable:{filePath}:{name}` → `Const:{filePath}:{name}`. First match wins.
 *
 * **Tier 0 priority**: if `exportedTypeMap` already has an entry for a
 * `(filePath, name)` pair, the accumulator entry does NOT overwrite it —
 * the SymbolTable tier-0 pass is authoritative. Without this guard, a
 * worker-path binding could clobber a higher-quality type from SymbolTable.
 *
 * **Finalize precondition**: the accumulator should be finalized before
 * calling this function. The lifecycle contract is
 * `append → finalize → enrich → dispose`. Finalization is not asserted
 * here (the test suite and pipeline both honor it separately), but any
 * append happening concurrently with this enrichment would be a lifecycle
 * bug at the caller level.
 *
 * @returns The number of new entries written into `exportedTypeMap`
 *          (0 on empty accumulator or when every candidate was filtered
 *          out by the export check or the Tier 0 guard).
 */
export function enrichExportedTypeMap(
  bindingAccumulator: BindingAccumulator,
  graph: EnrichmentGraphLookup,
  exportedTypeMap: Map<string, Map<string, string>>,
): number {
  if (bindingAccumulator.fileCount === 0) return 0;
  let enriched = 0;
  for (const filePath of bindingAccumulator.files()) {
    for (const [name, type] of bindingAccumulator.fileScopeEntries(filePath)) {
      // Three-candidate-ID lookup mirrors the sequential-path export check
      // in `collectExportedBindings()` (call-processor.ts).
      const functionNodeId = `Function:${filePath}:${name}`;
      const variableNodeId = `Variable:${filePath}:${name}`;
      const constNodeId = `Const:${filePath}:${name}`;
      const node =
        graph.getNode(functionNodeId) ??
        graph.getNode(variableNodeId) ??
        graph.getNode(constNodeId);
      if (!node?.properties?.isExported) continue;

      let fileExports = exportedTypeMap.get(filePath);
      if (!fileExports) {
        fileExports = new Map();
        exportedTypeMap.set(filePath, fileExports);
      }
      // Tier 0 priority: SymbolTable-populated entries are authoritative.
      if (!fileExports.has(name)) {
        fileExports.set(name, type);
        enriched++;
      }
    }
  }
  return enriched;
}

const ENTRY_OVERHEAD = 64; // bytes per entry (object overhead + property refs)
const MAP_ENTRY_OVERHEAD = 80; // bytes per file entry in the map

export class BindingAccumulator {
  // Storage is split into two parallel maps so file-scope reads are fast.
  // - _allByFile holds every BindingEntry (used by getFile, memory estimate).
  // - _fileScopeByFile is a nested Map<filePath, Map<varName, typeName>> for
  //   O(1) point-lookup via fileScopeGet(). For iteration-based consumers
  //   (enrichExportedTypeMap), fileScopeEntries() iterates the inner Map.
  //   Both maps carry the same key set modulo the `scope === ''` precondition:
  //   _allByFile has a key as soon as any entry is appended; _fileScopeByFile
  //   only has a key once a file-scope entry arrives. Code that iterates via
  //   files() uses _allByFile so files with only function-scope entries
  //   remain visible.
  //
  //   Note: Map.set semantics mean a duplicate varName for the same file
  //   overwrites the previous value (last-write-wins). This is the correct
  //   behavior — duplicate top-level bindings in the same file shouldn't
  //   happen in well-formed source, and if they do the last declaration
  //   is typically the one the compiler sees.
  private readonly _allByFile = new Map<string, BindingEntry[]>();
  private readonly _fileScopeByFile = new Map<string, Map<string, string>>();
  private _totalBindings = 0;
  private _finalized = false;
  private _disposed = false;

  /**
   * Append bindings for a file. Safe to call multiple times for the same file.
   * Throws if the accumulator has been finalized. Skips if entries is empty.
   *
   * The `entries` parameter is `readonly` — this method never mutates the
   * caller's array. Internally, the first `appendFile` call per filePath
   * makes a defensive copy (`slice()`), and subsequent calls push into the
   * accumulator's own storage.
   */
  appendFile(filePath: string, entries: readonly BindingEntry[]): void {
    if (this._finalized) {
      throw new Error(
        '[BindingAccumulator] appendFile after finalize — no further appends allowed',
      );
    }
    if (entries.length === 0) {
      return;
    }
    // Contract consistency: if this accumulator was previously disposed
    // without being finalized, `dispose()` is documented to leave it
    // "behaving like a fresh one" for subsequent appends. Clear the
    // `_disposed` flag here so the `disposed` getter tracks the actual
    // live state, not a stale signal from the prior lifecycle cycle.
    if (this._disposed) {
      this._disposed = false;
    }
    // Note on the file-scope-only invariant:
    // The accumulator does NOT reject function-scope entries at this
    // boundary. The narrowing contract is enforced by the two production
    // write sites — `parse-worker.ts` (which uses `typeEnv.fileScope()`
    // and hardcodes `scope: ''` in the pipeline adapter) and
    // `type-env.ts::flush()` (which iterates only `env.get(FILE_SCOPE)`).
    // The class JSDoc documents the invariant and the Phase 9 reversion
    // path. Making `appendFile` runtime-reject non-file-scope entries
    // would break the accumulator's own storage-split tests which
    // legitimately exercise mixed-scope entries. If a future write path
    // violates the invariant, tests should fail via missing exports in
    // the enrichment loop, not via an assertion here.
    // All-scope store.
    const existingAll = this._allByFile.get(filePath);
    if (existingAll !== undefined) {
      for (const e of entries) {
        existingAll.push(e);
      }
    } else {
      this._allByFile.set(filePath, entries.slice());
    }
    // File-scope fast-path store (nested Map for O(1) point-lookup via fileScopeGet).
    // Populated lazily on first file-scope entry per file.
    let fileScopeMap = this._fileScopeByFile.get(filePath);
    for (const e of entries) {
      if (e.scope === '') {
        if (fileScopeMap === undefined) {
          fileScopeMap = new Map();
          this._fileScopeByFile.set(filePath, fileScopeMap);
        }
        fileScopeMap.set(e.varName, e.typeName);
      }
    }
    this._totalBindings += entries.length;
  }

  /** Lock the accumulator — no further appends. Idempotent. */
  finalize(): void {
    // Dev-mode invariant: verify the parallel storage split is consistent.
    // `_fileScopeByFile` must be a proper projection of `_allByFile`
    // where the outer key is a subset and the inner entries are exactly
    // the `scope === ''` subset of `_allByFile[key]`. A drift would
    // indicate a bug in `appendFile()` where one map was updated but
    // not the other.
    if (process.env.NODE_ENV !== 'production' && !this._finalized) {
      for (const [filePath, fileScopeMap] of this._fileScopeByFile) {
        const allEntries = this._allByFile.get(filePath);
        if (allEntries === undefined) {
          throw new Error(
            `[BindingAccumulator] storage split drift: file ${filePath} has file-scope entries ` +
              `but no _allByFile entry`,
          );
        }
        // Count unique file-scope varNames in _allByFile (to match Map dedup
        // semantics in _fileScopeByFile where Map.set deduplicates same-name).
        const projectedNames = new Set(
          allEntries.filter((e) => e.scope === '').map((e) => e.varName),
        );
        if (projectedNames.size !== fileScopeMap.size) {
          throw new Error(
            `[BindingAccumulator] storage split drift: file ${filePath} has ` +
              `${fileScopeMap.size} file-scope names in Map but ${projectedNames.size} unique ` +
              `file-scope varNames in _allByFile`,
          );
        }
      }
    }
    this._finalized = true;
  }

  /**
   * Release the accumulator's heap footprint. Clears both internal storage
   * maps and resets `_totalBindings` to zero. Idempotent and orthogonal to
   * `finalize()` — calling `dispose()` does not change the finalized state.
   *
   * Post-dispose contract: all read methods return empty/undefined state
   * matching a never-appended-to accumulator. Specifically:
   *   - `fileCount === 0`
   *   - `totalBindings === 0`
   *   - `files()` yields an empty iterator
   *   - `getFile(x)` returns `undefined` for all `x`
   *   - `fileScopeEntries(x)` returns `[]` for all `x`
   *   - `estimateMemoryBytes()` returns `0`
   *
   * If `dispose()` is called **before** `finalize()`, subsequent `appendFile`
   * calls succeed — the accumulator behaves like a fresh one. If called
   * **after** `finalize()`, subsequent `appendFile` calls throw the existing
   * "finalized" error.
   *
   * Lifecycle note: the pipeline disposes the accumulator after both Phase 9
   * consumers (`processCallsFromExtracted`, `processAssignmentsFromExtracted`)
   * and the ExportedTypeMap enrichment loop have completed, so the heap is
   * released before Phase 14 (`runCrossFileBindingPropagation`) and
   * `runGraphAnalysisPhases` begin their long-running work.
   */
  dispose(): void {
    this._allByFile.clear();
    this._fileScopeByFile.clear();
    this._totalBindings = 0;
    this._disposed = true;
  }

  /** Get all bindings for a file, or undefined if the file is unknown. */
  getFile(filePath: string): readonly BindingEntry[] | undefined {
    return this._allByFile.get(filePath);
  }

  /**
   * Get only scope='' (file-level) entries as [varName, typeName] tuples.
   * For iteration-based consumers (e.g., `enrichExportedTypeMap`).
   * Returns an empty array for an unknown file.
   *
   * O(1) map lookup + O(n_file_scope) tuple reconstruction from the inner
   * Map. Does NOT walk function-scope entries.
   *
   * For point-lookup consumers (e.g., Phase 9 fallback), prefer
   * `fileScopeGet(filePath, name)` — O(1) with no allocation.
   */
  fileScopeEntries(filePath: string): readonly (readonly [string, string])[] {
    const map = this._fileScopeByFile.get(filePath);
    return map ? [...map.entries()] : [];
  }

  /**
   * O(1) point-lookup for a single file-scope binding by (filePath, name).
   * Returns the typeName if found, `undefined` otherwise.
   *
   * This is the preferred lookup path for Phase 9 consumers that resolve
   * a single callee's return type — avoids the O(n_file_scope) iteration
   * and defensive-copy allocation of `fileScopeEntries()`.
   */
  fileScopeGet(filePath: string, name: string): string | undefined {
    return this._fileScopeByFile.get(filePath)?.get(name);
  }

  /** Iterate over all file paths in insertion order. */
  files(): IterableIterator<string> {
    return this._allByFile.keys();
  }

  /** Number of distinct files with at least one binding. */
  get fileCount(): number {
    return this._allByFile.size;
  }

  /** Total number of binding entries across all files. */
  get totalBindings(): number {
    return this._totalBindings;
  }

  /** Whether the accumulator has been finalized. */
  get finalized(): boolean {
    return this._finalized;
  }

  /**
   * Whether the accumulator has been disposed. Exposed for symmetry with
   * `finalized` so debug tooling and future Phase 9 consumers can detect a
   * disposed accumulator without inspecting empty state heuristically.
   *
   * Disposal and finalization are orthogonal: a disposed accumulator may or
   * may not be finalized, and vice versa. See `dispose()` for the full
   * lifecycle contract.
   */
  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Rough memory estimate in bytes (intentionally pessimistic).
   * Formula: sum of (ENTRY_OVERHEAD + char bytes of scope+varName+typeName) per entry
   *          + MAP_ENTRY_OVERHEAD + char bytes of filePath per file.
   *
   * Note: V8 stores all-ASCII strings as Latin-1 (1 byte/char) and only upgrades
   * to UCS-2 (2 bytes/char) for non-Latin-1 code points. Source paths and type names
   * are typically all-ASCII, so actual heap cost is roughly half what this returns.
   * The pessimistic factor is intentional — better to over-budget than under-budget.
   *
   * **⚠ Cost profile**: O(totalBindings) — iterates every entry in
   * `_allByFile` and reads three string `.length` properties per entry.
   * At a typical repo scale (10k files × ~20 file-scope bindings) this is
   * ~200k property reads per call. Call at most once per pipeline run,
   * NOT per file, per chunk, or per progress tick. The current single
   * call site is the dev-mode telemetry log at the pipeline finalize
   * seam. Adding a per-file-progress caller would silently make it
   * quadratic in repo size.
   */
  estimateMemoryBytes(): number {
    let total = 0;
    for (const [filePath, entries] of this._allByFile) {
      total += MAP_ENTRY_OVERHEAD + filePath.length * 2;
      for (const e of entries) {
        total += ENTRY_OVERHEAD + (e.scope.length + e.varName.length + e.typeName.length) * 2;
      }
    }
    return total;
  }
}
