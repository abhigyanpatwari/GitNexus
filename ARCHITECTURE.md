# Architecture — GitNexus

Monorepo: **CLI/MCP** (`gitnexus/`) + **browser UI** (`gitnexus-web/`).

## Repository layout

| Path | Role |
|------|------|
| `gitnexus/` | npm package `gitnexus`: CLI, MCP server (stdio), HTTP API, ingestion pipeline, LadybugDB graph, embeddings. |
| `gitnexus-web/` | Vite + React thin client: graph explorer + AI chat. All queries via `gitnexus serve` HTTP API. |
| `gitnexus-shared/` | Shared TypeScript types and constants (consumed by CLI and Web). |
| `.claude/`, `gitnexus-claude-plugin/`, `gitnexus-cursor-integration/` | Agent skills and plugin metadata. |
| `eval/` | Evaluation harnesses for benchmarking tool usage. |
| `.github/` | CI workflows + composite actions (`setup-gitnexus/`, `setup-gitnexus-web/`). |

## End-to-end flow: index → graph → tools

1. **Ingestion** — `analyze.ts` → `runFullAnalysis` (`run-analyze.ts`) → `runPipelineFromRepo` (`pipeline.ts`). DAG of 14 phases builds a `KnowledgeGraph` in memory, then loads into LadybugDB under `.gitnexus/`. Repo registered in `~/.gitnexus/registry.json` for MCP discovery.

2. **Persistence** — `repo-manager.ts` (paths, registry, KuzuDB cleanup). `lbug-adapter.ts` (graph load, queries, embedding batches).

3. **Query layer** — three interfaces to the same backend:
   - **MCP (stdio):** `mcp.ts` → `LocalBackend` → tools (`tools.ts`) + resources (`resources.ts`)
   - **HTTP bridge:** `serve.ts` → Express (`api.ts`, `mcp-http.ts`) for web UI
   - **CLI direct:** `gitnexus query|context|impact|cypher` in `tool.ts`

4. **Staleness** — `staleness.ts` compares indexed `lastCommit` to `HEAD`, surfaces hints.

## MCP tools

| Tool | Purpose |
|------|---------|
| `list_repos` | Discover indexed repos |
| `query` | Hybrid BM25 + vector search over the graph |
| `cypher` | Ad hoc Cypher against the schema |
| `context` | Callers, callees, processes for one symbol |
| `impact` | Blast radius (upstream/downstream) with risk summary |
| `detect_changes` | Map git diffs to affected symbols and processes |
| `rename` | Graph-assisted multi-file rename with `dry_run` preview |
| `api_impact` | Pre-change impact report for an API route handler |
| `trace` | Shortest directed path between two symbols (call + class-member edges); group-aware (`repo: "@<group>"`) for cross-repo traces |
| `route_map` | API route → handler → consumer mappings |
| `tool_map` | MCP/RPC tool definitions and handlers |
| `shape_check` | Response shape vs consumer property access mismatches |
| `explain` | Persisted taint findings (source→sink data flows) — needs `analyze --pdg` |
| `pdg_query` | Control/data dependence — CDG (`mode: controls`) / REACHING_DEF (`mode: flows`) — needs `analyze --pdg` |
| `group_list` | List repo groups or details for one group |
| `group_sync` | Rebuild group Contract Registry (`contracts.json`) and bridge graph |

`query`, `context`, and `impact` are group-aware: pass `repo: "@<groupName>"` (or `"@<groupName>/<memberPath>"` to scope to one member) plus optional `service: "<monorepo/path>"`. Group-mode `query` merges per-repo results via Reciprocal Rank Fusion; group-mode `impact` runs the local walk in the chosen member and fans out across boundaries via the Contract Bridge (`gitnexus/src/core/group/cross-impact.ts`). `trace` is also group-aware via `repo: "@<groupName>"` — but, unlike the others, it resolves `from`/`to` across **all** members (a `@<groupName>/<memberPath>` suffix is advisory for trace, not a scope); pass `from_uid`/`to_uid` to disambiguate a symbol name that occurs in more than one member.

