# Architecture — GitNexus

Monorepo: **CLI/MCP** (`gitnexus/`) + **browser UI** (`gitnexus-web/`).

## Repository layout

| Path                                                                  | Role                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `gitnexus/`                                                           | npm package `gitnexus`: CLI, MCP server (stdio), HTTP API, ingestion pipeline, LadybugDB graph, embeddings. |
| `gitnexus-web/`                                                       | Vite + React thin client: graph explorer + AI chat. All queries via `gitnexus serve` HTTP API.              |
| `gitnexus-shared/`                                                    | Shared TypeScript types and constants (consumed by CLI and Web).                                            |
| `.claude/`, `gitnexus-claude-plugin/`, `gitnexus-cursor-integration/` | Agent skills and plugin metadata.                                                                           |
| `eval/`                                                               | Evaluation harnesses for benchmarking tool usage.                                                           |
| `.github/`                                                            | CI workflows + composite actions (`setup-gitnexus/`, `setup-gitnexus-web/`).                                |

## End-to-end flow: index → graph → tools

1. **Ingestion** — `analyze.ts` → `runFullAnalysis` (`run-analyze.ts`) → `runPipelineFromRepo` (`pipeline.ts`). The default DAG of 19 phases builds a `KnowledgeGraph` in memory, then loads into LadybugDB under `.gitnexus/`. Repo registered in `~/.gitnexus/registry.json` for MCP discovery.

2. **Persistence** — `repo-manager.ts` (paths, registry, LadybugDB cleanup). `lbug-adapter.ts` (graph load, queries, embedding batches).

3. **Query layer** — three interfaces to the same backend:
   - **MCP (stdio):** `mcp.ts` → `LocalBackend` → tools (`tools.ts`) + resources (`resources.ts`)
   - **HTTP bridge:** `serve.ts` → Express (`api.ts`, `mcp-http.ts`) for web UI
   - **CLI direct:** `gitnexus query|context|impact|cypher` in `tool.ts`

4. **Staleness** — `core/git-staleness.ts` compares indexed `lastCommit` to `HEAD` and classifies the result as `current`, `behind`, `diverged` (HEAD moved off the indexed commit, gap uncountable) or `unknown`; `core/staleness-status.ts` builds the one `staleness` payload that MCP `list_repos`, the read tools and the `serve` repo routes all emit.

## MCP tools

| Tool             | Purpose                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `list_repos`     | Discover indexed repos                                                                                                         |
| `query`          | Hybrid BM25 + vector search over the graph                                                                                     |
| `cypher`         | Ad hoc Cypher against the schema                                                                                               |
| `context`        | Callers, callees, processes for one symbol                                                                                     |
| `impact`         | Blast radius (upstream/downstream) with risk summary                                                                           |
| `detect_changes` | Map git diffs to affected symbols and processes                                                                                |
| `rename`         | Semantic rename: previews by default (`dry_run` omitted/true), applies with `dry_run: false` and the preview's `plan_token` |
| `api_impact`     | Pre-change impact report for an API route handler                                                                              |
| `trace`          | Shortest directed path between two symbols (call + class-member edges); group-aware (`repo: "@<group>"`) for cross-repo traces |
| `route_map`      | API route → handler → consumer mappings                                                                                        |
| `tool_map`       | MCP/RPC tool definitions and handlers                                                                                          |
| `shape_check`    | Response shape vs consumer property access mismatches                                                                          |
| `explain`        | Persisted taint findings (source→sink data flows) — needs `analyze --pdg`                                                      |
| `pdg_query`      | Control/data dependence — CDG (`mode: controls`) / REACHING_DEF (`mode: flows`) — needs `analyze --pdg`                        |
| `group_list`     | List repo groups or details for one group                                                                                      |
| `group_sync`     | Rebuild group Contract Registry (`contracts.json`) and bridge graph                                                            |

`query`, `context`, and `impact` are group-aware: pass `repo: "@<groupName>"` (or `"@<groupName>/<memberPath>"` to scope to one member) plus optional `service: "<monorepo/path>"`. Group-mode `query` merges per-repo results via Reciprocal Rank Fusion; group-mode `impact` runs the local walk in the chosen member and fans out across boundaries via the Contract Bridge (`gitnexus/src/core/group/cross-impact.ts`). `trace` is also group-aware via `repo: "@<groupName>"` — but, unlike the others, it resolves `from`/`to` across **all** members (a `@<groupName>/<memberPath>` suffix is advisory for trace, not a scope); pass `from_uid`/`to_uid` to disambiguate a symbol name that occurs in more than one member.

Group-mode `trace` (`gitnexus/src/core/group/cross-trace.ts`) stitches a path that crosses repositories: it resolves `from`/`to` across all members, and when they live in different repos it joins the home-repo segment to the target-repo segment over a single `ContractLink` boundary (an HTTP consumer→provider link, joined on `Contract.symbolUid`), reported as a `CONTRACT_LINK` hop in `crossings[]`. The crossing is clamped to one boundary (`MAX_SUPPORTED_CROSS_DEPTH`, shared with cross-impact); deeper `crossDepth` is reported via `notes[]`. With `pdg: true` (experimental, opt-in), each boundary-adjacent segment is enriched with its intra-procedural REACHING_DEF data-flow when that repo was indexed with `--pdg` (reusing the same anchored `flows` query as `pdg_query`); data flow never crosses the repo boundary, and a missing PDG layer degrades to call-level hops with a note. Two stores meet only at the `symbolUid` grain — the per-repo PDG/call graph and the group bridge — so this is the documented join; full cross-program (SDG-like) data flow across the boundary remains deferred (see `docs/plans/2026-06-18-002-feat-unified-pdg-impact-evaluation-plan.md`). The previously-planned `group_query`, `group_context`, `group_impact`, `group_contracts`, `group_status` MCP tools are intentionally not introduced — group-level state is exposed via resources instead:

| Resource URI                        | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `gitnexus://group/{name}/contracts` | Contract Registry (provider/consumer rows + cross-links) |
| `gitnexus://group/{name}/status`    | Per-member index + Contract Registry staleness           |

## Where to change what

