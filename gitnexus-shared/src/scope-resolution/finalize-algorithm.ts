/**
 * `finalize` — cross-file finalize algorithm for the SemanticModel
 * (RFC §3.2 Phase 2; Ring 2 SHARED #915).
 *
 * Pure logic that takes per-file parse output (`ParsedImport[]` +
 * `SymbolDefinition[]`) and returns:
 *
 *   - Linked `ImportEdge[]` per module scope, with `targetModuleScope` and
 *     `targetDefId` filled where resolvable; edges that could not be
 *     resolved within the hard fixpoint cap are marked
 *     `linkStatus: 'unresolved'`.
 *   - Materialized `bindings` per module scope — local defs merged with
 *     imported / wildcard-expanded / re-exported names via the provider's
 *     `mergeBindings` precedence.
 *   - The SCC condensation of the import graph, exposed so disjoint SCCs
 *     can be processed in parallel by callers that want that.
 *
 * The algorithm is **SCC-aware**: it runs Tarjan SCC over the file-level
 * import graph, processes SCCs in reverse-topological order (leaves
 * first), and within each SCC runs a bounded fixpoint link pass capped at
 * `N = |edges in SCC|`. Cyclic imports finalize without hanging; malformed
 * inputs are bounded by the cap.
 *
 * **No language-specific logic.** Target resolution, wildcard expansion,
 * and binding precedence all go through caller-supplied hooks
 * (`resolveImportTarget`, `expandsWildcardTo`, `mergeBindings`) that
 * match the LanguageProvider surface from #911.
 *
 * **Non-binding imports rule.** `dynamic-unresolved` passes through with
 * `targetFile: null`; `dynamic-resolved` and `side-effect` resolve to
 * file-level `ImportEdge`s. None of these materialize `BindingRef`s.
 */

import type { SymbolDefinition } from './symbol-definition.js';
import type { BindingRef, ImportEdge, ParsedImport, ScopeId, WorkspaceIndex } from './types.js';

// ─── Public contracts ───────────────────────────────────────────────────────

/** Per-file input for the finalize pass. */
export interface FinalizeFile {
  readonly filePath: string;
  /** The module scope id for this file; owns the finalized imports + bindings. */
  readonly moduleScope: ScopeId;
  readonly parsedImports: readonly ParsedImport[];
  /**
   * Defs exported from this file — the "what other files can import by name"
   * surface. Typically those with `isExported: true` (the module's own
   * declarations); parsers MAY also surface re-exported names here as a
   * shortcut, but it is no longer required for correctness.
   *
   * **Multi-hop re-export contract.** `finalize` resolves an edge
   * `A → B (importedName: 'X')` by first looking up `X` in `B.localDefs`.
   * If `B` only has `export { X } from './C'` and does NOT surface `X` in
   * its own `localDefs`, `finalize` falls back to the precomputed
   * per-file re-export closure (`buildReexportClosures`), which encodes
   * every name reachable through `B`'s named and wildcard re-exports —
   * including transitively through cyclic SCCs. The lookup is O(1) and
   * inherits the upstream `targetDefId`, populating `transitiveVia` with
   * the file paths traversed to reach the leaf def.
   *
   * Surfacing re-exported names in `localDefs` is still a valid (and
   * slightly cheaper) optimization: the direct lookup short-circuits the
   * closure consult. Parsers SHOULD prefer surfacing names they can resolve
   * statically (e.g., `export { X } from './c'` when `c.ts` is parsed in
   * the same workspace), and rely on the closure for the long tail of
   * barrel patterns.
   *
   * The fixpoint does NOT mutate `localDefs` across iterations — it is
   * static input.
   */
  readonly localDefs: readonly SymbolDefinition[];
}

/** Input to `finalize`. */
export interface FinalizeInput {
  readonly files: readonly FinalizeFile[];
  /** Opaque workspace context forwarded to provider hooks. */
  readonly workspaceIndex: WorkspaceIndex;
}

/**
 * Provider-supplied hooks. Mirror the optional LanguageProvider scope-
 * resolution hooks declared in #911; `finalize` calls them pure-ly and
 * expects pure answers.
 */
export interface FinalizeHooks {
  /**
   * Resolve a raw import target to the concrete file path that owns it.
   * Return `null` when no target file is resolvable (e.g., `np.foo` when
   * `numpy` is external to the workspace).
   */
  resolveImportTarget(
    targetRaw: string,
    fromFile: string,
    workspaceIndex: WorkspaceIndex,
    parsedImport?: ParsedImport,
  ): string | readonly string[] | null;

  /**
   * Reclassify syntax that names an imported symbol as a namespace import
   * after target resolution proves the symbol is itself a module.
   */
  readonly isNamespaceImport?: (
    parsedImport: ParsedImport,
    targetFile: string,
    fromFile: string,
  ) => boolean;

  /**
   * For a wildcard `import * from M`, return the names visible in the
   * exporting module scope `M`. The finalize pass looks each name up in
   * `M`'s local defs to produce a concrete `BindingRef`; names with no
   * matching export are dropped.
   */
  expandsWildcardTo(targetModuleScope: ScopeId, workspaceIndex: WorkspaceIndex): readonly string[];

  /**
   * Does this language make two `wildcard` re-exports that both DECLARE the
   * same name AMBIGUOUS (no winner), rather than overloads or redeclarations
   * of one entity?
   *
   * True for ECMAScript modules: `export * from './a'; export * from './b'`
   * with `collide` declared in both excludes the name from the module's
   * exports, so binding either source is a guess. False (the default) for
   * languages whose wildcard import is `#include`, `require`, or a package
   * fan-out, where the same name declared in two files is an overload set
   * (C++ `write_audit(int)` / `write_audit(int, int)` across two headers), a
   * redeclaration of one function, or a per-file `init` — legal, and resolved
   * downstream by arity or by definition. Only a language that opts in has
   * its collisions refused and reported via `ambiguousWildcardExports`.
   */
  readonly wildcardCollisionIsAmbiguous?: boolean;

  /**
   * A named import / named re-export binds only to MODULE-LEVEL declarations
   * of the target file. Opt-in for languages whose `import { x }` can never
   * reach a class member: without it, a class method sharing a name with a
   * top-level value — or standing alone — wins the callable preference in
   * `findExportByName` and the import binds to a symbol the module cannot
   * export (a confident wrong edge). Languages that bind module-level members
   * by bare name (static members, module functions) leave it off.
   */
  readonly namedImportsBindTopLevelOnly?: boolean;

  /**
   * Merge `incoming` bindings into `existing` for a given name. Called
   * once per name at each scope. Typical rules:
   *   - Python: local > imported > wildcard (last-write-wins within tier).
   *   - Rust: explicit `use` > glob; `pub use` overrides.
   * Return value replaces the bucket entirely — no implicit append.
   */
  mergeBindings(
    existing: readonly BindingRef[],
    incoming: readonly BindingRef[],
    scope: ScopeId,
  ): readonly BindingRef[];
}

/** One SCC in the file-level import graph. */
export interface FinalizedScc {
  readonly files: readonly string[];
  /** True iff this SCC has ≥ 2 files OR a single file that self-imports. */
  readonly isCycle: boolean;
}

/**
 * Counters reported by `finalize`.
 *
 * **Counting granularity** — `totalEdges` is **per-generated-`ImportEdgeDraft`**,
 * which may exceed the number of `ParsedImport` records when
 * `resolveImportTarget` returns a multi-file array (e.g. Go package-scoped
 * imports fan out to every `.go` file in the target directory). A single
 * `wildcard` ParsedImport that expands to N exports also counts as one
 * linked edge here; the materialized output (`FinalizeOutput.imports`) will
 * have N edges for that input. `dynamic-unresolved` ParsedImports count as
 * linked (they pass through with no `linkStatus`), so `linkedEdges` ≠ "has a
 * BindingRef" — use the `bindings` map for that.
 *
 * In other words: `totalEdges >= input.parsedImports.length` summed
 * across files, and `linkedEdges + unresolvedEdges === totalEdges`.
 */
export interface FinalizeStats {
  readonly totalFiles: number;
  /** Total `ImportEdgeDraft` records generated (≥ ParsedImport count). */
  readonly totalEdges: number;
  /**
   * `ParsedImport`s whose finalized edge does NOT carry
   * `linkStatus: 'unresolved'`. Includes `dynamic-unresolved` pass-throughs.
   */
  readonly linkedEdges: number;
  /** `ParsedImport`s whose finalized edge carries `linkStatus: 'unresolved'`. */
  readonly unresolvedEdges: number;
  readonly sccCount: number;
  readonly largestSccSize: number;
  /**
   * Names a file re-exported through two or more `export *` sources that each
   * DECLARE the name, so the language names no winner. The finalize pass
   * refuses to bind them (they are absent from the file's re-export closure
   * AND from its wildcard-expanded module-scope bindings) instead of taking the
   * first-listed source and publishing the guess as `import-resolved`.
   * Reported so the caller can record the refusal — an importer of that name
   * stays unresolved, and the reason must be auditable rather than silent.
   */
  readonly ambiguousWildcardExports: readonly AmbiguousWildcardExport[];
}

