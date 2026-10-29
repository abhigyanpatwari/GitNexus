# MCP reference

[Back to GitNexus](../README.md)

## Tools, resources and skills

### 19 MCP tools (17 per-repo + 2 group)

| Tool             | What It Does                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `list_repos`     | Discover all indexed repositories (paginated — `limit`/`offset`)                                                         |
| `query`          | Process-grouped hybrid search (BM25 + semantic + RRF)                                                                    |
| `context`        | 360-degree symbol view — categorized refs, process participation                                                         |
| `impact`         | Blast radius analysis with depth grouping and confidence                                                                 |
| `trace`          | Shortest directed path between two symbols (call + class-member edges)                                                   |
| `detect_changes` | Git-diff impact — maps changed lines to affected processes                                                               |
| `check`          | Read-only structural checks against the indexed graph                                                                    |
| `rename`         | Semantic rename — previews by default, `dry_run: false` with the preview's `plan_token` applies its exact reviewed edits |
| `cypher`         | Raw Cypher graph queries                                                                                                 |
| `route_map`      | API route map — which components fetch which endpoints, and handlers                                                     |
| `tool_map`       | MCP/RPC tool definitions — where they're defined and handled                                                             |
| `shape_check`    | Validate API response shapes against consumers' property accesses                                                        |
| `api_impact`     | Pre-change impact report for an API route handler                                                                        |
| `explain`        | Explain persisted taint findings (source→sink flows, `--pdg` indexes)                                                    |
| `pdg_query`      | Query control/data dependence at statement level (`--pdg` indexes)                                                       |
| `read_file`      | Read a checkout file (optional 0-indexed slice; `maxLines` cap)                                                          |
| `grep`           | Regex search of the working tree for indexed files (1-based hits)                                                        |
| `group_list`     | List configured repository groups                                                                                        |
| `group_sync`     | Rebuild a group's Contract Registry and cross-repo links                                                                 |

> Per-repo read-only tools take an optional `repo` parameter. Omit it when only one repo is indexed, an MCP default is configured, or the GitNexus process cwd is inside a registered path without crossing into an unindexed nested Git checkout; otherwise pass it explicitly. Mutating tools require `repo` when multiple repos are indexed and no MCP default exists. Per-repo tools also take an optional `branch` for indexes pinned with `gitnexus analyze --branch`, except `read_file` and `grep`, which read the checkout and do not accept `branch`. Omitting `branch` queries the workspace index, which follows your checked-out working tree — switching branches and re-running `gitnexus analyze` updates it incrementally. `explain` and `pdg_query` need an index built with `gitnexus analyze --pdg`.

### Resources for instant context

| Resource                                | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `gitnexus://repos`                      | List all indexed repositories (read this first)      |
| `gitnexus://setup`                      | Setup and usage guidance for agents                  |
| `gitnexus://repo/{name}/context`        | Codebase stats, staleness check, and available tools |
| `gitnexus://repo/{name}/clusters`       | All functional clusters with cohesion scores         |
| `gitnexus://repo/{name}/cluster/{name}` | Cluster members and details                          |
| `gitnexus://repo/{name}/processes`      | All execution flows                                  |
| `gitnexus://repo/{name}/process/{name}` | Full process trace with steps                        |
| `gitnexus://repo/{name}/schema`         | Graph schema for Cypher queries                      |
| `gitnexus://group/{name}/contracts`     | A group's extracted contracts and cross-links        |
| `gitnexus://group/{name}/status`        | Staleness of repos in a group                        |

### 2 MCP prompts for guided workflows

| Prompt          | What It Does                                                              |
| --------------- | ------------------------------------------------------------------------- |
| `detect_impact` | Pre-commit change analysis — scope, affected processes, risk level        |
| `generate_map`  | Architecture documentation from the knowledge graph with mermaid diagrams |

### Agent skills installed to `.claude/skills/` and `.agents/skills/` (if `.agents/` exists) automatically