Group-mode `trace` (`gitnexus/src/core/group/cross-trace.ts`) stitches a path that crosses repositories: it resolves `from`/`to` across all members, and when they live in different repos it joins the home-repo segment to the target-repo segment over a single `ContractLink` boundary (an HTTP consumer→provider link, joined on `Contract.symbolUid`), reported as a `CONTRACT_LINK` hop in `crossings[]`. The crossing is clamped to one boundary (`MAX_SUPPORTED_CROSS_DEPTH`, shared with cross-impact); deeper `crossDepth` is reported via `notes[]`. With `pdg: true` (experimental, opt-in), each boundary-adjacent segment is enriched with its intra-procedural REACHING_DEF data-flow when that repo was indexed with `--pdg` (reusing the same anchored `flows` query as `pdg_query`); data flow never crosses the repo boundary, and a missing PDG layer degrades to call-level hops with a note. Two stores meet only at the `symbolUid` grain — the per-repo PDG/call graph and the group bridge — so this is the documented join; full cross-program (SDG-like) data flow across the boundary remains deferred (see `docs/plans/2026-06-18-002-feat-unified-pdg-impact-evaluation-plan.md`). The previously-planned `group_query`, `group_context`, `group_impact`, `group_contracts`, `group_status` MCP tools are intentionally not introduced — group-level state is exposed via resources instead:

| Resource URI | Purpose |
|--------------|---------|
| `gitnexus://group/{name}/contracts` | Contract Registry (provider/consumer rows + cross-links) |
| `gitnexus://group/{name}/status` | Per-member index + Contract Registry staleness |

## Where to change what

| Concern | Start in |
|---------|----------|
| CLI commands/flags | `src/cli/` (`index.ts`, per-command modules) |
| Parsing/graph construction | `src/core/ingestion/pipeline-phases/` + `pipeline.ts` |
| Graph schema/DB | `src/core/lbug/` (`schema.ts`, `lbug-adapter.ts`) |
| MCP tools/resources | `src/mcp/server.ts`, `tools.ts`, `resources.ts` |
| Cross-repo groups (sync, contracts, `@<group>` routing) | `src/core/group/` (`service.ts`, `cross-impact.ts`, `sync.ts`, `bridge-db.ts`) |
| Search ranking | `src/core/search/` (BM25, hybrid fusion) |
| Embeddings | `src/core/embeddings/` + `src/core/run-analyze.ts` |
| Wiki generation | `src/core/wiki/` |
| Language support | `src/core/ingestion/languages/` + `tree-sitter-queries.ts` + `gitnexus-shared/src/languages.ts` |
| Import resolution | `src/core/ingestion/import-processor.ts` + `import-resolvers/configs/` + `model/resolution-context.ts` |
| Call resolution/inheritance/MRO | `src/core/ingestion/scope-resolution/` (pipeline, passes, graph-bridge) |
| Type extraction | `src/core/ingestion/type-extractors/` |
| Worker pool | `src/core/ingestion/workers/` |
| Web UI | `gitnexus-web/src/` |
| CI | `.github/workflows/*.yml`, `.github/actions/` |

> Paths above are relative to `gitnexus/` unless they start with `gitnexus-web/` or `.github/`.

---

## Pipeline Phase DAG

14 phases defined in `gitnexus/src/core/ingestion/pipeline-phases/`, each with explicit `deps` and typed output.

```
scan → structure → [markdown, cobol] → parse → [routes, tools, orm]
  → crossFile → scopeResolution → pruneLocalSymbols → mro → communities → processes
```

| Phase | File | Deps | Output |
|-------|------|------|--------|
| `scan` | `scan.ts` | (root) | File paths + sizes |
| `structure` | `structure.ts` | `scan` | File/Folder nodes, CONTAINS edges, `allPathSet` |
| `markdown` | `markdown.ts` | `structure` | Section nodes, cross-link edges from .md/.mdx |
| `cobol` | `cobol.ts` | `structure` | COBOL program/paragraph/section nodes (regex, no tree-sitter) |
| `parse` | `parse.ts` + `parse-impl.ts` | `structure`, `markdown`, `cobol` | Symbol nodes, IMPORTS/CALLS/EXTENDS edges, extracted routes/tools/ORM queries |
| `routes` | `routes.ts` | `parse` | Route nodes + HANDLES_ROUTE edges (Next.js, Expo, PHP, decorators) |
| `tools` | `tools.ts` | `parse` | Tool nodes + HANDLES_TOOL edges |
| `orm` | `orm.ts` | `parse` | QUERIES edges (Prisma, Supabase) |
| `crossFile` | `cross-file.ts` + `cross-file-impl.ts` | `parse`, `routes`, `tools`, `orm` | Cross-file type propagation in topological import order |
| `scopeResolution` | `scope-resolution/pipeline/phase.ts` | `parse`, `crossFile`, `structure` | Binding/reference + inheritance edges; disposes BindingAccumulator |
| `pruneLocalSymbols` | `prune-local-symbols.ts` | `scopeResolution` | Drops inert block-local `Const`/`Variable`/`Static` nodes (only a `File→DEFINES` edge) post-resolution |
| `mro` | `mro.ts` | `crossFile`, `scopeResolution`, `pruneLocalSymbols`, `structure` | METHOD_OVERRIDES + METHOD_IMPLEMENTS edges |
| `communities` | `communities.ts` | `mro`, `pruneLocalSymbols`, `structure` | Community nodes + MEMBER_OF edges (Leiden algorithm) |
| `processes` | `processes.ts` | `communities`, `routes`, `tools`, `pruneLocalSymbols`, `structure` | Process nodes + STEP_IN_PROCESS edges |