/** One refused `export *` collision — see `FinalizeStats.ambiguousWildcardExports`. */
export interface AmbiguousWildcardExport {
  readonly filePath: string;
  readonly name: string;
  /** `nodeId`s of the colliding declarations, in `export *` declaration order. */
  readonly candidateDefIds: readonly string[];
}

export interface FinalizeOutput {
  /** Linked `ImportEdge[]` per module scope, in original input order. */
  readonly imports: ReadonlyMap<ScopeId, readonly ImportEdge[]>;
  /** Materialized bindings per module scope. */
  readonly bindings: ReadonlyMap<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>;
  /** SCCs in reverse-topological order (leaves first). */
  readonly sccs: readonly FinalizedScc[];
  readonly stats: FinalizeStats;
}

// ─── Entry point ───────────────────────────────────────────────────────────

export function finalize(input: FinalizeInput, hooks: FinalizeHooks): FinalizeOutput {
  const byFilePath = new Map<string, FinalizeFile>();
  for (const f of input.files) byFilePath.set(f.filePath, f);

  // ── Phase 0: pre-resolve raw import targets (one syscall-equivalent per
  // (file, parsedImport)). Edges with no resolvable target become
  // `linkStatus: 'unresolved'` or, for dynamic-unresolved, pass through
  // with `targetFile: null`.
  const edgeIndex = new Map<string, ImportEdgeDraft[]>(); // filePath → drafts
  let totalEdges = 0;

  for (const file of input.files) {
    const drafts: ImportEdgeDraft[] = [];
    for (const parsed of file.parsedImports) {
      const draftArray = makeEdgeDrafts(parsed, file, hooks, input.workspaceIndex);
      drafts.push(...draftArray);
      totalEdges += draftArray.length;
    }
    edgeIndex.set(file.filePath, drafts);
  }

  // ── Phase 1: build file-level import graph (only resolvable edges form
  // graph edges; unresolvable ones are terminal and contribute no
  // fixpoint obligation).
  const graph = new Map<string, Set<string>>();
  for (const file of input.files) {
    graph.set(file.filePath, new Set());
  }
  for (const [fromFile, drafts] of edgeIndex) {
    const edges = graph.get(fromFile);
    if (edges === undefined) continue;
    for (const d of drafts) {
      if (d.targetFile !== null && byFilePath.has(d.targetFile)) {
        edges.add(d.targetFile);
      }
    }
  }

  // ── Phase 2: Tarjan SCC → reverse-topological list of SCCs.
  const sccs = tarjanSccs(graph);

  // ── Phase 2.5: precompute the per-file re-export closure (iterative,
  // SCC-condensed). Eliminates the recursive crawl that the per-edge
  // `tryFinalize` call site used to do; lookups are O(1) afterwards.
  // See `buildReexportClosures` for the algorithm.
  const ambiguityByFile = collectAmbiguityByFile(
    input.files,
    byFilePath,
    edgeIndex,
    hooks.wildcardCollisionIsAmbiguous === true,
    hooks.namedImportsBindTopLevelOnly === true,
  );
  const ambiguousByFile = new Map<string, ReadonlySet<string>>();
  for (const [filePath, byName] of ambiguityByFile) {
    ambiguousByFile.set(filePath, new Set(byName.keys()));
  }
  const topLevelOnly = hooks.namedImportsBindTopLevelOnly === true;
  const reexportClosures = buildReexportClosures(
    input.files,
    byFilePath,
    edgeIndex,
    ambiguousByFile,
    topLevelOnly,
  );

  // ── Phase 3: process SCCs in reverse-topological order (leaves first).
  // Within each SCC, run a bounded fixpoint that resolves intra-SCC edges.
  // Edges leaving the SCC are already resolved (their target SCC is
  // already finalized); edges inside the SCC may need multiple passes.
  const linkedByScope = new Map<ScopeId, readonly ImportEdge[]>();
  let linkedEdges = 0;
  // Every refused wildcard name, reported from the ambiguity map rather than from
  // the edges phase 4 happens to drop: a language whose `expandsWildcardTo`
  // returns nothing (TypeScript — `export *` never binds names locally) drops
  // no expanded edge, yet its importers were refused through the closure just
  // the same, and that refusal must still be visible. Named-vs-named conflicts
  // remain refused above but are not export-star collisions in this audit.
  const ambiguousWildcardExports: AmbiguousWildcardExport[] = [];
  for (const [filePath, byName] of ambiguityByFile) {
    for (const [name, ambiguity] of byName) {
      if (ambiguity.kind !== 'wildcard') continue;
      ambiguousWildcardExports.push({ filePath, name, candidateDefIds: ambiguity.candidateDefIds });
    }
  }

  for (const scc of sccs) {
    const sccFiles = new Set(scc.files);
    const capacity = countEdgesWithin(edgeIndex, sccFiles);

    // Run the fixpoint up to `capacity` iterations. Each iteration tries to
    // resolve every still-unlinked edge in the SCC; stops early if a pass
    // makes no progress.
    let progressed = true;
    let iterations = 0;
    while (progressed && iterations < capacity) {
      progressed = false;
      iterations++;
      for (const filePath of scc.files) {
        const drafts = edgeIndex.get(filePath);
        if (drafts === undefined) continue;
        for (const draft of drafts) {
          if (draft.finalized !== null) continue;
          const finalized = tryFinalize(draft, byFilePath, reexportClosures, topLevelOnly);
          if (finalized !== null) {
            draft.finalized = finalized;
            progressed = true;
          }
        }
      }
    }

    // Any drafts still not finalized within this SCC hit the cap → unresolved.
    for (const filePath of scc.files) {
      const drafts = edgeIndex.get(filePath);
      if (drafts === undefined) continue;
      for (const draft of drafts) {
        if (draft.finalized !== null) continue;
        draft.finalized = {
          ...draft.base,
          linkStatus: 'unresolved' as const,
        };
      }
    }
  }

  // ── Phase 4: collect finalized `ImportEdge[]` per module scope, preserving
  // input order within each file, and wildcard-expand where applicable.
  for (const file of input.files) {
    const drafts = edgeIndex.get(file.filePath);
    if (drafts === undefined) continue;
    const finalized: ImportEdge[] = [];
    // Names this file's `export *` sources collide on (see
    // `collectAmbiguousWildcards`). Their expanded edges are dropped here, so
    // the file's own module scope does not bind an arbitrary winner either —
    // suppressing them only in the closure would leave this binding standing,
    // and it was this binding, not the closure, that produced the published
    // `import-resolved` guess.
    const ambiguousHere = ambiguousByFile.get(file.filePath) ?? EMPTY_NAME_SET;
    for (const d of drafts) {
      const edge = d.finalized;
      if (edge === null) {
        throw new Error(`Invariant violated: import edge was not finalized for ${file.filePath}`);
      }
      if (d.source.kind === 'wildcard' && edge.linkStatus !== 'unresolved') {
        // Produce one `wildcard-expanded` ImportEdge per exported name.
        const expanded = expandWildcard(edge, byFilePath, hooks, input.workspaceIndex);
        for (const e of expanded) {
          if (e.kind === 'wildcard-expanded' && ambiguousHere.has(e.localName)) continue;
          finalized.push(e);
        }
      } else {
        finalized.push(edge);
      }
      if (edge.linkStatus !== 'unresolved') linkedEdges++;
    }
    linkedByScope.set(file.moduleScope, Object.freeze(finalized));
  }

  // ── Phase 5: materialize module-scope bindings (local + imports + wildcards),
  // delegating precedence to `provider.mergeBindings`.
  const bindingsByScope = materializeBindings(input.files, linkedByScope, hooks);

  // ── Stats.
  const sccCount = sccs.length;
  let largestSccSize = 0;
  for (const scc of sccs) {
    if (scc.files.length > largestSccSize) largestSccSize = scc.files.length;
  }
  const stats: FinalizeStats = {
    totalFiles: input.files.length,
    totalEdges,
    linkedEdges,
    unresolvedEdges: totalEdges - linkedEdges,
    sccCount,
    largestSccSize,
    ambiguousWildcardExports: Object.freeze(ambiguousWildcardExports),
  };

  return Object.freeze({
    imports: linkedByScope,
    bindings: bindingsByScope,
    sccs,
    stats,
  });
}

// ─── Internal: edge drafting (phase 0) ──────────────────────────────────────

interface ImportEdgeDraft {
  readonly source: ParsedImport;
  readonly fromFile: string;
  readonly fromScope: ScopeId;
  readonly targetFile: string | null;
  readonly base: ImportEdge;
  finalized: ImportEdge | null;
}