- **Exploring** — navigate unfamiliar code using the knowledge graph
- **Debugging** — trace bugs through call chains
- **Impact Analysis** — analyze blast radius before changes
- **Refactoring** — plan safe refactors using dependency mapping
- **Guide** — GitNexus tool/resource/schema reference for the agent
- **CLI** — run analyze/status/clean/wiki commands on request
- **PDG Query** — statement-level control/data dependence queries (`--pdg` index)
- **Taint Analysis** — source→sink data-flow findings (`--pdg` index)
- **Plan** (`/gitnexus-plan`) — implementation-ready engineering plans backed by the graph and PDG slices
- **Work** (`/gitnexus-work`) — executes a plan as impact-checked, `detect_changes`-gated atomic commits
- **Review** (`/gitnexus-review`) — graph-backed review of a PR, branch, range, or local diff, with taint pass and per-domain expert lenses
- **LFG** (`/gitnexus-lfg`) — the full pipeline: plan → user gate → work → review

**Repo-specific skills** — run `gitnexus analyze --skills` and GitNexus detects the functional areas of your codebase (via Leiden community detection) and generates each one as a direct project skill under `.claude/skills/gitnexus-area-<name>/`. Each skill describes a module's key files, entry points, execution flows, and cross-area connections, and is regenerated on each `--skills` run to stay current.

When a repo contains an `.agents/` directory, the standard and generated skills are also mirrored to `.agents/skills/` (e.g. `.agents/skills/gitnexus-cli/`, `.agents/skills/gitnexus-area-<name>/`) so agents that read repo-local `.agents/skills/` (like Codex) stay in sync.

## MCP read-only mode

Set `GITNEXUS_MCP_READ_ONLY=1` before starting the MCP server to expose only the proven single-repository read surface. `rename` stays available as a preview-only tool: its `dry_run` must be omitted or `true`, and any other value is rejected before backend dispatch. Raw `cypher`, group tools, group routing, and group resources are omitted from discovery and rejected before backend dispatch. Tool descriptions and generated setup/context resources are scrubbed so they do not recommend unavailable routes.

The default is unchanged when the variable is unset or `0`. Any other value fails server startup rather than silently weakening the policy.

## MCP index refresh

A local server started with `GITNEXUS_MCP_ENABLE_REFRESH=1` also lists `refresh_index`, which rebuilds one registered repository's index from its working tree. It is meant for agents that can see a stale index (`staleness.status` of `behind` or `diverged`) but cannot run `gitnexus analyze` themselves.

- **Index-only.** The rebuild runs in the same forked analyze worker auto-sync uses, with `--skip-agents-md --skip-skills`: no `AGENTS.md`, `CLAUDE.md`, skill, hook, or other repository file is written. It is incremental where it can be and keeps existing embeddings and PDG mode.
- **Local only.** `gitnexus serve` (and so the Docker `/api/mcp` surface) never lists it, whatever its environment. With `GITNEXUS_MCP_READ_ONLY=1` it is hidden from discovery and rejected before dispatch.
- **Bounded.** Repositories whose last index recorded more than `GITNEXUS_MCP_REFRESH_MAX_FILES` files (default `5000`; `0` for no limit), or no count at all, are refused. After `GITNEXUS_MCP_REFRESH_TIMEOUT_MS` (default ten minutes) the call stops waiting and returns an error. The analyze worker never interrupts an analysis it has started, so it finishes in the background and keeps the index lock until then; a later refresh waits on that lock. Cancelling the request does not stop a started rebuild either: it finishes and publishes, and until it does a new call gets "already running" and `dry_run` reports `inProgress`. Only one refresh per repository runs at a time. The file limit does not bound embedding generation, which `.gitnexusrc` can request.
- **Observable.** `dry_run: true` reports staleness, the indexed file count, whether `.gitnexusrc` makes the rebuild generate embeddings, and whether a refresh would run. A real call waits for the rebuild and returns `indexedAt`, `lastCommit`, `stats`, and `staleness`, with the values before the refresh under `previous`. A rebuild whose graph write collapsed is reported as an error, as `gitnexus analyze` and `serve` report it. Clients that send a progress token receive progress notifications; the MCP TypeScript SDK client gives up on a request after 60 seconds by default unless it resets that timeout on progress.

The tool takes `repo` and `dry_run` only. Like an applied `rename`, it needs an explicit `repo` unless one repository is indexed or an MCP default is configured.

## MCP repository policy