**Non-phase files in the same directory:** `parse-impl.ts`, `cross-file-impl.ts` (implementation), `wildcard-synthesis.ts` (whole-module import expansion), `types.ts`, `runner.ts`, `index.ts`.

### DAG runner

`runner.ts` — static phase graph, no plugins, compile-time type safety.

1. **Validation** — Kahn's topological sort. Rejects on: duplicate names, missing deps, cycles (DFS traces the concrete cycle path, e.g., `A -> B -> C -> A`, plus count of transitively blocked dependents).

2. **Execution** — sequential in topological order. Each phase receives:
   - `ctx: PipelineContext` — shared mutable `KnowledgeGraph`, `repoPath`, progress callback, options
   - `deps: ReadonlyMap<string, PhaseResult>` — **declared deps only** (runner filters the results map to prevent hidden coupling)

3. **Error handling** — wraps phase errors with the phase name, emits terminal `error` progress event, swallows progress handler errors to preserve the original cause.

4. **Timing** — per-phase `durationMs` in `PhaseResult`, dev-mode console logging.

**Design patterns:**
- **Single graph accumulator** — all phases mutate the same `KnowledgeGraph` in `ctx`; the graph is the primary output.
- **Typed phase access** — `getPhaseOutput<T>(deps, 'name')` for type-safe upstream results.
- **Binding accumulator lifecycle** — created in `parse`, disposed by `crossFile` (in `finally`). No other phase should take ownership.
- **Skippable phases** — `skipGraphPhases` omits MRO/communities/processes (faster tests); `pruneLocalSymbols` still runs (it is graph cleanup, not analysis). `skipWorkers` is no longer a sequential escape hatch — it (like `--workers 0` / `GITNEXUS_WORKER_POOL_SIZE=0`) is rejected with an actionable error, since the worker pool is the sole parse path (§ Chunked parse-and-resolve).
- **Local-symbol pruning** — `pruneLocalSymbols` removes inert block-local value symbols after scope resolution has consumed them. Opt out per-call with `PipelineOptions.keepLocalValueSymbols` or globally with the `GITNEXUS_KEEP_LOCAL_VALUE_SYMBOLS` env var.

### How to add a new phase

1. Create `pipeline-phases/my-phase.ts` with a `PipelinePhase<MyOutput>` (name, deps, execute)
2. Export from `pipeline-phases/index.ts`
3. Add to `buildPhaseList()` in `pipeline.ts`

```typescript
import type { PipelinePhase, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';

export interface MyPhaseOutput { /* ... */ }

export const myPhase: PipelinePhase<MyPhaseOutput> = {
  name: 'myPhase',
  deps: ['parse'],
  async execute(ctx, deps) {
    const { allPaths } = getPhaseOutput<ParseOutput>(deps, 'parse');
    // ... write to ctx.graph ...
    return { /* typed output */ };
  },
};
```

---

## Semantic model

`SemanticModel` (`gitnexus/src/core/ingestion/model/semantic-model.ts`) is the authoritative store for every symbol-indexed lookup (by `nodeId`, `simpleName`, `qualifiedName`, or `filePath`). The scope-resolution pipeline reads from here: `findOwnedMember`, `pickOverload`, and `findExportedDefByName` all consult `model.methods` / `model.fields` / `model.symbols`.

`ParsedFile` (`gitnexus-shared/src/scope-resolution/parsed-file.ts`) is the single per-file artifact the scope-resolution pipeline consumes. Scope-resolution passes MUST NOT build a parallel parse representation. If a per-language hook needs AST-level facts that `ParsedFile` doesn't expose, it should reuse the orchestrator's `treeCache` (`RunScopeResolutionInput.treeCache`) rather than re-invoking `parser.parse(...)` on its own — the C# `populateNamespaceSiblings` hook is the reference implementation of this pattern.