function makeEdgeDrafts(
  parsed: ParsedImport,
  file: FinalizeFile,
  hooks: FinalizeHooks,
  workspace: WorkspaceIndex,
): ImportEdgeDraft[] {
  // Dynamic-unresolved passes through — no `BindingRef`, no target file.
  if (parsed.kind === 'dynamic-unresolved') {
    const base: ImportEdge = {
      localName: parsed.localName,
      targetFile: null,
      targetExportedName: '',
      kind: 'dynamic-unresolved',
    };
    return [
      {
        source: parsed,
        fromFile: file.filePath,
        fromScope: file.moduleScope,
        targetFile: null,
        base,
        finalized: base, // already fully finalized
      },
    ];
  }

  const targetFile = hooks.resolveImportTarget(
    parsed.targetRaw ?? '',
    file.filePath,
    workspace,
    parsed,
  );

  // Edge is unresolvable at the file level — mark unresolved now.
  if (targetFile === null) {
    const base: ImportEdge = {
      localName: extractLocalName(parsed),
      targetFile: null,
      targetExportedName: extractExportedName(parsed),
      kind: edgeKindFor(parsed),
      ...typeOnlyFor(parsed),
      ...runsOnlyWhenCalledFor(parsed),
      linkStatus: 'unresolved',
    };
    return [
      {
        source: parsed,
        fromFile: file.filePath,
        fromScope: file.moduleScope,
        targetFile: null,
        base,
        finalized: base,
      },
    ];
  }

  // Resolvable at the file level; intra-SCC fixpoint may still fail to fill
  // in `targetDefId` (e.g., symbol not exported from target). Side-effect
  // and resolved-dynamic imports are terminal at the file level — no
  // `targetDefId` needed since they materialize no `BindingRef`. Pre-
  // finalize them here so the fixpoint loop skips them entirely.
  // Annotated rather than inferred: `isArray`'s `arg is any[]` predicate widens
  // the true branch to a MUTABLE array, and a resolver may hand back a cached,
  // frozen candidate list (Kotlin's `dirChildren` buckets do). Only `.map` is
  // wanted here, so pinning `readonly` makes an in-place `.sort()`/`.push()` —
  // which would reorder that resolver's index for the rest of the run — a
  // compile error rather than a runtime TypeError.
  const targetFiles: readonly string[] = Array.isArray(targetFile) ? targetFile : [targetFile];
  const isFileLevelTerminal = parsed.kind === 'side-effect' || parsed.kind === 'dynamic-resolved';
  return targetFiles.map((tf) => {
    const base: ImportEdge = {
      localName: extractLocalName(parsed),
      targetFile: tf,
      targetExportedName: extractExportedName(parsed),
      kind:
        hooks.isNamespaceImport?.(parsed, tf, file.filePath) === true
          ? 'namespace'
          : edgeKindFor(parsed),
      ...typeOnlyFor(parsed),
      ...runsOnlyWhenCalledFor(parsed),
    };
    return {
      source: parsed,
      fromFile: file.filePath,
      fromScope: file.moduleScope,
      targetFile: tf,
      base,
      finalized: isFileLevelTerminal ? base : null,
    };
  });
}

function edgeKindFor(parsed: ParsedImport): ImportEdge['kind'] {
  if (parsed.kind === 'wildcard') return 'wildcard-expanded';
  return parsed.kind;
}

/**
 * Carry `ParsedImport.typeOnly` onto the edge — the erasure fact `check
 * --cycles` needs and cannot re-derive, because `kind` is identical for the
 * erased and the runtime spelling of the same import (`import type D` and
 * `import D` both arrive as `alias`).
 *
 * `'typeOnly' in parsed` rather than a switch over the erasable kinds: only
 * four variants declare the property, so `parsed.typeOnly` does not compile
 * against the whole union, and `in` narrows it without naming them. That is
 * also the safer shape — an enumeration has to be updated when a variant gains
 * the property or the fact silently stops reaching the edge, while this form
 * handles a new variant correctly whether or not it declares one.
 *
 * Returns a spreadable object rather than a `boolean` so an edge that is not
 * type-only keeps the exact property set it had before this field existed.
 * Every `finalized` edge is built by spreading `base`, so setting it here is
 * enough for all of them.
 */
function typeOnlyFor(parsed: ParsedImport): { typeOnly?: true } {
  return 'typeOnly' in parsed && parsed.typeOnly === true ? { typeOnly: true } : {};
}

/**
 * Re-carry both runtime-presence flags from an existing edge onto a derived
 * one.
 *
 * `expandWildcard` builds each `wildcard-expanded` edge from scratch rather
 * than spreading the source (three fields differ per exported name), so every
 * field it does not name is dropped. That is exactly how both flags were lost
 * once already. Naming the pair here keeps "these two travel together" in one
 * place, so a third presence flag is added in one place too.
 */
function carriedPresenceFlags(edge: Pick<ImportEdge, 'typeOnly' | 'runsOnlyWhenCalled'>): {
  typeOnly?: true;
  runsOnlyWhenCalled?: true;
} {
  return {
    ...(edge.typeOnly === true ? { typeOnly: true } : {}),
    ...(edge.runsOnlyWhenCalled === true ? { runsOnlyWhenCalled: true } : {}),
  };
}

/**
 * Carry `ParsedImport.runsOnlyWhenCalled` onto the edge — the position fact
 * `check --cycles` needs and, unlike every other property of an import, cannot
 * look up for itself.
 *
 * The scope an import was written in does not survive to here:
 * `FinalizeFile.parsedImports` is a flat per-file list, and Phase 4 publishes
 * the finalized edges under `file.moduleScope` (see `linkedByScope.set` above),
 * so the consumer's map is keyed by the Module scope for every file. Walking
 * that map's key to look for an enclosing `Function` therefore always starts —
 * and ends — at a `Module`. Only the extractor still knows, so the edge has to
 * carry what it decided.
 *
 * No `in` guard, unlike {@link typeOnlyFor}: position is a property of where
 * the statement sits, so every variant declares `runsOnlyWhenCalled` and
 * `parsed.runsOnlyWhenCalled` compiles against the whole union. A new variant
 * that omits it is a build break here, which is the right outcome.
 *
 * Returns a spreadable object rather than a `boolean` so an edge that is not
 * deferred keeps the exact property set it had before this field existed.
 */
function runsOnlyWhenCalledFor(parsed: ParsedImport): { runsOnlyWhenCalled?: true } {
  return parsed.runsOnlyWhenCalled === true ? { runsOnlyWhenCalled: true } : {};
}

function extractLocalName(parsed: ParsedImport): string {
  switch (parsed.kind) {
    case 'wildcard':
    case 'side-effect':
    case 'dynamic-resolved':
      return '';
    default:
      return parsed.localName;
  }
}

function extractExportedName(parsed: ParsedImport): string {
  switch (parsed.kind) {
    case 'named':
    case 'alias':
    case 'namespace':
    case 'reexport':
      return parsed.importedName;
    case 'wildcard':
    case 'dynamic-unresolved':
    case 'dynamic-resolved':
    case 'side-effect':
      return '';
  }
}

// ─── Internal: per-edge finalization (phase 3) ─────────────────────────────

function tryFinalize(
  draft: ImportEdgeDraft,
  byFilePath: Map<string, FinalizeFile>,
  reexportClosures: ReadonlyMap<string, FileReexportClosure>,
  topLevelOnly: boolean,
): ImportEdge | null {
  const targetFile = draft.targetFile;
  if (targetFile === null) return draft.base; // already terminal

  const targetModule = byFilePath.get(targetFile);
  if (targetModule === undefined) return draft.base; // external target — leave as-is

  // Wildcards finalize at the file level; their per-name expansion happens
  // in phase 4. At this stage we just record the target module scope.
  if (draft.source.kind === 'wildcard') {
    return {
      ...draft.base,
      targetModuleScope: targetModule.moduleScope,
    };
  }

  // Namespace imports alias the target *module*; they don't name a
  // specific export. Link the module scope unconditionally. If the target
  // also exposes a def whose simple name matches `importedName` (some
  // languages emit a synthetic module-def), pick it up as the `targetDefId`
  // so consumers can reach the module as a symbol — but its absence is not
  // a failure.
  if (draft.base.kind === 'namespace') {
    const moduleDef = findExportByName(
      targetModule.localDefs,
      extractExportedName(draft.source),
      topLevelOnly,
    );
    return {
      ...draft.base,
      targetModuleScope: targetModule.moduleScope,
      ...(moduleDef !== undefined ? { targetDefId: moduleDef.nodeId } : {}),
    };
  }

  // named / alias / reexport: look up the imported name in the target's
  // local defs. Multi-hop re-export chains settle iteratively — each hop
  // resolves once its prior hop is finalized.
  const importedName = extractExportedName(draft.source);
  const exported = findExportByName(targetModule.localDefs, importedName, topLevelOnly);

  if (exported !== undefined) {
    const transitiveVia =
      draft.source.kind === 'reexport' ? Object.freeze([targetFile]) : undefined;
    return {
      ...draft.base,
      targetModuleScope: targetModule.moduleScope,
      targetDefId: exported.nodeId,
      ...(transitiveVia !== undefined ? { transitiveVia } : {}),
    };
  }

  // Multi-hop re-export follow. Barrel modules like
  //   // models.ts
  //   export { User } from './base';
  // emit no local def for `User`; the name surfaces only via their own
  // `reexport` edge. The per-file re-export closure built in phase 2.5
  // already encodes every name reachable through that file's named and
  // wildcard re-exports — including transitively through cyclic SCCs —
  // so the lookup is O(1) and never recurses.
  const followed = lookupReexportedName(reexportClosures, targetFile, importedName);
  if (followed === null) {
    // Target resolvable but the name isn't exported — keep trying in case a
    // re-export inside the target's SCC surfaces it in a later iteration.
    return null;
  }

  // Capped here too, not just inside the closure: this is the last hop, the
  // one the emitted edge carries.
  const viaFiles = extendVia(targetFile, followed.via);
  const transitiveVia =
    draft.source.kind === 'reexport' || viaFiles.length > 1 ? viaFiles : undefined;

  return {
    ...draft.base,
    targetModuleScope: targetModule.moduleScope,
    targetDefId: followed.def.nodeId,
    ...(transitiveVia !== undefined ? { transitiveVia } : {}),
  };
}

