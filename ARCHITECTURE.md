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
| `group_sync` | Rebuild group Contract Registry (`contracts.json`) and bridge graph |

`query`, `context`, and `impact` are group-aware: pass `repo: "@<groupName>"` (or `"@<groupName>/<memberPath>"` to scope to one member) plus optional `service: "<monorepo/path>"`. Group-mode `query` merges per-repo results via Reciprocal Rank Fusion; group-mode `impact` runs the local walk in the chosen member and fans out across boundaries via the Contract Bridge (`gitnexus/src/core/group/cross-impact.ts`). The previously-planned `group_query`, `group_context`, `group_impact`, `group_contracts`, `group_status` MCP tools are intentionally not introduced — group-level state is exposed via resources instead:

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

## Call-Resolution DAG

Typed 6-stage pipeline in `call-processor.ts` (inside the `parse` phase) that resolves method/function calls and emits CALLS edges. Language behavior plugs in at two `LanguageProvider` hook points (stages 3–4); shared code names no languages. Scope: call resolution only — import resolution, type extraction, heritage, and symbol-table population live in other phases.

### Stages

```
extract-call ──▶ classify-form ──▶ infer-receiver ──▶ select-dispatch ──▶ resolve-target ──▶ emit-edge
     (1)              (2)            (3)  [hook]       (4)  [hook]         (5)                 (6)
```

| Stage | Produces | Location |
|-------|----------|----------|
| **extract-call** | `ExtractedCallSite` (name, form, receiver, argCount) | `call-extractors/` (per-language); runs in worker |
| **classify-form** | callForm (`free`/`member`/`constructor`) + arity | `call-analysis.ts` → `inferCallForm`; shared, runs in worker |
| **infer-receiver** | `ReceiverEnriched` (receiver type finalized) | `call-processor.ts`; shared default chain, then `inferImplicitReceiver` hook |
| **select-dispatch** | `DispatchDecision` (primary, fallback, ancestryView) | `selectDispatch` hook, falls back to shared default |
| **resolve-target** | `TieredCandidates` | `model/resolve.ts` → `lookupMethodByOwnerWithMRO` (MRO walk) |
| **emit-edge** | CALLS edge in graph | `call-processor.ts`; writes edge with confidence tier |

### Provider hooks

Both hooks are optional on `LanguageProvider`. Ruby is the only current implementer.

**`inferImplicitReceiver`** — called after shared infer-receiver defaults. Returns `ImplicitReceiverOverride | null`.

| | |
|---|---|
| Inputs | `calledName`, `callForm`, `receiverName`, `receiverTypeName`, `callNode` (AST), `filePath` |
| Non-null fields | `callForm`, `receiverName`, `receiverTypeName` (required); `receiverSource: 'implicit-self'` (fixed); `hint?` (opaque, passed to `selectDispatch`) |
| Null | Keep existing `ReceiverEnriched` state |

**`selectDispatch`** — called after infer-receiver (including hook). Returns `DispatchDecision | null`; null uses shared default (constructor → `primary:'constructor'`; typed receiver → `primary:'owner-scoped'`; else → `primary:'free'`).

| | |
|---|---|
| Inputs | `calledName`, `callForm`, `receiverName`, `receiverTypeName`, `receiverSource`, `hint` |
| Non-null fields | `primary: 'owner-scoped' \| 'free' \| 'constructor'`; `fallback?: 'free-arity-narrowed'`; `ancestryView?: 'instance' \| 'singleton'`; `hint?` |