Set `GITNEXUS_MCP_ALLOWED_REPOS` to a comma-separated list of canonical registry names or absolute indexed paths. Entries are trimmed, resolved against the registry, and deduplicated at startup. When exactly one repository is allowed it becomes the implicit default; when several are allowed, callers must select one unless `GITNEXUS_MCP_DEFAULT_REPO` is also set.

The default repository must resolve to an allowed repository. Invalid, ambiguous, blank, or mismatched configuration fails startup before stdio or HTTP begins serving. The allowlist applies to tools, aliases, discovery, resources, templates, implicit resolution, and embedded HTTP; hidden repository details are not included in selection errors. Setting only `GITNEXUS_MCP_DEFAULT_REPO` chooses a default without restricting explicit repository selections. An allowed repository whose name is duplicated in the registry must be configured by path, and its context resource is only served for the unique name form.

## MCP response budgets

Prefer explicit response filters before a byte cutoff. Single-repository MCP
`query` and `context` accept `response_sections`: choose query sections
(`processes`, `process_symbols`, `definitions`) or context sections (`incoming`,
`outgoing`, `processes`, `chain`, `routes`, `typed_properties`). Context always
keeps the selected symbol and also accepts `relationTypes: ["CALLS"]` to show
only that category in the existing incoming/outgoing reference window. These
options do not change graph search, ranking or traversal. They are not supported
for `@group` routing; use a member's indexed repository name/path instead.

For example, `context({uid: "<returned symbol id>", response_sections: ["incoming"],
relationTypes: ["CALLS"]})` returns the symbol, its returned callers, and all
completeness/staleness diagnostics. The `response_filter` field identifies omitted
data; omission does not mean absence. Remove filters for a broader view. For
impact, existing `summaryOnly`, `limit` and `offset` already provide focused views.
Omitting these filters preserves the existing response.

The `query`, `context`, and `impact` tools accept an optional positive-integer `maxTokens` argument. It bounds the complete formatted MCP response, including hints and error text, using a deterministic four-UTF-8-bytes-per-token estimate. When truncation is required, the response ends with `…` and remains valid UTF-8.

Set `GITNEXUS_MCP_DEFAULT_MAX_TOKENS` to apply the same guardrail when callers do not send `maxTokens`. An explicit tool argument takes precedence. Leaving both unset preserves the existing response byte-for-byte; this is a transport guardrail, not semantic pagination or an exact model-specific tokenizer limit.

## Tool Examples

### Impact Analysis

```
impact({target: "UserService", direction: "upstream", minConfidence: 0.8})

TARGET: Class UserService (src/services/user.ts)

UPSTREAM (what depends on this):
  Depth 1 (WILL BREAK):
    handleLogin [CALLS 90%] -> src/api/auth.ts:45
    handleRegister [CALLS 90%] -> src/api/auth.ts:78
    UserController [CALLS 85%] -> src/controllers/user.ts:12
  Depth 2 (LIKELY AFFECTED):
    authRouter [IMPORTS] -> src/routes/auth.ts
```

Options: `maxDepth`, `minConfidence`, `relationTypes` (`CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`), `includeTests`, `limit` (max symbols per depth, default 100), `offset` (pagination start per depth), `summaryOnly` (counts and risk only, omits symbol list)

**Disambiguation** — when several symbols share the target name, `impact` returns a ranked `ambiguous` candidate list instead of guessing. Narrow it with `target_uid` (exact, zero-ambiguity), `file_path`, or `kind` (`Function`, `Class`, `Method`, …). From the CLI these are `--uid`, `--file`, and `--kind`, matching `gitnexus context`:

```bash
gitnexus impact get_embeddings                       # → ambiguous: lists ranked candidates
gitnexus impact get_embeddings --file src/embed.py   # → resolves to the one in that file
gitnexus impact get_embeddings --uid "Function:src/embed.py:get_embeddings"  # exact
```

## More examples: search · context · detect_changes · rename · Cypher

### Process-Grouped Search

```
query({search_query: "authentication middleware"})

processes:
  - summary: "LoginFlow"
    priority: 0.042
    symbol_count: 4
    process_type: cross_community
    step_count: 7

process_symbols:
  - name: validateUser
    type: Function
    filePath: src/auth/validate.ts
    process_id: proc_login
    step_index: 2

definitions:
  - name: AuthConfig
    type: Interface
    filePath: src/types/auth.ts
```