The scope-resolution pipeline additionally carries `WorkspaceResolutionIndex` for `Scope`-valued lookups (`classScopeByDefId`, `moduleScopeByFile`) that `SemanticModel` structurally cannot hold. No symbol-indexed duplicates exist outside `SemanticModel`.

**Write / read phase contract.** The model is mutable during three ordered phases and read-only afterward:

```
 Phase 1: parse            ──► symbolTable.add fans into types/methods/fields
 Phase 2: scope-resolution ──► reconcileOwnership() registers corrected ownerIds
 Phase 3: finalize         ──► model.attachScopeIndexes(bundle) — one-shot freeze
 ─────────────────────────── phase boundary ───────────────────────────
 Read phase: all resolution passes + MCP + HTTP + embeddings see
             SemanticModel (read-only handle); writes are type-errors.
```

`runScopeResolution` narrows `MutableSemanticModel` → `SemanticModel` at the phase boundary so downstream passes physically cannot mutate the model even accidentally.

**Reconciliation pass.** `reconcileOwnership` (`scope-resolution/pipeline/reconcile-ownership.ts`) is a shim for languages whose parse-time extractor doesn't resolve `enclosingClassId` at parse time (Python class-body methods are the canonical case). It walks `parsed.localDefs[i].ownerId` after `populateOwners` and registers any missed methods/fields into the model. Idempotent — safe to re-run, safe alongside languages whose extractor already carries `ownerId` (C#).

The architectural end state is for every language's parse-time extractor to emit the correct `ownerId` directly, making reconciliation a no-op (tracked as a follow-up refactor). The dev-mode validator `validateOwnershipParity` surfaces any drift via `onWarn` under `NODE_ENV !== 'production' && VALIDATE_SEMANTIC_MODEL !== '0'`.

References: `semantic-model.ts` file-head (full write/read contract); `contract/scope-resolver.ts` Contract Invariant I9 (scope-resolution-side rule).

---

## Scope-Resolution Pipeline (RFC #909 Ring 3)

