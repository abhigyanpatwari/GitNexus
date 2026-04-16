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

1. **Ingestion** — `analyze.ts` → `runFullAnalysis` (`run-analyze.ts`) → `runPipelineFromRepo` (`pipeline.ts`). DAG of 12 phases builds a `KnowledgeGraph` in memory, then loads into LadybugDB under `.gitnexus/`. Repo registered in `~/.gitnexus/registry.json` for MCP discovery.

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
| `route_map` | API route → handler → consumer mappings |
| `tool_map` | MCP/RPC tool definitions and handlers |
| `shape_check` | Response shape vs consumer property access mismatches |
| `group_list` | List repo groups or details for one group |
| `group_query` | Cross-repo search in a group (reciprocal rank fusion) |
| `group_sync` | Rebuild group Contract Registry (`contracts.json`) |
| `group_contracts` | Inspect group contracts and cross-links |
| `group_status` | Index and Contract Registry staleness per repo in a group |

## Where to change what

| Concern | Start in |
|---------|----------|
| CLI commands/flags | `src/cli/` (`index.ts`, per-command modules) |
| Parsing/graph construction | `src/core/ingestion/pipeline-phases/` + `pipeline.ts` |
| Graph schema/DB | `src/core/lbug/` (`schema.ts`, `lbug-adapter.ts`) |
| MCP tools/resources | `src/mcp/server.ts`, `tools.ts`, `resources.ts` |
| Search ranking | `src/core/search/` (BM25, hybrid fusion) |
| Embeddings | `src/core/embeddings/` + `src/core/run-analyze.ts` |
| Wiki generation | `src/core/wiki/` |
| Language support | `src/core/ingestion/languages/` + `tree-sitter-queries.ts` + `gitnexus-shared/src/languages.ts` |
| Import resolution | `src/core/ingestion/import-processor.ts` + `model/resolution-context.ts` |
| Call resolution/MRO | `src/core/ingestion/call-processor.ts` + `model/resolve.ts` |
| Type extraction | `src/core/ingestion/type-extractors/` |
| Worker pool | `src/core/ingestion/workers/` |
| Web UI | `gitnexus-web/src/` |
| CI | `.github/workflows/*.yml`, `.github/actions/` |

> Paths above are relative to `gitnexus/` unless they start with `gitnexus-web/` or `.github/`.

---

## Pipeline Phase DAG

12 phases defined in `gitnexus/src/core/ingestion/pipeline-phases/`, each with explicit `deps` and typed output.

```
scan → structure → [markdown, cobol] → parse → [routes, tools, orm]
  → crossFile → mro → communities → processes
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
| `mro` | `mro.ts` | `crossFile`, `structure` | METHOD_OVERRIDES + METHOD_IMPLEMENTS edges |
| `communities` | `communities.ts` | `mro`, `structure` | Community nodes + MEMBER_OF edges (Leiden algorithm) |
| `processes` | `processes.ts` | `communities`, `routes`, `tools`, `structure` | Process nodes + STEP_IN_PROCESS edges |

**Non-phase files in the same directory:** `parse-impl.ts`, `cross-file-impl.ts` (implementation), `wildcard-synthesis.ts` (whole-module import expansion), `orm-extraction.ts` (sequential ORM fallback), `types.ts`, `runner.ts`, `index.ts`.

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
- **Skippable phases** — `skipGraphPhases` omits MRO/communities/processes (faster tests). `skipWorkers` forces sequential parsing.

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

## Language-agnostic graph feeding

16 languages → single unified graph. Four abstraction layers:

```
 Unified Graph Schema (44 node types, 21 relationship types)
           ↑
 Unified Resolution (3-tier name lookup + MRO walk)
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

16 providers in `languages/index.ts` via `satisfies Record<SupportedLanguages, LanguageProvider>` — missing a language is a compile error.

### Unified capture tags

Per-language tree-sitter queries use different AST node names but produce the **same semantic capture tags**: `@definition.class`, `@definition.function`, `@call.name`, `@import.source`, `@heritage.extends`. Downstream extraction needs no language branching. Defined in `tree-sitter-queries.ts`.

### Import resolution

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
1. Worker pool dispatches files (or sequential fallback via `skipWorkers`)
2. Each worker: detect language → load grammar → run queries → return unified `ParseWorkerResult`
3. Synthesize wildcard bindings (`wildcard-synthesis.ts`)
4. Resolve imports and heritage
5. Collect `BindingAccumulator` entries for cross-file propagation

Workers: `workers/worker-pool.ts`, `workers/parse-worker.ts`.

### Heritage and MRO

All languages emit unified `ExtractedHeritage` (child, parent, `EXTENDS`/`IMPLEMENTS`). MRO phase walks the heritage graph using per-language strategy:
- **`first-wins`** — Java, C#, C++, TS, Ruby, Go
- **`c3`** — Python (C3 linearization)
- **`none`** — single-inheritance languages

Unified walk: `lookupMethodByOwnerWithMRO()` in `model/resolve.ts`.

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
