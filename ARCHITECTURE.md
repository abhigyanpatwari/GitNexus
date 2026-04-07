# Architecture — GitNexus

This repository is a **monorepo** with two main products: the **CLI / MCP package** (`gitnexus/`) and the **browser UI** (`gitnexus-web/`). Supporting folders ship editor integrations and plugins without changing the core graph engine.

## Repository layout

| Path | Role |
|------|------|
| `gitnexus/` | Published npm package `gitnexus`: CLI, MCP server (stdio), local HTTP API for bridge mode, ingestion pipeline, LadybugDB graph, embeddings (optional). |
| `gitnexus-web/` | Vite + React UI: in-browser indexing (WASM), graph visualization, optional connection to `gitnexus serve`. |
| `.claude/`, `gitnexus-claude-plugin/`, `gitnexus-cursor-integration/` | Packaged **skills** and plugin metadata so agents discover the same workflows as documented in `AGENTS.md`. |
| `eval/` | Evaluation harnesses and docs for benchmarking tool usage. |
| `.github/` | CI workflows (quality, unit, integration, E2E) and composite actions. |

## End-to-end flow: index → graph → tools

1. **Ingestion** (`gitnexus analyze`)  
   - Entry: `gitnexus/src/cli/analyze.ts` → `runPipelineFromRepo` in `gitnexus/src/core/ingestion/pipeline.ts`.  
   - Walks the git working tree, parses supported languages via **Tree-sitter**, resolves imports/calls/inheritance, detects **communities** and **processes** (execution flows), and builds an in-memory **knowledge graph** (`gitnexus/src/core/graph/`).  
   - Output is loaded into **LadybugDB** under **`.gitnexus/`** at the repo root (`lbug/`, `meta.json`, etc.). Optional **FTS** indexes and **embeddings** attach to the same store.  
   - The repo is registered in **`~/.gitnexus/registry.json`** so MCP can find it from any working directory.

2. **Persistence & metadata**  
   - `gitnexus/src/storage/repo-manager.ts` — paths, registry, cleanup of legacy Kuzu artifacts.  
   - `gitnexus/src/core/lbug/lbug-adapter.ts` — graph load, queries, embedding restore batches.

3. **Query & agents**  
   - **MCP (stdio):** `gitnexus/src/cli/mcp.ts` → `startMCPServer` → `LocalBackend` (`gitnexus/src/mcp/local/local-backend.ts`) opens registered repos and serves **tools** from `gitnexus/src/mcp/tools.ts` and **resources** from `gitnexus/src/mcp/resources.ts`.  
   - **Bridge HTTP:** `gitnexus/src/cli/serve.ts` → Express app in `gitnexus/src/server/api.ts` (CORS-limited) exposes REST + MCP-over-HTTP for the web UI.  
   - **CLI tools (no MCP):** `gitnexus query`, `context`, `impact`, `cypher` in `gitnexus/src/cli/tool.ts` call the same backend for scripts and CI.

4. **Staleness**  
   - `gitnexus/src/mcp/staleness.ts` compares indexed `lastCommit` to `HEAD` and surfaces hints when the graph is behind git.

## MCP tools (summary)

| Tool | Purpose |
|------|---------|
| `list_repos` | Discover indexed repositories when more than one is registered. |
| `query` | Natural-language / keyword search over the graph (hybrid BM25 + optional vectors). |
| `cypher` | Ad hoc **Cypher** against the schema (see resource `gitnexus://repo/{name}/schema`). |
| `context` | Callers, callees, processes for one symbol (with disambiguation). |
| `impact` | Blast radius (upstream/downstream) with depth and risk summary. |
| `detect_changes` | Map git diffs to affected symbols and processes. |
| `rename` | Graph-assisted rename with `dry_run` preview (`graph` vs `text_search` confidence). |

## Where to change what