| Concern                                                 | Start in                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| CLI commands/flags                                      | `src/cli/` (`index.ts`, per-command modules)                                                           |
| Parsing/graph construction                              | `src/core/ingestion/pipeline-phases/` + `pipeline.ts`                                                  |
| Graph schema/DB                                         | `src/core/lbug/` (`schema.ts`, `lbug-adapter.ts`)                                                      |
| MCP tools/resources                                     | `src/mcp/server.ts`, `tools.ts`, `resources.ts`                                                        |
| Cross-repo groups (sync, contracts, `@<group>` routing) | `src/core/group/` (`service.ts`, `cross-impact.ts`, `sync.ts`, `bridge-db.ts`)                         |
| Search ranking                                          | `src/core/search/` (BM25, hybrid fusion)                                                               |
| Embeddings                                              | `src/core/embeddings/` + `src/core/run-analyze.ts`                                                     |
| Wiki generation                                         | `src/core/wiki/`                                                                                       |
| Language support                                        | `src/core/ingestion/languages/` + `tree-sitter-queries.ts` + `gitnexus-shared/src/languages.ts`        |
| Import resolution | `src/core/ingestion/scope-resolution/pipeline/run.ts` + per-language `ScopeResolver.resolveImportTarget` hooks |
| Call resolution/inheritance/MRO                         | `src/core/ingestion/scope-resolution/` (pipeline, passes, graph-bridge)                                |
| Type extraction                                         | `src/core/ingestion/type-extractors/`                                                                  |
| Worker pool                                             | `src/core/ingestion/workers/`                                                                          |
| Web UI                                                  | `gitnexus-web/src/`                                                                                    |
| CI                                                      | `.github/workflows/*.yml`, `.github/actions/`                                                          |

> Paths above are relative to `gitnexus/` unless they start with `gitnexus-web/` or `.github/`.

---

## Pipeline Phase DAG

19 default phases are defined in `gitnexus/src/core/ingestion/pipeline-phases/`, each with explicit `deps` and typed output. `--pdg` adds `taintSummaries` and `callSummaries` (21 total).

```
scan → structure → [springConfig, markdown, cobol] → parse → [routes, tools, orm]
  → crossFile → scopeResolution → [springAutoConfiguration, springAop]
  → pruneLocalSymbols → mro → springAopInheritance → di → communities → processes
```