**`DispatchDecision` field semantics:**
- `primary: 'owner-scoped'` — MRO walk from receiver's type; used when receiver type is known.
- `fallback: 'free-arity-narrowed'` — after owner-scoped miss, search free-call candidates by arity only (Ruby uses this for implicit-self calls that miss their owner's MRO).
- `ancestryView: 'singleton'` — walk singleton/class ancestry instead of instance ancestry (Ruby `def self.foo` bodies, so `extend`-ed methods are found).

### Adding language behavior

1. **Implicit receivers** — implement `inferImplicitReceiver`: return null if call already has a receiver; otherwise use `findEnclosingClassInfo` (`ast-helpers.ts`) to find the enclosing context, return `ImplicitReceiverOverride` with `receiverSource: 'implicit-self'`, and optionally set `hint` for `selectDispatch`.
2. **Custom dispatch** — implement `selectDispatch`: inspect `receiverSource` and `hint`, return `DispatchDecision` with `primary`, optional `fallback`, optional `ancestryView`; return null to keep shared defaults.
3. **MRO strategy** — confirm `mroStrategy` is `'first-wins'`, `'c3'`, `'ruby-mixin'`, or `'none'`; consumed by `lookupMethodByOwnerWithMRO`.

**Ruby example** (`languages/ruby.ts` + `utils/ruby-self-call.ts`): `inferImplicitReceiver` rewrites bare-identifier calls to `self.method` and sets `hint` to `'instance'`/`'singleton'`; `selectDispatch` uses hint for `ancestryView` and adds `fallback: 'free-arity-narrowed'` for implicit-self calls.

### Code references

| Module | Purpose |
|--------|---------|
| `core/ingestion/call-types.ts` | DAG types: `ReceiverEnriched`, `DispatchDecision`, `ImplicitReceiverOverride` |
| `core/ingestion/language-provider.ts` | Hook signatures: `inferImplicitReceiver`, `selectDispatch` |
| `core/ingestion/call-processor.ts` | `processCalls`: stages 3–6 |
| `core/ingestion/model/resolve.ts` | `lookupMethodByOwnerWithMRO`: stage 5 MRO walk |
| `core/ingestion/languages/ruby.ts` | Both hooks + `mroStrategy: 'ruby-mixin'` |
| `core/ingestion/utils/ruby-self-call.ts` | Bare-call rewrite for `inferImplicitReceiver` |

### Coexistence with the scope-resolution pipeline

The Call-Resolution DAG is the **legacy path**. RFC #909 Ring 3 introduces a parallel **scope-resolution pipeline** (next section) that replaces stages 1–6 with a scope-indexed registry lookup. Both paths ship side-by-side and are gated per-language via `MIGRATED_LANGUAGES` + the `REGISTRY_PRIMARY_<LANG>` env var.

- **Unmigrated language** → Call-Resolution DAG runs; scope-resolution phase is a no-op.
- **Migrated language** (currently: Python, C#) → scope-resolution owns CALLS/ACCESSES/USES emission; the legacy DAG gates off for that language via `isRegistryPrimary(lang)` checks in `call-processor.ts` and `import-processor.ts`.
- `import-processor` still populates `importMap` for migrated languages — heritage's `ctx.resolve` reads it to disambiguate parent classes. Only edge emission is gated.
- CI runs BOTH paths for every migrated language on every PR (`.github/workflows/ci-scope-parity.yml`); both must pass.

#### Same-graph guarantee

Edges emitted by the scope-resolution pipeline and edges emitted by the legacy DAG are indistinguishable to downstream consumers (MCP tools, HTTP API, embeddings, group bridge):

- **Node identity** — both paths use `generateId(...)` from `lib/utils.ts`, the same qualified-name keyspace, and the same node labels (`File`, `Folder`, `Class`, `Method`, `Function`, …). Overload disambiguation suffixes `parameterTypes` into the id consistently — see `scope-resolution/graph-bridge/ids.ts` and the legacy emitter in `call-processor.ts`.
- **Edge vocabulary** — both paths emit the same reasons: `'import-resolved' | 'global' | 'local-call' | 'same-file' | 'interface-dispatch' | 'read' | 'write'`. Migrating a language must not change which reasons consumers see for previously-resolved edges.
- **Confidence tier** — both paths attach a numeric `confidence` to each edge using the same scale.

The CI parity workflow (`.github/workflows/ci-scope-parity.yml`) runs both paths against every migrated language's fixture corpus and fails on any divergence.

#### Semantic-model source of truth

Two independent invariants.

**ParsedFile = the AST-level truth.** `ParsedFile` (`gitnexus-shared/src/scope-resolution/parsed-file.ts`) is the single per-file artifact both resolution paths consume. Scope-resolution passes MUST NOT build a parallel parse representation. If a per-language hook needs AST-level facts that `ParsedFile` doesn't expose, it should reuse the orchestrator's `treeCache` (`RunScopeResolutionInput.treeCache`) rather than re-invoking `parser.parse(...)` on its own — the C# `populateNamespaceSiblings` hook is the reference implementation of this pattern.

**SemanticModel = the symbol-level truth.** `SemanticModel` (`gitnexus/src/core/ingestion/model/semantic-model.ts`) is the authoritative store for every symbol-indexed lookup (by `nodeId`, `simpleName`, `qualifiedName`, or `filePath`). Both paths read from here:

- Legacy Call-Resolution DAG → `call-processor` Tier 1/2/3 via `model.symbols.lookupExactAll`, `model.methods.lookupMethodByName`, `model.types.lookupClassByName`, `lookupMethodByOwnerWithMRO`.
- Scope-resolution pipeline → `findOwnedMember`, `pickOverload`, `findExportedDefByName` all consult `model.methods` / `model.fields` / `model.symbols`.

The scope-resolution pipeline additionally carries `WorkspaceResolutionIndex` for `Scope`-valued lookups (`classScopeByDefId`, `moduleScopeByFile`) that `SemanticModel` structurally cannot hold. No symbol-indexed duplicates exist outside `SemanticModel`.

**Write / read phase contract.** The model is mutable during three ordered phases and read-only afterward:

```
 Phase 1: legacy parse     ──► symbolTable.add fans into types/methods/fields
 Phase 2: scope-resolution ──► reconcileOwnership() registers corrected ownerIds
 Phase 3: finalize         ──► model.attachScopeIndexes(bundle) — one-shot freeze
 ─────────────────────────── phase boundary ───────────────────────────
 Read phase: all resolution passes + MCP + HTTP + embeddings see
             SemanticModel (read-only handle); writes are type-errors.
```

`runScopeResolution` narrows `MutableSemanticModel` → `SemanticModel` at the phase boundary so downstream passes physically cannot mutate the model even accidentally.

**Transitional: reconciliation pass.** `reconcileOwnership` (`scope-resolution/pipeline/reconcile-ownership.ts`) is a shim for languages whose legacy extractor doesn't resolve `enclosingClassId` at parse time (Python class-body methods are the canonical case). It walks `parsed.localDefs[i].ownerId` after `populateOwners` and registers any missed methods/fields into the model. Idempotent — safe to re-run, safe alongside languages whose legacy extractor already carries `ownerId` (C#).

The architectural end state is for every language's parse-time extractor to emit the correct `ownerId` directly, making reconciliation a no-op (tracked as a follow-up refactor). The dev-mode validator `validateOwnershipParity` surfaces any drift via `onWarn` under `NODE_ENV !== 'production' && VALIDATE_SEMANTIC_MODEL !== '0'`.

References: `semantic-model.ts` file-head (full write/read contract); `contract/scope-resolver.ts` Contract Invariant I9 (scope-resolution-side rule).

---

## Scope-Resolution Pipeline (RFC #909 Ring 3)

Language-agnostic registry-primary resolver. Replaces the Call-Resolution DAG for migrated languages. Adding a language is one interface implementation (`ScopeResolver`) plus two registrations — no changes to shared code, no new pipeline phase.

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
Pipeline phase: `scopeResolutionPhase` in `scope-resolution/pipeline/phase.ts` — iterates `SCOPE_RESOLVERS ∩ MIGRATED_LANGUAGES`, reads per-file Trees from the parse phase's `scopeTreeCache`, disposes the cache at the end.

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
3. Add the language to `MIGRATED_LANGUAGES` in `registry-primary-flag.ts` when the shadow-harness corpus parity ≥ 99% fixtures / ≥ 98% corpus.

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
| `registry-primary-flag.ts` | `MIGRATED_LANGUAGES` set + `isRegistryPrimary(lang)` |
| `languages/python/index.ts` | Python `ScopeResolver` hooks + known-limitation docs |
| `languages/python/captures.ts` | `emitPythonScopeCaptures` (honors cross-phase Tree cache) |
| `languages/csharp/index.ts` | C# `ScopeResolver` hooks + known-limitation docs |
| `languages/csharp/captures.ts` | `emitCsharpScopeCaptures` (honors cross-phase Tree cache) |
| `languages/csharp/namespace-siblings.ts` | Cross-file implicit-namespace visibility hook (reads `treeCache`) |

### Performance notes

- **Cross-phase Tree cache**: parse phase writes Trees into `scopeTreeCache` (separate from the chunk-local `astCache`) ONLY for languages with `emitScopeCaptures`. Scope-resolution reads from it to skip the second parse. Cleared at end of the phase. Workers leave the cache empty — Trees can't cross MessageChannels; cache miss = fresh parse. `PROF_SCOPE_RESOLUTION=1` emits hit/miss counters and a worker-engaged warning.
- **Typed relationship iteration**: heritage + MRO walk only the EXTENDS / IMPLEMENTS / HAS_METHOD edges via `iterRelationshipsByType`, not the full relationship map.
- **Workspace-resolution-index**: O(1) `findOwnedMember` / `findExportedDef` / `classScopeByDefId` built once per run.
- **SCC-ordered cross-file return-type propagation** (PR #1050): `propagateImportedReturnTypes` walks `indexes.sccs` in reverse-topological order (leaves first), so multi-hop alias chains like `models.User → service.user → app.user` collapse to the terminal class in a single linear pass. Within each importer, the source module's `typeBindings` is chain-followed BEFORE mirroring (so we mirror terminal types, not intermediate refs), and the importer's own `typeBindings` is chain-followed AFTER mirroring (so local `const x = importedFn()` resolves before downstream importers run). Cyclic SCCs reach a partial fixpoint within a single pass without iterating to convergence — see the `ts-circular` cross-file-binding fixture which only asserts pipeline-no-throw. PROF output (`PROF_SCOPE_RESOLUTION=1`) splits `finalize` from `propagate` so quadratic regressions in the chain-follow surface independently.

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
