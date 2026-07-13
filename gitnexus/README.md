# GitNexus

**Graph-powered code intelligence for AI agents.** Index any codebase into a knowledge graph, then query it via MCP or CLI.

Works with **Cursor**, **Claude Code**, **Antigravity** (Google), **Codex**, **Windsurf**, **Cline**, **OpenCode**, **CodeBuddy** (Tencent), **Qoder** (Alibaba), and any MCP-compatible tool.

[![npm version](https://img.shields.io/npm/v/gitnexus.svg)](https://www.npmjs.com/package/gitnexus)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](https://polyformproject.org/licenses/noncommercial/1.0.0/)

---

## Why?

AI coding tools don't understand your codebase structure. They edit a function without knowing 47 other functions depend on it. GitNexus fixes this by **precomputing every dependency, call chain, and relationship** into a queryable graph.

**Three commands to give your AI agent full codebase awareness.**

## Large-Scale Validation: Unreal Engine 5.8

Validated on a full Unreal Engine 5.8 source tree — **92,321 files** (91,601 C++ + 466 C + 254 Dart), exit 0 in **6.53h** (23,508.9s), producing **2,587,687 nodes / 5,171,925 edges / 55,288 clusters / 119 flows**, peak RSS 72.7 GB.

This scale required four fixes on top of upstream (see [`rebuild-notes.md`](../rebuild-notes.md)):

1. **cpp qualified-namespace resolution indexed** (`src/core/ingestion/languages/cpp/inline-namespaces.ts`) — O(N×M) full scan → O(1) `Map` lookup. Emit-receiver phase 29.5h → ~1-2h.
2. **Option A OOM guard** (`gitnexus-shared/src/scope-resolution/finalize-algorithm.ts`) — consumer wildcards (cpp `#include`, etc.) skip the pure-waste transitive-closure copy. `closureEntries` 726M → 12.5M.
3. **emit 6-subphase probes** (`src/core/ingestion/scope-resolution/pipeline/run.ts`) — `sr-emit-receiver/unresolved-receiver/free-call/references/imports/post-resolution` pre/post.
4. **main pipeline phase2/phase3 probes** (`src/core/run-analyze.ts`) — `phase2-lbug-load` / `phase3-fts` pre/post.

Reproduce: `gitnexus analyze <ue-root> --force --skills --verbose --workers 16 --max-file-size 4096` with `GITNEXUS_DEBUG_HEAP=1` + `GITNEXUS_HEAP_PROBE_FILE=<path>`.

## Quick Start

```bash
# Index your repo (run from repo root)
npx gitnexus analyze
```

That's it. This indexes the codebase, installs agent skills, registers Claude Code hooks, and creates `AGENTS.md` / `CLAUDE.md` context files — all in one command.

> **On npm 11.x?** `npx` can crash during install (`Cannot destructure property 'package' of 'node.target'`). Use the pnpm form instead:
>
> ```bash
> pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter dlx gitnexus@latest analyze
> ```
>
> See [Troubleshooting → `npx gitnexus` crashes with `node.target is null` (npm 11)](#cannot-destructure-property-package-of-nodetarget-as-it-is-null) for the full matrix (global install, npm downgrade).

To configure MCP for your editor, run `npx gitnexus setup` once — or set it up manually below.

`gitnexus setup` auto-detects your editors and writes the correct global MCP config. You only need to run it once. To configure only selected integrations, pass `--coding-agent`/`-c` with a comma-separated list or repeat the option, for example `gitnexus setup -c cursor,codex`.

### Editor Support

| Editor                   | MCP | Skills | Hooks (auto-augment)                                                                       | Support      |
| ------------------------ | --- | ------ | ------------------------------------------------------------------------------------------ | ------------ |
| **Claude Code**          | Yes | Yes    | Yes (PreToolUse + PostToolUse)                                                             | **Full**     |
| **Cursor**               | Yes | Yes    | Yes (postToolUse, [manual install](../gitnexus-cursor-integration/README.md#hook-install)) | **Full**     |
| **Antigravity** (Google) | Yes | Yes    | Yes (AfterTool, [Gemini CLI hooks schema](https://geminicli.com/docs/hooks/reference/))    | **Full**     |
| **Codex**                | Yes | Yes    | Yes (PreToolUse + PostToolUse, [Codex hooks](https://developers.openai.com/codex/hooks))   | **Full**     |
| **OpenCode**             | Yes | Yes    | —                                                                                          | MCP + Skills |
| **CodeBuddy** (Tencent)  | Yes | Yes    | —                                                                                          | MCP + Skills |
| **Qoder** (Alibaba)      | Yes | Yes    | —                                                                                          | MCP + Skills |
| **Windsurf**             | Yes | —      | —                                                                                          | MCP          |

> **Claude Code** and **Codex** get the deepest integration: MCP tools + agent skills + PreToolUse hooks that automatically enrich grep/glob/bash calls with knowledge graph context + PostToolUse hooks that detect a stale index after commits and prompt the agent to reindex.

### Community Integrations

| Agent                | Install                      | Source                                                  |
| -------------------- | ---------------------------- | ------------------------------------------------------- |
| [pi](https://pi.dev) | `pi install npm:pi-gitnexus` | [pi-gitnexus](https://github.com/tintinweb/pi-gitnexus) |

## MCP Setup (manual)

If you prefer to configure manually instead of using `gitnexus setup`:

### Claude Code (full support — MCP + skills + hooks)

```bash
# macOS / Linux
claude mcp add gitnexus -- npx -y gitnexus@latest mcp

# Windows
claude mcp add gitnexus -- cmd /c npx -y gitnexus@latest mcp
```

### Codex (full support — MCP + skills + hooks)

```bash
codex mcp add gitnexus -- npx -y gitnexus@latest mcp
```

Codex hooks (PreToolUse graph enrichment + PostToolUse stale-index detection in `~/.codex/hooks.json`, [same schema as Claude Code](https://developers.openai.com/codex/hooks)) need the bundled adapter script, so they are installed by `gitnexus setup -c codex` rather than manually.

Alternatively, install everything as a [Codex plugin](https://developers.openai.com/codex/plugins/build) (MCP + skills + hooks in one step):

```bash
codex plugin marketplace add abhigyanpatwari/GitNexus
# then inside Codex: /plugins → install "GitNexus"
```

> **Codex notes:** SessionStart is intentionally not registered — Codex reads [AGENTS.md natively](https://developers.openai.com/codex/guides/agents-md), which already carries the GitNexus context block. Newly installed hooks need a one-time approval in Codex via `/hooks` before they run. Pick **one** install route (`gitnexus setup -c codex` **or** the plugin): plugin hooks load alongside `~/.codex/hooks.json`, so installing both can fire duplicate hooks per tool call.

### Cursor / Windsurf

Add to `~/.cursor/mcp.json` (global — works for all projects):

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

### OpenCode

Add to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

### CodeBuddy

CodeBuddy reads only the **first existing file** in its config priority chain: `~/.codebuddy/.mcp.json` (recommended) → `~/.codebuddy/mcp.json` (deprecated) → `~/.codebuddy.json` (legacy). Edit the first non-empty file that exists — creating a higher-priority file would hide the servers in the ones below it. If none exist, create `~/.codebuddy/.mcp.json`:

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

### Qoder

Add to `~/.qoder.json`:

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

## How It Works

GitNexus builds a complete knowledge graph of your codebase through a multi-phase indexing pipeline:

1. **Structure** — Walks the file tree and maps folder/file relationships
2. **Parsing** — Extracts functions, classes, methods, and interfaces using Tree-sitter ASTs
3. **Resolution** — Resolves imports and function calls across files with language-aware logic
   - **Field & Property Type Resolution** — Tracks field types across classes and interfaces for deep chain resolution (e.g., `user.address.city.getName()`)
   - **Return-Type-Aware Variable Binding** — Infers variable types from function return types, enabling accurate call-result binding
4. **Clustering** — Groups related symbols into functional communities
5. **Processes** — Traces execution flows from entry points through call chains
6. **Search** — Builds hybrid search indexes for fast retrieval

The result is a **LadybugDB graph database** stored locally in `.gitnexus/` with full-text search and semantic embeddings.

### Experimental community detection engine

Community detection uses the bundled Graphology Leiden implementation by default. To test the #2337 Icebug migration path without changing default analyze behavior, set:

```bash
GITNEXUS_COMMUNITY_ENGINE=icebug npx gitnexus analyze
```

Supported values are `graphology`, `icebug`, and `auto`. The Icebug path is an experimental probe: GitNexus does not bundle an Icebug native package yet, and if a separately resolvable module is unavailable or its API does not match the expected `Graph.fromCSR` / `ParallelLeidenView` shape, analyze falls back to Graphology and reports the fallback in progress output. Today `auto` is behaviorally identical to `icebug`: both try Icebug and fall back to Graphology, while `graphology` skips the Icebug probe entirely.

## MCP Tools

Your AI agent gets **17 tools** (15 per-repo + 2 group) automatically:

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

> With one indexed repo, the `repo` param is optional. With multiple, specify which: `query({search_query: "auth", repo: "my-app"})`. Per-repo tools also take an optional `branch` for indexes pinned with `gitnexus analyze --branch`; omitting it queries the workspace index, which follows your checked-out working tree. `explain` and `pdg_query` need an index built with `gitnexus analyze --pdg`.

## MCP Resources

| Resource                                | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `gitnexus://repos`                      | List all indexed repositories (read first)           |
| `gitnexus://setup`                      | Setup and usage guidance for agents                  |
| `gitnexus://repo/{name}/context`        | Codebase stats, staleness check, and available tools |
| `gitnexus://repo/{name}/clusters`       | All functional clusters with cohesion scores         |
| `gitnexus://repo/{name}/cluster/{name}` | Cluster members and details                          |
| `gitnexus://repo/{name}/processes`      | All execution flows                                  |
| `gitnexus://repo/{name}/process/{name}` | Full process trace with steps                        |
| `gitnexus://repo/{name}/schema`         | Graph schema for Cypher queries                      |
| `gitnexus://group/{name}/contracts`     | A group's extracted contracts and cross-links        |
| `gitnexus://group/{name}/status`        | Staleness of repos in a group                        |

## MCP Prompts

| Prompt          | What It Does                                                              |
| --------------- | ------------------------------------------------------------------------- |
| `detect_impact` | Pre-commit change analysis — scope, affected processes, risk level        |
| `generate_map`  | Architecture documentation from the knowledge graph with mermaid diagrams |

## CLI Commands

```bash
gitnexus setup                   # Configure MCP for detected editors (one-time; use -c to select)
gitnexus uninstall               # Preview removal of GitNexus MCP/skills/hooks (add --force to apply)
gitnexus analyze [path]          # Index a repository (or update stale index)
gitnexus analyze --repair-fts    # Fast path: rebuild/verify only FTS indexes on existing index data
gitnexus analyze --force         # Full rebuild: re-parse + graph rebuild + FTS rebuild
gitnexus analyze --embeddings    # Enable embedding generation (slower, better search)
gitnexus embeddings install      # Fetch the optional local embedding stack on demand (--cuda, --force)
gitnexus analyze --skills        # Generate repo-specific skill files from detected communities
gitnexus analyze --skip-agents-md  # Preserve custom AGENTS.md/CLAUDE.md gitnexus section edits
gitnexus analyze --skip-skills   # Skip installing .claude/skills/gitnexus/ skill files
gitnexus analyze --skip-git      # Index folders that are not Git repositories
gitnexus analyze --workers <n>   # Parse worker pool size (>=1; default: cores-1, capped at 16)
gitnexus analyze --verbose       # Log skipped files when parsers are unavailable
gitnexus analyze --max-file-size 1024  # Skip files larger than N KB (default: 512, cap: 32768)
gitnexus analyze --worker-timeout 60  # Increase worker idle timeout for slow parses
gitnexus analyze --wal-checkpoint-threshold 67108864  # 64 MiB. Control LadybugDB WAL auto-checkpoint threshold (default: 67108864 = 64 MiB; -1 keeps Ladybug stock ~16 MiB)
gitnexus mcp                     # Start MCP server (stdio) — serves all indexed repos
gitnexus serve                   # Start local HTTP server (multi-repo) for web UI
gitnexus index                   # Register an existing .gitnexus/ folder into the global registry
gitnexus list                    # List all indexed repositories
gitnexus status                  # Show index status for current repo
gitnexus clean                   # Delete index for current repo
gitnexus clean --all --force     # Delete all indexes
gitnexus wiki [path]             # Generate LLM-powered docs from knowledge graph
gitnexus wiki --model <model>    # Wiki with custom LLM model (default: minimax/minimax-m2.5)
gitnexus doctor                  # Show runtime platform capabilities and embedding configuration

# Direct graph queries — the same tools the MCP server exposes, no MCP daemon needed
gitnexus query "<concept>"                                    # Process-grouped hybrid search
gitnexus context <symbol> [--uid <uid> | --file <path>]       # 360° symbol view; flags disambiguate a shared name
gitnexus impact <symbol> [--uid <uid> | --file <path> | --kind <kind>]  # Blast radius; flags disambiguate a shared name
gitnexus trace <from> <to>       # Shortest directed path between two symbols
gitnexus detect-changes          # Map the working-tree diff to affected symbols and execution flows
gitnexus check                   # Read-only structural checks against the indexed graph
gitnexus cypher "<query>"        # Run a raw Cypher query against the knowledge graph

# Repository groups (multi-repo / monorepo service tracking)
gitnexus group create <name>                                   # Create a repository group
gitnexus group add <group> <groupPath> <registryName>          # Add a repo to a group. <groupPath> is a hierarchy path (e.g. hr/hiring/backend); <registryName> is the repo's name from the registry (see `gitnexus list`)
gitnexus group remove <group> <groupPath>                      # Remove a repo from a group by its hierarchy path
gitnexus group list [name]                                     # List groups, or show one group's config
gitnexus group sync <name>                                     # Extract contracts and match across repos/services
gitnexus group contracts <name>  # Inspect extracted contracts and cross-links
gitnexus group query <name> <q>  # Search execution flows across all repos in a group
gitnexus group status <name>     # Check staleness of repos in a group
gitnexus group impact <name> --target <symbol> --repo <groupPath>  # Cross-repo blast radius
```

> **`gitnexus uninstall`** reverses `gitnexus setup` — it removes the GitNexus MCP entries, hooks, and skill directories it added to each detected editor. Skill directories are identified **by bundled gitnexus skill name** (e.g. `gitnexus-cli/`), so if you customized files inside an installed skill directory, back them up first. It is a dry-run preview by default and prints the exact paths it would remove; pass `--force` to apply. Per-repo indexes (`gitnexus clean --all`) and the global npm package (`npm uninstall -g gitnexus`) are left for you to remove.

## Remote Embeddings

Set these env vars to use a remote OpenAI-compatible `/v1/embeddings` endpoint instead of the local model:

```bash
export GITNEXUS_EMBEDDING_URL=http://your-server:8080/v1
export GITNEXUS_EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
export GITNEXUS_EMBEDDING_DIMS=1024          # optional, default 384
export GITNEXUS_EMBEDDING_API_KEY=your-key   # optional, default: "unused"
gitnexus analyze . --embeddings
```

Works with Infinity, vLLM, TEI, llama.cpp, Ollama, LM Studio, or OpenAI. When unset, local embeddings are used unchanged.

## Multi-Repo Support

GitNexus supports indexing multiple repositories. Each `gitnexus analyze` registers the repo in a global registry (`~/.gitnexus/registry.json`). The MCP server serves all indexed repos automatically.

## Supported Languages

TypeScript, JavaScript, Python, Java, C, C++, C#, Go, Rust, PHP, Kotlin, Swift, Ruby, Dart

### Language Feature Matrix

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

## Agent Skills

GitNexus ships with skill files that teach AI agents how to use the tools effectively:

- **Exploring** — Navigate unfamiliar code using the knowledge graph
- **Debugging** — Trace bugs through call chains
- **Impact Analysis** — Analyze blast radius before changes
- **Refactoring** — Plan safe refactors using dependency mapping
- **Guide** — GitNexus tool/resource/schema reference for the agent
- **CLI** — Run analyze/status/clean/wiki commands on request

Installed automatically by both `gitnexus analyze` (per-repo) and `gitnexus setup` (global). Run `gitnexus analyze --skills` to additionally generate repo-specific skills for each detected functional area under `.claude/skills/generated/`.

## Requirements

- Node.js >= 22
- Git repository (uses git for commit tracking)

## Release candidates

Stable releases publish to the default `latest` dist-tag. When a pull request
with non-documentation changes merges into `main`, an automated workflow also
publishes a prerelease build under the `rc` dist-tag, so early adopters can
try in-flight fixes without waiting for the next stable cut. (Docs-only
merges are skipped.)

```bash
# Try the latest release candidate (pre-stable — may change at any time)
npm install -g gitnexus@rc
# — or —
npx gitnexus@rc analyze
```

Release-candidate versions follow the standard semver prerelease format
`X.Y.Z-rc.N`, where `X.Y.Z` is the next stable target (bumped from the
current `latest` by patch by default; `minor` or `major` when kicking off a
bigger cycle) and `N` increments per published rc. Example sequence:
`1.6.2-rc.1`, `1.6.2-rc.2`, …, then once `1.6.2` ships stable,
`1.6.3-rc.1`. See the [Releases page](https://github.com/abhigyanpatwari/GitNexus/releases)
for the full list; stable `latest` is unaffected.

## Troubleshooting

### `Cannot destructure property 'package' of 'node.target' as it is null`

This error comes from **npm 11.x's arborist** while installing gitnexus (often via `npx`), before gitnexus code runs. It is triggered by platform-filtered `optionalDependencies` in native packages such as `onnxruntime-node` / `@huggingface/transformers` (used when indexing with `--embeddings`). GitNexus cannot catch it at runtime — use one of these workarounds:

```bash
pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter dlx gitnexus@latest analyze       # auto-selected when pnpm + npm 11+
npm install -g gitnexus@latest         # global install avoids per-run npx reify
gitnexus analyze                       # if already installed globally
```

On **pnpm 10+**, lifecycle scripts are blocked unless explicitly allowed — the resolver adds `--allow-build` for `@ladybugdb/core`, `gitnexus`, and `tree-sitter` automatically when it picks `pnpm dlx`.

If you must stay on npm 11.x without pnpm, downgrade npm toolchain-wide (last resort):

```bash
npm install -g npm@10.9.0
```

See [#1939](https://github.com/abhigyanpatwari/GitNexus/issues/1939) and the original [#819](https://github.com/abhigyanpatwari/GitNexus/issues/819) thread. An older variant of this crash (tree-sitter-dart tarball URL) was fixed in gitnexus v1.6.2+ ([#820](https://github.com/abhigyanpatwari/GitNexus/pull/820)); if you still see install failures after upgrading, clear cache:

```bash
npm cache clean --force
npx gitnexus@latest analyze
```

### `ERR_DLOPEN_FAILED` / `lbugjs.node` missing (pnpm dlx, pnpx)

GitNexus depends on `@ladybugdb/core`, whose native database addon
(`lbugjs.node`) is placed by a postinstall script. `pnpm dlx`, `pnpx`, and any
install run with `--ignore-scripts` skip lifecycle scripts, so the addon is
never put in place and the runtime crashes with `ERR_DLOPEN_FAILED`:

```
Error: dlopen(.../@ladybugdb/core/lbugjs.node, ...): tried: '...' (no such file)
  code: 'ERR_DLOPEN_FAILED'
```

Options that run install scripts:

```bash
# pnpm dlx with explicit build permission (one-off, no global install required)
pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter \
  dlx gitnexus@latest serve

# npm: global install (recommended on npm 11+; bare npx may crash — see section above)
npm install -g gitnexus@latest
gitnexus serve

# npx (npm < 11, or after upgrading npm)
npx gitnexus@latest serve

# pnpm: global install with build scripts allowed (pnpm 10.2+; no approve-builds -g on pnpm 11+)
pnpm add -g --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter gitnexus
gitnexus serve
```

### Installation fails with native module errors

Some optional language grammars (Dart, Proto, Swift, Kotlin) require native compilation. If they fail, GitNexus still works — those languages will be skipped. To skip them intentionally (no C++ toolchain needed), set `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` before installing.

If `npm install -g gitnexus` fails on native modules:

```bash
# Ensure build tools are available (Linux/macOS)
# Ubuntu/Debian: sudo apt install python3 make g++
# macOS: xcode-select --install

# Retry installation
npm install -g gitnexus
```

### Installation fails behind an HTTP proxy (`onnxruntime-node` postinstall)

`onnxruntime-node`'s postinstall downloads optional CUDA GPU binaries from `api.nuget.org` — outside the npm registry, so registry mirrors don't cover it, and its proxy layer (`global-agent`) ignores the standard `HTTP_PROXY`/`HTTPS_PROXY` variables and rejects 302 redirects ([#2370](https://github.com/abhigyanpatwari/GitNexus/issues/2370)).

Since the packages are optional dependencies, a failed download no longer breaks `npm install -g gitnexus` — npm skips the embedding stack and everything else works. The stack then **self-heals on demand**: the first `gitnexus analyze --embeddings` (or an explicit `gitnexus embeddings install`) fetches it through your configured npm registry — mirrors and proxies apply, no NuGet download involved — into `~/.gitnexus/embedding-runtime`.

```bash
# heal a proxy-degraded install manually (CPU embeddings; registry-only)
gitnexus embeddings install

# reinstall into the prefix even when the stack already resolves
gitnexus embeddings install --force

# CUDA GPU hosts: also fetch GPU binaries (NuGet; set the proxy global-agent reads)
GLOBAL_AGENT_HTTPS_PROXY=<proxy-url> gitnexus embeddings install --cuda
```

The prefix defaults to `~/.gitnexus/embedding-runtime`; set `GITNEXUS_EMBEDDING_RUNTIME_DIR` to install it elsewhere (e.g. a writable path in a container).

> **Node requirement for the on-demand prefix:** the self-heal loads the prefixed packages via `module.registerHooks`, available on Node **≥ 22.15** (on the 22.x line) or **≥ 23.5** (on the 23.x line). On an older Node the packages install but can't be loaded from the prefix — reinstall them into the install itself instead (works on every supported Node): `ONNXRUNTIME_NODE_INSTALL=skip npm install -g gitnexus` (Windows: `set ONNXRUNTIME_NODE_INSTALL=skip && npm install -g gitnexus`). Skipping only the CUDA download keeps full CPU embeddings (CPU embeddings don't need it). Check the result any time with `gitnexus doctor` (Embeddings → Support line).

### Analyze warns about unavailable FTS or VECTOR extensions

GitNexus uses optional DuckDB extensions for BM25 and vector search. The `gitnexus serve` and MCP read paths only ever try to `LOAD` the extensions — they never block on a network install. The `analyze` command, by default, attempts one bounded out-of-process install if `LOAD` fails (a plain `INSTALL` to download a missing extension, escalating to `FORCE INSTALL` only when the `LOAD` error shows the existing file is broken or truncated, so a permanent non-file failure does not re-download on every run) and proceeds even when that install times out, so the index is always written to disk; BM25/vector search degrade gracefully until the extensions become available.

Configure the behavior with these environment variables:

| Variable                                     | Values                       | Default             | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITNEXUS_LBUG_EXTENSION_INSTALL`            | `auto`, `load-only`, `never` | `auto`              | `auto` runs one bounded install if LOAD fails — a plain `INSTALL`, escalating to `FORCE INSTALL` only when the LOAD error shows the present extension file is broken. `load-only` only uses already-installed extensions (recommended for offline / firewalled environments). `never` skips optional extensions entirely.                                                                                                                                                                                                                                                                                                                                                                               |
| `GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS` | positive integer             | `15000`             | Wall-clock budget for the out-of-process extension-install child before it is killed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GITNEXUS_FTS_STEMMER`                       | supported LadybugDB stemmer  | `porter`            | Stemmer used when rebuilding BM25/FTS indexes. Use `none` for CJK-heavy repositories, or a language stemmer such as `german`, `french`, or `spanish` when that better matches repository comments and identifiers. Re-run `gitnexus analyze --repair-fts` after changing it.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GITNEXUS_FTS_CJK_SEGMENTATION`              | `none`, `bigram`             | `none`              | `bigram` inserts overlapping character-bigram boundaries into Chinese/Japanese Han-ideograph spans in `content`/`description` before FTS indexing, so LadybugDB's space-only tokenizer can see sub-phrase word boundaries. Scoped to CJK Unified Ideographs only — Japanese Hiragana/Katakana and Korean Hangul are not currently segmented. Unlike `GITNEXUS_FTS_STEMMER`, this rewrites stored text — enabling it on an already-indexed repo requires a full `gitnexus analyze --force`; neither `--repair-fts` nor a plain incremental `analyze` applies it to previously-indexed files. Set the same value wherever `analyze` and search-serving processes (CLI query, MCP server, web server) run. |
| `GITNEXUS_COMMUNITY_ENGINE`                  | `graphology`, `icebug`, `auto` | `graphology`        | Community-detection engine used during analyze. `graphology` uses the bundled default path. `icebug` and `auto` currently behave identically: both try the experimental Icebug CSR path and fall back to Graphology if the optional native module is unavailable or incompatible.                                                                                                                                                                                                                                                                                                                                                         |
| `GITNEXUS_WAL_CHECKPOINT_THRESHOLD`          | integer `>= -1`              | `67108864` (64 MiB) | LadybugDB WAL auto-checkpoint threshold during analyze (bytes). Auto-checkpoint remains enabled; `-1` keeps Ladybug's stock ~16 MiB. Larger thresholds reduce checkpoint frequency but increase the WAL size at rotation time — choose a smaller value on disk-constrained environments.                                                                                                                                                                                                                                                                                                                                                                                                                |

```bash
# Offline/airgapped: never reach the network for extensions
GITNEXUS_LBUG_EXTENSION_INSTALL=load-only npx gitnexus analyze

# Slow network: give extension downloads more time
GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS=30000 npx gitnexus analyze

# CJK-heavy codebase: rebuild keyword indexes without English stemming
GITNEXUS_FTS_STEMMER=none npx gitnexus analyze --repair-fts

# CJK-heavy codebase: enable sub-phrase search over Chinese/Japanese Han text.
# On an already-indexed repo, the first run after enabling this MUST be --force —
# --repair-fts and plain incremental `analyze` both leave old files un-segmented.
GITNEXUS_FTS_CJK_SEGMENTATION=bigram npx gitnexus analyze --force
```

### Analysis runs out of memory

For very large repositories:

```bash
# Increase Node.js heap size
NODE_OPTIONS="--max-old-space-size=16384" npx gitnexus analyze

# Exclude large directories
echo "vendor/" >> .gitnexusignore
echo "dist/" >> .gitnexusignore
```

### Large files are being skipped

By default the walker skips files larger than **512 KB** (see log line `Skipped N large files (>512KB)`). Raise the threshold via either the CLI flag or the environment variable — both accept a value in **KB**:

```bash
# CLI flag (takes precedence over the env var)
npx gitnexus analyze --max-file-size 2048     # skip only files > 2 MB

# Environment variable (persists across commands)
export GITNEXUS_MAX_FILE_SIZE=2048
npx gitnexus analyze
```

Values above **32768 KB (32 MB)** are clamped to the tree-sitter parser ceiling; invalid values fall back to the 512 KB default with a one-time warning. When an override is active, `analyze` prints the effective threshold in its startup banner (e.g. `GITNEXUS_MAX_FILE_SIZE: effective threshold 2048KB (default 512KB)`).

### Analyze reports a worker timeout

Worker parse timeouts are recoverable. GitNexus retries stalled worker jobs with backoff, splits large jobs to isolate slow files, and quarantines a file that repeatedly crashes its worker (respawning the slot so the pool keeps going). If a large repository needs more time per worker job, use either:

```bash
# CLI flag, in seconds
npx gitnexus analyze --worker-timeout 60

# Environment variable, in milliseconds
export GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS=60000
npx gitnexus analyze
```

For repositories with very large source files, `GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES` controls the worker job byte budget. The default is **8388608 bytes (8 MB)**.

### Worker pool resilience tuning

Three env vars expose the pool's resilience layers (respawn budget, cumulative-timeout cap, circuit breaker). Defaults are tuned for typical repos; bump them when an analyze legitimately needs more retries, or lower them to fail-fast on a known-bad shape.

| Variable                                        | Default                 | Effect                                                                                                                |
| ----------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GITNEXUS_WORKER_MAX_RESPAWNS_PER_SLOT`         | `3`                     | Max replacement spawns per slot before the slot is dropped from the active rotation.                                  |
| `GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS`     | `5 × subBatchTimeoutMs` | Total retry wall-time budget per job before quarantining. Bounds exponentially-growing retry waits.                   |
| `GITNEXUS_WORKER_CONSECUTIVE_FAILURE_THRESHOLD` | `max(3, poolSize)`      | Per-slot consecutive deaths before the pool's circuit breaker trips. After tripping, dispatches require a fresh pool. |
| `GITNEXUS_WORKER_SHUTDOWN_DRAIN_MS`             | `30000`                 | Max wait at pool shutdown for a retired worker still inside native code — terminated at its next JS-safe point instead of mid-native-call, which would abort the process (`Napi::Error`, #2432). |
| `GITNEXUS_CPP_CAPTURE_BUDGET_MS`                | `20000`                 | Per-file wall-clock budget for C++ capture extraction; on breach the file keeps partial captures with a warning (#2432). `0` expires immediately.           |

### Graph cleanup tuning

After scope resolution, analyze prunes inert block-local value symbols (a function-local `const`/`let`/`var` that ends up with only its structural `File→DEFINES` edge) to keep the graph focused on cross-symbol relationships. Module/file-scope symbols, class members, and any local with a real edge are always kept.

| Variable                            | Default | Effect                                                                             |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `GITNEXUS_KEEP_LOCAL_VALUE_SYMBOLS` | unset   | Set to `1`/`true` to keep inert block-local value symbols instead of pruning them. |

Programmatic callers can pass `keepLocalValueSymbols: true` in `PipelineOptions` instead of setting the env var.

### Hook augmentation and skip diagnostics

The Claude Code / Antigravity hooks keep their **stderr** silent on normal skip
paths so strict hook runners (e.g. Codex `PreToolUse`) never see unexpected
diagnostic output.

When a GitNexus process holds the repo DB write lock (the common case — the MCP
server is running, or the DB-lock probe timed out and failed closed), the local
CLI `augment` can't run (LadybugDB is single-writer). Rather than drop the
augmentation, the hook hands the agent a short, conditional MCP-query hint on
stdout (the sanctioned `additionalContext` channel) — _"if the GitNexus MCP tools
are live in this session, call `query` …"_ — so an agent that has the tools can
still fetch graph-ranked context. The hint is throttled to at most once per repo
per window (`GITNEXUS_MCP_HINT_THROTTLE_MS`, default 10 min; `0` disables), so an
owner-locked session isn't nudged on every search. A stale-index reminder, or an
already-current index, stays silent.

To see why a hook skipped the CLI augment, set `GITNEXUS_DEBUG=1` and re-run the
action — the hook writes the reason (e.g. `[GitNexus] augment skipped: MCP server
owns DB`) and the stale-index hint to its stderr:

```bash
GITNEXUS_DEBUG=1 <your command>   # surfaces hook skip/diagnostic reasons on stderr
```

Only `GITNEXUS_DEBUG=1` and `GITNEXUS_DEBUG=true` enable diagnostics; every other
value (including `0` and `false`) is treated as off. Diagnostics go to stderr
only — the hook's structured stdout (the JSON the agent consumes) is unaffected.

## Privacy

- All processing happens locally on your machine
- No code is sent to any server
- Index stored in `.gitnexus/` inside your repo (gitignored)
- Global registry at `~/.gitnexus/` stores only paths and metadata

## Web UI

GitNexus also has a browser-based UI at [gitnexus.vercel.app](https://gitnexus.vercel.app) — 100% client-side, your code never leaves the browser.

**Local Backend Mode:** Run `gitnexus serve` and open the web UI locally — it auto-detects the server and shows all your indexed repos, with full AI chat support. No need to re-upload or re-index. The agent's tools (Cypher queries, search, code navigation) route through the backend HTTP API automatically.

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)

Free for non-commercial use. Contact for commercial licensing.
