# GitNexus

**⚠️ Important Notice:** GitNexus has NO official cryptocurrency, token, or coin. Any token/coin using the GitNexus name on Pump.fun or any other platform is **not affiliated with, endorsed by, or created by** this project or its maintainers. Do not purchase any cryptocurrency claiming association with GitNexus.

<div align="center">

  <a href="https://trendshift.io/repositories/19809" target="_blank">
    <img src="https://trendshift.io/api/badge/repositories/19809" alt="abhigyanpatwari%2FGitNexus | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/>
  </a>

  <p>
    <a href="https://discord.gg/MgJrmsqr62">
      <img src="https://img.shields.io/discord/1477255801545429032?color=5865F2&logo=discord&logoColor=white" alt="Discord"/>
    </a>
    <a href="https://www.npmjs.com/package/gitnexus">
      <img src="https://img.shields.io/npm/v/gitnexus.svg" alt="npm version"/>
    </a>
    <a href="https://polyformproject.org/licenses/noncommercial/1.0.0/">
      <img src="https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg" alt="License: PolyForm Noncommercial"/>
    </a>
    <a href="https://securityscorecards.dev/viewer/?uri=github.com/abhigyanpatwari/GitNexus">
      <img src="https://api.securityscorecards.dev/projects/github.com/abhigyanpatwari/GitNexus/badge" alt="OpenSSF Scorecard"/>
    </a>
    <a href="https://github.com/abhigyanpatwari/GitNexus/actions/workflows/ci.yml">
      <img src="https://github.com/abhigyanpatwari/GitNexus/actions/workflows/ci.yml/badge.svg" alt="CI Workflows"/>
    </a>
  </p>

  <p><strong>The nervous system for agent context.</strong></p>

  <p>
    Indexes any codebase into a knowledge graph — every dependency, call chain, cluster, and execution flow —
    then exposes it through smart MCP tools so AI agents never miss code.
  </p>

  <p>
    💬 <a href="https://discord.gg/MgJrmsqr62">Discord</a> ·
    🌐 <a href="https://gitnexus.vercel.app">Web UI</a> ·
    🏢 <a href="https://akonlabs.com">Enterprise (SaaS & self-hosted)</a>
  </p>

</div>

https://github.com/user-attachments/assets/172685ba-8e54-4ea7-9ad1-e31a3398da72

> _Like DeepWiki, but deeper._ DeepWiki helps you _understand_ code. GitNexus lets you _analyze_ it — a knowledge graph tracks every relationship, not just descriptions.

**TL;DR:** The **CLI + MCP** makes your AI agent reliable — it gives Cursor, Claude Code, Antigravity, Codex, and friends a deep architectural view of your codebase so they stop missing dependencies, breaking call chains, and shipping blind edits. Even smaller models get full architectural clarity. The **Web UI** is a quick way to chat with any repo in the browser.

## Quick Start

```bash
# 1. Index your repo (run from repo root)
npx gitnexus analyze

# 2. Connect your editors (one-time, auto-detects Claude Code, Cursor, Codex, …)
npx gitnexus setup
```

That's it. `analyze` indexes the codebase, installs agent skills, registers Claude Code hooks, and creates `AGENTS.md` / `CLAUDE.md` context files — all in one command. `setup` writes the MCP config so your AI agent can use the graph.

<details>
<summary><strong>Install problems?</strong> npm 11 crash · slow cold install · no C++ toolchain</summary>