| Phase                     | File                                   | Deps                                                               | Output                                                                                                                                                                                      |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan`                    | `scan.ts`                              | (root)                                                             | File paths + sizes                                                                                                                                                                          |
| `structure`               | `structure.ts`                         | `scan`                                                             | File/Folder nodes, CONTAINS edges, `allPathSet`                                                                                                                                             |
| `springConfig`            | `spring-config.ts`                     | `structure`                                                        | Spring configuration-property nodes and metadata                                                                                                                                            |
| `markdown`                | `markdown.ts`                          | `structure`                                                        | Section nodes, cross-link edges from .md/.mdx                                                                                                                                               |
| `cobol`                   | `cobol.ts`                             | `structure`                                                        | COBOL program/paragraph/section nodes (regex, no tree-sitter)                                                                                                                               |
| `parse`                   | `parse.ts` + `parse-impl.ts`           | `structure`, `markdown`, `cobol`                                   | Symbol nodes, IMPORTS/CALLS/EXTENDS edges, extracted routes/tools/ORM queries                                                                                                               |
| `routes`                  | `routes.ts`                            | `parse`                                                            | Route nodes + HANDLES_ROUTE edges (Next.js, Expo, PHP, decorators, and JS/TS static route sources — see below)                                                                              |
| `tools`                   | `tools.ts`                             | `parse`                                                            | Tool nodes + HANDLES_TOOL edges                                                                                                                                                             |
| `orm`                     | `orm.ts`                               | `parse`                                                            | QUERIES edges (Prisma, Supabase)                                                                                                                                                            |
| `crossFile`               | `cross-file.ts` + `cross-file-impl.ts` | `parse`, `routes`, `tools`, `orm`                                  | Cross-file type propagation in topological import order                                                                                                                                     |
| `scopeResolution`         | `scope-resolution/pipeline/phase.ts`   | `parse`, `crossFile`, `structure`                                  | Binding/reference + inheritance edges; disposes BindingAccumulator                                                                                                                          |
| `springAutoConfiguration` | `spring-auto-configuration.ts`         | `structure`, `scopeResolution`                                     | DECLARES and CONDITIONAL_ON metadata for Spring configuration candidates                                                                                                                    |
| `springAop`               | `spring-aop.ts`                        | `scopeResolution`                                                  | Direct declarative/advice ADVISED_BY edges and pointcut evidence                                                                                                                            |
| `pruneLocalSymbols`       | `prune-local-symbols.ts`               | `scopeResolution`                                                  | Drops inert block-local `Const`/`Variable`/`Static` nodes (only a `File→DEFINES` edge) post-resolution                                                                                      |
| `mro`                     | `mro.ts`                               | `crossFile`, `scopeResolution`, `pruneLocalSymbols`, `structure`   | METHOD_OVERRIDES + METHOD_IMPLEMENTS edges                                                                                                                                                  |
| `springAopInheritance`    | `spring-aop.ts`                        | `springAop`, `mro`                                                 | Propagates declarative behavior through class/interface inheritance decisions                                                                                                               |
| `di`                      | `di.ts`                                | `mro`                                                              | INJECTS edges from consumer Classes, factory Methods, or AST-captured programmatic lookup callables to provider Classes/declaration CodeElements (framework-neutral DI resolution; per-language matchers registered in `di-extractors/`) |
| `communities`             | `communities.ts`                       | `mro`, `pruneLocalSymbols`, `structure`                            | Community nodes + MEMBER_OF edges (Leiden algorithm)                                                                                                                                        |
| `processes`               | `processes.ts`                         | `communities`, `routes`, `tools`, `pruneLocalSymbols`, `structure` | Process nodes + STEP_IN_PROCESS edges                                                                                                                                                       |

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
- **Skippable phases** — `skipGraphPhases` omits MRO/di/communities/processes (faster tests); `pruneLocalSymbols` still runs (it is graph cleanup, not analysis). `skipWorkers` is no longer a sequential escape hatch — it (like `--workers 0` / `GITNEXUS_WORKER_POOL_SIZE=0`) is rejected with an actionable error, since the worker pool is the sole parse path (§ Chunked parse-and-resolve).
- **Local-symbol pruning** — `pruneLocalSymbols` removes inert block-local value symbols after scope resolution has consumed them. Opt out per-call with `PipelineOptions.keepLocalValueSymbols` or globally with the `GITNEXUS_KEEP_LOCAL_VALUE_SYMBOLS` env var.

### How to add a new phase

1. Create `pipeline-phases/my-phase.ts` with a `PipelinePhase<MyOutput>` (name, deps, execute)
2. Export from `pipeline-phases/index.ts`
3. Add to `buildPhaseList()` in `pipeline.ts`

```typescript
import type { PipelinePhase, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';

export interface MyPhaseOutput {
  /* ... */
}

export const myPhase: PipelinePhase<MyPhaseOutput> = {
  name: 'myPhase',
  deps: ['parse'],
  async execute(ctx, deps) {
    const { allPaths } = getPhaseOutput<ParseOutput>(deps, 'parse');
    // ... write to ctx.graph ...
    return {
      /* typed output */
    };
  },
};
```

### Where routes come from

`route-extractors/` holds five independent ways a route can be discovered, all
converging on the routes phase's `(method, url)` registry:

| Source | Shape | Examples |
| --- | --- | --- |
| Filesystem convention | path → URL, no parsing | Next.js `app/`, Expo, PHP |
| Single-file framework route | `isRouteFile` + worker extraction | Laravel `routes/*.php` |
| Cross-file framework route | `discoverRootRouteFiles` + `extractRoutes` | Django `urlpatterns` |
| AST-level route in a normal file | `extractDecoratorRoutes` | Spring, FastAPI, NestJS (`@Controller` + `@Get`/`@Post`/…; URLs are controller-relative — `setGlobalPrefix` and URI versioning live in the bootstrap file and are not applied), **JS/TS dispatch guards and static data route tables** |
| Cross-file AST route facts | `extractRouteFacts` + `resolveRouteFacts` | Express apps/routers and their mount paths; directly proven Hono registrations |

The AST-level route hook is the one whose name undersells it. A route is DECLARED by a
decorator, but it can also be **inferred** from a raw `node:http` server's own
dispatch — `if (req.method === 'GET' && pathname === '/api/x')` is a route with
a path, a verb and a handler, and nothing else in the pipeline could see it.
`route-extractors/dispatch-guard.ts` reads that shape; the transport, dedup and
handler resolution are shared with decorator routes, and
`ExtractedDecoratorRoute.source` carries the provenance difference through to
the `HANDLES_ROUTE` edge.

JS/TS data route tables share that transport when a route-named array contains
direct object literals with static `path`, `method`, and `handler` fields and a
same-scope `for...of` dispatcher positively compares the path and method before
directly invoking the handler. Dynamic values, computed keys, spreads,
inline/called handlers, unknown verbs, and ambiguous handler bindings are
suppressed. Bare import aliases and single-level member handlers are attributed
only through declared import and owner provenance; an unproven receiver never
falls back to a global name guess.

That extractor is deliberately **precision-weighted**: `route_map` presents its
output as fact, so a `startsWith` namespace test, a bare `pathname === '/'`
without a verb, and any regex it cannot translate exactly are all dropped rather
than guessed at. A missing route is a coverage limit; an invented one is a lie.
Express `app.get(RegExp, handler)` registrations are likewise omitted: a regex
matcher does not have one finite URL to use as a Route node key.
Express `app.use(path, middleware)` does not itself create a Route node. When
both receivers are proven Express instances, mounting a router joins the literal
prefix to its registered paths before handler selection. Nested and repeated
mounts, literal path arrays, and middleware arrays share this composition.

Express receiver facts reuse the existing AST and `ParsedFile` lexical identities.
They follow explicit ESM/CommonJS imports and exports through the configured
`ScopeResolver`, including stable aliases and barrels. An object named `app` or
`router` is not evidence; type-only imports, shadowed bindings, conflicting writes,
and unproven factories do not establish a receiver. Directly proven Hono verb
registrations remain supported, without applying Express mounting semantics.
A registration whose receiver, literal path or mounted router is a parameter of a
named function (`mountSSEProgress(app, '/p', jobs)` → `app.get(routePath, …)`)
resolves through each call site of that function, once per site and in the
helper's file. This is one hop only: a site argument that is itself a parameter,
an unproven argument, or a reassigned parameter establishes nothing, and a helper
with no recorded call site is read as written, so an unknown mount path still
suppresses its router's standalone paths.

Fetch-wrapper facts use the same lexical identities. The shared resolver in
`route-extractors/fetch-wrapper-index.ts` names no language, but it applies
ECMAScript `ResolveExport` rules to the re-export facts it receives: only
providers whose modules link that way implement the re-export hook. A file that
passes a route's URL to a callee not proven to be a wrapper is counted on the
Route as `unverifiedConsumers` (proven consumers and the route's own file
excluded), and `api_impact` then reports its consumer count as a lower bound.

An inline Express handler resolves to the anonymous Function node the capture
layer names by position, so its Route carries a `handlerSymbolId`. In a file
with several routes, response keys come from that handler's lines rather than
the whole file (middleware stays file-level), and flows link only where they
start at that handler.

A standalone router retains its local paths. A known dynamic mount suppresses
that fallback, while independently proven static mounts remain available. Cycles
terminate, and exceeding the expansion budget omits the affected mount component
rather than publishing a partial set of paths. Per-file facts are cached, but
cross-file paths are recomputed each run. Group HTTP contracts use the same
resolver and composition, including in source-only mode.

Dispatch-guard inference also ignores stored `route.routePath` metadata:
comparing a recorded route name with a literal does not prove that the request
path is being dispatched.

Two rules there need more than one comparison to decide, and are worth knowing
about before changing either:

- **Same-file constant folding.** `` pathname === `${basePath}/rules` `` is
  common enough that refusing it loses whole route modules — and loses them
  invisibly, since a module with unfoldable paths and a module with no routes
  produce the same empty answer. Folding is same-file, string literals only, one
  alias hop, and refuses on ambiguity (a name declared twice with different
  values is dropped, never guessed).
- **Whole-repo reconciliation** (`reconcileDispatchGuardRoutes`, applied in the
  routes phase). A split route table — one module listing every path it
  recognises so the dispatcher can 404 early, handlers in others — otherwise
  lists every route twice, once verb-less with the table as its "handler". It
  applies to dispatch-guard routes only: a framework route with no verb is
  method-agnostic *by declaration*, which is a fact, not a weaker observation.

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
    │  emitReferencesViaLookup ── uses handledSites + deferred-site skip set
    │  emitPropertyDispatchCalls ── registration USES + conservative CALLS
    │  emitCallableValueFlow   ── assigned/passed callable invocation CALLS
    │  emitImportedValueReferences ── cross-file value reads via finalized imports
    │  emitUniqueNamePropertyAccesses ── LAST-RESORT property reads by name,
    │       narrowed same-file → direct-import, refusing to choose otherwise
    │  emitImportEdges
    ▼
 KnowledgeGraph  (IMPORTS / CALLS / ACCESSES / INHERITS / USES)
```

Orchestrator: `runScopeResolution(input, provider)` in `scope-resolution/pipeline/run.ts`.
Pipeline phase: `scopeResolutionPhase` in `scope-resolution/pipeline/phase.ts` — iterates the registered `SCOPE_RESOLVERS` over the worker-serialized `ParsedFile`s. (Per-language `emitScopeCaptures` hooks may reuse a cached Tree via the orchestrator's `treeCache`, but in worker-pool runs that cache is empty — Trees can't cross MessageChannels — so they consume the pre-extracted `ParsedFile` instead; § Performance notes.)

### Semantic rename

`rename` plans through the graph-backed planner in `mcp/local/rename/graph-rename.ts`; `dry_run` (omitted or `true`) stops after planning and returns a single-use `plan_token`. Public apply requires that token with `dry_run: false`, validates the captured repository, declaration inventory, stable symbol identity, source-file set, source hashes and approved physical paths, and executes exactly the captured edits without replanning. The process-local cache retains edited-file snapshots and targets, hash/target evidence for unedited semantic sources, and an immutable provider-resolution configuration value, with a 15-minute lifetime and bounded plan-count and memory budgets. Provider-owned fresh configuration hooks bypass workspace memoization; configuration semantics are checked at capability validation and once after staging, before the first installation, independently of edited-file count. Source bytes and approved targets are checked before each replacement. These cooperative-workspace checks are not an atomic filesystem snapshot. An unedited source aliasing an edited target blocks preview. In MCP read-only mode the same tool is listed preview-only and any other `dry_run` is rejected before backend dispatch (`mcp/read-only-policy.ts`). The selected graph declaration must match the current source. Each language's `LanguageProvider.rename` supplies original-source name spans, spelling rules, declaration families, and syntax-specific rewrites. Embedded and standalone providers retain their own parsing strategy; shared planning does not classify language syntax or invoke compiler/language-service APIs.

The planner runs the existing scope-resolution pipeline before and after the proposed edits. An opt-in source-binding observer records the declaration selected for a written name, separately from runtime dispatch expansion. Provider capture metadata travels with each parsed file, so both passes retain ordinary import and ownership evidence. Provider-proven declaration families use the existing inheritance, implementation, and declaration relationships. Re-resolution checks edited references, untouched bindings, collisions, and changes in those families.

Application validates all captured source snapshots before each per-file replacement, then rechecks that destination immediately before installing it. Validation and replacement are separate filesystem operations; the operation is neither an atomic compare-and-swap nor a multi-file transaction. Unsupported or ambiguous source constructs produce an explicit blocked result. Coverage is limited to the indexed workspace and the provider's available semantic evidence; dynamic names and external consumers are not silently treated as resolved.

### Callable-value flow

First-class callable values use a language-neutral inclusion analysis in `passes/callable-value-flow.ts`. Providers recognize their own syntax and emit JSON-safe `CallableFlowSite` facts (`seed`, `copy`, `alias`, `address`, `load`, `store`, `formal`, `argument`, and `invoke`) into `ParsedFile`; shared ingestion never branches on a language name. These always-on facts cross workers and the durable parse store. Changes to their producers or shared contracts automatically change the base parser identity used by both caches.

The emit stage defers only invocation sites proven to reference a flow cell. Ordinary receiver/free/reference passes still resolve direct callees first and record exact callee IDs by file/line/column. Property dispatch then runs before callable flow because a property-dispatched wrapper call can seed actual-to-formal propagation. The callable solver consumes those direct targets, propagates callable sets through lexical cells and formals, and emits `CALLS` at the real indirect invocation site with reason `callable-value-flow` (confidence 0.8 for a singleton, 0.7 for a bounded multi-target set).

The solver is flow-insensitive but bounded: dependency-indexed work items rerun only when a cell they read changes; target/address sets cap at 32; a hostile fact graph has a finite work budget; overflow or budget exhaustion emits no partial `CALLS` and produces a structured warning. Lexical shadowing is function/block aware, invocation/constructor results are not reinterpreted as callable designators, and overload selection uses provider-supplied signature metadata. C/C++ additionally associate visible prototypes with unique definitions so actual-to-formal flow crosses translation units; the provider-owned `hasFileLocalCallableLinkage` hook prevents `static` declarations or definitions from leaking across files. C++ member-function pointers preserve parameter/cv shape, keep non-virtual targets exact, and expand virtual targets through `MethodDispatchIndex`/MRO.

Property-key dispatch remains a separate conservative fallback. Its per-key fan-out cap is 32; capped keys synthesize no partial calls and are reported at warning level with language, skipped-key count, dropped key names (bounded), and cap; the count also travels in `RunScopeResolutionStats.propertyDispatchSkippedKeys`.

Interface-dispatch fan-out walks the subtype closure of the receiver's interface and is **generic-instantiation aware** (#2912): a call through `IValidator<string>` must not reach an implementor of `IValidator<int>`, which shares its declaration and therefore its subtype list. Each heritage clause's arguments reach resolution by one of three routes — read off the `@reference.inherits` anchor's own spelling where that anchor spans the whole base (most languages, no query change), through the `@reference.type-arguments` sub-tag where the anchor is the bare name and moving it would renumber inheritance edge ids (Rust `impl T<A> for S`, Dart `extends`), or on a heritage MARKER payload for clauses that never become reference sites (Dart `implements`/`with`). Whichever pass emits the edge records the pair through one sink: `preEmitInheritanceEdges` for heritage clauses, `ScopeResolver.emitHeritageEdges` for the rest.

The walk then carries a substitution: a subtype's own type parameters bind to the receiver's arguments, so `class Wrapper<T> : IValidator<T>` stays reachable from every instantiation while `class IntValidator : IValidator<int>` is pruned from the `string` one. Receiver arguments come from the declared type (Case 4), a class-level field's declared type (Case 6), or — for a compound receiver such as `this._repo` — the spelling the compound fold typed that position from, reported back through `recordReceiverType` and accepted only when it names the class the fold returned.

The filter prunes only on positive evidence: an unknown instantiation on either side, an argument list whose arity does not line up, a name that may be a type variable the language's captures never recorded, or an unresolved spelling whose simple name matches all keep the target. A type parameter of the declaration ENCLOSING either side is recognised as such and never compared — `void Run<T>(IValidator<T> v)` writes a receiver with no known instantiation, so it keeps the unfiltered fan-out. That recognition is what generic METHODS now carry `@declaration.type-parameters` for in C#, Java and Kotlin (TypeScript already did): without it an unbounded `T` grounds to nothing and a bounded one grounds to its BOUND, and both compare unequal to an implementor's concrete argument. Languages that capture neither type arguments nor type parameters therefore emit exactly the pre-#2912 fan-out. The fan-out cap (32, `GITNEXUS_MAX_INTERFACE_DISPATCH_FANOUT`) and its skipped-target reporting are unchanged and apply after filtering. Note the fan-out itself still fires only for a receiver whose folded type is an `Interface` symbol, so a Rust `Trait` or a Dart abstract `Class` receiver emits no secondary targets to filter in the first place.

Standalone (regex-based) providers such as COBOL participate via `ScopeResolver.scopeResolutionEdgeMode: 'callable-flow-only'`: `runScopeResolution` runs for them, but every ordinary emission path — heritage, interface implementations, receiver-bound, free-call fallback, reference/import edges, post-resolution hooks — is gated off, so their legacy phase (e.g. `cobolPhase`) remains the sole owner of structural edges and the callable solver's `CALLS` are purely additive. A callable-flow-only provider whose files emitted no callable facts exits early, before finalize, keeping the opt-in proportional to source scanning.

### Receiver chains and the drop census (#2766)

A compound receiver (`svc.getUser().address.save()`) is captured as a compact string on `ReferenceSite.receiverChain`. `utils/receiver-chain-codec.ts` is the ONE encoder/decoder — capture emitters, the scope-resolution fold, and the durable ParsedFile store all import it rather than hand-rolling the format.

Wire format is **v2**: `2|<base>|<step>|<step>…`, one-character version prefix, then base-first steps, each a one-character kind sigil plus the member name (`c` = call, `f` = field). `a` (await) and `i` (index) are **name-free** and encode as a bare sigil — an awaited call's name already lives on its `c` step, and a subscript key is a value, not a lookup-able identifier. The version went 1 → 2 when those two kinds were added, and a decoder REFUSES a foreign version rather than decoding the prefix it understands: a chain missing its await/index hop decodes cleanly as a different, shorter chain and would type the receiver against the wrong member. The format is unescaped (`|` and `~` cannot occur in an identifier), so an unencodable name is refused rather than escaped, and the payload is capped at `MAX_RECEIVER_CHAIN_BYTES` / `MAX_CHAIN_DEPTH` steps. These strings live in both parse stores. Codec and capture changes automatically invalidate their caches through the base parser identity; the explicit receiver-chain wire version and foreign-version rejection still govern decoding.

Receivers the resolver could not type are not silently dropped. Each records a `ResolutionOutcome` (`scope-resolution/resolution-outcome.ts`) carrying the receiver's *shape* (`classifyReceiverShape`: `chain-call` / `chain-field` / `chain-mixed` / `chain-unwrap` / `no-chain` — the bench censuses these) and its *origin* (`in-program` / `external` / `unknown`). `scope-resolution/unresolved-receivers.ts` aggregates them per member name into the index-persisted `unresolvedReceiverMembers` summary, keeping in-program and external counts under separate keys. Only in-program drops make a count short: an external-rooted call (`System.out.println`, `fetch(...)`) has no in-graph node an edge could have reached, so it is reported but does not hedge. `impact` / `context` read that summary and publish `epistemic: 'exact' | 'lower-bound'`, prose `boundaries`, and the machine-readable `causes` split (`EpistemicCauses` in `mcp/local/local-backend.ts`).

### Optional CFG/PDG emission (`--pdg`, #2081–#2086)

On a `--pdg` run providers build control-flow graphs through `LanguageProvider.cfgVisitor` (Tree-sitter ASTs) or `collectSourceCfgs` (standalone source processing). Every supported language supplies one of these hooks; Vue covers executable scripts. AST visitors run in the parse worker, while source-backed providers run during fresh scope extraction. Both produce plain `ParsedFile.cfgSideChannel` data. Scope-resolution emits the program-dependence layers **inside Phase 4 of `runScopeResolution`, while the disk-backed ParsedFile store is still live**. The store is cleared after that phase, so a later standalone phase cannot consume it.

The opt-in is off by default, folded into the parse-cache key, and bounded by executable-region and edge caps. Providers report unsupported regions and cap drops instead of fabricating complete flow. All dependence edges remain `BasicBlock → BasicBlock` in the existing `CodeRelation` table. Ordinary function ownership uses the BasicBlock id prefix and source span. A provider may supply an exact graph `ownerId` for a larger executable region; COBOL uses its existing program Module identity so paragraph fallthrough and PERFORM return continuations remain inside one region. This identity is persisted on BasicBlocks and used by PDG symbol projection. No new function-to-block relation is introduced. The layers build on each other:

- **M1 — CFG** (#2081): `BasicBlock` nodes + `CFG` edges. Edge _kind_ (`seq`/`cond-true`/`loop-back`/…) rides the `reason` column (CFG is one `CodeRelation` type, not one per kind).
- **M2 — REACHING_DEF** (#2082): GEN/KILL def→use data dependence from a pure fixpoint solver; the variable name rides `reason`.
- **M3/M4 — TAINTED / SANITIZES / TAINT_PATH** (#2083–#2084): intra- and inter-procedural taint (source→sink) — the `explain` tool's data.
- **M5 — CDG** (#2085): Ferrante control dependence over a Cooper–Harvey–Kennedy post-dominator tree (the EXIT-rooted reverse CFG); branch sense (`'T'`/`'F'`) rides `reason`. A CFG whose EXIT is unreachable from some block is skipped for CDG (post-dominance would be unsound) while its CFG/REACHING_DEF layers are kept.
- **M6 — read surface** (#2086): the `pdg_query` MCP tool answers "what gates X?" (CDG, `mode: controls`) and "where does Y flow?" (REACHING_DEF, `mode: flows`); `explain` is the taint consumer. Both are always anchored + `LIMIT`-bounded (LadybugDB has no rel-property index) and share one `resolveBlockAnchor` helper. These PDG edge types are deliberately kept out of the default `VALID_RELATION_TYPES` / web schema.
- **Cross-repo trace enrichment**: group-mode `trace` (`pdg: true`) reuses the same anchored REACHING_DEF `flows` query to annotate a boundary-adjacent segment with how a value reaches the cross-repo call — strictly intra-procedural (data flow never crosses the repo boundary). See the group-aware tools note above.

See `core/ingestion/cfg/` (emit + the pure CFG / post-dominator / control-dependence / reaching-defs / taint passes) and `mcp/local/local-backend.ts` (`_pdgQueryImpl`, `_explainImpl`, the shared `resolveBlockAnchor`).

### `ScopeResolver` contract

Single interface a language implements to plug into the pipeline. Contract fully documented in `scope-resolution/contract/scope-resolver.ts`.

| Hook                                                    | Purpose                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `languageProvider`                                      | Base `LanguageProvider` (tree-sitter query, `emitScopeCaptures`, import/binding interpreters, hooks)                                                                                                                                                            |
| `populateOwners(parsed)`                                | Fill deferred `ownerId` fields on method defs (captures can't always know the owning class at parse time)                                                                                                                                                       |
| `buildMro(graph, parsed, nodeLookup)`                   | Produce `mroByClassDefId: Map<DefId, DefId[]>` — C3, Ruby-mixin, or first-wins per language                                                                                                                                                                     |
| `resolveImportTarget(target, fromFile, allFiles)`       | `(rawImportPath, sourceFile) → targetFilePath` (PEP-328 for Python, etc.)                                                                                                                                                                                       |
| `isNamespaceImport(parsedImport, targetFile, fromFile)` | Optionally reclassify a resolved named import as a namespace handle when the imported symbol is itself a module                                                                                                                                                 |
| `mergeBindings(existing, incoming, scopeId)`            | Shadowing / LEGB precedence                                                                                                                                                                                                                                     |
| `arityCompatibility`                                    | Provider consumed by registry during `MethodRegistry.lookup` Step 2                                                                                                                                                                                             |
| `importEdgeReason`                                      | Confidence-tier string for IMPORTS edge reason field                                                                                                                                                                                                            |
| `propagatesReturnTypesAcrossImports?`                   | Opt out of cross-file return-type propagation (default on)                                                                                                                                                                                                      |
| `fieldFallbackOnMethodLookup?`                          | Statically-typed languages turn this OFF — the heuristic over-connects (default on)                                                                                                                                                                             |
| `elementTypeOf?`                                        | `(containerType, via: {kind:'index'} \| {kind:'accessor',name}) → elementType \| undefined` — element type of a container, reached by subscript (`repos[0]`) or by a property-style collection view (`data.Values`). ONE hook for both routes (it replaced the split `unwrapCollectionAccessor` / `unwrapCollectionElement`, where implementing one silently answered nothing for the other). Consulted only where the source actually performed the access — never as a general type-name normalizer |
| `stripTypePreservingDecoration?`                        | `(typeName) → strippedName \| undefined` — strip ONE layer of TYPE-PRESERVING decoration (pointer, reference, `const`, nullable, borrow, sigil) so a receiver declared `*Host` still finds the `Host` binding (#2766). Never a container: unwrapping `Repo[]` here would fold `repos.find(x)` to `Repo.find` — that is `elementTypeOf`'s job, and only after a real subscript. Consulted only after every undecorated lookup fails, and only by receiver-chain base/step resolution — default off |
| `qualifiedTypeLookupSpelling?`                          | `(typeRef) → 'pkg.Type' \| undefined` — the namespace-qualified spelling of a declared type whose qualifier capture cut from `rawName` (`*models.User` stored as `User`), recovered from `declaredSpelling`. Receiver typing tries it first, grounded on the qualifier's import (no unique-name guess), and falls back to the bare `rawName` lookup on any miss, so two packages' same-named types stop colliding. The binding is not rewritten — default off |
| `collapseMemberCallsByCallerTarget?`                    | One CALLS edge per (caller, target) instead of per-site — default off                                                                                                                                                                                           |
| `populateNamespaceSiblings?`                            | Cross-file implicit visibility (compiler-implicit namespace sharing) — default off; ctx carries `treeCache`                                                                                                                                                     |
| `resolveImplicitInheritanceBase?`                       | Fallback for a bare inheritance base the shared chain left unbound, bound by the implicit namespace rule (siblings exist only after the pre-pass); Java, Kotlin, C# opt in                                                                                      |
| `hoistTypeBindingsToModule?`                            | Walk up to Module scope when looking up a method's return-type typeBinding — default off; enable only when bindings are stored at module level                                                                                                                  |
| `hasFileLocalCallableLinkage?`                          | Precise internal-linkage predicate used only when joining callable declarations/prototypes to cross-file definitions; C/C++ use it for `static` free functions                                                                                                  |
| `constructorCallTargetsClass?`                          | A constructor-form call `Type(...)` links to the Class def rather than its explicit Constructor def — default off; Swift and Dart opt in                                                                                                                        |
| `constructionSyntax?`                                   | How the language spells construction, so an INLINE constructor receiver (`Service(db).m()`, `new Service(db).m()`, `Service.new.m()`) can be typed — `bare` / `keyword` / `selector`; default off, opt in per language only where measured to be needed (#2708) |

### Per-language registration

1. Implement `ScopeResolver` in `languages/<lang>/scope-resolver.ts`.
2. Add entry to `SCOPE_RESOLVERS` in `scope-resolution/pipeline/registry.ts`.

CI auto-discovers the set via `tsx`. No workflow edit required.

### Code references

| Module                                        | Purpose                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scope-resolution/contract/scope-resolver.ts` | `ScopeResolver` interface + shared types                                                                                     |
| `scope-resolution/pipeline/run.ts`            | Generic orchestrator                                                                                                         |
| `scope-resolution/pipeline/phase.ts`          | Pipeline-phase wrapper (deps: `parse`, `structure`)                                                                          |
| `scope-resolution/pipeline/registry.ts`       | `SCOPE_RESOLVERS` map                                                                                                        |
| `scope-resolution/passes/*.ts`                | Reference-resolution passes (receiver-bound, free-call fallback, compound-receiver, MRO, cross-file return-type propagation) |
| `scope-resolution/graph-bridge/*.ts`          | CLI-local translation from resolved references → `KnowledgeGraph` edges                                                      |
| `scope-resolution/scope/*.ts`                 | Generic scope-chain walkers + namespace targets                                                                              |
| `scope-resolution/workspace-index.ts`         | Build-once O(1) lookup index                                                                                                 |
| `languages/python/index.ts`                   | Python `ScopeResolver` hooks + known-limitation docs                                                                         |
| `languages/python/captures.ts`                | `emitPythonScopeCaptures` (honors cross-phase Tree cache)                                                                    |
| `languages/csharp/index.ts`                   | C# `ScopeResolver` hooks + known-limitation docs                                                                             |
| `languages/csharp/captures.ts`                | `emitCsharpScopeCaptures` (honors cross-phase Tree cache)                                                                    |
| `languages/csharp/namespace-siblings.ts`      | Cross-file implicit-namespace visibility hook (reads `treeCache`)                                                            |

### Performance notes

- **Cross-phase Tree cache**: the orchestrator's `treeCache` (`RunScopeResolutionInput.treeCache`) lets a scope-resolution per-language hook (`emitScopeCaptures`) reuse a tree instead of re-parsing. Workers leave it empty — Trees can't cross MessageChannels — so in normal (worker-pool) runs scope-resolution does NOT rely on it: workers serialize each file's `ParsedFile` (+ capture side-channel) and stream them in, so scope-resolution consumes the pre-extracted artifact rather than re-parsing on the main thread (§ Chunked parse-and-resolve). `PROF_SCOPE_RESOLUTION=1` emits hit/miss counters and a worker-engaged warning.
- **Typed relationship iteration**: heritage + MRO walk only the EXTENDS / IMPLEMENTS / HAS_METHOD edges via `iterRelationshipsByType`, not the full relationship map.
- **Workspace-resolution-index**: O(1) `findOwnedMember` / `findExportedDef` / `classScopeByDefId` built once per run.
- **Callable-value worklist**: dependency-indexed inclusion propagation is linear in a reverse-ordered copy-chain fixture; target/address sets cap at 32 and the whole worklist has a finite budget with no partial edge emission on exhaustion.
- **SCC-ordered cross-file return-type propagation** (PR #1050): `propagateImportedReturnTypes` walks `indexes.sccs` in reverse-topological order (leaves first), so multi-hop alias chains like `models.User → service.user → app.user` collapse to the terminal class in a single linear pass. Within each importer, the source module's `typeBindings` is chain-followed BEFORE mirroring (so we mirror terminal types, not intermediate refs), and the importer's own `typeBindings` is chain-followed AFTER mirroring (so local `const x = importedFn()` resolves before downstream importers run). Cyclic SCCs reach a partial fixpoint within a single pass without iterating to convergence — see the `ts-circular` cross-file-binding fixture which only asserts pipeline-no-throw. PROF output (`PROF_SCOPE_RESOLUTION=1`) splits `finalize` from `propagate` so quadratic regressions in the chain-follow surface independently.

---

## Language-agnostic graph feeding

18 languages → single unified graph. Four abstraction layers:

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

| Field                  | Purpose                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `extensions`     | Language identity and file matching                                                                                                                                                                                                                                                                                               |
| `treeSitterQueries`    | S-expression queries for AST extraction                                                                                                                                                                                                                                                                                           |
| `importSemantics`      | `named` / `wildcard-leaf` / `wildcard-transitive` / `namespace`                                                                                                                                                                                                                                                                   |
| `exportChecker`        | Public/exported symbol detection                                                                                                                                                                                                                                                                                                  |
| `typeConfig`           | Type annotation extraction rules                                                                                                                                                                                                                                                                                                  |
| `mroStrategy`          | `first-wins` / `c3` / `none`                                                                                                                                                                                                                                                                                                      |
| `descriptionExtractor` | Optional hook returning a symbol's doc-comment text as its `description`; feeds the embedding metadata header so doc-only terms are semantically searchable (issue #2270). Most languages register `createLeadingDocDescriptionExtractor` (shared, language-neutral; per-language comment/wrapper config passed at the call site) |
| `definitionPropertiesExtractor` | Optional language-owned hook for structured, clone-safe definition metadata. Shared ingestion persists these properties opaquely; the owning provider supplies the extraction semantics. |

18 providers in `languages/index.ts` via `satisfies Record<SupportedLanguages, LanguageProvider>` — missing a language is a compile error.

### Unified capture tags

Per-language tree-sitter queries use different AST node names but produce the **same semantic capture tags**: `@definition.class`, `@definition.function`, `@call.name`, `@import.source`, `@reference.inherits`. Downstream extraction needs no language branching. Defined in `tree-sitter-queries.ts`.

### Import resolution

Per-language import resolution runs through `ScopeResolver.resolveImportTarget`, registered in `SCOPE_RESOLVERS`. The shared orchestrator (`scope-resolution/pipeline/run.ts`) passes each language's workspace configuration to the resolver hook. The hook maps a parsed import to its target file or files; finalization links imports and materializes bindings for scope lookup.

Language-specific import helpers and namespace rules live beside each resolver in `languages/<language>/`. Language-neutral package-directory and suffix indexes, workspace indexes, and per-file-set caches live in `ingestion/utils/`; suffix lookups receive their ordered extension candidates from callers. The dormant `LanguageProvider.importResolver` field, adapter, and strategy factory have been removed; new languages implement the `ScopeResolver` hook.

### Chunked parse-and-resolve

`parse` processes files in ~20 MB byte-budget chunks to bound memory. Per chunk:

1. Worker pool dispatches files (the sole parse path — there is no sequential fallback; `skipWorkers`, `--workers 0`, and `GITNEXUS_WORKER_POOL_SIZE=0` are rejected with an actionable error)
2. Each worker: detect language → load grammar → run queries → return unified `ParseWorkerResult`
3. Synthesize wildcard bindings (`wildcard-synthesis.ts`)
4. Resolve imports
5. Collect `BindingAccumulator` entries for cross-file propagation

Inheritance edges are emitted later, by the scope-resolution phase (`preEmitInheritanceEdges` + `emitHeritageEdges`), not during `parse`.

Workers: `workers/worker-pool.ts`, `workers/parse-worker.ts`.

**Worker-serialized ParsedFiles (#2038).** To index very large repos (e.g. the Linux kernel) without OOM, the worker pool is the _sole_ parse path and workers serialize each file's `ParsedFile` (plus its capture side-channel) in parallel, streaming them to scope-resolution through a disk-backed store. Scope-resolution consumes the pre-extracted artifact instead of re-parsing every file on the main thread — tree-sitter's native input buffers are not GC-reclaimable, so the former main-thread re-parse leaked native memory until the process died. Pool creation is lazy / cache-miss-gated, so a warm all-cache-hit run replays cached worker output without spawning a worker (hence `usedWorkerPool` can be false even when the repo has parseable files).

### Inheritance and MRO

Inheritance is captured by the `@reference.inherits` tag and emitted by the scope-resolution phase: `preEmitInheritanceEdges` resolves each base in scope, then `emitHeritageEdges` writes the `EXTENDS`/`IMPLEMENTS` edges. A bare base the shared chain cannot bind falls back to `ScopeResolver.resolveImplicitInheritanceBase`, because same-namespace sibling bindings (`populateNamespaceSiblings`) are populated only after this pre-pass; without it a Java `class C extends B` with no import loses its edge whenever another package also declares a `B`. The phase then computes method resolution order via each `ScopeResolver`'s `buildMro` hook, feeding a `MethodDispatchIndex` used for owner-scoped lookups. Per-language strategy:

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
  ├── lbug.shadow    # Shadow sidecar (checkpoint staging)
  ├── lbug.lock      # Single-writer lock
  ├── lbug.wal.checkpoint, lbug.checkpoint.{intent,apply}.lock  # checkpoint-in-flight artifacts; left behind only by an interrupted checkpoint, consumed by the next writable open
  ├── lbug.{wal,shadow}.dirty-recovery  # parked sidecars from a crashed run; safe to delete
  ├── gitnexus.json  # lastCommit, indexedAt, stats (primary metadata file)
  └── meta.json      # legacy mirror of gitnexus.json, kept in sync (see MIGRATION.md)

~/.gitnexus/
  ├── registry.json  # Global repo registry (MCP discovery)
  └── stores/<key>/  # Shared sibling index store (see below)
      ├── caches/                         # parse cache + durable ParsedFile store
      ├── commits/<commit>-<featureKey>/  # one immutable graph per commit + settings
      └── checkouts/<slot>/               # one checkout's metadata, membership, and
                                          # private graph when it has local edits
```

The flat `<repo>/.gitnexus/` layout applies to a standalone repository and
whenever `GITNEXUS_STORAGE_PATH` / `GITNEXUS_STORAGE_ROOT` is set. A repository
with linked worktrees, and clones with the same `origin` URL, share one
`stores/<key>/` automatically (a clone opts out with `analyze --no-share`;
`GITNEXUS_SHARED_STORE=off` turns sharing off entirely). Each sharing checkout
keeps only a `.gitnexus/store.json` pointer to its store. Path resolution lives
in `shared-store.ts`.

Read-only opens self-heal an interrupted checkpoint: the refusal is
classified and cleared by one writable open (probe + `CHECKPOINT`) before
the read-only open is retried — see `sidecar-recovery.ts`
(`isReadOnlyCheckpointInProgressError`) and the
`lbug-interrupted-checkpoint-recovery` integration test.

Managed by `repo-manager.ts`.

### Automatic parse-cache identity

`core/parse-cache-identity.ts` derives full SHA-256 base and PDG identities
from sorted, framed logical paths and raw artifact bytes. It needs no Git
history, branch name, timestamp, network access, or contributor-assigned
semantic version. The boundary is intentionally conservative:

| Component                | Owned inputs                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base                     | `core/ingestion/**` except the PDG-only paths below, `core/tree-sitter/**`, `lib/**`, `core/graph/**`, and the audited support/storage files listed in `PARSE_CACHE_BASE_FILES` |
| PDG                      | `core/ingestion/cfg/**` and the classified COBOL extraction helpers `languages/cobol/flow.ts` and `flow-harvest.ts`; the shared COBOL tokenizer remains in base                 |
| Runtime and dependencies | The actual selected worker, shared source/compiled runtime or packaged `dist/_shared`, grammar/parser/native/loader dependency closure, and effective runtime/loader options    |

Source execution covers both source inputs and the compiled worker when that
is the selected entry. Editing source invalidates identity immediately; it
does not compile that worker. Run `npm run build` before expecting changed
worker facts. Installed packages derive identity from their shipped runtime
without requiring source, Git metadata, or a development compiler. Native
binary bytes and loader fallback candidates are covered even when package
versions stay the same. Unsupported resolution modes such as
`--preserve-symlinks` cannot be verified and disable persistent cache reuse.

Raw bytes mean comments and formatting inside owned roots can invalidate
reuse. Repository documentation, UI, unrelated CLI files, and unrelated
dependencies do not change this parser identity; broader analyzer freshness
rules still apply. New files inside an owned root are included automatically.
Inputs outside that boundary require an ownership decision and an update to
`test/unit/parse-cache-input-coverage.test.ts`, which audits imports, dynamic
loaders, runtime assets, and shared dependencies.

Both the worker-result index and durable `ParsedFile` index validate the base
identity before workers can be skipped. Physical chunk keys bind that identity
and sorted source path/content hashes; PDG-enabled chunks additionally bind
the PDG identity and resolved function-line cap. A CFG-only change therefore
does not invalidate ordinary chunks. Legacy numeric, missing, malformed, or
foreign identities miss; a concurrently pruned shard is also a miss.

`RepoMeta.parseCacheIdentity` records the effective parser identity for
unchanged-analysis and shared-current adoption checks. Analysis resolves it
once, stages fresh cache writes, and verifies artifacts again before
publication. A changed build rejects publication; failed staging or build
verification keeps the published cache pair. Cache-write failures after graph
publication warn without rolling back the successful graph. If identity is
unverifiable, the run uses bounded transient `ParsedFile` storage without
persistent cache reads or writes.
`--no-parse-cache` instead requests a cold parse and publishes its fresh cache
generation on success. FTS-only maintenance retains the old parser receipt.

These checks complement graph `SCHEMA_FINGERPRINT`, the analyzer runner
receipt, embedding preservation, and explicit wire-format checks such as the
V8 envelope and receiver-chain version. Benchmark semantic goldens still
require review of changed facts and pack membership; automatic compatibility
does not approve a new baseline.

## LadybugDB schema

Defined in `lbug/schema.ts`. Separate node tables per type, single `CodeRelation` table.

**Node tables:** File, Folder, Function, Class, Interface, Method, Constructor, CodeElement, Struct, Enum, Macro, Typedef, Union, Namespace, Trait, Impl, TypeAlias, Const, Static, Property, Record, Delegate, Annotation, Template, Module, Community, Process, Route, Tool, Section, Embedding.

**Relation types** (`CodeRelation.type`): CONTAINS, DEFINES, CALLS, IMPORTS, INHERITS, EXTENDS, IMPLEMENTS, USES, DECORATES, HAS_METHOD, HAS_PROPERTY, ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS, MEMBER_OF, STEP_IN_PROCESS, HANDLES_ROUTE, FETCHES, HANDLES_TOOL, ENTRY_POINT_OF, WRAPS, QUERIES, INJECTS, CONDITIONAL_ON, DECLARES, ADVISED_BY, BINDS_EVENT_HANDLER, EMITS_EVENT.

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

| Match quality                  | Confidence |
| ------------------------------ | ---------- |
| Exact parameter types match    | 1.0        |
| Arity match, types unavailable | 1.0        |
| Variadic vs fixed              | 0.7        |
| Insufficient info              | 0.7        |

## Related docs

- [MIGRATION.md](MIGRATION.md) — breaking changes and migration guidance
- [RUNBOOK.md](RUNBOOK.md) — operational commands and recovery
- [GUARDRAILS.md](GUARDRAILS.md) — safety boundaries for humans and agents
- [TESTING.md](TESTING.md) — how to run tests
- [docs/languages/objective-c-provider.md](docs/languages/objective-c-provider.md) — Objective-C provider behavior and limits
- `AGENTS.md` / `CLAUDE.md` — agent workflows and tool usage