// ─── Internal: re-export closure (phase 2.5) ───────────────────────────────

/**
 * Per-file map of `name → terminal def + via path` — i.e. every name
 * importable from this file via its named/wildcard re-export chain
 * (excluding the file's own `localDefs`, which the caller checks first
 * via `findExportByName`). `via` is the ordered list of intermediate
 * files traversed to reach the def.
 *
 * Built once per finalize pass. Lookups are O(1).
 */
type ReexportClosureEntry = { readonly def: SymbolDefinition; readonly via: readonly string[] };
type FileReexportClosure = ReadonlyMap<string, ReexportClosureEntry>;

/**
 * Build per-file re-export closures.
 *
 * **Algorithm.** Iterative SCC-condensed reverse-topological propagation,
 * structurally identical to how `finalize` itself processes the file-
 * level import graph. Replaces the legacy recursive
 * `followReexportChain` crawl with a bounded, stack-safe pass:
 *
 *   1. **Sub-graph.** Build a directed graph whose edges are `wildcard`
 *      drafts, `reexport` drafts, and `named`/`alias` drafts flagged
 *      `reexportsName` by their provider. `namespace`/`reexport-namespace`
 *      are terminal — their target def lives in `localDefs` — and are
 *      excluded on `base.kind`, after any `isNamespaceImport`
 *      reclassification.
 *
 *      The flagged-named case is what languages with no dedicated
 *      re-export form need (today: Python, whose module-level
 *      `from m import x` both binds and republishes). For those providers
 *      the sub-graph is close to the file-level named-import graph, NOT a
 *      sparse barrel graph — measured ~20× more edges on the CPython
 *      stdlib — so read every bound below with that input class in mind.
 *   2. **SCC condensation.** Run the same iterative `tarjanSccs` over
 *      the sub-graph. Output is in reverse-topological order (leaves
 *      first), so when we process an SCC every out-of-SCC neighbor
 *      already has its closure populated.
 *   3. **Per-SCC propagation.**
 *        * Acyclic singleton: one pass — read neighbors' (already
 *          fully populated) closures.
 *        * Cyclic SCC (cycle ≥ 2 files, or self-loop): bounded
 *          fixpoint inside the SCC, capped at `|SCC| + 1` iterations
 *          (each iteration propagates names one hop further around
 *          the cycle; first-wins precedence keeps the map monotone
 *          so the fixpoint converges in at most |SCC| hops).
 *
 * **Precedence semantics.**
 *   * Named re-exports take precedence over wildcards.
 *   * Within each kind, declaration order wins (first match for a
 *     given exported name is kept; later drafts skip). This is only sound
 *     where the language makes a duplicate export illegal — true for TS
 *     and Rust `kind: 'reexport'`, false for the flagged-named form, where
 *     the module namespace rebinds (last write wins) and `if`/`try` pairs
 *     execute exactly one branch. For those, an in-file collision on the
 *     same published name with two different in-workspace targets is
 *     genuinely ambiguous and is dropped instead of guessed — see
 *     `collectAmbiguousReexports`.
 *
 * **Complexity.**
 *   * Pre-pass: O(V + E_re) for SCC, plus O(|SCC| × Σ drafts) per cyclic
 *     SCC. Tree-shaped barrel graphs collapse to O(E_re) total; the
 *     flagged-named input class does not — the CPython stdlib produces 10
 *     cyclic SCCs here where TypeScript-shaped input produced none.
 *   * Per-edge lookup at finalize time: O(1). Target `localDefs` are
 *     indexed by simple name on first use (`findExportByName`), so the
 *     per-hop cost is O(1) rather than a linear scan of the target file.
 *   * `transitiveVia` preserves the exact file path chain for diagnostics
 *     and graph provenance. Building those arrays copies the inherited path,
 *     which is Θ(depth²) in a single-name chain, and Θ(|SCC|²) for a cyclic
 *     SCC whose chain tracks the cycle. `MAX_REEXPORT_DEPTH = 100` bounded
 *     this until it was removed in `fc919ad6` for shallow TypeScript
 *     barrels; **nothing bounds it now**, and the flagged-named class feeds
 *     it far deeper input. Real `__init__.py` chains measure ≤ ~6, so this
 *     is a known unenforced assumption, not a live regression.
 *   * Pathological deep chains that previously needed
 *     `MAX_REEXPORT_DEPTH=100` to bound stack growth now resolve
 *     in full and are bounded only by available memory — the
 *     iterative formulation has no call-stack ceiling.
 */
function buildReexportClosures(
  files: readonly FinalizeFile[],
  byFilePath: ReadonlyMap<string, FinalizeFile>,
  edgeIndex: ReadonlyMap<string, ImportEdgeDraft[]>,
  ambiguous: ReadonlyMap<string, ReadonlySet<string>>,
  topLevelOnly: boolean,
): ReadonlyMap<string, FileReexportClosure> {
  const closures = new Map<string, Map<string, ReexportClosureEntry>>();
  for (const file of files) closures.set(file.filePath, new Map());

  // ── Step 1: build the re-export sub-graph (only resolvable wildcard /
  // reexport / flagged-named targets contribute edges). The per-file
  // ambiguous-name sets arrive precomputed (`collectAmbiguityByFile`) because
  // phase 4 consults the same sets when it expands wildcards into module
  // scope — one source of truth for "this name has no winner".
  const subGraph = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    const drafts = edgeIndex.get(file.filePath);
    if (drafts !== undefined) {
      for (const d of drafts) {
        if (!contributesReexportEdge(d)) continue;
        if (d.targetFile === null) continue;
        if (!byFilePath.has(d.targetFile)) continue;
        targets.add(d.targetFile);
      }
    }
    subGraph.set(file.filePath, targets);
  }

  // ── Step 2: SCC over the sub-graph. Reuses the same iterative Tarjan
  // implementation that drives the file-level finalize loop, so any
  // call-stack-safety guarantees there transfer here unchanged.
  const subSccs = tarjanSccs(subGraph);

  // ── Step 3: process SCCs in reverse-topological order. Acyclic
  // singletons settle in one pass; cyclic SCCs run a bounded fixpoint.
  for (const scc of subSccs) {
    if (!scc.isCycle) {
      const filePath = scc.files[0];
      if (filePath !== undefined) {
        populateFileClosure(filePath, byFilePath, edgeIndex, closures, ambiguous, topLevelOnly);
      }
      continue;
    }
    // Cap = |SCC| + 1. With first-wins precedence each name needs at
    // most |SCC| iterations to propagate fully around the cycle; the
    // extra iteration confirms no progress and breaks the loop.
    const cap = scc.files.length + 1;
    let progressed = true;
    let iter = 0;
    while (progressed && iter < cap) {
      progressed = false;
      iter++;
      for (const filePath of scc.files) {
        if (
          populateFileClosure(filePath, byFilePath, edgeIndex, closures, ambiguous, topLevelOnly)
        ) {
          progressed = true;
        }
      }
    }
  }

  return closures;
}

/**
 * Does this import republish names from its target under the *importing* file,
 * making it an edge in the re-export sub-graph?
 *
 * `reexport` and `wildcard` are the explicit forms; `named`/`alias` drafts
 * flagged `reexportsName` cover providers whose ordinary import syntax also
 * republishes (see that field on `ParsedImport` for the contract).
 *
 * Tested on `base.kind`, not `source.kind`: `isNamespaceImport` can reclassify
 * a `named` draft to `namespace` (Python's `from . import submodule`), and a
 * namespace import aliases the target *module* — it publishes no name, so
 * admitting it would republish whatever def happens to share the module's
 * simple name.
 */
function contributesReexportEdge(draft: ImportEdgeDraft): boolean {
  if (draft.base.kind === 'namespace') return false;
  if (draft.source.kind === 'wildcard') return true;
  return isNamedReexport(draft);
}