Language-agnostic scope-resolution resolver. This is the resolution path for every language — it owns CALLS/ACCESSES/USES emission and inheritance edges. Adding a language is one interface implementation (`ScopeResolver`) plus one registration in the `SCOPE_RESOLVERS` map — no changes to shared code, no new pipeline phase. (RING4-1 #942 removed the legacy call-resolution DAG and the per-language `MIGRATED_LANGUAGES` flag, so `SCOPE_RESOLVERS` registration is all that's needed.)

### Pipeline stages

```
 ParsedFile[]  (extractParsedFile per file)
    │  finalizeScopeModel (+ provider hooks)
    ▼
 ScopeResolutionIndexes
    │  resolveReferenceSites  (via MethodRegistry.lookup)
    ▼
 ReferenceIndex
    │  emitReceiverBoundCalls  ── FIRST
    │  emitFreeCallFallback    ── THEN
    │  emitReferencesViaLookup ── LAST (uses handledSites)
    │  emitImportEdges
    ▼
 KnowledgeGraph  (IMPORTS / CALLS / ACCESSES / INHERITS / USES)
```

Orchestrator: `runScopeResolution(input, provider)` in `scope-resolution/pipeline/run.ts`.
Pipeline phase: `scopeResolutionPhase` in `scope-resolution/pipeline/phase.ts` — iterates the registered `SCOPE_RESOLVERS` over the worker-serialized `ParsedFile`s. (Per-language `emitScopeCaptures` hooks may reuse a cached Tree via the orchestrator's `treeCache`, but in worker-pool runs that cache is empty — Trees can't cross MessageChannels — so they consume the pre-extracted `ParsedFile` instead; § Performance notes.)

### Optional CFG/PDG emission (`--pdg`, #2081–#2086)

On a `--pdg` run the parse worker builds a per-function control-flow graph from the tree-sitter AST (`LanguageProvider.cfgVisitor`; TypeScript/JavaScript today) and serializes it onto `ParsedFile.cfgSideChannel` as plain data. Scope-resolution then emits the program-dependence layers from that side-channel **inside Phase 4 of `runScopeResolution`, while the disk-backed ParsedFile store is still live** — the only window where the worker-built CFGs are loaded (the store is cleared right after the phase returns). A standalone post-`mro` phase would read an empty store, so the emit deliberately lives in-phase, mirroring the `applyCaptureSideChannel` pattern. The opt-in is off by default (graph byte-identical), folded into the parse-cache key (a pdg-off warm cache is never reused on a `--pdg` run), and each layer is bounded by a per-function edge cap that logs any dropped edges. All layers are `BasicBlock → BasicBlock` edges in the single `CodeRelation` table, keyed by `type`; there is **no** `Function → BasicBlock` edge — the symbol↔block join is reconstructed from the BasicBlock id prefix + line span. The layers build on each other:

- **M1 — CFG** (#2081): `BasicBlock` nodes + `CFG` edges. Edge *kind* (`seq`/`cond-true`/`loop-back`/…) rides the `reason` column (CFG is one `CodeRelation` type, not one per kind).
- **M2 — REACHING_DEF** (#2082): GEN/KILL def→use data dependence from a pure fixpoint solver; the variable name rides `reason`.
- **M3/M4 — TAINTED / SANITIZES / TAINT_PATH** (#2083–#2084): intra- and inter-procedural taint (source→sink) — the `explain` tool's data.
- **M5 — CDG** (#2085): Ferrante control dependence over a Cooper–Harvey–Kennedy post-dominator tree (the EXIT-rooted reverse CFG); branch sense (`'T'`/`'F'`) rides `reason`. A CFG whose EXIT is unreachable from some block is skipped for CDG (post-dominance would be unsound) while its CFG/REACHING_DEF layers are kept.
- **M6 — read surface** (#2086): the `pdg_query` MCP tool answers "what gates X?" (CDG, `mode: controls`) and "where does Y flow?" (REACHING_DEF, `mode: flows`); `explain` is the taint consumer. Both are always anchored + `LIMIT`-bounded (LadybugDB has no rel-property index) and share one `resolveBlockAnchor` helper. These PDG edge types are deliberately kept out of the default `VALID_RELATION_TYPES` / web schema.
- **Cross-repo trace enrichment**: group-mode `trace` (`pdg: true`) reuses the same anchored REACHING_DEF `flows` query to annotate a boundary-adjacent segment with how a value reaches the cross-repo call — strictly intra-procedural (data flow never crosses the repo boundary). See the group-aware tools note above.

See `core/ingestion/cfg/` (emit + the pure CFG / post-dominator / control-dependence / reaching-defs / taint passes) and `mcp/local/local-backend.ts` (`_pdgQueryImpl`, `_explainImpl`, the shared `resolveBlockAnchor`).

### `ScopeResolver` contract

Single interface a language implements to plug into the pipeline. Contract fully documented in `scope-resolution/contract/scope-resolver.ts`.

| Hook | Purpose |
|------|---------|
| `languageProvider` | Base `LanguageProvider` (tree-sitter query, `emitScopeCaptures`, import/binding interpreters, hooks) |
| `populateOwners(parsed)` | Fill deferred `ownerId` fields on method defs (captures can't always know the owning class at parse time) |
| `buildMro(graph, parsed, nodeLookup)` | Produce `mroByClassDefId: Map<DefId, DefId[]>` — C3, Ruby-mixin, or first-wins per language |
| `resolveImportTarget(target, fromFile, allFiles)` | `(rawImportPath, sourceFile) → targetFilePath` (PEP-328 for Python, etc.) |
| `mergeBindings(existing, incoming, scopeId)` | Shadowing / LEGB precedence |
| `arityCompatibility` | Provider consumed by registry during `MethodRegistry.lookup` Step 2 |
| `importEdgeReason` | Confidence-tier string for IMPORTS edge reason field |
| `propagatesReturnTypesAcrossImports?` | Opt out of cross-file return-type propagation (default on) |
| `fieldFallbackOnMethodLookup?` | Statically-typed languages turn this OFF — the heuristic over-connects (default on) |
| `unwrapCollectionAccessor?` | Property-style collection views (`data.Values` on Dictionary-like receivers) — default off |
| `collapseMemberCallsByCallerTarget?` | One CALLS edge per (caller, target) instead of per-site — default off |
| `populateNamespaceSiblings?` | Cross-file implicit visibility (compiler-implicit namespace sharing) — default off; ctx carries `treeCache` |
| `hoistTypeBindingsToModule?` | Walk up to Module scope when looking up a method's return-type typeBinding — default off; enable only when bindings are stored at module level |

### Per-language registration

1. Implement `ScopeResolver` in `languages/<lang>/scope-resolver.ts`.
2. Add entry to `SCOPE_RESOLVERS` in `scope-resolution/pipeline/registry.ts`.

CI auto-discovers the set via `tsx`. No workflow edit required.

### Code references

| Module | Purpose |
|--------|---------|
| `scope-resolution/contract/scope-resolver.ts` | `ScopeResolver` interface + shared types |
| `scope-resolution/pipeline/run.ts` | Generic orchestrator |
| `scope-resolution/pipeline/phase.ts` | Pipeline-phase wrapper (deps: `parse`, `structure`) |
| `scope-resolution/pipeline/registry.ts` | `SCOPE_RESOLVERS` map |
| `scope-resolution/passes/*.ts` | Reference-resolution passes (receiver-bound, free-call fallback, compound-receiver, MRO, cross-file return-type propagation) |
| `scope-resolution/graph-bridge/*.ts` | CLI-local translation from resolved references → `KnowledgeGraph` edges |
| `scope-resolution/scope/*.ts` | Generic scope-chain walkers + namespace targets |
| `scope-resolution/workspace-index.ts` | Build-once O(1) lookup index |
| `languages/python/index.ts` | Python `ScopeResolver` hooks + known-limitation docs |
| `languages/python/captures.ts` | `emitPythonScopeCaptures` (honors cross-phase Tree cache) |
| `languages/csharp/index.ts` | C# `ScopeResolver` hooks + known-limitation docs |
| `languages/csharp/captures.ts` | `emitCsharpScopeCaptures` (honors cross-phase Tree cache) |
| `languages/csharp/namespace-siblings.ts` | Cross-file implicit-namespace visibility hook (reads `treeCache`) |

### Performance notes

- **Cross-phase Tree cache**: the orchestrator's `treeCache` (`RunScopeResolutionInput.treeCache`) lets a scope-resolution per-language hook (`emitScopeCaptures`) reuse a tree instead of re-parsing. Workers leave it empty — Trees can't cross MessageChannels — so in normal (worker-pool) runs scope-resolution does NOT rely on it: workers serialize each file's `ParsedFile` (+ capture side-channel) and stream them in, so scope-resolution consumes the pre-extracted artifact rather than re-parsing on the main thread (§ Chunked parse-and-resolve). `PROF_SCOPE_RESOLUTION=1` emits hit/miss counters and a worker-engaged warning.
- **Typed relationship iteration**: heritage + MRO walk only the EXTENDS / IMPLEMENTS / HAS_METHOD edges via `iterRelationshipsByType`, not the full relationship map.
- **Workspace-resolution-index**: O(1) `findOwnedMember` / `findExportedDef` / `classScopeByDefId` built once per run.
- **SCC-ordered cross-file return-type propagation** (PR #1050): `propagateImportedReturnTypes` walks `indexes.sccs` in reverse-topological order (leaves first), so multi-hop alias chains like `models.User → service.user → app.user` collapse to the terminal class in a single linear pass. Within each importer, the source module's `typeBindings` is chain-followed BEFORE mirroring (so we mirror terminal types, not intermediate refs), and the importer's own `typeBindings` is chain-followed AFTER mirroring (so local `const x = importedFn()` resolves before downstream importers run). Cyclic SCCs reach a partial fixpoint within a single pass without iterating to convergence — see the `ts-circular` cross-file-binding fixture which only asserts pipeline-no-throw. PROF output (`PROF_SCOPE_RESOLUTION=1`) splits `finalize` from `propagate` so quadratic regressions in the chain-follow surface independently.

---

## Language-agnostic graph feeding

16 languages → single unified graph. Four abstraction layers:

```
 Unified Graph Schema (44 node types, 21 relationship types)
           ↑
 Scope-Resolution Pipeline (registry lookup + 3-tier import resolution + MRO)
           ↑
 Language Providers (import semantics, type config, export checker, MRO strategy)
           ↑
 Tree-Sitter Queries (per-language S-expressions, unified capture tags)
```

### Language providers

Each language implements `LanguageProvider` (`language-provider.ts`). Key fields:

| Field | Purpose |
|-------|---------|
| `id`, `extensions` | Language identity and file matching |
| `treeSitterQueries` | S-expression queries for AST extraction |
| `importSemantics` | `named` / `wildcard-leaf` / `wildcard-transitive` / `namespace` |
| `importResolver` | Language-specific path → file resolution |
| `exportChecker` | Public/exported symbol detection |
| `typeConfig` | Type annotation extraction rules |
| `mroStrategy` | `first-wins` / `c3` / `none` |
| `descriptionExtractor` | Optional hook returning a symbol's doc-comment text as its `description`; feeds the embedding metadata header so doc-only terms are semantically searchable (issue #2270). Most languages register `createLeadingDocDescriptionExtractor` (shared, language-neutral; per-language comment/wrapper config passed at the call site) |

16 providers in `languages/index.ts` via `satisfies Record<SupportedLanguages, LanguageProvider>` — missing a language is a compile error.

### Unified capture tags

Per-language tree-sitter queries use different AST node names but produce the **same semantic capture tags**: `@definition.class`, `@definition.function`, `@call.name`, `@import.source`, `@reference.inherits`. Downstream extraction needs no language branching. Defined in `tree-sitter-queries.ts`.

### Import resolution

Per-language import resolution uses the **configs + factory** pattern (like call/method/class extractors). Each language declares an `ImportResolutionConfig` in `import-resolvers/configs/`, listing an ordered chain of `ImportResolverStrategy` functions. `createImportResolver()` (in `resolver-factory.ts`) composes them: first non-null result wins. Low-level helpers shared across strategies live alongside the configs in `import-resolvers/` (e.g. `go.ts`, `rust.ts`, `python.ts`).

Unified 3-tier algorithm (`model/resolution-context.ts`), per-language `importSemantics` controls which tier activates:

| Tier | Confidence | Mechanism |
|------|-----------|-----------|
| 1 — same-file | 0.95 | Symbol table for caller's file |
| 2 — import-scoped | 0.9 | `NamedImportMap` chains (named) or all files in `importMap` (wildcard) |
| 3 — global | 0.5 | O(1) index lookups: class, impl, callable. Fallback only |

| Import strategy | Languages | Behavior |
|----------------|-----------|----------|
| `named` | TS, JS, Java, C#, Rust, PHP, Kotlin | Only explicitly imported names visible |
| `wildcard-leaf` | Go, Ruby, Swift, Dart | Whole-package import, no transitive re-exports |
| `wildcard-transitive` | C, C++ | `#include` closure chains through re-exports |
| `namespace` | Python | Module aliases resolved at call site |

### Chunked parse-and-resolve

`parse` processes files in ~20 MB byte-budget chunks to bound memory. Per chunk:
1. Worker pool dispatches files (the sole parse path — there is no sequential fallback; `skipWorkers`, `--workers 0`, and `GITNEXUS_WORKER_POOL_SIZE=0` are rejected with an actionable error)
2. Each worker: detect language → load grammar → run queries → return unified `ParseWorkerResult`
3. Synthesize wildcard bindings (`wildcard-synthesis.ts`)
4. Resolve imports
5. Collect `BindingAccumulator` entries for cross-file propagation

Inheritance edges are emitted later, by the scope-resolution phase (`preEmitInheritanceEdges` + `emitHeritageEdges`), not during `parse`.

Workers: `workers/worker-pool.ts`, `workers/parse-worker.ts`.

**Worker-serialized ParsedFiles (#2038).** To index very large repos (e.g. the Linux kernel) without OOM, the worker pool is the *sole* parse path and workers serialize each file's `ParsedFile` (plus its capture side-channel) in parallel, streaming them to scope-resolution through a disk-backed store. Scope-resolution consumes the pre-extracted artifact instead of re-parsing every file on the main thread — tree-sitter's native input buffers are not GC-reclaimable, so the former main-thread re-parse leaked native memory until the process died. Pool creation is lazy / cache-miss-gated, so a warm all-cache-hit run replays cached worker output without spawning a worker (hence `usedWorkerPool` can be false even when the repo has parseable files).

### Inheritance and MRO

Inheritance is captured by the `@reference.inherits` tag and emitted by the scope-resolution phase: `preEmitInheritanceEdges` resolves each base in scope, then `emitHeritageEdges` writes the `EXTENDS`/`IMPLEMENTS` edges. The phase then computes method resolution order via each `ScopeResolver`'s `buildMro` hook, feeding a `MethodDispatchIndex` used for owner-scoped lookups. Per-language strategy:
- **`first-wins`** — Java, C#, C++, TS, Ruby, Go
- **`c3`** — Python (C3 linearization)
- **`ruby-mixin`** — Ruby (mixin-aware linearization)
- **`none`** — single-inheritance languages

---

## Full analysis flow

`runFullAnalysis` in `run-analyze.ts` orchestrates everything around the pipeline:

```
CLI (analyze.ts) → runFullAnalysis(repoPath, options, callbacks)
  1. Early exit if lastCommit == HEAD (unless --force)     [0%]
  2. Cache existing embeddings from prior index             [0%]
  3. runPipelineFromRepo() → KnowledgeGraph                [0-60%]
  4. Clean up legacy KuzuDB files                          [60%]
  5. initLbug() → loadGraphToLbug() via CSV streaming      [60-85%]
  6. Create FTS indexes (File, Function, Class, Method...) [85-90%]
  7. Restore cached embeddings (batch insert)              [88%]
  8. Generate new embeddings if --embeddings               [90-98%]
  9. Save metadata + register repo + update .gitignore     [98-100%]
 10. Generate AI context files (AGENTS.md, CLAUDE.md)      [100%]
```

**Options:** `--force` (rebuild regardless), `--embeddings` (opt-in, skipped if >50k nodes), `--skipGit`, `--noStats`.

## Storage

```
<repo>/.gitnexus/
  ├── lbug           # LadybugDB database
  ├── lbug.wal       # Write-ahead log
  ├── lbug.lock      # Single-writer lock
  └── meta.json      # lastCommit, indexedAt, stats

~/.gitnexus/
  └── registry.json  # Global repo registry (MCP discovery)
```

Managed by `repo-manager.ts`.

## LadybugDB schema

Defined in `lbug/schema.ts`. Separate node tables per type, single `CodeRelation` table.

**Node tables:** File, Folder, Function, Class, Interface, Method, Constructor, CodeElement, Struct, Enum, Macro, Typedef, Union, Namespace, Trait, Impl, TypeAlias, Const, Static, Property, Record, Delegate, Annotation, Template, Module, Community, Process, Route, Tool, Section, Embedding.

**Relation types** (`CodeRelation.type`): CONTAINS, DEFINES, CALLS, IMPORTS, EXTENDS, IMPLEMENTS, HAS_METHOD, HAS_PROPERTY, ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, FETCHES, HANDLES_TOOL, ENTRY_POINT_OF.

**Optional `--pdg` additions** (off by default, opt-in via `gitnexus analyze --pdg`; see _Optional CFG/PDG emission_ above): a `BasicBlock` node table, plus the PDG relation types `CFG`, `REACHING_DEF`, `CDG`, `TAINTED`, `SANITIZES`, and `TAINT_PATH` on the same `CodeRelation` table. These are deliberately kept out of the default `VALID_RELATION_TYPES` / web graph schema — query them via `cypher`, `explain`, or `pdg_query`.

## Embeddings and search

**Embeddings** (`src/core/embeddings/`): Snowflake arctic-embed-xs (384D). Embeddable: File, Function, Class, Method, Interface. Incremental via SHA1 content hash. Separate `Embedding` table.

**Search** (`src/core/search/`): Hybrid BM25 + semantic vector, merged via Reciprocal Rank Fusion (K=60).

## Known limitations

### Overloaded method resolution

Node IDs use arity suffix (`#<paramCount>`): `Method:file:Class.method#1` vs `#2`.

**Same-arity disambiguation:** type-hash suffix `~type1,type2` when collision detected and type annotations present. Languages without types (Python, Ruby, JS) use arity-only. TS/JS overload signatures excluded (collapse to implementation body). See #651.

**C++ const-qualified:** `$const` suffix after type-hash when non-const collision exists: `Method:file:Container.begin#0$const`.

**Generic/template types:** type-hash uses `rawType` (full AST text including generics): `~vector<int>` vs `~vector<std::string>`.

**ID stability:** collision-only tags mean IDs change when overloads are added. `save#1` becomes `save#1~int` when `save(String)` is added.

**Variadic matching:** confidence 0.7 when one side is variadic and the other has fixed count.

**METHOD_IMPLEMENTS confidence tiering:**

| Match quality | Confidence |
|---|---|
| Exact parameter types match | 1.0 |
| Arity match, types unavailable | 1.0 |
| Variadic vs fixed | 0.7 |
| Insufficient info | 0.7 |

## Related docs

- [MIGRATION.md](MIGRATION.md) — breaking changes and migration guidance
- [RUNBOOK.md](RUNBOOK.md) — operational commands and recovery
- [GUARDRAILS.md](GUARDRAILS.md) — safety boundaries for humans and agents
- [TESTING.md](TESTING.md) — how to run tests
- `AGENTS.md` / `CLAUDE.md` — agent workflows and tool usage
