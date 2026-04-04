# RFC: Cross-Index Impact Analysis — Repository Groups

**Date:** 2026-03-31
**Status:** Draft
**Author:** @ivkond
**Related Issues:** [#256](https://github.com/abhigyanpatwari/GitNexus/issues/256), [#306](https://github.com/abhigyanpatwari/GitNexus/issues/306), [#77](https://github.com/abhigyanpatwari/GitNexus/issues/77)

## Summary

Add cross-repository impact analysis to GitNexus by allowing users to organize repositories into logical groups with hierarchical naming (e.g., `hr/hiring/backend`, `hr/hiring/ui`). When analyzing blast radius, the system looks not only into the current repo's index but also into neighboring repos in the group, connected through a Contract Registry of shared touch-points (HTTP routes, gRPC services, message topics, shared library exports).

## Motivation

Modern applications are split across multiple repositories: frontend, BFF, backend, ML pipeline, workflow engines, shared libraries. GitNexus currently indexes each repo in isolation — the knowledge graph captures call chains within each repo, but connections across repo boundaries are lost.

When a developer changes a DTO in the backend, they have no way to know which frontend components, BFF handlers, or downstream services will break — without manually grepping across repos or relying on LLM inference.

### Use Cases

1. **Developer:** "I'm changing `UserDTO.email` in backend — what breaks in the UI and BFF?"
2. **Architect:** "Show me all dependencies between services in the `hr` group."
3. **CI/CD:** Pre-merge check — does this PR affect contracts consumed by other repos?

## Design: Hybrid — Lazy Virtual Graph (Approach C)

Each repo keeps its own isolated index (`.gitnexus/lbug`). A lightweight metadata layer on top stores group configuration and a Contract Registry of extracted touch-points. Cross-repo impact works by fan-out: local impact in the current repo, then follow cross-links to run local impact in neighboring repos.

### Why Not a Unified Super-Graph?

Merging all indexes into one KuzuDB/LadybugDB would give full Cypher across the group, but:
- O(n) rebuild time when any single repo is re-indexed
- Multiplicative graph size growth
- Name collisions between repos
- Breaks the current "each repo is independent" model

The hybrid approach is incremental, non-destructive, and minimizes changes to the core indexing pipeline.

### Prerequisites and Current State

**Current public surface (no `group` surface exists today):**
- CLI commands: `analyze`, `serve`, `wiki`, `status`, `clean`, `list`, `impact`, `cypher`, `mcp` ([index.ts](gitnexus/src/cli/index.ts))
- MCP tools: 7 tools — `list_repos`, `query`, `cypher`, `context`, `impact`, `detect_changes`, `rename` ([tools.ts](gitnexus/src/mcp/tools.ts))
- Shape guards: tool count asserted in [tools.test.ts](gitnexus/test/unit/tools.test.ts), resource count in [resources.test.ts](gitnexus/test/unit/resources.test.ts)

**Graph schema gaps** — the following entities referenced in this RFC do NOT currently exist in the LadybugDB schema ([schema.ts](gitnexus/src/core/lbug/schema.ts)):
- No `Route` node label
- No `HANDLES_ROUTE` or `FETCHES` relation types
- Route data during ingestion is ephemeral — reduced to `CALLS` edges with `reason: "laravel-route"` ([parse-worker.ts:1145](gitnexus/src/core/ingestion/workers/parse-worker.ts), [call-processor.ts:642](gitnexus/src/core/ingestion/call-processor.ts))
- Import graph stores file→file edges, not raw package coordinates ([import-processor.ts:343](gitnexus/src/core/ingestion/import-processor.ts))
- `.proto` files are not a supported language ([supported-languages.ts](gitnexus/src/config/supported-languages.ts))

**Impact tool limitation** — current `impact` resolves symbols by name with `LIMIT 1` ([local-backend.ts:1347-1352](gitnexus/src/mcp/local/local-backend.ts)), not by UID. This creates false positives for common names.

**Existing tech debt** — `impact` tool description documents `HAS_METHOD/OVERRIDES` relation types ([tools.ts:203](gitnexus/src/mcp/tools.ts)) but runtime filter only allows 4 types ([local-backend.ts:50](gitnexus/src/mcp/local/local-backend.ts)). Should be resolved before extending `group_impact`.

These gaps define the **prerequisite work** required before the group features can function. See Section 8: Implementation Prerequisites.

---

## Section 1: Concepts and Terminology

### Repository Group

A logical group of related repositories with hierarchical path-like addressing. Names support arbitrary nesting depth:

```
company/
  hr/
    hiring/
      backend        <- repo (leaf)
      ui             <- repo (leaf)
    payroll/
      backend        <- repo (leaf)
      camunda        <- repo (leaf)
  sales/
    admin/
      ui             <- repo (leaf)
      bff            <- repo (leaf)
    crm/
      backend        <- repo (leaf)
```

A **group** is any non-leaf node in the hierarchy. `company/hr` is a group, `company/hr/hiring` is also a group, `company/hr/hiring/backend` is a repo (leaf). Operations on a group (impact, query) cascade to all nested repos.

### Contract

A touch-point between repositories. Types:

| Type | Description | Example |
|------|-------------|---------|
| **HTTP Route** | REST/GraphQL endpoint | `GET /api/users` |
| **gRPC Service** | Proto service + method | `UserService.GetUser` |
| **Message Topic** | Kafka/RabbitMQ topic | `user.created` |
| **Shared Library Export** | Package export | `@hr/common::UserDTO` |
| **Custom** | User-defined from manifest | `custom::payroll-calc-v2` |

### Contract Registry

A lightweight JSON index of extracted contracts from all repos in a group. Stored at `~/.gitnexus/groups/<root-group>/contracts.json`.

### Cross-Link

An edge between a contract provider in one repo and a contract consumer in another. Confidence levels:

| Match Type | Confidence | Source |
|-----------|-----------|--------|
| `exact` | 1.0 | Identical contract IDs |
| `manifest` | 1.0 | Explicitly declared in group.yaml (bypasses matching cascade) |
| `bm25` | 0.85-0.95 | BM25 text similarity |
| `embedding` | 0.5-0.85 | Semantic vector similarity |

---

## Section 2: Storage and Group Configuration

### File Structure

```
~/.gitnexus/
  registry.json                  <- existing (unchanged)
  groups/
    company/
      group.yaml                 <- root group definition
      contracts.json             <- Contract Registry for entire subtree
      embeddings.bin             <- embedding vectors for contracts (optional)
```

### group.yaml

```yaml
version: 1
name: company
description: "All company microservices"

# Mapping: path in group -> repo name from registry.json
# Repo can also be referenced by filesystem path or git remote URL
# for portability across machines where registry names may differ.
repos:
  hr/hiring/backend: hr-hiring-backend
  hr/hiring/ui: hr-hiring-ui
  hr/payroll/backend: hr-payroll-api
  sales/admin/ui: sales-admin-frontend
  sales/admin/bff: sales-admin-bff
  sales/crm/backend: sales-crm

# Explicit links (manifest) for connections auto-detect can't find.
# Manifest links bypass the matching cascade entirely (confidence 1.0).
# `role` specifies the role of the `from` repo in this contract.
links:
  - from: hr/payroll/backend
    to: hr/hiring/backend
    type: topic
    contract: "employee.hired"
    role: provider       # provider | consumer (role of `from` repo)

  - from: sales/admin/bff
    to: sales/crm/backend
    type: http
    contract: "/api/v2/leads/*"
    role: consumer       # sales/admin/bff consumes this route from sales/crm/backend

# Cross-language package coordinate mapping.
# Keys under each repo are free-form ecosystem identifiers,
# supporting any package manager (npm, maven, pypi, go, nuget, crates, gems, etc.)
packages:
  hr/common:
    npm: "@hr/common"
    maven: "com.hr.common"
    pypi: "hr-common"
    go: "github.com/hr/common"
    nuget: "Hr.Common"

# Auto-detection settings
detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: true

# Matching cascade tuning
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
```

### contracts.json

Auto-generated by `gitnexus group sync`. Written atomically (write to temp file, then rename) to prevent torn reads during concurrent `group_impact` queries.

**Version migration:** On version mismatch, `group_impact` and `group_contracts` fail with a message to re-run `group sync`. No automatic migration — the file is fully regenerated on each sync anyway.

**Staleness detection** uses two complementary checks for different purposes:

1. **Repo index staleness** (commit-based, consistent with existing [staleness.ts:20](gitnexus/src/mcp/staleness.ts)): compares `meta.json.lastCommit` vs `git rev-parse HEAD`. Answers: "is this repo's index behind its own HEAD?" Used by `group sync` before extraction and by `group status`.

2. **Contract Registry staleness** (indexedAt-based): compares `repoSnapshots[repo].indexedAt` in `contracts.json` against the repo's current `meta.json.indexedAt`. Answers: "was this repo re-indexed after the last `group sync`?" Used by `group_impact` before fan-out and by `group status`.

These are different questions and intentionally use different heuristics:
- Check 1 catches: repo has new commits but hasn't been re-indexed
- Check 2 catches: repo was re-indexed (possibly with schema changes) but `group sync` hasn't been re-run

```json
{
  "version": 1,
  "generatedAt": "2026-03-31T10:00:00Z",
  "repoSnapshots": {
    "sales/crm/backend": { "indexedAt": "2026-03-30T21:14:14Z", "lastCommit": "5838fb8d" },
    "sales/admin/bff": { "indexedAt": "2026-03-30T19:05:00Z", "lastCommit": "a1b2c3d4" }
  },
  "contracts": [
    {
      "id": "http::GET::/api/v2/leads",
      "type": "http",
      "repo": "sales/crm/backend",
      "symbolName": "LeadController.list",
      "symbolUid": "abc123",
      "symbolRef": { "filePath": "src/controller/LeadController.java", "name": "LeadController.list" },
      "role": "provider",
      "meta": {
        "method": "GET",
        "path": "/api/v2/leads",
        "pathSegments": ["api", "v2", "leads"],
        "extractionStrategy": "source_scan"
      }
    },
    {
      "id": "http::GET::/api/v2/leads",
      "type": "http",
      "repo": "sales/admin/bff",
      "symbolName": "fetchLeads",
      "symbolUid": "def456",
      "symbolRef": { "filePath": "src/api/leads.ts", "name": "fetchLeads" },
      "role": "consumer",
      "meta": {
        "method": "GET",
        "path": "/api/v2/leads",
        "pathSegments": ["api", "v2", "leads"],
        "extractionStrategy": "source_scan"
      }
    }
  ],
  "crossLinks": [
    {
      "from": { "repo": "sales/admin/bff", "symbolUid": "def456", "symbolRef": { "filePath": "src/api/leads.ts", "name": "fetchLeads" } },
      "to": { "repo": "sales/crm/backend", "symbolUid": "abc123", "symbolRef": { "filePath": "src/controller/LeadController.java", "name": "LeadController.list" } },
      "type": "http",
      "contractId": "http::GET::/api/v2/leads",
      "matchType": "exact",
      "confidence": 1.0
    }
  ]
}
```

### Contract ID Format

`<type>::<discriminator>`:

| Type | Discriminator | Example |
|------|---------------|---------|
| http | `METHOD::path` | `http::GET::/api/v2/leads` |
| grpc | `package.Service/Method` | `grpc::hr.UserService/GetUser` |
| topic | `topic_name` | `topic::employee.hired` |
| lib | `package::export` | `lib::@hr/common::UserDTO` |
| custom | free-form from manifest | `custom::payroll-calc-v2` |

---

## Section 3: Contract Extraction

### Extractor Architecture

Contract extraction uses a **two-tier strategy**: graph queries where the data is available in LadybugDB, and lightweight source scanning where it is not. This is necessary because the current graph does not store all the data extractors need (see Prerequisites).

```
ContractExtractor (interface)
  |-- HttpRouteExtractor        <- graph (CALLS with route reason) + source scan (fetch/axios patterns)
  |-- GrpcExtractor             <- source scan only (.proto files, not in supported languages)
  |-- MessageTopicExtractor     <- graph (CALLS) + source scan (publish/subscribe patterns)
  |-- SharedLibExtractor        <- graph (IMPORTS file->file) + packages map from group.yaml
  |-- ManifestExtractor         <- group.yaml links (no graph/source access)
```

### ContractExtractor Interface

```typescript
interface ContractExtractor {
  type: ContractType;  // 'http' | 'grpc' | 'topic' | 'lib' | 'custom'
  canExtract(repoHandle: RepoHandle): Promise<boolean>;
  /**
   * Extract contracts. Gets both db connection (for graph queries)
   * and repoPath (for source file scanning when graph data is insufficient).
   */
  extract(db: LbugConnection, repoPath: string): Promise<ExtractedContract[]>;
}

interface ExtractedContract {
  contractId: string;
  type: ContractType;
  role: 'provider' | 'consumer';
  symbolUid: string;                                // may be empty for source-scan-only results
  symbolRef: { filePath: string; name: string };     // stable fallback for UID
  symbolName: string;                                // human-readable, used in BM25/embedding
  confidence: number;                                // extraction confidence (1.0 graph, 0.3-0.8 source scan)
  meta: Record<string, unknown>;
}
```

Note: `symbolName` is a denormalized convenience field (same as `symbolRef.name`) used in BM25 document building and embedding input. `confidence` reflects extraction quality — graph-derived contracts get 1.0, source-scanned get lower confidence depending on pattern reliability.

### HttpRouteExtractor

**Current graph state:** No `Route` nodes, no `HANDLES_ROUTE`/`FETCHES` edges. Route handlers are recorded as `CALLS` edges with `reason: "laravel-route"` (Laravel only). Frontend fetch calls are not in the graph at all.

**Provider extraction (backend)** — two strategies:

Strategy A — Graph query for existing route-annotated CALLS edges (auxiliary only):
```cypher
MATCH (source)-[r:CodeRelation {type: 'CALLS'}]->(target)
WHERE r.reason CONTAINS 'route'
RETURN source.name, source.uid, source.filePath,
       target.name, target.uid, target.filePath,
       r.reason, r.confidence
```
**Limitation:** Current graph stores only `reason: "laravel-route"` without HTTP method or path ([call-processor.ts:685](gitnexus/src/core/ingestion/call-processor.ts)). Strategy A can identify that a symbol is a route handler (useful for filtering) but **cannot reconstruct the contract ID** (`http::METHOD::path`). Contract ID must come from Strategy B (source scan). Strategy A serves as a hint to narrow source scan scope.

Strategy B — Source scan for route decorator/annotation patterns (primary source of contract ID):
- Scan files matching common patterns: `*Controller.*`, `*Router.*`, `routes/*`
- Regex match for route annotations: `@GetMapping`, `@app.route`, `router.get`, `@Controller`/`@RequestMapping` (Java/Spring), `Route::get` (Laravel)
- Extract HTTP method + path from annotation arguments
- Resolve to nearest symbol in graph by file + line number

**Consumer extraction (frontend/BFF)** — source scan only (not in graph):
- Scan `.ts`, `.tsx`, `.js`, `.jsx`, `.vue`, `.svelte` files
- Regex match for fetch patterns: `fetch('...')`, `axios.get('...')`, `$.ajax`, `http.get`
- Extract HTTP method (from function name or options) + URL path
- Resolve calling function from graph by file + approximate line range

**Path normalization:** strip trailing slash, collapse path params (`/users/:id`, `/users/{id}`, `/users/[id]` -> `/users/{param}`).

**Meta fields:**
```json
{
  "method": "GET",
  "path": "/api/v2/users",
  "pathSegments": ["api", "v2", "users"],
  "extractionStrategy": "source_scan",
  "handlerName": "UserController.list",
  "paramNames": ["limit", "offset"]
}
```

Note: `responseKeys`/`accessedKeys` from the original design require response shape tracking which does not exist in the current graph. These fields are omitted from MVP and listed in Future Work as a prerequisite for shape_check cross-repo integration.

**Contract ID:** `http::{METHOD}::{normalized_path}`

### GrpcExtractor

`.proto` files are not a supported language in GitNexus — no symbols are extracted during indexing. This extractor is **source-scan only**.

- Scan for `.proto` files in repo directory
- Parse `service` and `rpc` declarations with regex
- For consumers: scan source files for generated stub/client class usage patterns

In MVP, `canExtract` returns `true` only when `.proto` files exist in the repo's file tree. Extraction confidence is lower (0.7) due to regex-only parsing.

**Contract ID:** `grpc::{package}.{Service}/{Method}`

### MessageTopicExtractor

**Current graph state:** `ACCESSES` relation type does not exist in the current schema ([schema.ts:29](gitnexus/src/core/lbug/schema.ts)). This extractor is **source-scan only**.

Topic name resolution cascade (all via source scanning):

1. **String literal** — `publish("user.created", ...)` -> topic name directly (confidence 1.0)
2. **Constant** — `publish(TOPICS.USER_CREATED, ...)` -> source-scan the constant definition file (follow import path from source, not graph ACCESSES edge) to find the string value. If constant is in the same file or a direct import, resolution succeeds (confidence 0.9). If indirect or dynamic import chain, falls through to step 4.
3. **Env variable** — `publish(process.env.USER_TOPIC, ...)` -> cannot auto-resolve, recorded as `topic::${USER_TOPIC}` with `confidence: 0.3` and env name in meta
4. **Dynamic / unresolvable** — `publish(getTopicName(), ...)` -> **no contract created**, warning emitted:

```
WARNING: sales/crm/backend: found publish() call at src/events/publisher.ts:42
  but could not resolve topic name (dynamic expression).
  -> Add this link explicitly in group.yaml:
    links:
      - from: sales/crm/backend
        to: <consumer-repo>
        type: topic
        contract: "<topic-name>"
        role: provider
```

Meta includes `resolution` field for transparency: `"literal"`, `"constant"`, `"env"`, `"unresolved"`.

### SharedLibExtractor

**Current graph state:** IMPORTS edges are file→file only ([import-processor.ts:343](gitnexus/src/core/ingestion/import-processor.ts)), without raw package coordinates. External imports (to packages outside the repo) are not in the graph.

**Strategy — hybrid graph + source scan:**

1. **Source scan** — read import statements from source files to get raw package coordinates (e.g., `import { UserDTO } from '@hr/common'`, `import com.hr.common.UserDTO`)
2. **Match against `packages` map** from group.yaml:

```yaml
packages:
  hr/common:
    npm: "@hr/common"
    maven: "com.hr.common"
    pypi: "hr-common"
    go: "github.com/hr/common"
```

3. **Resolve symbols** — once the target repo is identified via package match, look up the imported symbol name in that repo's graph to get the `symbolUid`
4. Without packages map — fallback: search import strings containing another group repo's name (fuzzy, low confidence 0.6)

Contract ID normalized to group path: `lib::hr/common::UserDTO` — same contract regardless of import language.

Warning for unmatched imports:

```
WARNING: hr/hiring/backend: import "com.acme.utils.DateHelper" at src/Main.java:3
  matches no known package in group. If this is a shared library, add to packages:
    packages:
      <repo-path>:
        maven: "com.acme.utils"
```

### ManifestExtractor

Reads `links` section from `group.yaml` directly. Manifest links **bypass the matching cascade entirely** — they are pre-matched by definition and always produce cross-links with confidence 1.0.

Role mapping from `group.yaml`:
- `role: provider` on `from` repo means `from` provides the contract, `to` consumes it
- `role: consumer` on `from` repo means `from` consumes the contract, `to` provides it

For each manifest link, the extractor creates two `ExtractedContract` entries (one provider, one consumer) and one pre-matched cross-link.

**Symbol resolution during sync** (not deferred): When sync processes manifest links, it attempts to resolve the contract identifier against the graph of each referenced repo. For example, manifest `contract: "employee.hired"` with `type: topic` — sync searches for symbols in the `from` and `to` repos that reference this topic name (using the same strategies as MessageTopicExtractor). If resolution succeeds, `symbolUid` and `symbolRef` are populated. If it fails, the contract is created with empty `symbolUid` and `symbolRef: { filePath: "", name: contract }`. During `group_impact` Phase 2, step 4c-iv handles these entries: it searches the target repo's graph for symbols matching the contractId pattern (e.g., route handlers matching the HTTP path).

### Sync Execution Order

```
1. For each repo in group (sequential, LadybugDB pool limit):
   a. Open LadybugDB (read-only)
   b. For each enabled extractor (http, grpc, topic, lib):
      canExtract(repo)? -> extract(db, repoPath)
   c. Close connection

2. ManifestExtractor — add links from group.yaml

3. Matching cascade:
   a. Exact match by contract ID -> crossLinks (confidence 1.0)
   b. BM25 by contract ID + symbol + meta -> crossLinks (confidence 0.85-0.95)
   c. Embedding fallback by symbol + meta -> crossLinks (confidence 0.5-0.85)

4. Write contracts.json
```

---

## Section 4: Cross-Index Impact

### Algorithm — Two Phases

**Prerequisite: UID-based impact resolution.** The current `impact` tool resolves symbols by name with `LIMIT 1` ([local-backend.ts:1347-1352](gitnexus/src/mcp/local/local-backend.ts)). For `group_impact` Phase 2 fan-out, where the target symbol is known by UID from the Contract Registry, this creates false positives on common names (e.g., `getUser` may match the wrong overload). Phase 2 requires an internal `impactByUid(uid, direction)` variant that resolves by UID directly. This is listed as a prerequisite in Section 8.

**Phase 1: Local impact** — blast radius within current repo (existing `impact` tool, unchanged):

```
UserDTO (hr/hiring/backend)
  d=1: UserController.getUser, UserMapper.toDTO, UserService.findById
  d=2: HiringRouter (/api/v2/users/:id)
```

**Phase 2: Cross-boundary fan-out** — expand through Contract Registry:

```
1. Close Phase 1 db connection (free pool slot for fan-out)
2. Collect all symbol UIDs from Phase 1 result
3. For each symbol — lookup in contracts.json:
   a. Primary: match by symbolUid
   b. Fallback: if UID not found (repo re-indexed since last sync),
      match by symbolRef (filePath + name)
   c. If neither matches — skip with warning "contracts.json may be stale, re-run group sync"
4. For each found crossLink (sorted by confidence desc):
   a. Determine traversal side based on direction:
      - upstream ("what depends on me"): follow links where the changed symbol
        is the PROVIDER — look up consumers in other repos
        (crossLinks where `to.symbolUid` matches phase1 symbol → fan-out to `from.repo`)
      - downstream ("what do I depend on"): follow links where the changed symbol
        is the CONSUMER — look up providers in other repos
        (crossLinks where `from.symbolUid` matches phase1 symbol → fan-out to `to.repo`)
   b. Open LadybugDB of target repo (sequential, reusing pool)
   c. Resolve target symbol in target repo's graph:
      i.   Try symbolUid (fast, exact)
      ii.  Fallback: symbolRef filePath + name
      iii. Fallback: symbolRef name only (warn if ambiguous)
      iv.  Fallback (for manifest links with empty symbolRef): search target repo's graph
           for symbols matching the contractId pattern (e.g., for http contract, find
           route handlers matching the path; for topic, find publish/subscribe calls
           matching the topic name). This is a slower text-based search in the graph.
      v.   If all fail: skip with staleness warning
   d. Run local impactByUid(resolvedUid, direction) in that repo
   e. Tag results as cross-repo (with crossLink confidence)
   f. Close connection before opening next repo
5. DO NOT recurse further — one hop through boundary (default)
```

### Symbol UID Stability

Symbol UIDs in LadybugDB may change when a repo is re-indexed. Cross-links store both `symbolUid` (fast lookup) and `symbolRef` (stable fallback: filePath + name).

Resolution cascade when `symbolUid` lookup fails:
1. **filePath + name** — match by both fields together (stable unless file was moved)
2. **name only** — if filePath match fails, search by name alone. If multiple candidates found, emit warning: "Ambiguous symbol resolution for {name}, {count} candidates — re-run `group sync`" and skip the cross-link
3. **Neither** — skip with staleness warning

### Why One Hop Default

Transitive cross-boundary chains (UI -> BFF -> Backend -> ML) are exponentially expensive and yield decreasing confidence. One hop covers the primary scenario. `--cross-depth 2+` is reserved for Future Work — the flag is accepted but capped at 1 in MVP with a message: "Multi-hop cross-boundary traversal is not yet implemented. Using --cross-depth 1."

### Response Format

**`impact` tool** — unchanged. Returns exactly the same response as today.

**`group_impact` tool** — new tool, new response type:

```typescript
interface GroupImpactResult {
  local: ImpactResult;           // everything the existing impact returns
  group: string;                 // group name
  cross: CrossRepoImpact[];     // empty if no cross-links found
  outOfScope: OutOfScopeLink[];  // cross-links not followed due to --subgroup filter
  truncated: boolean;            // true if timeout reached before all repos processed
  truncatedRepos: string[];      // repos not reached due to timeout
  summary: {
    direct: number;                // existing impact field name
    processes_affected: number;    // existing impact field name ([local-backend.ts:1477])
    modules_affected: number;     // existing impact field name
    cross_repo_hits: number;      // new field, 0 if no cross-links
  };
  risk: RiskLevel;              // recalculated with cross-repo factors
}

interface OutOfScopeLink {
  from: string;                  // repo path
  to: string;                   // repo path
  contractId: string;
  confidence: number;
}

interface CrossRepoImpact {
  repo: string;                 // registry name
  repo_path: string;            // path in group hierarchy
  contract: {
    id: string;
    type: ContractType;
    match_type: 'exact' | 'manifest' | 'bm25' | 'embedding';
    confidence: number;
  };
  by_depth: Record<string, SymbolHit[]>;
  affected_processes: string[];
}
// Note: JSON field naming uses snake_case to match existing impact output style
// ([local-backend.ts:1477](gitnexus/src/mcp/local/local-backend.ts))
```

Clients using `impact` are unaffected. Two fully independent tool registrations in MCP.

### Risk Scoring

| Factor | Risk contribution |
|--------|------------------|
| d=1 local callers > 5 | +MEDIUM |
| Any cross-repo hit with confidence >= 0.85 | +HIGH |
| Cross-repo hit with confidence < 0.85 | +MEDIUM + "verify manually" warning |
| Cross-repo hits in >= 3 repos | +CRITICAL |
| Affected process with > 10 steps | +HIGH |

### Concurrency and Performance

LadybugDB pool limit = 5 simultaneous databases. Fan-out strategy:

```
Phase 1: local impact          -> 1 db connection, released after completion
Phase 2: contract registry     -> in-memory (JSON), no db
Phase 3: fan-out impacts       -> sequential, one connection at a time
                                  (Phase 1 connection already released,
                                   so full pool of 5 available for fan-out)

Fan-out order: sorted by confidence desc
  -> exact matches (1.0) first — most likely real impact
  -> embedding matches (0.5-0.85) last — can be interrupted by timeout
```

Timeout budget:
- Total wall time: 30s default (configurable via `--timeout`)
- Phase 1: max 5s
- Remaining budget = total - Phase1_elapsed
- Each fan-out hop: `min(5s, remaining_budget / remaining_hops)`
- On timeout: return partial result with `"truncated": true` and list of repos not reached

---

## Section 5: Matching Cascade

### Overview

During `group sync`, after extracting contracts from all repos, the cascade finds provider-consumer pairs. Each step processes only **unmatched** contracts remaining from the previous step:

```
Extracted contracts (all repos)
  |
  +- Step 1: Exact match by contract ID
  |    matched -> crossLinks (confidence 1.0)
  |    unmatched |
  |
  +- Step 2: BM25 by contract ID + symbol + meta
  |    score >= threshold -> crossLinks (confidence 0.85-0.95)
  |    unmatched |
  |
  +- Step 3: Embedding similarity by symbol + meta
  |    score >= threshold -> crossLinks (confidence 0.5-0.85)
  |    unmatched |
  |
  +- Unmatched -> report (warnings)
```

### Step 1: Exact Match

```
providers = contracts.filter(c => c.role === 'provider')
consumers = contracts.filter(c => c.role === 'consumer')
index = Map<contractId, provider[]>

for each consumer:
  if index.has(consumer.contractId):
    emit crossLink(consumer -> provider, matchType: 'exact', confidence: 1.0)
```

Contract ID normalization before comparison:
- HTTP: lowercase method, strip trailing slash, collapse path params
- gRPC: lowercase package name
- Topic: trim whitespace, lowercase
- Lib: lowercase package coordinates

Time: O(n) — single hashmap pass.

### Step 2: BM25

Document for indexing — concatenation of contract fields:

```typescript
function contractToDocument(c: ExtractedContract): string {
  const parts = [
    c.contractId,
    c.symbolRef.name,
    c.type,
  ];
  if (c.meta.path) parts.push(c.meta.path);
  if (c.meta.pathSegments) parts.push(...c.meta.pathSegments);
  if (c.meta.responseKeys) parts.push(...c.meta.responseKeys);
  if (c.meta.accessedKeys) parts.push(...c.meta.accessedKeys);
  if (c.meta.paramNames) parts.push(...c.meta.paramNames);
  if (c.meta.topicName) parts.push(c.meta.topicName);
  return parts.join(' ');
}
```

Only type-compatible pairs match: http <-> http, topic <-> topic, lib <-> lib, grpc <-> grpc. Within `lib` type, cross-ecosystem matching is allowed (e.g., a `maven` provider can match an `npm` consumer for the same logical package — this is exactly what the `packages` map in group.yaml enables).

Thresholds — BM25 raw scores are unbounded and corpus-dependent, so we use **relative scoring** (score / max_score in result set) rather than an absolute threshold:
- `BM25_RELATIVE_THRESHOLD = 0.7` (min ratio of score to top result's score)
- `BM25_TOP_K = 3` (candidates per query)
- Configurable via `matching.bm25_threshold` in `group.yaml` — may need tuning per deployment

Confidence mapping (based on relative score):
- relative 0.7-0.8 -> confidence 0.85
- relative 0.8-0.9 -> confidence 0.90
- relative 0.9-1.0 -> confidence 0.95

What BM25 catches well:
- Versioned paths (`/api/v1/users` <-> `/api/v2/users`)
- Partial name matches (`UserDTO` <-> `UserResponseDTO`)
- Matching meta fields (e.g., same pathSegments, paramNames; `responseKeys`/`accessedKeys` are future work — see Section 3 HttpRouteExtractor note)

What BM25 does NOT catch:
- Cross-language naming (`IUser` in TypeScript <-> `UserDTO` in Java)
- Synonymous concepts (`fetchPeople` <-> `GET /api/employees`)

These cases fall through to Step 3.

### Step 3: Embedding Similarity

Embedding input — richer than BM25, includes structural context:

```typescript
function contractToEmbeddingInput(c: ExtractedContract): string {
  const parts = [
    `${c.type} contract`,
    c.role,
    c.symbolRef.name,
    c.contractId,
  ];
  if (c.meta.responseKeys) {
    parts.push(`fields: ${c.meta.responseKeys.join(', ')}`);
  }
  if (c.meta.accessedKeys) {
    parts.push(`accesses: ${c.meta.accessedKeys.join(', ')}`);
  }
  return parts.join(' | ');
}
```

Model: Snowflake/snowflake-arctic-embed-xs (384 dims) — same as GitNexus internal semantic search.

Thresholds:
- `EMBEDDING_THRESHOLD = 0.65` (min cosine similarity)
- `EMBEDDING_MAX_CONFIDENCE = 0.85` (cap — never higher than BM25 min)

Confidence mapping (linear):
- cosine 0.65 -> confidence 0.50
- cosine 0.75 -> confidence 0.67
- cosine 0.85 -> confidence 0.85

Storage: `~/.gitnexus/groups/<group>/embeddings.bin` — flat binary, ~1.5KB per contract.

### Interaction with Existing Flags

Embedding fallback respects flags and index state:

| Flag | Behavior |
|------|----------|
| (default) | Exact -> BM25 -> Embedding fallback |
| `--skip-embeddings` | Exact -> BM25 only. No model load. No embeddings.bin |
| `--exact-only` | Exact match only. Fastest, strictest |
| `--force-embeddings` | Regenerate embeddings.bin even if fresh |

Automatic skip when model unavailable:

```
WARNING: Embedding model unavailable (onnxruntime not found).
  Matching cascade limited to: exact -> BM25.
  Unmatched contracts may increase. Use group.yaml links for manual linking.
```

Note: `group sync --skip-embeddings` and `gitnexus analyze --embeddings` are independent. Per-repo embeddings (for `query` semantic search) and group embeddings (for cross-repo contract matching) are separate concerns.

### Unmatched Report

```
WARNING: Unmatched contracts (4):

  PROVIDERS without consumers:
    http::DELETE::/api/v2/users/{param}  (hr/hiring/backend)
    topic::employee.terminated  (hr/hiring/backend)

  CONSUMERS without providers:
    http::GET::/api/v2/departments  (hr/hiring/ui)
    lib::hr/common::DepartmentDTO  (hr/payroll/backend)

  -> To link manually, add to group.yaml links section.
```

---

## Section 6: CLI Commands and MCP Tools

### CLI Commands

All commands live under `gitnexus group`:

#### `gitnexus group create <name>`

Creates `~/.gitnexus/groups/<name>/group.yaml` with a template. Errors if group exists (use `--force` to overwrite).

#### `gitnexus group add <group> <path> <repo>`

Adds a repo to a group. `<repo>` is a name from registry.json, `<path>` is the path in group hierarchy.

Validations:
- `<repo>` must exist in registry.json
- `<path>` must not duplicate within group
- A repo can be in multiple groups (e.g., shared lib)

#### `gitnexus group remove <group> <path>`

Removes a repo from a group. Prompts to re-sync.

#### `gitnexus group sync <name> [flags]`

Main command — runs contract extraction and matching cascade.

```
$ gitnexus group sync company

Syncing group "company" (6 repos)...

  [1/6] hr/hiring/backend      12 contracts (8 provider, 4 consumer)
  [2/6] hr/hiring/ui            7 contracts (0 provider, 7 consumer)
  ...

Matching cascade:
  exact:     18 cross-links (confidence 1.0)
  bm25:       4 cross-links (confidence 0.85-0.95)
  embedding:  2 cross-links (confidence 0.62-0.78)
  unmatched:  3 contracts

Wrote ~/.gitnexus/groups/company/contracts.json (41 contracts, 24 cross-links)
```

Flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--skip-embeddings` | false | Exact + BM25 only |
| `--exact-only` | false | Exact match only |
| `--force-embeddings` | false | Regenerate embeddings.bin |
| `--allow-stale` | false | Skip stale index warnings |
| `--verbose` | false | Show each cross-link detail |
| `--json` | false | JSON output |

**Stale index detection** uses the same heuristic as the existing staleness system ([staleness.ts:20](gitnexus/src/mcp/staleness.ts)): compare `meta.json.lastCommit` vs `git rev-parse HEAD`. This is commit-based, not time-based — consistent with the staleness heuristic defined in Section 2 for `contracts.json` (which compares `repoSnapshots[repo].indexedAt` against current `meta.json.indexedAt`). Two complementary checks:

1. **Repo index staleness** (commit-based): is the repo's own index behind HEAD? → warn before extraction
2. **Contract Registry staleness** (indexedAt-based): was the repo re-indexed since last `group sync`? → warn during `group_impact`

**Missing repo handling:** If a repo listed in `group.yaml` is not found in `registry.json` (not indexed, deleted, different machine), sync **skips it with a warning** and continues with remaining repos. The missing repo is listed in the sync summary. Contracts from a missing repo are **dropped** from the regenerated `contracts.json` (since sync is a full rebuild, not a patch). The missing repo is recorded in a top-level `missingRepos` array in `contracts.json` for transparency:

```json
{
  "missingRepos": ["sales/admin/bff"],
  ...
}
```

#### `gitnexus group list [name]`

Without argument — all groups. With name — details including repo list and subgroup tree.

#### `gitnexus group contracts <name>`

Debug/inspect view of Contract Registry. Flags: `--type`, `--repo`, `--unmatched`, `--json`.

#### `gitnexus group impact <name> [flags]`

```
$ gitnexus group impact company --target UserDTO --repo hr/hiring/backend

Target: UserDTO (hr/hiring/backend)
Risk: HIGH (cross-repo hits in 2 repos)

Local (hr/hiring/backend):
  d=1 WILL BREAK:
    UserController.getUser    src/controller/UserController.java:42
    ...

Cross-repo:
  hr/hiring/ui  (via http::GET::/api/v2/users/{param}, exact, conf=1.0):
    d=1 WILL BREAK:
      fetchUser               src/api/users.ts:18
    d=2 LIKELY AFFECTED:
      UserProfile             src/components/UserProfile.tsx:7

  hr/payroll/backend  (via topic::employee.updated, bm25, conf=0.88):
    d=1 WILL BREAK:
      EmployeeEventHandler    src/events/EmployeeEventHandler.java:31
```

Flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--target` | required | Symbol name |
| `--repo` | required | Repo in group (path or registry name) |
| `--direction` | upstream | upstream / downstream |
| `--cross-depth` | 1 | Hops through boundaries (MVP: capped at 1) |
| `--max-depth` | 3 | Max depth within each repo |
| `--min-confidence` | 0.5 | Min confidence for cross-links |
| `--subgroup` | (all) | Limit fan-out scope: `--subgroup hr/hiring` |
| `--timeout` | 30000 | Total wall time budget in ms |
| `--json` | false | JSON output |

#### `gitnexus group query <name> <query>`

Fan-out of existing `query` across all repos in group, results merged via RRF, grouped by repo path.

#### `gitnexus group status <name>`

Quick health check — shows staleness of Contract Registry relative to repo indexes:

```
$ gitnexus group status company

Group: company (last sync: 2026-03-31T10:00:00Z)

  Repo index staleness (meta.lastCommit vs HEAD):
  hr/hiring/backend     OK        (index at HEAD 5838fb8d)
  hr/hiring/ui          STALE     (index at a1b2c3d4, HEAD is e5f6g7h8 — 2 commits behind)
  hr/payroll/backend    OK

  Contract Registry staleness (repoSnapshot.indexedAt vs meta.indexedAt):
  hr/hiring/backend     OK        (sync matches index)
  hr/hiring/ui          STALE     (re-indexed after last sync)
  hr/payroll/backend    OK

  Missing repos:
  sales/admin/bff       MISSING   (not in registry.json)
```

#### Subgroup Boundary Behavior

When `--subgroup hr/hiring` is specified, fan-out only follows cross-links where the **target repo** is within the subgroup. Cross-links pointing outside (e.g., from `hr/hiring/backend` to `hr/payroll/backend`) are **not followed** but are listed in the output as "out-of-scope" for transparency.

### MCP Tools

| MCP Tool | Parameters | Description |
|----------|-----------|-------------|
| `group_list` | `name?` | List groups or details of one |
| `group_sync` | `name`, `skipEmbeddings?`, `exactOnly?` | Sync Contract Registry |
| `group_contracts` | `name`, `type?`, `repo?`, `unmatchedOnly?` | Show contracts and cross-links |
| `group_impact` | `name`, `target`, `repo`, `direction?`, `crossDepth?`, `maxDepth?`, `minConfidence?`, `subgroup?`, `timeout?` | Cross-index blast radius |
| `group_query` | `name`, `query`, `subgroup?`, `limit?` | Search flows across group |
| `group_status` | `name` | Staleness check for group and repos |

Mutating operations (`group_create`, `group_add`, `group_remove`) are CLI-only — not exposed as MCP tools.

### AI Context Integration (CLAUDE.md + AGENTS.md)

When groups exist, `gitnexus analyze` appends to both `CLAUDE.md` and `AGENTS.md` (consistent with the existing generation pattern in [ai-context.ts:293](gitnexus/src/cli/ai-context.ts)):

```markdown
## Cross-Repo Groups

This repo is part of group **company** as `hr/hiring/backend`.
Use `group_impact` instead of `impact` when changes may affect other repos in the group.
```

---

## Section 7: Limitations and Future Work

### Known Limitations (MVP)

1. **Single hop only (MVP)** — cross-boundary traversal is capped at 1 hop. `--cross-depth` flag is accepted but values >1 are ignored with a message. Full E2E chain (UI -> BFF -> Backend -> ML) requires a future `group trace` command.
2. **Contract Registry is full-rebuild** — `group sync` regenerates entirely. Incremental sync (only re-extract changed repos) is a future optimization.
3. **LadybugDB pool limit** — max 5 databases open simultaneously. Groups with 10+ repos will see sequential fan-out with queuing.
4. **Runtime-only connections** — service discovery, feature flags, A/B routing are invisible to static analysis.
5. **Embedding quality for short names** — symbol names like `IUser` vs `UserDTO` may not embed well without field context.
6. **No unified Cypher** — cannot run a single Cypher query across the entire group (each repo has its own database).

### Future Work

- **Incremental sync** — detect which repos changed since last sync, re-extract only those
- **`group trace`** — full E2E flow tracing across multiple boundaries
- **Virtual Cypher** — Cypher-like query language that transparently fans out across group databases
- **CI integration** — `group impact` as a PR check ("this change affects 3 other repos")
- **OpenAPI/AsyncAPI import** — generate contracts from spec files instead of extracting from code
- **Dependency drift detection** — alert when a consumer accesses fields that the provider no longer returns
- **Web UI visualization** — graph view showing cross-repo connections in gitnexus-web

### Demo PR Scope

A minimal demonstration PR to validate the concept:

1. **`group.yaml` parser** — read/validate group configuration
2. **`group list`** and **`group status`** CLI commands — show groups, repos, and staleness
3. **`group sync`** with exact-match only — extract HTTP contracts via source scan, build cross-links
4. **`group_impact`** MCP tool — Phase 1 (local) + Phase 2 (cross-boundary fan-out, exact match only)
5. **Tests** — integration test with two small fixture repos (frontend + backend)
6. **Test migration** — update tool/resource count assertions (see Section 9)

BM25 and embedding matching are out of scope for the demo PR but designed in from the start.

---

## Section 8: Implementation Prerequisites

Changes required in GitNexus core before group features can function correctly. These should be separate PRs merged before the group feature PR.

### P1: `impactByUid` — UID-based symbol resolution for impact

**Problem:** Current `impact` resolves by name with `LIMIT 1` ([local-backend.ts:1347-1352](gitnexus/src/mcp/local/local-backend.ts)). For `group_impact` fan-out, the target symbol is known by UID from the Contract Registry. Name-based resolution creates false positives for common symbol names.

**Change:** Add an internal `impactByUid(uid: string, direction: string, opts)` function alongside the existing name-based `impact`. The public MCP `impact` tool is unchanged — `impactByUid` is internal-only, called by `group_impact` during Phase 2.

**Scope:** ~50 lines in `local-backend.ts`. No public API change. No schema change.

### P2: Impact relationTypes runtime filter alignment

**Problem:** Impact tool description documents 6 relation types as valid for `relationTypes` parameter: `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `HAS_METHOD`, `OVERRIDES` ([tools.ts:203](gitnexus/src/mcp/tools.ts)). But runtime filter only allows 4: `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS` ([local-backend.ts:50](gitnexus/src/mcp/local/local-backend.ts)). The additional types `HAS_METHOD` and `OVERRIDES` are silently ignored at runtime.

**Change:** Expand runtime filter to accept the documented types (`HAS_METHOD`, `OVERRIDES`). This is existing tech debt, not introduced by this RFC, but should be resolved to avoid confusion when `group_impact` inherits the same filter.

**Scope:** ~10 lines in `local-backend.ts`.

### P3: (Future, not MVP) Route/FETCHES schema extension

For full-fidelity HTTP contract extraction from the graph (without source scanning), the ingestion pipeline would need:
- `Route` node label in schema.ts
- `HANDLES_ROUTE` and `FETCHES` relation types in schema.ts
- Route extraction generalized beyond Laravel (Spring Boot, Express, FastAPI, etc.)
- Consumer-side fetch detection persisted as `FETCHES` edges

This is a **significant change to the ingestion pipeline** and is NOT a prerequisite for MVP. The demo PR uses source-scan extraction instead. This is listed here as future optimization path — once the graph has this data, extractors can switch from source scan to Cypher queries (faster, more accurate).

---

## Section 9: Test Migration Plan

### Affected test guards

Adding group CLI commands and MCP tools will break existing shape assertions:

| Test | Current assertion | After change |
|------|-------------------|--------------|
| [tools.test.ts:14](gitnexus/test/unit/tools.test.ts) | Tool count = 7 | Tool count = 7 + 6 group tools = 13 |
| [resources.test.ts:40](gitnexus/test/unit/resources.test.ts) | Resource count assertion | Unchanged (no new resources) |
| [resources.test.ts:66](gitnexus/test/unit/resources.test.ts) | Resource template count assertion | Unchanged |

### New tests required

| Test | Type | Description |
|------|------|-------------|
| `group-config.test.ts` | Unit | Parse/validate group.yaml, handle missing repos, nested paths |
| `contract-extractor.test.ts` | Unit | Each extractor against fixture source files |
| `matching-cascade.test.ts` | Unit | Exact match, BM25 relative scoring, confidence mapping |
| `group-impact.test.ts` | Integration | Two fixture repos (TS frontend + Java backend), end-to-end group_impact |
| `group-cli.test.ts` | Integration | CLI commands: create, add, list, status, sync |
| `group-tools.test.ts` | Unit | MCP tool registration, parameter validation |

### Fixture repos for integration tests

Two minimal repos checked into `test/fixtures/group/`:
- `test-frontend/` — TypeScript, contains `fetch('/api/users')` call
- `test-backend/` — Java/TypeScript, contains route handler for `/api/users`

Both pre-indexed with `.gitnexus/` directories committed as test fixtures.