/**
 * Named (non-wildcard) re-export. The narrowed type lets `populateFileClosure`
 * read `localName` (the name this file publishes) and `importedName` (the name
 * the target exports) without re-discriminating on `kind`.
 */
function isNamedReexport(draft: ImportEdgeDraft): draft is ImportEdgeDraft & {
  readonly source: Extract<ParsedImport, { kind: 'named' | 'alias' | 'reexport' }>;
} {
  if (draft.base.kind === 'namespace') return false;
  const source = draft.source;
  if (source.kind === 'reexport') return true;
  return (source.kind === 'named' || source.kind === 'alias') && source.reexportsName === true;
}

/**
 * Names this file publishes ambiguously, which the closure must decline to
 * answer for rather than guess at.
 *
 * Declaration-order first-wins is sound only where a duplicate export is
 * illegal — two `export { X } from …` is a TypeScript compile error, so the
 * rule never fires. The flagged-named form has no such guarantee: CPython's
 * module namespace rebinds, so
 *
 *     from .v1 import Client   # legacy, left behind
 *     from .v2 import Client   # the actual public Client
 *
 * binds `v2`, and first-wins would attribute every `from pkg import Client` in
 * the repo to the dead implementation. Last-wins is not the answer either —
 * for the equally common `try:`/`except ImportError:` and `if
 * sys.version_info` pairs exactly one branch runs, and which one is not
 * decidable here. So both directions are wrong on real code and the entry is
 * dropped: the importer stays unresolved, which is exactly the pre-#2864
 * answer, and the file-level IMPORTS edge is unaffected.
 *
 * Computed once per file from data phase 0 froze (`edgeIndex`, `targetFile`)
 * and never revised, so the closure map stays monotone and the `|SCC| + 1`
 * fixpoint cap keeps the meaning it has above. A set that could grow mid-
 * fixpoint would need retraction to propagate to files that already inherited
 * the name, and would break both.
 *
 * Only two flagged drafts resolving to two *different in-workspace files*
 * count. Duplicates of the same target are harmless, and an unresolvable
 * target (`null` — the `try: import ujson / except: import json` shape, both
 * external) never entered the closure to begin with.
 *
 * ponytail: named-vs-named only. Wildcard-vs-wildcard collisions are also
 * first-wins today, but their inherited half depends on target closures that
 * are still filling in, so detecting them needs a set that grows during the
 * fixpoint — the thing this pre-pass exists to avoid.
 */
/**
 * Per-file set of re-exported names that have NO decidable winner, from both
 * detectors: `collectAmbiguousReexports` (flagged-named vs flagged-named) and
 * `collectAmbiguousWildcards` (`export *` vs `export *`, direct declarations).
 * Fixed for the whole run; consulted by the closure fixpoint AND by phase 4's
 * wildcard expansion, so a refused name is absent from BOTH the exports an
 * importer can reach and the module-scope bindings the file itself sees.
 */
interface ReexportAmbiguity {
  readonly kind: 'named' | 'wildcard';
  readonly candidateDefIds: readonly string[];
}

function collectAmbiguityByFile(
  files: readonly FinalizeFile[],
  byFilePath: ReadonlyMap<string, FinalizeFile>,
  edgeIndex: ReadonlyMap<string, ImportEdgeDraft[]>,
  wildcardCollisionIsAmbiguous: boolean,
  topLevelOnly: boolean,
): ReadonlyMap<string, ReadonlyMap<string, ReexportAmbiguity>> {
  const out = new Map<string, ReadonlyMap<string, ReexportAmbiguity>>();
  for (const file of files) {
    const drafts = edgeIndex.get(file.filePath);
    if (drafts === undefined) continue;
    const byName = new Map<string, ReexportAmbiguity>();
    for (const name of collectAmbiguousReexports(drafts, byFilePath)) {
      byName.set(name, {
        kind: 'named',
        candidateDefIds: namedReexportCandidates(drafts, byFilePath, name, topLevelOnly),
      });
    }
    // Wildcard-vs-wildcard is a language rule (`FinalizeHooks.
    // wildcardCollisionIsAmbiguous`): ECMAScript excludes the name, C++
    // overloads it. Without the opt-in this half stays first-wins.
    if (wildcardCollisionIsAmbiguous) {
      for (const [name, ids] of collectAmbiguousWildcards(file, drafts, byFilePath)) {
        if (!byName.has(name)) byName.set(name, { kind: 'wildcard', candidateDefIds: ids });
      }
    }
    if (byName.size === 0) continue;
    out.set(file.filePath, byName);
  }
  return out;
}

/** The declarations a flagged-named collision on `localName` points at. */
function namedReexportCandidates(
  drafts: readonly ImportEdgeDraft[],
  byFilePath: ReadonlyMap<string, FinalizeFile>,
  localName: string,
  topLevelOnly: boolean,
): readonly string[] {
  const ids: string[] = [];
  for (const draft of drafts) {
    if (!isNamedReexport(draft) || draft.source.localName !== localName) continue;
    const targetFile = draft.targetFile;
    if (targetFile === null) continue;
    const target = byFilePath.get(targetFile);
    if (target === undefined) continue;
    const def = findExportByName(target.localDefs, draft.source.importedName, topLevelOnly);
    if (def !== undefined && !ids.includes(def.nodeId)) ids.push(def.nodeId);
  }
  return Object.freeze(ids);
}

/**
 * `export * from './a'; export * from './b'` where BOTH `a` and `b` declare
 * `collide`: the language names no winner (ECMAScript excludes the name from
 * the module's exports entirely; a direct `import { collide }` of it is a
 * SyntaxError-class ambiguity). First-wins here published the `a` binding as
 * `import-resolved` at full confidence — a definite target for a call that has
 * none, which is the incorrect-context-over-missing-context failure in its
 * purest form. The name is refused instead and reported.
 *
 * Decidable in this pre-pass because it reads only the targets' own
 * `localDefs` — nothing that fills in during the closure fixpoint. Collisions
 * that arrive TRANSITIVELY (two wildcards whose targets each re-export the
 * name from somewhere else) are still first-wins; detecting them needs a set
 * that grows mid-fixpoint, the thing this pre-pass exists to avoid.
 *
 * A name the file DECLARES itself, or re-exports by NAME, is excluded: an
 * explicit export shadows every `export *`, so those collisions are legal and
 * resolved by precedence, not ambiguous.
 *
 * Only MODULE-LEVEL, EXPORT-SHAPED declarations can collide. `localDefs` also
 * carries class members, properties and parameters (a `Property:value` on two
 * unrelated classes, an interface field named `move`), which no `export *`
 * publishes. Counting those produced thousands of phantom collisions on a real
 * monorepo (2,640 on grafana) and — the dangerous half — would have refused a
 * genuinely exported `move()` because some class elsewhere had a `move`
 * property. The wildcard closure loop tolerates the wider set because nobody
 * imports a property by name; a refusal cannot afford the same tolerance.
 *
 * Export evidence, when the language supplies it (`SymbolDefinition.isExported`,
 * tri-state), settles the rest: a def marked `false` is module-private and is
 * neither a provider here nor published by the closure
 * (`indexTopLevelExportsByName`), so a private `function foo` beside an exported
 * one no longer refuses the export — and, the half that matters more, cannot be
 * the first-listed winner the closure binds either. A def marked `true` counts
 * whatever its label, `Variable` included: the closure publishes a `Variable`,
 * so two sources each exporting `const alpha` are a real collision and must be
 * refused rather than first-wins.
 *
 * Without evidence (`isExported` undefined — most languages) `Variable` is
 * excluded from the COLLISION set only: the typical top-level `const` in a
 * barrel's sources is module-private (`const category = ['Axis']` in fourteen
 * option-builder files), so counting it would refuse a real exported constant
 * of the same name for nothing. Residual risk, accepted, for that evidence-free
 * case: a non-exported `function`/`class` sharing its name with an exported one
 * behind the same barrel is counted as a collision and the export is refused —
 * a missing edge, never a wrong one. `ownerId` is only set for class members, so
 * a callable nested in an object literal (`showIf: (cfg) => …` across fourteen
 * option-builder files) still counts as a provider when unmarked. Measured
 * before the export marker existed: grafana@871af0720 refuses 52 names (from
 * 2,640 before the member exclusion), discourse@3f71fa15c 5.
 */

/** Labels that are never a module export, whatever their owner. */
const NON_EXPORTABLE_MEMBER_LABELS: readonly string[] = [
  'Property',
  'Method',
  'Constructor',
  'Parameter',
  'Field',
];
/** Labels excluded from the collision set when no export evidence is present. */
const UNMARKED_NON_COLLIDING_LABELS: ReadonlySet<string> = new Set([
  ...NON_EXPORTABLE_MEMBER_LABELS,
  'Variable',
]);
/**
 * Labels a module can never export by name: class/interface members and
 * parameters. Filtered by LABEL, not `ownerId` — `ownerId` is populated in a
 * later pass and is not reliable while the closure is built.
 */