### Context (360-degree Symbol View)

```
context({name: "validateUser"})

symbol:
  uid: "Function:validateUser"
  kind: Function
  filePath: src/auth/validate.ts
  startLine: 15

incoming:
  calls: [handleLogin, handleRegister, UserController]
  imports: [authRouter]

outgoing:
  calls: [checkPassword, createSession]

processes:
  - name: LoginFlow (step 2/7)
  - name: RegistrationFlow (step 3/5)
```

### Detect Changes (Pre-Commit)

```
detect_changes({scope: "all"})

summary:
  changed_count: 12
  affected_count: 3
  changed_files: 4
  risk_level: medium

changed_symbols: [validateUser, AuthService, ...]
affected_processes: [LoginFlow, RegistrationFlow, ...]
```

### Rename (Graph and Semantic Layer)

```js
rename({ symbol_name: 'validateUser', new_name: 'verifyUser', repo: 'my-app', dry_run: true });
// Omitting dry_run also previews. For an ambiguous name, repeat with the symbol_uid from context().
```

```text
result_version: 2
status: success
planning_status: ready
application_status: not_requested
applied: false
files_affected: 5
total_edits: 8
semantic_edits: 8
graph_edits: 0
text_search_edits: 0
text_search: not_used
coverage: {name: "gitnexus-semantic", scope: "indexed-repository", languages: [...], limitations: [...], ...}
changes: [{file_path, edits: [{start, length, old_text, new_text, line, confidence: "semantic"}]}]
```

Review the exact UTF-16 spans and coverage, then call `rename` with the same
selectors, `dry_run: false`, and its returned `plan_token` to apply exactly those edits.
Tokens are single-use, expire after 15 minutes or a server restart, and may be
evicted by the bounded retained-plan cache. Changed source contents, physical
targets, indexed declarations, provider resolution configuration or source-file sets (including untracked additions)
require a fresh reviewed preview. Omitting `dry_run` also previews.
Configuration is compared by provider resolution semantics; comment-only changes
that preserve those semantics are accepted. Unedited source aliases of an edited
physical file block preview. Apply checks configuration before the first write
and source contents and approved targets before each replacement; these checks
assume a cooperative checkout and do not form a filesystem transaction.
Counts describe occurrences, including multiple edits on one line. The graph
selects indexed declarations and files; GitNexus's language providers rebuild
semantic scopes from the current source and resolve exact name spans.

Rename does not load a compiler or language service. Comments, strings, and
unrelated same-spelled symbols are preserved. Unsupported syntax, ambiguous
bindings, stale declarations, and incomplete occurrence coverage block writes.
Coverage includes indexed files accepted by the selected language provider,
including its supported embedded-language sources, and excludes unindexed files
and external consumers. Each registered source-language provider supplies rename
rules. Constructor, destructor, inheritance, and interface families require
complete provider evidence. Dynamic or computed references block a rename when
the provider cannot prove their binding or exclude them from the selected family.
`rename` operates on the current checkout and rejects `branch`.

Language-specific limits remain explicit in the result. For example, PHP handles
case-insensitive function/class names separately from case-sensitive constants
and properties, but refuses class renames that require moving a PSR-4 file.
Java also refuses public top-level type renames that require a source-file move.
Rename edits source spans; it does not move files or rewrite dynamic string names.

Apply revalidates the reviewed plan and source snapshots before writing. The
single-use preview token does not make the filesystem operation transactional.
The final destination check and replacement are separate
operations, so another process can still change a file between them. Avoid
concurrent source writes during application. On a write failure, `status: partial` and `failed_files`
report the failed file and `unattempted_files` lists the later files that were never touched;
`applied`, counts, and `changes` describe only landed edits.
Inspect failures before retrying, and run type checking, tests, and
`detect_changes` after applying. A valid identifier is not a guarantee against
new-name collisions.

### Cypher Queries

```cypher
-- Find what calls auth functions with high confidence
MATCH (c:Community {heuristicLabel: 'Authentication'})<-[:CodeRelation {type: 'MEMBER_OF'}]-(fn)
MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(fn)
WHERE r.confidence > 0.8
RETURN caller.name, fn.name, r.confidence
ORDER BY r.confidence DESC
```