| If you are changing… | Start in… |
|----------------------|-----------|
| CLI commands / flags | `gitnexus/src/cli/` (`index.ts`, per-command modules). |
| Parsing or graph construction | `gitnexus/src/core/ingestion/` (pipeline, processors, resolvers, type-extractors). |
| Graph schema / DB access | `gitnexus/src/core/lbug/` (`schema.ts`, `lbug-adapter.ts`), `gitnexus/src/mcp/core/lbug-adapter.ts` if MCP-specific. |
| MCP protocol, tools, resources | `gitnexus/src/mcp/server.ts`, `tools.ts`, `resources.ts`. |
| Search ranking | `gitnexus/src/core/search/` (BM25, hybrid fusion). |
| Embeddings | `gitnexus/src/core/embeddings/`, phases in `analyze.ts`. |
| Wiki generation | `gitnexus/src/core/wiki/`. |
| Web UI behavior | `gitnexus-web/src/` (components, workers, graph client). |
| CI | `.github/workflows/*.yml`, `.github/actions/setup-gitnexus/`. |

## Known limitations

### Overloaded method resolution

Method and Constructor node IDs include an arity suffix (`#<paramCount>`) to
disambiguate overloaded methods. Two overloads with different parameter counts
produce distinct graph nodes: `Method:file:Class.method#1` vs
`Method:file:Class.method#2`.

**Same-arity overload disambiguation:** When two overloads share the same
parameter count but differ in types (e.g. `save(int)` vs `save(String)`), a
type-hash suffix `~type1,type2` is appended to produce distinct node IDs:
`Method:file:Class.save#1~int` vs `Method:file:Class.save#1~String`. The suffix
is only added when a same-arity collision is detected within a class and all
parameters have non-null type annotations. Languages without type info (Python,
Ruby, JS) fall back to arity-only IDs. TypeScript/JavaScript overload signatures
are intentionally excluded from type-hashing because they are declaration-only
contracts that should collapse to the implementation body's node ID. See issue
\#651.

**C++ const-qualified overload disambiguation:** Methods overloaded by const
qualification (e.g. `begin()` vs `begin() const`) are disambiguated via an
`isConst` property and a `$const` ID suffix appended to the const-qualified
variant when a non-const collision exists. The `$const` suffix appears after the
type-hash suffix: e.g. `Method:file:Container.begin#0$const`.

**Generic/template type preservation in type-hash:** The type-hash suffix uses
`rawType` (full AST text including generic/template args) rather than the
simplified `type` from `extractSimpleTypeName`. This means C++ template overloads
like `process(vector<int>)` vs `process(vector<string>)` produce distinct IDs:
`~vector<int>` vs `~vector<std::string>`. Java generic overloads like
`process(List<String>)` vs `process(List<Integer>)` are a compile error due to
type erasure, so this gap is theoretical for Java.

**ID stability on first overload:** Type and const tags are collision-only. When
a class has `save(int)` as its only `save` method, the ID is `save#1` (no tag).
Adding `save(String)` changes the original to `save#1~int`. This is correct for
fresh analysis but means IDs are not stable across overload additions. Future
incremental re-analysis should account for this.

**Variadic method matching:** When one side is variadic (`parameterCount`
undefined) and the other has a fixed count, `METHOD_IMPLEMENTS` edges are
emitted with confidence 0.7 instead of 1.0. Variadic methods like
`foo(String... args)` may superficially match `foo(String s)` by type but
are not guaranteed to be interchangeable across all languages (Java/Kotlin
accept this via varargs sugar; TypeScript, C#, Rust do not).

**Confidence tiering** for `METHOD_IMPLEMENTS` edges:

| Match quality | Confidence | When |
|---|---|---|
| Exact parameter types match | 1.0 | Both sides have `parameterTypes` arrays and they match |
| Arity (count) matches | 1.0 | Both sides have `parameterCount`, types unavailable |
| Variadic vs fixed | 0.7 | One side is variadic, other has fixed count |
| Lenient (insufficient info) | 0.7 | One or both sides lack type and count data |

## Related docs

- [MIGRATION.md](MIGRATION.md) — breaking changes and migration guidance.
- [RUNBOOK.md](RUNBOOK.md) — operational commands and recovery.  
- [GUARDRAILS.md](GUARDRAILS.md) — safety boundaries for humans and agents.  
- [TESTING.md](TESTING.md) — how to run tests.  
- `AGENTS.md` / `CLAUDE.md` — agent workflows and tool usage expectations for **this** repo when indexed by GitNexus.