const MEMBER_LABELS: ReadonlySet<string> = new Set(NON_EXPORTABLE_MEMBER_LABELS);

/**
 * A declaration `export *` could publish, for COLLISION purposes: top-level, of
 * an exportable kind, and not marked module-private. With export evidence the
 * label rule yields to the marker (an exported `Variable` collides; a private
 * `function` does not); without it `Variable` is left out — see the header.
 */
function isWildcardPublishable(def: SymbolDefinition): boolean {
  // Explicit evidence wins over the label: a CommonJS `module.exports = {
  // alpha() {} }` member is labeled Method and IS the module's export.
  if (def.isExported === true) return true;
  if (def.isExported === false) return false;
  if (def.ownerId !== undefined) return false;
  return !UNMARKED_NON_COLLIDING_LABELS.has(def.type);
}

/**
 * Can a declaration of the barrel's OWN shadow a name its `export *` sources
 * collide on? Only a module-level binding can — ECMAScript's explicit-export
 * precedence is about the module's own exports. A class MEMBER named `clash`
 * (`export class Unrelated { clash() {} }`) is not such a binding and must not
 * switch the collision check off; it did, and a confident edge to one source's
 * `clash` was emitted where the import should have been refused.
 */
function canShadowWildcard(def: SymbolDefinition): boolean {
  if (def.isExported === true) return true;
  if (def.isExported === false) return false;
  if (def.ownerId !== undefined) return false;
  return !MEMBER_LABELS.has(def.type);
}
function collectAmbiguousWildcards(
  file: FinalizeFile,
  drafts: readonly ImportEdgeDraft[],
  byFilePath: ReadonlyMap<string, FinalizeFile>,
): ReadonlyMap<string, readonly string[]> {
  const shadowed = new Set<string>();
  for (const def of file.localDefs) {
    if (!canShadowWildcard(def)) continue;
    const name = deriveSimpleName(def);
    if (name !== null) shadowed.add(name);
  }
  for (const draft of drafts) {
    if (isNamedReexport(draft)) shadowed.add(draft.source.localName);
  }

  // name → (target file → declaring def ids), in declaration order.
  const providers = new Map<string, Map<string, string[]>>();
  for (const draft of drafts) {
    if (draft.source.kind !== 'wildcard') continue;
    const targetFile = draft.targetFile;
    if (targetFile === null) continue;
    const target = byFilePath.get(targetFile);
    if (target === undefined) continue;
    for (const def of target.localDefs) {
      if (!isWildcardPublishable(def)) continue;
      const name = deriveSimpleName(def);
      if (name === null || shadowed.has(name)) continue;
      let byTarget = providers.get(name);
      if (byTarget === undefined) {
        byTarget = new Map<string, string[]>();
        providers.set(name, byTarget);
      }
      const ids = byTarget.get(targetFile);
      if (ids === undefined) byTarget.set(targetFile, [def.nodeId]);
      else ids.push(def.nodeId);
    }
  }
  const conflicting = new Map<string, readonly string[]>();
  for (const [name, byTarget] of providers) {
    // Two DIFFERENT source files declaring the name. The same file declaring
    // it twice (overloads, a declaration merged with its namespace) is one
    // provider and not a collision.
    if (byTarget.size < 2) continue;
    conflicting.set(name, Object.freeze([...byTarget.values()].flat()));
  }
  return conflicting;
}

function collectAmbiguousReexports(
  drafts: readonly ImportEdgeDraft[],
  byFilePath: ReadonlyMap<string, FinalizeFile>,
): ReadonlySet<string> {
  const firstTarget = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const draft of drafts) {
    if (!isNamedReexport(draft)) continue;
    if (draft.source.kind === 'reexport') continue; // explicit form: duplicates are illegal upstream
    const targetFile = draft.targetFile;
    if (targetFile === null || !byFilePath.has(targetFile)) continue;
    const localName = draft.source.localName;
    const seen = firstTarget.get(localName);
    if (seen === undefined) firstTarget.set(localName, targetFile);
    else if (seen !== targetFile) conflicting.add(localName);
  }
  return conflicting;
}

/**
 * Populate one file's re-export closure for one pass. Returns `true`
 * iff the closure grew (signalling fixpoint progress to the caller).
 *
 * Walks the file's drafts in declaration order, named re-exports first
 * (precedence), then wildcards. For each draft, attempts:
 *   1. **Direct hit** — name exists in the target file's `localDefs`.
 *   2. **Inherited** — name exists in the target file's already-populated
 *      closure (which encodes the target's own re-export chain).
 *
 * `closures.get(targetFile)` may itself still be empty for in-SCC
 * targets on the first iteration; the outer fixpoint loop handles
 * that by re-invoking this function.
 */
function populateFileClosure(
  filePath: string,
  byFilePath: ReadonlyMap<string, FinalizeFile>,
  edgeIndex: ReadonlyMap<string, ImportEdgeDraft[]>,
  closures: Map<string, Map<string, ReexportClosureEntry>>,
  ambiguousByFile: ReadonlyMap<string, ReadonlySet<string>>,
  topLevelOnly: boolean,
): boolean {
  const myClosure = closures.get(filePath);
  if (myClosure === undefined) return false;
  const before = myClosure.size;
  const drafts = edgeIndex.get(filePath);
  if (drafts === undefined) return false;
  // Fixed for the whole run — see `collectAmbiguousReexports`. Consulted in
  // both loops below: suppressing only the named one would let a later
  // `import *` refill the name and reinstate an arbitrary winner.
  const ambiguous = ambiguousByFile.get(filePath) ?? EMPTY_NAME_SET;

  // Named re-exports — precedence over wildcards, declaration order
  // first-wins for duplicates of the same exported name.
  for (const draft of drafts) {
    if (!isNamedReexport(draft)) continue;
    const targetFile = draft.targetFile;
    if (targetFile === null) continue;
    const targetModule = byFilePath.get(targetFile);
    if (targetModule === undefined) continue;

    const localName = draft.source.localName;
    if (ambiguous.has(localName) || myClosure.has(localName)) continue;

    const importedName = draft.source.importedName;
    const direct = findExportByName(targetModule.localDefs, importedName, topLevelOnly);
    if (direct !== undefined) {
      myClosure.set(localName, { def: direct, via: Object.freeze([targetFile]) });
      continue;
    }
    const inherited = closures.get(targetFile)?.get(importedName);
    if (inherited !== undefined) {
      myClosure.set(localName, {
        def: inherited.def,
        via: extendVia(targetFile, inherited.via),
      });
    }
    // Else: target's closure is still empty (in-SCC, awaiting next
    // iteration). Outer loop will revisit.
  }

  // Wildcard re-exports — fan out the target's own surface (localDefs
  // + transitive closure). `myClosure.has(name)` checks below preserve
  // the named-precedence and first-wins semantics from above.
  for (const draft of drafts) {
    if (draft.source.kind !== 'wildcard') continue;
    const targetFile = draft.targetFile;
    if (targetFile === null) continue;
    const targetModule = byFilePath.get(targetFile);
    if (targetModule === undefined) continue;

    // Fan out the WINNER per name, not every def. `export const alpha = () =>
    // {}` emits both a `Variable` (the lexical declaration) and a `Function`
    // (the arrow) under the same simple name; iterating `localDefs` raw let
    // whichever came first — the `Variable` — claim the closure slot, and a
    // call bound to a value shadow emits no CALLS edge. Named re-exports
    // already go through `findExportByName`'s callable-preferred index; the
    // wildcard hop is the same lookup and must apply the same preference.
    // Measured: grafana `Button`/`clearButtonStyles` (arrow consts behind
    // `export *`) resolved 8 of 475 ledger entries before this.
    // Over TOP-LEVEL declarations only. `localDefs` also carries class members;
    // `Foo.render` (label `Method`, callable) outranked the file's real
    // `const render` in the callable-preferred index and `import { render }`
    // bound to a symbol `export *` can never publish — a confident wrong edge
    // where the value shadow used to yield none. Gated by the same hook as the
    // named-import path: only a language that opted in (ECMAScript, where
    // `export *` cannot publish a class member) narrows; every other language's
    // wildcard keeps the wide index, whose members are legitimately reachable.
    for (const [name, def] of (topLevelOnly ? indexTopLevelExportsByName : indexExportsByName)(
      targetModule.localDefs,
    )) {
      if (ambiguous.has(name) || myClosure.has(name)) continue;
      myClosure.set(name, { def, via: Object.freeze([targetFile]) });
    }
    const targetClosure = closures.get(targetFile);
    if (targetClosure !== undefined) {
      for (const [name, entry] of targetClosure) {
        if (ambiguous.has(name) || myClosure.has(name)) continue;
        myClosure.set(name, {
          def: entry.def,
          via: extendVia(targetFile, entry.via),
        });
      }
    }
  }

  return myClosure.size > before;
}