> **On npm 11.x?** `npx` can crash during install with `Cannot destructure property 'package' of 'node.target'` (an npm/arborist bug, before GitNexus runs). Use pnpm instead — it builds the native deps explicitly:
>
> ```bash
> pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter dlx gitnexus@latest analyze
> ```
>
> Or install globally (`npm install -g gitnexus@latest`) and run `gitnexus analyze`. See [#1939](https://github.com/abhigyanpatwari/GitNexus/issues/1939).

> **Fastest MCP startup:** install globally (`npm i -g gitnexus`) before running `gitnexus setup` — this writes an absolute-path MCP config that bypasses `npx` entirely. On a cold cache, an `npx`-based MCP install can exceed Claude Code's `MCP_TIMEOUT` default (~30s).

> **No C++ toolchain?** Set `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` before `npm install -g gitnexus` to skip the vendored grammar materialize/build for `tree-sitter-dart`, `tree-sitter-proto`, `tree-sitter-swift`, and `tree-sitter-kotlin` — those four languages won't be parsed, but install completes in seconds without `python3`/`make`/`g++`. Strict `=1` only — any other value falls through to the rebuild.

> **Behind an HTTP proxy / regional firewall?** `onnxruntime-node`'s postinstall downloads optional CUDA binaries from `api.nuget.org` and ignores `HTTP_PROXY`/`HTTPS_PROXY` ([#2370](https://github.com/abhigyanpatwari/GitNexus/issues/2370)). The embedding stack is an optional dependency, so a failed download no longer breaks the install — and it self-heals: the first `gitnexus analyze --embeddings` (or `gitnexus embeddings install`) fetches the stack through your npm registry config (mirrors/proxies apply, no NuGet) into `~/.gitnexus/embedding-runtime` (override with `GITNEXUS_EMBEDDING_RUNTIME_DIR`). The on-demand prefix needs Node with `module.registerHooks` (≥ 22.15 on 22.x, ≥ 23.5 on 23.x); on older Node, keep the stack in the install itself with `ONNXRUNTIME_NODE_INSTALL=skip npm install -g gitnexus` (works on every supported Node).

> **About `tree-sitter-kotlin`:** like Dart/Proto/Swift, Kotlin is a **vendored** grammar (under `gitnexus/vendor/tree-sitter-kotlin`). Upstream ships **source only** (no prebuilt binaries), so GitNexus cross-builds the platform prebuilds itself (via the `build-tree-sitter-prebuilds` GitHub Actions workflow) and vendors them — the same uniform pipeline used for Dart, Proto, and Swift. `node-gyp-build` selects the right `.node` at require time, so **no C/C++ toolchain is needed**. If no prebuild matches your platform-arch, only Kotlin (`.kt`/`.kts`) parsing is unavailable; the rest of `gitnexus` is unaffected.

</details>

## Two Ways to Use GitNexus

|             | **CLI + MCP** (recommended)                                                        | **Web UI**                                                           |
| ----------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **What**    | Index repos locally, connect AI agents via MCP                                     | Visual graph explorer + AI chat in browser                           |
| **For**     | Daily development with Cursor, Claude Code, Antigravity, Codex, Windsurf, OpenCode | Quick exploration, demos, one-off analysis                           |
| **Scale**   | Full repos, any size                                                               | Limited by browser memory (~5k files), or unlimited via backend mode |
| **Install** | `npm install -g gitnexus`                                                          | No install — [gitnexus.vercel.app](https://gitnexus.vercel.app)      |
| **Storage** | LadybugDB native (fast, persistent)                                                | LadybugDB WASM (in-memory, per session)                              |
| **Parsing** | Tree-sitter native bindings                                                        | Tree-sitter WASM                                                     |
| **Privacy** | Everything local, no network                                                       | Everything in-browser, no server                                     |

> **Bridge mode:** `gitnexus serve` connects the two — the web UI auto-detects the local server and can browse all your CLI-indexed repos without re-uploading or re-indexing.

## Why a Knowledge Graph?

Tools like **Cursor**, **Claude Code**, **Codex**, **Cline**, **Roo Code**, and **Windsurf** are powerful — but they don't truly know your codebase structure. So this happens:

1. AI edits `UserService.validate()`
2. Doesn't know 47 functions depend on its return type
3. **Breaking changes ship**

Traditional Graph RAG gives the LLM raw graph edges and hopes it explores enough. GitNexus **precomputes structure at index time** — clustering, tracing, scoring — so tools return complete context in one call:

```mermaid
flowchart TB
    subgraph Traditional["Traditional Graph RAG"]
        direction TB
        U1["User: What depends on UserService?"]
        U1 --> LLM1["LLM receives raw graph"]
        LLM1 --> Q1["Query 1: Find callers"]
        Q1 --> Q2["Query 2: What files?"]
        Q2 --> Q3["Query 3: Filter tests?"]
        Q3 --> Q4["Query 4: High-risk?"]
        Q4 --> OUT1["Answer after 4+ queries"]
    end

    subgraph GN["GitNexus Smart Tools"]
        direction TB
        U2["User: What depends on UserService?"]
        U2 --> TOOL["impact UserService upstream"]
        TOOL --> PRECOMP["Pre-structured response:
        8 callers, 3 clusters, all 90%+ confidence"]
        PRECOMP --> OUT2["Complete answer, 1 query"]
    end
```

**Core innovation: Precomputed Relational Intelligence**

- **Reliability** — the LLM can't miss context; it's already in the tool response
- **Token efficiency** — no 10-query chains to understand one function
- **Model democratization** — smaller LLMs work because the tools do the heavy lifting

## What Your AI Agent Gets

### 17 MCP tools (15 per-repo + 2 group)

| Tool             | What It Does                                                           |
| ---------------- | ---------------------------------------------------------------------- |
| `list_repos`     | Discover all indexed repositories (paginated — `limit`/`offset`)       |
| `query`          | Process-grouped hybrid search (BM25 + semantic + RRF)                  |
| `context`        | 360-degree symbol view — categorized refs, process participation       |
| `impact`         | Blast radius analysis with depth grouping and confidence               |
| `trace`          | Shortest directed path between two symbols (call + class-member edges) |
| `detect_changes` | Git-diff impact — maps changed lines to affected processes             |
| `check`          | Read-only structural checks against the indexed graph                  |
| `rename`         | Multi-file coordinated rename with graph + text search                 |
| `cypher`         | Raw Cypher graph queries                                               |
| `route_map`      | API route map — which components fetch which endpoints, and handlers   |
| `tool_map`       | MCP/RPC tool definitions — where they're defined and handled           |
| `shape_check`    | Validate API response shapes against consumers' property accesses      |
| `api_impact`     | Pre-change impact report for an API route handler                      |
| `explain`        | Explain persisted taint findings (source→sink flows, `--pdg` indexes)  |
| `pdg_query`      | Query control/data dependence at statement level (`--pdg` indexes)     |
| `group_list`     | List configured repository groups                                      |
| `group_sync`     | Rebuild a group's Contract Registry and cross-repo links               |

> Per-repo tools take an optional `repo` parameter (omit it when only one repo is indexed) and an optional `branch` for indexes pinned with `gitnexus analyze --branch`. Omitting `branch` queries the workspace index, which follows your checked-out working tree — switching branches and re-running `gitnexus analyze` updates it incrementally. `explain` and `pdg_query` need an index built with `gitnexus analyze --pdg`.

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

### 6 agent skills installed to `.claude/skills/` automatically

- **Exploring** — navigate unfamiliar code using the knowledge graph
- **Debugging** — trace bugs through call chains
- **Impact Analysis** — analyze blast radius before changes
- **Refactoring** — plan safe refactors using dependency mapping
- **Guide** — GitNexus tool/resource/schema reference for the agent
- **CLI** — run analyze/status/clean/wiki commands on request

**Repo-specific skills** — run `gitnexus analyze --skills` and GitNexus detects the functional areas of your codebase (via Leiden community detection) and generates each one as a direct project skill under `.claude/skills/gitnexus-area-<name>/`. Each skill describes a module's key files, entry points, execution flows, and cross-area connections, and is regenerated on each `--skills` run to stay current.

## Editor Setup

`gitnexus setup` auto-detects your editors and writes the correct global MCP config. Run it once. To configure only selected integrations, pass `--coding-agent`/`-c` with a comma-separated list, e.g. `gitnexus setup -c cursor,codex`.

| Editor                   | MCP | Skills | Hooks (auto-augment)                                                                                              | Support      |
| ------------------------ | --- | ------ | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| **Claude Code**          | Yes | Yes    | Yes (PreToolUse + PostToolUse)                                                                                    | **Full**     |
| **Cursor**               | Yes | Yes    | Yes (postToolUse, [manual install](gitnexus-cursor-integration/README.md#hook-install))                           | **Full**     |
| **Antigravity** (Google) | Yes | Yes    | Yes (AfterTool, [Gemini CLI hooks schema](https://geminicli.com/docs/hooks/reference/))[¹](#fn-antigravity-hooks) | **Full**     |
| **Codex**                | Yes | Yes    | Yes (PreToolUse + PostToolUse, [Codex hooks](https://developers.openai.com/codex/hooks))                          | **Full**     |
| **OpenCode**             | Yes | Yes    | —                                                                                                                 | MCP + Skills |
| **CodeBuddy** (Tencent)  | Yes | Yes    | —                                                                                                                 | MCP + Skills |
| **Qoder** (Alibaba)      | Yes | Yes    | —                                                                                                                 | MCP + Skills |
| **Windsurf**             | Yes | —      | —                                                                                                                 | MCP          |

> **Claude Code** and **Codex** get the deepest integration: MCP tools + agent skills + PreToolUse hooks that enrich searches with graph context + PostToolUse hooks that detect a stale index after commits and prompt the agent to reindex.

<a id="fn-antigravity-hooks"></a>

> ¹ **Antigravity hooks** follow the [Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/) (Antigravity 2.0 is the documented successor to Gemini CLI). Augmentation runs in `AfterTool` because `BeforeTool` has no context-injection channel in the Gemini contract — the agent sees graph context appended to the tool result via `hookSpecificOutput.additionalContext`. Stale-index hints land in the same channel after a successful `git commit/merge/rebase/cherry-pick/pull`. The schema may evolve if Antigravity-specific hook docs diverge from Gemini CLI's; the implementation will track those changes.

<details>
<summary><strong>Manual MCP configuration</strong> (if you prefer not to run <code>gitnexus setup</code>)</summary>

**Claude Code** (full support — MCP + skills + hooks):

```bash
# macOS / Linux
claude mcp add gitnexus -- npx -y gitnexus@latest mcp

# Windows
claude mcp add gitnexus -- cmd /c npx -y gitnexus@latest mcp
```

**Codex** (full support — MCP + skills + hooks):

```bash
codex mcp add gitnexus -- npx -y gitnexus@latest mcp
```

Or via `~/.codex/config.toml` (system scope) / `.codex/config.toml` (project scope):

```toml
[mcp_servers.gitnexus]
command = "npx"
args = ["-y", "gitnexus@latest", "mcp"]
```

Codex hooks (PreToolUse graph enrichment + PostToolUse stale-index detection in `~/.codex/hooks.json`, [same schema as Claude Code](https://developers.openai.com/codex/hooks)) need the bundled adapter script, so they are installed by `gitnexus setup -c codex` rather than manually.

Alternatively, install everything as a [Codex plugin](https://developers.openai.com/codex/plugins/build) (MCP + skills + hooks in one step):

```bash
codex plugin marketplace add abhigyanpatwari/GitNexus
# then inside Codex: /plugins → install "GitNexus"
```

> **Codex notes:** SessionStart is intentionally not registered — Codex reads [AGENTS.md natively](https://developers.openai.com/codex/guides/agents-md), which already carries the GitNexus context block. Newly installed hooks need a one-time approval in Codex via `/hooks` before they run. Pick **one** install route (`gitnexus setup -c codex` **or** the plugin): plugin hooks load alongside `~/.codex/hooks.json`, so installing both can fire duplicate hooks per tool call.

**Cursor** (`~/.cursor/mcp.json` — global, works for all projects):

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

**Antigravity** (Google) — `~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

> `gitnexus setup` also merges an `AfterTool` entry into `~/.gemini/settings.json` (under the canonical [Gemini CLI hooks schema](https://geminicli.com/docs/hooks/reference/)) and installs skills to `~/.gemini/antigravity/skills/`. Existing user hooks are preserved. The hook adapter's path is rewritten at install time, so run `gitnexus setup` rather than hand-editing.

**OpenCode** (`~/.config/opencode/config.json`):

```json
{
  "mcp": {
    "gitnexus": {
      "type": "local",
      "command": ["gitnexus", "mcp"]
    }
  }
}
```

**CodeBuddy** (Tencent) — priority chain, edit the **first non-empty file that exists**: `~/.codebuddy/.mcp.json` (recommended) → `~/.codebuddy/mcp.json` (deprecated) → `~/.codebuddy.json` (legacy). CodeBuddy reads only the first existing file, so adding servers to a higher-priority file than the one currently in use would hide the servers below it. Create `~/.codebuddy/.mcp.json` only if none exist:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

**Qoder** (Alibaba) — `~/.qoder.json`:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

</details>

<details>
<summary><strong>MCP read-only mode</strong></summary>

Set `GITNEXUS_MCP_READ_ONLY=1` before starting the MCP server to expose only the proven single-repository read surface. Raw `cypher`, rename and group tools, group routing, and group resources are omitted from discovery and rejected before backend dispatch. Tool descriptions and generated setup/context resources are scrubbed so they do not recommend unavailable routes.

The default is unchanged when the variable is unset or `0`. Any other value fails server startup rather than silently weakening the policy.

</details>

<details>
<summary><strong>MCP repository policy</strong></summary>

Set `GITNEXUS_MCP_ALLOWED_REPOS` to a comma-separated list of canonical registry names or absolute indexed paths. Entries are trimmed, resolved against the registry, and deduplicated at startup. When exactly one repository is allowed it becomes the implicit default; when several are allowed, callers must select one unless `GITNEXUS_MCP_DEFAULT_REPO` is also set.

The default repository must resolve to an allowed repository. Invalid, ambiguous, blank, or mismatched configuration fails startup before stdio or HTTP begins serving. The allowlist applies to tools, aliases, discovery, resources, templates, implicit resolution, and embedded HTTP; hidden repository details are not included in selection errors. Setting only `GITNEXUS_MCP_DEFAULT_REPO` chooses a default without restricting explicit repository selections. An allowed repository whose name is duplicated in the registry must be configured by path, and its context resource is only served for the unique name form.

</details>

<details>
<summary><strong>MCP response budgets</strong></summary>

The `query`, `context`, and `impact` tools accept an optional positive-integer `maxTokens` argument. It bounds the complete formatted MCP response, including hints and error text, using a deterministic four-UTF-8-bytes-per-token estimate. When truncation is required, the response ends with `…` and remains valid UTF-8.

Set `GITNEXUS_MCP_DEFAULT_MAX_TOKENS` to apply the same guardrail when callers do not send `maxTokens`. An explicit tool argument takes precedence. Leaving both unset preserves the existing response byte-for-byte; this is a transport guardrail, not semantic pagination or an exact model-specific tokenizer limit.

</details>

## CLI Reference

Everyday commands:

```bash
gitnexus setup                   # Configure MCP for detected editors (one-time; -c to select)
gitnexus analyze [path]          # Index a repository (or update a stale index)
gitnexus mcp                     # Start MCP server (stdio) — serves all indexed repos
gitnexus serve                   # Start local HTTP server (multi-repo) for web UI connection
gitnexus eval-server             # Start lightweight evaluation HTTP tools (loopback by default)
gitnexus list                    # List all indexed repositories
gitnexus status                  # Show index status for current repo
gitnexus clean                   # Delete index for current repo
gitnexus wiki [path]             # Generate repository wiki from knowledge graph
gitnexus uninstall               # Preview removal of GitNexus MCP/skills/hooks (--force to apply)
```

You can also query the graph directly from the terminal — `gitnexus query`, `context`, `impact`, `trace`, `cypher`, `detect-changes`, and `check` mirror the MCP tools of the same names, and `gitnexus doctor` prints runtime platform capabilities.

<details>
<summary><strong>Authenticated <code>eval-server</code> binding</strong></summary>

`gitnexus eval-server` binds to `127.0.0.1` by default. Loopback bindings do not require authentication. Any non-loopback bind, including `0.0.0.0`, a LAN address, or a hostname that resolves to a LAN IPv4 address, requires `GITNEXUS_AUTH_TOKEN`. Every endpoint then requires an exact `Authorization: Bearer <token>` header.

```bash
GITNEXUS_AUTH_TOKEN='replace-me' gitnexus eval-server --host 0.0.0.0
```

The token may be set in the shell, `.env.local`, or `.env` in the working directory. Precedence is shell > `.env.local` > `.env`. Only `GITNEXUS_AUTH_TOKEN` is read from those files; their other values are not added to the process environment. Keep token files uncommitted.

</details>

<details>
<summary><strong>All <code>analyze</code> flags</strong></summary>

```bash
gitnexus analyze --force         # Full rebuild: re-parse + graph rebuild + FTS rebuild
gitnexus analyze --repair-fts    # Fast path: rebuild/verify only FTS indexes on existing index data
gitnexus analyze --skills        # Generate repo-specific skill files from detected communities
gitnexus analyze --skip-embeddings  # Skip embedding generation (faster)
gitnexus analyze --embeddings [limit]  # Enable embedding generation (slower, better search)
gitnexus analyze --skip-agents-md   # Preserve custom AGENTS.md/CLAUDE.md gitnexus section edits
gitnexus analyze --skip-skills      # Skip installing standard .claude/skills/gitnexus-* skill files
gitnexus analyze --skip-git         # Index folders that are not Git repositories
gitnexus analyze --default-branch develop  # Branch used in the generated regression-compare example (base_ref)
gitnexus analyze --verbose       # Log skipped files when parsers are unavailable
gitnexus analyze --worker-timeout 60  # Increase worker idle timeout for slow parses
gitnexus analyze --workers <n>   # Parse worker pool size (>=1; default: cores-1, capped at 16,
                                 # auto-sized to the repo). 0 is rejected — there is no sequential mode.
gitnexus analyze --wal-checkpoint-threshold 67108864  # LadybugDB WAL auto-checkpoint threshold in bytes
                                 # (default 67108864 = 64 MiB; -1 keeps Ladybug stock ~16 MiB)
```

If `analyze` reports a worker parse timeout on a large or unusual repository, it keeps running and falls back safely. To give slow worker jobs more time, use `--worker-timeout 60` or set `GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS=60000`. For very large files, `GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES` controls the worker job byte budget.

**Embeddings node limit** — `gitnexus analyze --embeddings` generates semantic search vectors with a default 50,000-node safety cap to protect memory on large repositories:

```bash
gitnexus analyze --embeddings          # default 50,000 node safety cap
gitnexus analyze --embeddings 0        # disable the cap entirely
gitnexus analyze --embeddings 100000   # custom cap
```

If embeddings are skipped on a large repository, the indexed graph likely exceeds the default cap — re-run with `--embeddings 0` or a higher limit.

</details>

<details>
<summary><strong>Repository groups</strong> (multi-repo / monorepo service tracking)</summary>

```bash
gitnexus group create <name>                           # Create a repository group
gitnexus group add <group> <groupPath> <registryName>  # Add a repo. <groupPath> is a hierarchy path
                                                       # (e.g. hr/hiring/backend); <registryName> is the
                                                       # repo's name from the registry (see `gitnexus list`)
gitnexus group remove <group> <groupPath>              # Remove a repo by its hierarchy path
gitnexus group list [name]                             # List groups, or show one group's config
gitnexus group sync <name>                             # Extract contracts and match across repos/services
gitnexus group contracts <name>                        # Inspect extracted contracts and cross-links
gitnexus group query <name> <q>                        # Search execution flows across all repos in a group
gitnexus group status <name>                           # Check staleness of repos in a group
gitnexus group impact <name> --target <symbol> --repo <groupPath>  # Cross-repo blast radius
```

</details>

<details>
<summary><strong>Project config (<code>.gitnexusrc</code>)</strong></summary>

Commit a `.gitnexusrc` JSON file at the repo root to preconfigure recurring `analyze` options per project, instead of re-passing the same flags every run. It is read from the resolved repo root (not `.gitnexus/`, which is gitignored index storage). **CLI flags always override `.gitnexusrc`.**

```jsonc
{
  // Default branch used in the generated regression-compare example (base_ref).
  // Use this so a project on `develop`/`master` doesn't get "main" rewritten
  // over its fix on every analyze. (Alias: "branch".)
  "defaultBranch": "develop",
  "skipContextFiles": true, // alias of skipAgentsMd: keep your own AGENTS.md/CLAUDE.md
  "skipSkills": true, // don't install standard .claude/skills/gitnexus-* skills
  "embeddings": true, // generate embeddings by default
  "workerTimeout": 60,
}
```

A nested `analyze` block is also accepted (and overrides flat keys for the same option):

```json
{ "analyze": { "defaultBranch": "develop", "skipSkills": true } }
```

Notes:

- The default branch is resolved as: `--default-branch` > `.gitnexusrc` `defaultBranch`/`branch` > auto-detected `origin/HEAD` > `main`.
- `skipContextFiles` / `skipAiContext` are aliases for `skipAgentsMd` — they skip the `AGENTS.md` / `CLAUDE.md` block only. They do **not** imply `skipSkills`. `indexOnly` is the stronger option that skips all file injection.
- Supported keys: `defaultBranch` (`branch`), `skipAgentsMd` (`skipContextFiles`, `skipAiContext`), `skipSkills`, `indexOnly`, `stats`/`noStats`, `embeddings`, `dropEmbeddings`, `name`, `allowDuplicateName`, `maxFileSize`, `workerTimeout`, `walCheckpointThreshold`, `workers`, `embeddingThreads`, `embeddingBatchSize`, `embeddingSubBatchSize`, `embeddingDevice`.
- The file is JSON only. Unknown keys and invalid values fail fast with an actionable error before analysis starts.

</details>

<details>
<summary><strong>Environment variables</strong></summary>

Most `analyze` knobs are also CLI flags (`--workers`, `--worker-timeout`, `--max-file-size`, `--verbose`). Use the env-var form when you'd otherwise repeat the same flag every run, or when invoking GitNexus from a long-running host (MCP server, eval-server, CI shell) that already manages its own environment. CLI flags take precedence over env vars; env vars take precedence over built-in defaults.

| Variable                                        | Default                   | Effect                                                                                                                                                                                                                                                                                                      | Tune when…                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITNEXUS_WORKER_POOL_SIZE`                     | `cores - 1`, capped at 16 | Parse worker pool size (must be ≥ 1). Equivalent to `--workers <n>`. The worker pool is the sole parse path — there is no sequential parser, so `0` is rejected with an actionable error (the pool self-heals via quarantine + respawn).                                                                    | Constrained containers (cgroup CPU limits) or CI runners with explicit quotas. To narrow down a worker crash set `1` for a single-worker pool — not `0`.                              |
| `GITNEXUS_PARSE_CHUNK_CONCURRENCY`              | `2`                       | Number of chunks whose file contents may be read into memory in parallel while the pool dispatches the current chunk. Worker dispatch itself stays serial.                                                                                                                                                  | Repos large enough to chunk (multi-MB total source) where disk I/O is a measurable fraction of analyze wall-clock.                                                                    |
| `GITNEXUS_VERBOSE`                              | unset                     | When `1`, enables verbose ingestion logs (skipped-file warnings, per-chunk throughput, parse-cache stats). Equivalent to `--verbose`.                                                                                                                                                                       | Debugging an analyze that "completed" but seems to have missed files; tuning `--workers` / chunk concurrency against observable throughput.                                           |
| `GITNEXUS_AUTH_TOKEN`                           | unset                     | Bearer token required when `eval-server` binds beyond loopback. May also be read from `.env.local` or `.env`; shell values take precedence.                                                                                                                                                                 | Exposing the evaluation HTTP tools to a container, VM, or LAN.                                                                                                                        |
| `GITNEXUS_PROFILE_DEFERRED`                     | unset                     | When `1`, emits `[deferred-profile]` timing/progress logs for the post-chunk deferred resolution band (imports → heritage → buildHeritageMap → legacy call resolution). Implied by `GITNEXUS_VERBOSE`.                                                                                                      | Diagnosing analyze stalls in "Resolving calls (all chunks)" on large Java/Kotlin repos (issue #1741) without the full verbose ingestion noise.                                        |
| `GITNEXUS_PROFILE_DEFERRED_SLOW_MS`             | `3000` (verbose) / `5000` | Per-file threshold in ms above which `processCallsFromExtracted` emits a `slow file …` log line. Parsed via `Number()`: accepts integers (`5000`), scientific notation (`2.5e3`), decimals (`.5`), and hex (`0x10`). Non-finite or non-positive values fall back to the default.                            | Hunting a few outlier files dominating the deferred call-resolution stage; lower to surface more, raise to focus only on the worst.                                                   |
| `PROF_LBUG_LOAD`                                | unset                     | When `1`, emits one `[lbug-load prof]` summary line per `loadGraphToLbug` call breaking the graph-DB persistence wall into stages (`csv-emit` / `copy-nodes` / `copy-rels` / `fallback` / `total`) plus node & edge counts. Zero-cost when unset.                                                           | Attributing large-repo analyze wall time across CSV generation vs. LadybugDB `COPY` (issue #2203) — the analyze "emit" timing is the scope-resolution bucket, not this DB-write path. |
| `GITNEXUS_MAX_FILE_SIZE`                        | `512` (KB)                | Walker skip threshold in KB. Hard cap is `32768` (tree-sitter buffer ceiling). Equivalent to `--max-file-size <kb>`.                                                                                                                                                                                        | Indexing repos with intentionally-large source files (generated parsers, vendored bundles) that should still be parsed.                                                               |
| `GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS`          | `30000`                   | Worker idle timeout in milliseconds before retry/fallback. Equivalent to `--worker-timeout <seconds>` × 1000.                                                                                                                                                                                               | Slow-parsing files (large minified JS, deeply-nested TS types) that legitimately need more than 30s.                                                                                  |
| `GITNEXUS_FTS_STEMMER`                          | `porter`                  | Stemmer used when rebuilding BM25/FTS indexes. Use `none` for CJK-heavy repositories, or a language stemmer such as `german`, `french`, or `spanish` for matching repository comments. Re-run `gitnexus analyze --repair-fts` after changing it.                                                            | Keyword search quality is poor for non-English comments or identifiers under English stemming.                                                                                        |
| `GITNEXUS_WAL_CHECKPOINT_THRESHOLD`             | `67108864` (64 MiB)       | LadybugDB WAL auto-checkpoint threshold in bytes. Equivalent to `--wal-checkpoint-threshold <bytes>`. `-1` keeps LadybugDB's stock threshold (~16 MiB). Larger thresholds reduce checkpoint frequency but increase the WAL size at rotation time — choose a smaller value on disk-constrained environments. | You need a larger or smaller WAL auto-checkpoint threshold for your analyze workload.                                                                                                 |
| `GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES`           | `8388608` (8 MB)          | Per-job byte budget the pool will send to a worker in one `postMessage`.                                                                                                                                                                                                                                    | Very large individual files; mostly diagnostic — bumping past 8 MB risks structured-clone memory pressure.                                                                            |
| `GITNEXUS_WORKER_MAX_RESPAWNS_PER_SLOT`         | `3`                       | Max replacement spawns per worker slot before the slot is dropped from the active rotation. Bounds respawn loops on a chronically-crashing slot.                                                                                                                                                            | Hosts where a flaky worker should retry more (raise) or fail-fast (lower) before the slot is dropped.                                                                                 |
| `GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS`     | `5 × subBatchTimeoutMs`   | Total retry wall-time budget per job before quarantining. Combined with `timeoutBackoffFactor`, prevents exponentially-growing retries from stalling for hours.                                                                                                                                             | Slow files that legitimately need long total retry windows; lower to fail-fast on stalls.                                                                                             |
| `GITNEXUS_WORKER_CONSECUTIVE_FAILURE_THRESHOLD` | `max(3, poolSize)`        | Per-slot consecutive deaths before the pool's circuit breaker trips. After tripping, every subsequent dispatch rejects until a fresh pool is created.                                                                                                                                                       | Hosts where a SIGSEGV-prone native grammar should trip the breaker sooner; CI runners that should fail loudly.                                                                        |
| `GITNEXUS_WORKER_SHUTDOWN_DRAIN_MS`             | `30000`                   | Max wait at pool shutdown for a retired worker still inside native code. The worker is terminated at its next JS-safe point instead of mid-native-call (which aborts the whole process with `Napi::Error`, #2432); on expiry it is left running, unref'd, and terminated when it surfaces.                  | Shutdown latency matters more than draining a wedged worker (lower), or a legitimately-slow native grammar needs longer to surface (raise).                                           |
| `GITNEXUS_CPP_CAPTURE_BUDGET_MS`                | `20000`                   | Per-file wall-clock budget for C++ capture extraction. On breach the file keeps the captures accumulated so far and logs a warning — the worker returns to JS instead of stalling in native-heavy loops (#2432). `0` expires immediately.                                                                   | Pathological generated C++ that still exceeds the budget after the indexed lookups; raise for completeness, lower to fail-fast.                                                       |
| `GITNEXUS_CHUNK_BYTE_BUDGET`                    | `2097152` (2 MB)          | Chunk boundary used for cache-key composition and dispatch. Smaller = finer-grained cache hits but more dispatch overhead.                                                                                                                                                                                  | Tuning incremental-analyze cache behavior on monorepos.                                                                                                                               |
| `GITNEXUS_NO_GITIGNORE`                         | unset                     | When set, skips `.gitignore` parsing. `.gitnexusignore` is still honored.                                                                                                                                                                                                                                   | Indexing a repo whose `.gitignore` excludes files you actually want indexed (e.g., generated code committed for cross-repo lookup).                                                   |
| `GITNEXUS_SKIP_OPTIONAL_GRAMMARS`               | unset                     | When `=1` strictly, skips the vendored grammar materialize for `tree-sitter-dart`, `tree-sitter-proto`, `tree-sitter-swift`, and `tree-sitter-kotlin` at install time (and the Dart/Proto source builds). Those four won't be parsed; the install still succeeds.                                           | Installing on a host without a C++ toolchain or where the vendored prebuilds don't match; willing to skip Dart/Proto/Swift/Kotlin parsing.                                            |
| `GITNEXUS_MCP_READ_ONLY`                        | unset                     | Set to `1` to expose only proven single-repository read tools and resources; `0` disables the policy and any other value fails startup.                                                                                                                                                                     | The MCP server runs in an environment where graph mutation, raw Cypher, and cross-repository group routing must be unavailable.                                                       |
| `GITNEXUS_MCP_ALLOWED_REPOS`                    | unset                     | Comma-separated allowlist of canonical indexed repository names or absolute paths. Invalid, ambiguous, or blank entries fail startup.                                                                                                                                                                       | One MCP process must expose only a bounded subset of the repositories in the global registry.                                                                                         |
| `GITNEXUS_MCP_DEFAULT_REPO`                     | unset                     | Canonical indexed repository name or absolute path used when a tool or resource omits its repository. Must belong to the allowlist when one is set.                                                                                                                                                         | Several repositories are available but unqualified MCP calls should resolve deterministically.                                                                                        |
| `GITNEXUS_MCP_DEFAULT_MAX_TOKENS`               | unset                     | Default positive-integer response budget for MCP `query`, `context`, and `impact`, estimated at four UTF-8 bytes per token. Explicit `maxTokens` wins.                                                                                                                                                      | Long MCP responses consume too much model context and callers cannot reliably add a per-request budget.                                                                               |

</details>

<details>
<summary><strong><code>gitnexus uninstall</code></strong></summary>

`gitnexus uninstall` reverses `gitnexus setup` — it removes the GitNexus MCP entries, hooks, and skill directories it added to each detected editor. Skill directories are identified **by bundled gitnexus skill name** (e.g. `gitnexus-cli/`), so if you customized files inside an installed skill directory, back them up first. It is a dry-run preview by default and prints the exact paths it would remove; pass `--force` to apply. Per-repo indexes (`gitnexus clean --all`) and the global npm package (`npm uninstall -g gitnexus`) are left for you to remove.

</details>

<details>
<summary><strong>Publishing to understand-quickly</strong> (opt-in)</summary>

[`looptech-ai/understand-quickly`](https://github.com/looptech-ai/understand-quickly) is a public registry of code-knowledge graphs that lists `gitnexus@1` as a first-class format. After registering your repo once (`npx @understand-quickly/cli add` or the [wizard](https://looptech-ai.github.io/understand-quickly/add.html)), `gitnexus publish` fires a single `repository_dispatch` event so the registry resyncs your entry on demand instead of waiting for the nightly job.

It is opt-in and a no-op without `UNDERSTAND_QUICKLY_TOKEN` — a fine-grained GitHub PAT with `Repository dispatches: write` on the registry repo. Nothing else happens; no graph file is uploaded. See the [protocol spec](https://github.com/looptech-ai/understand-quickly/blob/main/docs/integrations/protocol.md) for the full contract.

</details>

## How It Works

GitNexus builds a complete knowledge graph of your codebase through a multi-phase indexing pipeline:

1. **Structure** — walks the file tree and maps folder/file relationships
2. **Parsing** — extracts functions, classes, methods, and interfaces using Tree-sitter ASTs
3. **Resolution** — resolves imports, function calls, heritage, constructor inference, and `self`/`this` receiver types across files with language-aware logic
4. **Clustering** — groups related symbols into functional communities
5. **Processes** — traces execution flows from entry points through call chains
6. **Search** — builds hybrid search indexes for fast retrieval

### Supported Languages

| Language   | Imports | Named Bindings | Exports | Heritage | Type Annotations | Constructor Inference | Config | Frameworks | Entry Points |
| ---------- | ------- | -------------- | ------- | -------- | ---------------- | --------------------- | ------ | ---------- | ------------ |
| TypeScript | ✓       | ✓              | ✓       | ✓        | ✓                | ✓                     | ✓      | ✓          | ✓            |
| JavaScript | ✓       | ✓              | ✓       | ✓        | —                | ✓                     | ✓      | ✓          | ✓            |
| Python     | ✓       | ✓              | ✓       | ✓        | ✓                | ✓                     | ✓      | ✓          | ✓            |
| Java       | ✓       | ✓              | ✓       | ✓        | ✓                | ✓                     | —      | ✓          | ✓            |
| Kotlin     | ✓       | ✓              | ✓       | ✓        | ✓                | ✓                     | —      | ✓          | ✓            |
| C#         | ✓       | ✓              | ✓       | ✓        | ✓                | ✓                     | ✓      | ✓          | ✓            |
| Go         | ✓       | —              | ✓       | ✓        | ✓                | ✓                     | ✓      | ✓          | ✓            |
| Rust       | ✓       | ✓              | ✓       | ✓        | ✓                | ✓                     | —      | ✓          | ✓            |
| PHP        | ✓       | ✓              | ✓       | —        | ✓                | ✓                     | ✓      | ✓          | ✓            |
| Ruby       | ✓       | —              | ✓       | ✓        | —                | ✓                     | —      | ✓          | ✓            |
| Swift      | —       | —              | ✓       | ✓        | ✓                | ✓                     | ✓      | ✓          | ✓            |
| C          | —       | —              | ✓       | —        | ✓                | ✓                     | —      | ✓          | ✓            |
| C++        | —       | —              | ✓       | ✓        | ✓                | ✓                     | —      | ✓          | ✓            |
| Dart       | ✓       | —              | ✓       | ✓        | ✓                | ✓                     | —      | ✓          | ✓            |

**Imports** — cross-file import resolution · **Named Bindings** — `import { X as Y }` / re-export tracking · **Exports** — public/exported symbol detection · **Heritage** — class inheritance, interfaces, mixins · **Type Annotations** — explicit type extraction for receiver resolution · **Constructor Inference** — infer receiver type from constructor calls (`self`/`this` resolution included for all languages) · **Config** — language toolchain config parsing (tsconfig, go.mod, etc.) · **Frameworks** — AST-based framework pattern detection · **Entry Points** — entry point scoring heuristics

**Control flow (CFG, opt-in `--pdg`)** — per-function control-flow graphs (`BasicBlock` nodes + `CFG` edges) feeding the PDG/taint substrate, currently **TypeScript & JavaScript** (#2081 M1); other languages planned. Off by default.

### Multi-Repo Architecture

GitNexus uses a **global registry** so one MCP server can serve multiple indexed repos. No per-project MCP config needed — set it up once and it works everywhere.

Each `gitnexus analyze` stores the index in `.gitnexus/` inside the repo (portable, gitignored) and registers a pointer in `~/.gitnexus/registry.json`. When an AI agent starts, the MCP server reads the registry and can serve any indexed repo. LadybugDB connections are opened lazily on first query and evicted after 5 minutes of inactivity (max 5 concurrent). If only one repo is indexed, the `repo` parameter is optional on all tools — agents don't need to change anything.

<details>
<summary><strong>Architecture diagram</strong></summary>

```mermaid
flowchart TD
    subgraph CLI [CLI Commands]
        Setup["gitnexus setup"]
        Analyze["gitnexus analyze"]
        Clean["gitnexus clean"]
        List["gitnexus list"]
    end

    subgraph Registry ["~/.gitnexus/"]
        RegFile["registry.json"]
    end

    subgraph Repos [Project Repos]
        RepoA[".gitnexus/ in repo A"]
        RepoB[".gitnexus/ in repo B"]
    end

    subgraph MCP [MCP Server]
        Server["server.ts"]
        Backend["LocalBackend"]
        Pool["Connection Pool"]
        ConnA["LadybugDB conn A"]
        ConnB["LadybugDB conn B"]
    end

    Setup -->|"writes global MCP config"| CursorConfig["~/.cursor/mcp.json"]
    Analyze -->|"registers repo"| RegFile
    Analyze -->|"stores index"| RepoA
    Clean -->|"unregisters repo"| RegFile
    List -->|"reads"| RegFile
    Server -->|"reads registry"| RegFile
    Server --> Backend
    Backend --> Pool
    Pool -->|"lazy open"| ConnA
    Pool -->|"lazy open"| ConnB
    ConnA -->|"queries"| RepoA
    ConnB -->|"queries"| RepoB
```

</details>

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

<details>
<summary><strong>More examples:</strong> search · context · detect_changes · rename · Cypher</summary>

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

### Rename (Multi-File)

```
rename({symbol_name: "validateUser", new_name: "verifyUser", dry_run: true})

status: success
files_affected: 5
total_edits: 8
graph_edits: 6     (high confidence)
text_search_edits: 2  (review carefully)
changes: [...]
```

### Cypher Queries

```cypher
-- Find what calls auth functions with high confidence
MATCH (c:Community {heuristicLabel: 'Authentication'})<-[:CodeRelation {type: 'MEMBER_OF'}]-(fn)
MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(fn)
WHERE r.confidence > 0.8
RETURN caller.name, fn.name, r.confidence
ORDER BY r.confidence DESC
```

</details>

## Wiki Generation

Generate LLM-powered documentation from your knowledge graph:

```bash
# Requires an LLM API key (OPENAI_API_KEY, etc.)
gitnexus wiki

# Use a custom model or provider (default model: minimax/minimax-m2.5)
gitnexus wiki --model gpt-4o
gitnexus wiki --base-url https://api.anthropic.com/v1

# Force full regeneration
gitnexus wiki --force

# Increase the timeout or retries for large codebases or slow LLM providers
gitnexus wiki --timeout <seconds>  # LLM request timeout in seconds (default: disabled)
gitnexus wiki --retries <n>        # Max LLM retry attempts per request (default: 3)

# Allow a specific LAN/self-hosted HTTP LLM host (HTTPS is preferred for remote endpoints)
gitnexus wiki --base-url http://llama-box.local:8080/v1 --allow-insecure-connection llama-box.local
# Or set a comma-separated host allowlist:
GITNEXUS_ALLOW_INSECURE_CONNECTION=llama-box.local,192.168.1.23

# Change the output language
gitnexus wiki --lang <lang>  # e.g. english, chinese, spanish, japanese
```

For safety, `http://` LLM base URLs are allowed by default only for loopback hosts (`localhost`, `127.0.0.1`, `::1`). `--allow-insecure-connection` and `GITNEXUS_ALLOW_INSECURE_CONNECTION` accept exact hostnames or IP addresses only; do not include schemes, ports, paths, credentials, or wildcards.

The wiki generator reads the indexed graph structure, groups files into modules via LLM, generates per-module documentation pages, and creates an overview page — all with cross-references to the knowledge graph.

## Web UI (browser-based)

A client-side graph explorer and AI chat — your code never leaves your machine.

**Try it now:** [gitnexus.vercel.app](https://gitnexus.vercel.app) — run `npx gitnexus@latest serve` locally and the page auto-connects to your local backend.

<img width="2550" height="1343" alt="gitnexus_img" src="https://github.com/user-attachments/assets/cc5d637d-e0e5-48e6-93ff-5bcfdb929285" />

The web UI uses the same indexing pipeline as the CLI but runs entirely in WebAssembly (Tree-sitter WASM, LadybugDB WASM, in-browser embeddings). It's great for quick exploration but limited by browser memory for larger repos.

**Local Backend Mode:** run `gitnexus serve` and open the web UI — it auto-detects the server and shows all your indexed repos, with full AI chat support. No re-upload, no re-index. The agent's tools (Cypher queries, search, code navigation) route through the backend HTTP API automatically.

<details>
<summary><strong>Run the frontend locally</strong></summary>

```bash
git clone https://github.com/abhigyanpatwari/gitnexus.git
cd gitnexus/gitnexus-shared && npm install && npm run build
cd ../gitnexus-web && npm install
npm run dev
# Then in another terminal, start the backend the frontend connects to:
npx gitnexus@latest serve
```

</details>

## Docker

```bash
docker compose up -d
```

This starts the server on `http://localhost:4747` and the web UI on `http://localhost:4173`. The UI auto-detects the server because the browser runs on the host and reaches the container via the mapped port.

The official setup ships **two signed images**, published identically to **GitHub Container Registry** (GHCR) and **Docker Hub** — same build, same digest, same Cosign signature:

| Purpose                                                                | GHCR (default in `docker-compose.yaml`)       | Docker Hub mirror              |
| ---------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ |
| CLI / `gitnexus serve` backend (HTTP API on port `4747`, MCP, indexer) | `ghcr.io/abhigyanpatwari/gitnexus:latest`     | `akonlabs/gitnexus:latest`     |
| Static web UI (port `4173`)                                            | `ghcr.io/abhigyanpatwari/gitnexus-web:latest` | `akonlabs/gitnexus-web:latest` |

A named volume (`gitnexus-data`) persists the global registry, indexes, and cloned repos at `/data/gitnexus` inside the server container. To make repos on your host machine indexable, set `WORKSPACE_DIR` before bringing the stack up:

```bash
WORKSPACE_DIR=$HOME/code docker compose up -d
# Inside the server container the directory is mounted read-only at /workspace.
docker compose exec gitnexus-server gitnexus index /workspace/my-repo
```

> **Heads-up — image rename.** Earlier releases published the web UI under `ghcr.io/abhigyanpatwari/gitnexus`. That slug now hosts the CLI/server image and the UI moved to `ghcr.io/abhigyanpatwari/gitnexus-web`. Previous tags remain pullable, but new versions are only published under the new slugs — update your `docker run` / compose files (or just adopt the bundled compose).

<details>
<summary><strong>Direct <code>docker run</code> & env file</strong></summary>

```bash
# Server
docker run --rm -d \
  --name gitnexus-server \
  -p 4747:4747 \
  -v gitnexus-data:/data/gitnexus \
  ghcr.io/abhigyanpatwari/gitnexus:latest

# Web UI
docker run --rm -d \
  --name gitnexus-web \
  -p 4173:4173 \
  ghcr.io/abhigyanpatwari/gitnexus-web:latest
```

Optional env file (override image tags, container names, ports, workspace dir):

```bash
cp .env.example .env
docker compose --env-file .env up -d
```

Files:

- [Dockerfile.web](Dockerfile.web) — builds `gitnexus-shared` and `gitnexus-web`, then serves the production frontend.
- [Dockerfile.cli](Dockerfile.cli) — builds the CLI/server (with its native deps) and runs `gitnexus serve --host 0.0.0.0`.
- [docker-compose.yaml](docker-compose.yaml) — starts both signed images side by side.
- [.env.example](.env.example) — overrides for image names, container names, ports, and the workspace mount.

</details>

<details>
<summary><strong>Versioning & supply-chain protection</strong> (Cosign signatures, provenance, Kubernetes admission policy)</summary>

The Docker images are version-locked to the npm package:

- Stable images are **only published from `vX.Y.Z` git tags** (via `docker.yml` triggered directly by the tag push), and the workflow refuses to build unless the tag exactly matches `gitnexus/package.json`'s version. So `ghcr.io/abhigyanpatwari/gitnexus:1.6.2` (and its Docker Hub mirror `akonlabs/gitnexus:1.6.2`) is byte-for-byte the same release as `npm install gitnexus@1.6.2` — no drift, no floating builds from `main`. Both registries receive the same digest from a single build step, so you can pull from either and the signature verifies identically.
- Release-candidate images (e.g. `:1.7.0-rc.1`) are published alongside each RC npm release. They are built by `publish.yml` calling `docker.yml` as a reusable workflow after the RC tag is created and pushed.
- `:latest` is auto-promoted only from non-prerelease tags by the Docker metadata action, so it always points at a real, npm-published version.

Both images are signed with [Cosign keyless signing][cosign-keyless] using the workflow's GitHub OIDC identity, and shipped with build provenance and SBOM attestations. **This is your protection against supply-chain attacks**: even if an attacker republishes a same-named image elsewhere (or somehow pushes to a typo-squatted registry), they cannot forge a Cosign signature tied to `abhigyanpatwari/GitNexus`'s `docker.yml`. Always verify before pulling into sensitive environments.

**Stable releases** — signed from the `v*` tag ref:

```bash
cosign verify ghcr.io/abhigyanpatwari/gitnexus:1.6.2 \
  --certificate-identity-regexp '^https://github\.com/abhigyanpatwari/GitNexus/\.github/workflows/docker\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Same signature verifies the Docker Hub mirror (identical digest):
cosign verify docker.io/akonlabs/gitnexus:1.6.2 \
  --certificate-identity-regexp '^https://github\.com/abhigyanpatwari/GitNexus/\.github/workflows/docker\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The regex pins the certificate identity to this repo's `docker.yml` workflow **run from a `v*` tag** — rejecting unsigned images, images signed by other workflows, and images signed from unprotected refs. It is identical for both registries because both sets of tags were signed at the same digest in one workflow run.

**Release candidates** — signed from `refs/heads/main` (the caller's ref when `publish.yml` invokes `docker.yml` as a reusable workflow):

```bash
cosign verify ghcr.io/abhigyanpatwari/gitnexus:1.7.0-rc.1 \
  --certificate-identity 'https://github.com/abhigyanpatwari/GitNexus/.github/workflows/docker.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

You can also inspect the build provenance and SBOM:

```bash
cosign download attestation ghcr.io/abhigyanpatwari/gitnexus:1.6.2 \
  --predicate-type https://slsa.dev/provenance/v1
```

**Kubernetes: enforce signatures at admission.** Ship the bundled [`ClusterImagePolicy`](deploy/kubernetes/cluster-image-policy.yaml) so the [Sigstore policy-controller][policy-controller] rejects any GitNexus pod whose image is not signed by this repo's `docker.yml` running from a `vX.Y.Z` tag — the same identity the `cosign verify` snippet above pins.

```bash
# 1. Install the controller (one-time, cluster-wide)
helm repo add sigstore https://sigstore.github.io/helm-charts && helm repo update
helm install policy-controller -n cosign-system --create-namespace \
  sigstore/policy-controller

# 2. Opt your namespace in
kubectl label namespace <your-ns> policy.sigstore.dev/include=true

# 3. Apply the policy
kubectl apply -f deploy/kubernetes/cluster-image-policy.yaml
```

After this, attempting to deploy an unsigned image — or one signed by anything other than `abhigyanpatwari/GitNexus`'s `docker.yml` at a `v*` tag — fails the admission webhook before a pod is ever created. This turns the verifiable signature into an enforced policy, which is the supply-chain control most clusters actually need.

[cosign-keyless]: https://docs.sigstore.dev/cosign/signing/overview/
[policy-controller]: https://docs.sigstore.dev/policy-controller/overview/

</details>

## Enterprise

GitNexus is available as an **enterprise offering** — fully managed **SaaS** or **self-hosted** deployment. Commercial use of the OSS version is also available with proper licensing.

Enterprise includes:

- **PR Review** — automated blast radius analysis on pull requests
- **Auto-updating Code Wiki** — always up-to-date documentation (Code Wiki is also available in OSS)
- **Auto-reindexing** — knowledge graph stays fresh automatically
- **Multi-repo support** — unified graph across repositories
- **OCaml support** — additional language coverage
- **Priority feature/language support** — request new languages or features

**Upcoming:** auto regression forensics · end-to-end test generation

👉 Learn more at [akonlabs.com](https://akonlabs.com) — for commercial licensing or enterprise inquiries, ping us on [Discord](https://discord.gg/AAsRVT6fGb) or email founders@akonlabs.com

## Community Integrations

Built by the community — not officially maintained, but worth checking out.

| Project                                                                       | Author                                                 | Description                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [pi-gitnexus](https://github.com/tintinweb/pi-gitnexus)                       | [@tintinweb](https://github.com/tintinweb)             | GitNexus plugin for [pi](https://pi.dev) — `pi install npm:pi-gitnexus` |
| [gitnexus-stable-ops](https://github.com/ShunsukeHayashi/gitnexus-stable-ops) | [@ShunsukeHayashi](https://github.com/ShunsukeHayashi) | Stable ops & deployment workflows (Miyabi ecosystem)                    |
| [KiloCode MCP workflow](Documentation/kilo-code-mcp.md)                       | [@oktanishq](https://github.com/oktanishq)             | Guide to connect GitNexus MCP to Kilo Code and verify tools.            |

> Have a project built on GitNexus? Open a PR to add it here!

## Roadmap

**Actively building:**

- [ ] **LLM Cluster Enrichment** — semantic cluster names via LLM API
- [ ] **AST Decorator Detection** — parse @Controller, @Get, etc.
- [ ] **Incremental Indexing** — only re-index changed files

**Recently completed:**

- [x] Constructor-Inferred Type Resolution, `self`/`this` Receiver Mapping
- [x] Wiki Generation, Multi-File Rename, Git-Diff Impact Analysis
- [x] Process-Grouped Search, 360-Degree Context, Claude Code Hooks
- [x] Multi-Repo MCP, Zero-Config Setup, 14 Language Support
- [x] Community Detection, Process Detection, Confidence Scoring
- [x] Hybrid Search, Vector Index

## Development

- [ARCHITECTURE.md](ARCHITECTURE.md) — packages, index → graph → MCP flow, where to change code
- [RUNBOOK.md](RUNBOOK.md) — analyze, embeddings, stale index, MCP recovery, CI snippets
- [GUARDRAILS.md](GUARDRAILS.md) — safety rules and operational "Signs" for contributors and agents
- [CONTRIBUTING.md](CONTRIBUTING.md) — license, setup, commits, and pull requests
- [TESTING.md](TESTING.md) — test commands for `gitnexus` and `gitnexus-web`

## Tech Stack

| Layer               | CLI                                   | Web                                     |
| ------------------- | ------------------------------------- | --------------------------------------- |
| **Runtime**         | Node.js (native)                      | Browser (WASM)                          |
| **Parsing**         | Tree-sitter native bindings           | Tree-sitter WASM                        |
| **Database**        | LadybugDB native                      | LadybugDB WASM                          |
| **Embeddings**      | HuggingFace transformers.js (GPU/CPU) | transformers.js (WebGPU/WASM)           |
| **Search**          | BM25 + semantic + RRF                 | BM25 + semantic + RRF                   |
| **Agent Interface** | MCP (stdio)                           | LangChain ReAct agent                   |
| **Visualization**   | —                                     | Sigma.js + Graphology (WebGL)           |
| **Frontend**        | —                                     | React 18, TypeScript, Vite, Tailwind v4 |
| **Clustering**      | Graphology                            | Graphology                              |
| **Concurrency**     | Worker threads + async                | Web Workers + Comlink                   |

## Security & Privacy

- **CLI**: everything runs locally on your machine. No network calls. Index stored in `.gitnexus/` (gitignored). Global registry at `~/.gitnexus/` stores only paths and metadata.
- **Web**: everything runs in your browser. No code uploaded to any server. API keys stored in localStorage only.
- Open source — audit the code yourself.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=abhigyanpatwari/GitNexus&type=date&legend=top-left)](https://www.star-history.com/#abhigyanpatwari/GitNexus&type=date&legend=top-left)

## Acknowledgments

- [Tree-sitter](https://tree-sitter.github.io/) — AST parsing
- [LadybugDB](https://ladybugdb.com/) — embedded graph database with vector support (formerly KuzuDB)
- [Sigma.js](https://www.sigmajs.org/) — WebGL graph rendering
- [transformers.js](https://huggingface.co/docs/transformers.js) — browser ML
- [Graphology](https://graphology.github.io/) — graph data structures
- [MCP](https://modelcontextprotocol.io/) — Model Context Protocol