/**
 * Longest `transitiveVia` chain kept intact. Beyond this the tail is replaced
 * by {@link VIA_TRUNCATED}, so the entry still says "this came through a long
 * chain" without carrying it.
 *
 * Reinstates a bound the algorithm lost. Each hop copies the inherited path,
 * so an uncapped chain is Θ(depth²) in both time and retained memory, and
 * Θ(|SCC|²) for a cycle whose chain tracks it. `MAX_REEXPORT_DEPTH = 100`
 * covered this until `fc919ad6` removed it — correctly, for the TypeScript
 * barrels that were then the only input, which are shallow. Admitting
 * flagged-named imports changes the input class, so the bound comes back.
 *
 * 32 against a measured real-world worst case of ~6 for `__init__.py` chains:
 * five times the deepest chain anyone has, and it turns the quadratic into
 * O(depth × 32). Safe to truncate because `ImportEdge.transitiveVia` has no
 * production reader — it is diagnostic provenance, emitted and typed but not
 * consumed by graph emission (`emitImportEdges` dedups on source→target and
 * drops it).
 */
const MAX_VIA_LENGTH = 32;
const VIA_TRUNCATED = '…';

function extendVia(head: string, inherited: readonly string[]): readonly string[] {
  if (inherited.length + 1 <= MAX_VIA_LENGTH) return Object.freeze([head, ...inherited]);
  // Already truncated one hop down: re-truncating keeps the array at the cap
  // rather than growing it by one per hop, which is the whole point.
  return Object.freeze([head, ...inherited.slice(0, MAX_VIA_LENGTH - 2), VIA_TRUNCATED]);
}

/**
 * O(1) lookup into a precomputed re-export closure. Replaces the legacy
 * recursive `followReexportChain` traversal with a single map indexing.
 */
function lookupReexportedName(
  closures: ReadonlyMap<string, FileReexportClosure>,
  filePath: string,
  name: string,
): { def: SymbolDefinition; via: readonly string[] } | null {
  const closure = closures.get(filePath);
  if (closure === undefined) return null;
  const entry = closure.get(name);
  if (entry === undefined) return null;
  return { def: entry.def, via: entry.via };
}

/**
 * The "simple" (unqualified) name of a def, for import-name matching.
 *
 * Canonical source: `def.qualifiedName` — the tail after the last `.` (or
 * the whole string if no dot). Defs without a qualifiedName can't be
 * resolved by name here and return `null`; callers treat that as "name
 * not exported" and either retry in a later fixpoint iteration or mark
 * the edge unresolved.
 */
function deriveSimpleName(def: SymbolDefinition): string | null {
  const q = def.qualifiedName;
  if (q === undefined || q.length === 0) return null;
  const dot = q.lastIndexOf('.');
  return dot === -1 ? q : q.slice(dot + 1);
}

function findExportByName(
  defs: readonly SymbolDefinition[],
  name: string,
  /**
   * `true` (a `namedImportsBindTopLevelOnly` language): consult only
   * module-level declarations, so a class member can neither outrank a
   * top-level value nor bind on its own. Phase-4 wildcard expansion keeps
   * the wide index — that is the path languages use to bind members.
   */
  topLevelOnly: boolean = false,
): SymbolDefinition | undefined {
  // GENERIC RULE (applies to every language using this finalize
  // algorithm): when MULTIPLE `SymbolDefinition`s share the same simple
  // name in `localDefs`, prefer callable / type-like defs over plain
  // value defs (`Variable`, `Property`, …). The CALLER side of an
  // import almost always wants the callable, not a value shadow that
  // happens to share the name — and without a deterministic
  // preference, capture order silently decides which def the import
  // binds to.
  //
  // The single-def case is unchanged: when only one def has the name,
  // it's returned regardless of its type (the `fallback` path below).
  //
  // TypeScript is the first known language where this matters in
  // practice: `const fn = () => {}` emits BOTH a `Function` def (from
  // `@declaration.function` on the inner arrow) AND a `Variable` def
  // (from the generic `@declaration.variable` pattern matching the
  // wrapping `lexical_declaration`), and consumers of `import { fn }`
  // need to bind to the callable. Other migrated languages don't
  // currently produce dual emits of this shape, so the rule is a no-op
  // for them today; future languages get the same correctness
  // guarantee for free if they ever do.
  //
  // See `gitnexus/test/integration/resolvers/typescript-hof-callbacks.test.ts`
  // for the cross-file regression this rule prevents.
  return (topLevelOnly ? indexTopLevelExportsByName(defs) : indexExportsByName(defs)).get(name);
}

/**
 * `simple name → winning def` for one file's `localDefs`, built once and
 * memoized on the array itself.
 *
 * Every caller of `findExportByName` sits in a loop that revisits the same
 * target files: the phase-3 fixpoint rescans a target once per iteration, and
 * `populateFileClosure` scans once per admitted re-export — which for a
 * provider setting `reexportsName` is every named import in the file, where it
 * used to be zero. Keeping the scan turned that into O(edges × defs).
 *
 * Safe to key on identity because `FinalizeFile.localDefs` is documented static
 * input that the fixpoint never mutates; a `WeakMap` ties each index to its
 * array's lifetime with no cross-pass state to invalidate. Same shape as the
 * `defById` map `materializeBindings` already builds for the same reason.
 */
const EXPORTS_BY_NAME = new WeakMap<
  readonly SymbolDefinition[],
  ReadonlyMap<string, SymbolDefinition>
>();

function indexExportsByName(
  defs: readonly SymbolDefinition[],
): ReadonlyMap<string, SymbolDefinition> {
  const cached = EXPORTS_BY_NAME.get(defs);
  if (cached !== undefined) return cached;
  const index = new Map<string, SymbolDefinition>();
  for (const d of defs) {
    const name = deriveSimpleName(d);
    if (name === null) continue;
    const existing = index.get(name);
    // First match wins within a tier; a callable displaces a stored value
    // shadow but never another callable — identical to the linear scan's
    // "first callable if any, else first match".
    if (existing === undefined) index.set(name, d);
    else if (!isCallableOrTypeLike(existing.type) && isCallableOrTypeLike(d.type))
      index.set(name, d);
  }
  EXPORTS_BY_NAME.set(defs, index);
  return index;
}

/**
 * `indexExportsByName` restricted to declarations a module publishes by name:
 * members (by LABEL — `ownerId` is stamped by a later reconcile pass and is not
 * reliable while the closure is built) are skipped unless the language marked
 * them exported (a CommonJS `module.exports = { alpha() {} }` member), and so
 * is any def the language marked module-private (`isExported === false`) — a
 * function nested inside another function carries the Function label and used
 * to displace the real exported value of the same name here; a barrel cannot
 * republish what its source never exported, and binding it would put a private
 * `function foo` in front of the exported one another source provides.
 * `Variable` stays, since a barrel legitimately republishes a `const`. Same
 * memoization contract.
 */
const TOP_LEVEL_EXPORTS_BY_NAME = new WeakMap<
  readonly SymbolDefinition[],
  ReadonlyMap<string, SymbolDefinition>
>();

function indexTopLevelExportsByName(
  defs: readonly SymbolDefinition[],
): ReadonlyMap<string, SymbolDefinition> {
  const cached = TOP_LEVEL_EXPORTS_BY_NAME.get(defs);
  if (cached !== undefined) return cached;
  const index = new Map<string, SymbolDefinition>();
  for (const d of defs) {
    // Evidence over label, both ways: a marked-private def (a function nested
    // in another function carries the Function label too) is skipped, and a
    // marked-exported member (`module.exports = { alpha() {} }`) is admitted.
    if (d.isExported === false) continue;
    if (d.isExported !== true && MEMBER_LABELS.has(d.type)) continue;
    const name = deriveSimpleName(d);
    if (name === null) continue;
    const existing = index.get(name);
    if (existing === undefined) index.set(name, d);
    else if (!isCallableOrTypeLike(existing.type) && isCallableOrTypeLike(d.type))
      index.set(name, d);
  }
  TOP_LEVEL_EXPORTS_BY_NAME.set(defs, index);
  return index;
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set();

const CALLABLE_OR_TYPE_LIKE: ReadonlySet<string> = new Set([
  'Function',
  'Method',
  'Constructor',
  'Class',
  'Interface',
  'Enum',
  'Struct',
  'Union',
  'Record',
  'Trait',
  'Namespace',
  'Module',
  'TypeAlias',
  'Type',
  'Typedef',
]);

function isCallableOrTypeLike(type: string): boolean {
  return CALLABLE_OR_TYPE_LIKE.has(type);
}

function countEdgesWithin(edgeIndex: Map<string, ImportEdgeDraft[]>, files: Set<string>): number {
  let n = 0;
  for (const filePath of files) {
    const drafts = edgeIndex.get(filePath);
    if (drafts === undefined) continue;
    for (const d of drafts) {
      if (d.targetFile !== null && files.has(d.targetFile)) n++;
    }
  }
  // Guarantee at least one pass even for a trivial SCC (ensures deterministic
  // fixpoint termination even when a single-file SCC has zero intra-SCC edges
  // but still needs one settle pass).
  return Math.max(n, 1);
}

// ─── Internal: wildcard expansion (phase 4) ────────────────────────────────

function expandWildcard(
  edge: ImportEdge,
  byFilePath: Map<string, FinalizeFile>,
  hooks: FinalizeHooks,
  workspace: WorkspaceIndex,
): readonly ImportEdge[] {
  if (edge.targetModuleScope === undefined || edge.targetFile === null) {
    return [edge]; // unresolvable wildcard survives as a single unlinked edge
  }
  const target = byFilePath.get(edge.targetFile);
  if (target === undefined) return [edge];

  const names = hooks.expandsWildcardTo(edge.targetModuleScope, workspace);
  if (names.length === 0) {
    // Resolved wildcard with zero propagating names is still a real file-
    // level dependency (e.g. a C++ header that only declares classes —
    // `#include` is a valid IMPORTS edge, but unqualified-binding names
    // are correctly empty since class methods require `Class::method`).
    // Preserve the original wildcard edge so the file→file IMPORTS edge
    // survives; downstream binding materialization sees no propagated
    // names because the edge has no `targetExportedName`/`localName`.
    return [edge];
  }

  const expanded: ImportEdge[] = [];
  for (const name of names) {
    const def = findExportByName(target.localDefs, name);
    if (def === undefined) continue;
    expanded.push({
      localName: name,
      targetFile: edge.targetFile,
      targetExportedName: name,
      kind: 'wildcard-expanded',
      targetModuleScope: edge.targetModuleScope,
      targetDefId: def.nodeId,
      // Every expanded edge inherits the presence facts of the ONE statement it
      // came from. They are built fresh rather than spread from `edge` because
      // `localName`, `targetExportedName` and `targetDefId` all differ per name
      // — which is exactly how a property added to the wildcard edge upstream
      // gets silently dropped here, and how `runsOnlyWhenCalled` was.
      //
      // `runsOnlyWhenCalled`: Ruby's `def f; require './m'; end` is one
      // statement inside one method body — and every Ruby `require` is a
      // wildcard, since the required file's whole surface becomes visible — so
      // each name it brings in is bound only when `f` runs. Losing the flag
      // here re-reports the pair as an initialization dependency and
      // suppresses nothing — it INVENTS a cycle (`check --cycles`), which is
      // why this is carried and not derived.
      //
      // Ruby is the reachable spelling. Python has no function-local
      // `from x import *` — it is a SyntaxError — and Rust's `fn f() { use
      // m::*; }`, which IS legal, is not deferred at all: `use` is a
      // compile-time path alias, so the Rust provider opts out of the position
      // rule (`LanguageProvider.importsExecuteWhereWritten`).
      //
      // `typeOnly`: unreachable today and deliberately kept. No provider emits
      // a type-only wildcard — `reexport-wildcard` returns `kind: 'wildcard'`
      // with no `typeOnly` because `export type *` is unparseable by the
      // vendored grammar (documented on `ParsedImport`'s `wildcard` variant).
      // It is propagated so the day that gap closes does not silently
      // reintroduce this same defect for erasure. Do not delete it as dead
      // code; `typeOnlyFor` is the gate that decides whether it can ever be
      // set, and it is where the correspondence is enforced.
      ...carriedPresenceFlags(edge),
    });
  }
  return expanded;
}

// ─── Internal: bindings materialization (phase 5) ───────────────────────────

function materializeBindings(
  files: readonly FinalizeFile[],
  linkedByScope: ReadonlyMap<ScopeId, readonly ImportEdge[]>,
  hooks: FinalizeHooks,
): ReadonlyMap<ScopeId, ReadonlyMap<string, readonly BindingRef[]>> {
  const out = new Map<ScopeId, ReadonlyMap<string, readonly BindingRef[]>>();

  // Build a `nodeId → SymbolDefinition` index once across all files
  // (O(N_files × D_defs)) so the per-edge lookup below is O(1) instead
  // of a full linear scan. At realistic TypeScript monorepo scale
  // (~5k files × ~50 defs × ~100k linked import edges) this is the
  // difference between ~25 s and a few ms inside finalize. The map
  // is local to this pass — no cross-pass state leaks.
  const defById = new Map<string, SymbolDefinition>();
  for (const f of files) {
    for (const d of f.localDefs) defById.set(d.nodeId, d);
  }

  for (const file of files) {
    const scopeBindings = new Map<string, readonly BindingRef[]>();

    // Start with local defs as `origin: 'local'` bindings.
    for (const def of file.localDefs) {
      const name = deriveSimpleName(def);
      if (name === null) continue;
      const incoming: BindingRef[] = [{ def, origin: 'local' }];
      const existing = scopeBindings.get(name) ?? [];
      scopeBindings.set(name, hooks.mergeBindings(existing, incoming, file.moduleScope));
    }

    // Layer in finalized imports.
    const imports = linkedByScope.get(file.moduleScope) ?? [];
    for (const edge of imports) {
      if (edge.targetDefId === undefined || edge.linkStatus === 'unresolved') continue;
      const def = defById.get(edge.targetDefId);
      if (def === undefined) continue;

      const origin: BindingRef['origin'] =
        edge.kind === 'namespace'
          ? 'namespace'
          : edge.kind === 'wildcard-expanded'
            ? 'wildcard'
            : edge.kind === 'reexport'
              ? 'reexport'
              : 'import';
      const fallback = deriveSimpleName(def);
      const name = edge.localName.length > 0 ? edge.localName : fallback;
      if (name === null) continue;
      const incoming: BindingRef[] = [{ def, origin, via: edge }];
      const existing = scopeBindings.get(name) ?? [];
      scopeBindings.set(name, hooks.mergeBindings(existing, incoming, file.moduleScope));
    }

    // Freeze nested buckets for immutability.
    const frozen = new Map<string, readonly BindingRef[]>();
    for (const [name, refs] of scopeBindings) {
      frozen.set(name, Object.freeze(refs.slice()));
    }
    out.set(file.moduleScope, frozen);
  }

  return out;
}

// ─── Internal: Tarjan SCC ──────────────────────────────────────────────────

/**
 * Iterative Tarjan SCC. Returns SCCs in **reverse-topological** order
 * (leaves first — a property Tarjan gives for free, and the order
 * `finalize` wants so leaves are fully resolved before their dependents).
 */
function tarjanSccs(graph: ReadonlyMap<string, ReadonlySet<string>>): FinalizedScc[] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: FinalizedScc[] = [];
  let idx = 0;

  // Iterative DFS to avoid stack overflow on deep import chains.
  const allNodes = Array.from(graph.keys()).sort(); // deterministic order
  const iterStack: Array<{ node: string; children: Iterator<string>; entered: boolean }> = [];

  for (const root of allNodes) {
    if (index.has(root)) continue;
    iterStack.push({
      node: root,
      children: (graph.get(root) ?? new Set<string>()).values(),
      entered: false,
    });
    while (iterStack.length > 0) {
      const frame = iterStack[iterStack.length - 1];
      if (frame === undefined) break;

      if (!frame.entered) {
        frame.entered = true;
        index.set(frame.node, idx);
        lowlink.set(frame.node, idx);
        idx++;
        stack.push(frame.node);
        onStack.add(frame.node);
      }

      const nextChild = frame.children.next();
      if (nextChild.done) {
        // Post-visit: compute SCC membership if frame.node is a root.
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const scc: string[] = [];
          let selfInCycle = false;
          while (true) {
            const w = stack.pop();
            if (w === undefined) {
              throw new Error(`Invariant violated: Tarjan stack exhausted at ${frame.node}`);
            }
            onStack.delete(w);
            scc.push(w);
            // A single-file self-loop counts as a cycle.
            if (w === frame.node) {
              selfInCycle = (graph.get(w) ?? new Set()).has(w);
              break;
            }
          }
          const isCycle = scc.length > 1 || selfInCycle;
          sccs.push({ files: Object.freeze(scc), isCycle });
        }
        iterStack.pop();
        // Propagate lowlink to parent.
        if (iterStack.length > 0) {
          const parent = iterStack[iterStack.length - 1];
          if (parent !== undefined) {
            lowlink.set(
              parent.node,
              Math.min(
                requiredNumber(lowlink, parent.node, 'lowlink'),
                requiredNumber(lowlink, frame.node, 'lowlink'),
              ),
            );
          }
        }
        continue;
      }

      const child = nextChild.value;
      if (!index.has(child)) {
        iterStack.push({
          node: child,
          children: (graph.get(child) ?? new Set<string>()).values(),
          entered: false,
        });
      } else if (onStack.has(child)) {
        lowlink.set(
          frame.node,
          Math.min(
            requiredNumber(lowlink, frame.node, 'lowlink'),
            requiredNumber(index, child, 'index'),
          ),
        );
      }
    }
  }

  return sccs;
}

function requiredNumber(map: ReadonlyMap<string, number>, key: string, label: string): number {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Invariant violated: missing Tarjan ${label} for ${key}`);
  }
  return value;
}
