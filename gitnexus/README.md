# GitNexus

**Graph-powered code intelligence for AI agents.** Index any codebase into a knowledge graph, then query it via MCP or CLI.

Works with **Cursor**, **Claude Code**, **Codex**, **Windsurf**, **Cline**, **OpenCode**, and any MCP-compatible tool.

[![npm version](https://img.shields.io/npm/v/gitnexus.svg)](https://www.npmjs.com/package/gitnexus)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](https://polyformproject.org/licenses/noncommercial/1.0.0/)

---

## Why?

AI coding tools don't understand your codebase structure. They edit a function without knowing 47 other functions depend on it. GitNexus fixes this by **precomputing every dependency, call chain, and relationship** into a queryable graph.

**Three commands to give your AI agent full codebase awareness.**

## Quick Start

```bash
# Index your repo (run from repo root)
npx gitnexus analyze
```

That's it. This indexes the codebase, installs agent skills, registers Claude Code hooks, and creates `AGENTS.md` / `CLAUDE.md` context files — all in one command.

To configure MCP for your editor, run `npx gitnexus setup` once — or set it up manually below.

`gitnexus setup` auto-detects your editors and writes the correct global MCP config. You only need to run it once.

### Editor Support

| Editor | MCP | Skills | Hooks (auto-augment) | Support |
|--------|-----|--------|---------------------|---------|
| **Claude Code** | Yes | Yes | Yes (PreToolUse) | **Full** |
| **Cursor** | Yes | Yes | — | MCP + Skills |
| **Codex** | Yes | Yes | — | MCP + Skills |
| **Windsurf** | Yes | — | — | MCP |
| **OpenCode** | Yes | Yes | — | MCP + Skills |

> **Claude Code** gets the deepest integration: MCP tools + agent skills + PreToolUse hooks that automatically enrich grep/glob/bash calls with knowledge graph context.

### Community Integrations

| Agent | Install | Source |
|-------|---------|--------|
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

### Codex (full support — MCP + skills)

```bash
codex mcp add gitnexus -- npx -y gitnexus@latest mcp
```

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

## MCP Tools

Your AI agent gets these tools automatically:

| Tool | What It Does | `repo` Param |
|------|-------------|--------------|
| `list_repos` | Discover all indexed repositories | — |
| `query` | Process-grouped hybrid search (BM25 + semantic + RRF) | Optional |
| `context` | 360-degree symbol view — categorized refs, process participation | Optional |
| `impact` | Blast radius analysis with depth grouping and confidence | Optional |
| `detect_changes` | Git-diff impact — maps changed lines to affected processes | Optional |
| `rename` | Multi-file coordinated rename with graph + text search | Optional |
| `cypher` | Raw Cypher graph queries | Optional |

> With one indexed repo, the `repo` param is optional. With multiple, specify which: `query({query: "auth", repo: "my-app"})`.

## MCP Resources

| Resource | Purpose |
|----------|---------|
| `gitnexus://repos` | List all indexed repositories (read first) |
| `gitnexus://repo/{name}/context` | Codebase stats, staleness check, and available tools |
| `gitnexus://repo/{name}/clusters` | All functional clusters with cohesion scores |
| `gitnexus://repo/{name}/cluster/{name}` | Cluster members and details |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{name}` | Full process trace with steps |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher queries |

## MCP Prompts

| Prompt | What It Does |
|--------|-------------|
| `detect_impact` | Pre-commit change analysis — scope, affected processes, risk level |
| `generate_map` | Architecture documentation from the knowledge graph with mermaid diagrams |

## CLI Commands

```bash
gitnexus setup                   # Configure MCP for your editors (one-time)
gitnexus analyze [path]          # Index a repository (or update stale index)
gitnexus analyze --force         # Force full re-index
gitnexus analyze --embeddings    # Enable embedding generation (slower, better search)
gitnexus analyze --skip-agents-md  # Preserve custom AGENTS.md/CLAUDE.md gitnexus section edits
gitnexus analyze --verbose       # Log skipped files when parsers are unavailable
gitnexus analyze --max-file-size 1024  # Skip files larger than N KB (default: 512, cap: 32768)
gitnexus analyze --worker-timeout 60  # Increase worker idle timeout for slow parses
gitnexus mcp                     # Start MCP server (stdio) — serves all indexed repos
gitnexus serve                   # Start local HTTP server (multi-repo) for web UI
gitnexus index                   # Register an existing .gitnexus/ folder into the global registry
gitnexus list                    # List all indexed repositories
gitnexus status                  # Show index status for current repo
gitnexus clean                   # Delete index for current repo
gitnexus clean --all --force     # Delete all indexes
gitnexus wiki [path]             # Generate LLM-powered docs from knowledge graph
gitnexus wiki --model <model>    # Wiki with custom LLM model (default: gpt-4o-mini)

# Repository groups (multi-repo / monorepo service tracking)
gitnexus group create <name>                                   # Create a repository group
gitnexus group add <group> <groupPath> <registryName>          # Add a repo to a group. <groupPath> is a hierarchy path (e.g. hr/hiring/backend); <registryName> is the repo's name from the registry (see `gitnexus list`)
gitnexus group remove <group> <groupPath>                      # Remove a repo from a group by its hierarchy path
gitnexus group list [name]                                     # List groups, or show one group's config
gitnexus group sync <name>                                     # Extract contracts and match across repos/services
gitnexus group contracts <name>  # Inspect extracted contracts and cross-links
gitnexus group query <name> <q>  # Search execution flows across all repos in a group
gitnexus group status <name>     # Check staleness of repos in a group
```

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

TypeScript, JavaScript, Python, Java, C, C++, C#, Go, Rust, PHP, Kotlin, Swift, Ruby

### Language Feature Matrix

| Language | Imports | Named Bindings | Exports | Heritage | Type Annotations | Constructor Inference | Config | Frameworks | Entry Points |
|----------|---------|----------------|---------|----------|-----------------|---------------------|--------|------------|-------------|
| TypeScript | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| JavaScript | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Python | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Java | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Kotlin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| C# | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Go | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Rust | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| PHP | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ruby | ✓ | — | ✓ | ✓ | — | ✓ | — | ✓ | ✓ |
| Swift | — | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| C | — | — | ✓ | — | ✓ | ✓ | — | ✓ | ✓ |
| C++ | — | — | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ |

**Imports** — cross-file import resolution · **Named Bindings** — `import { X as Y }` / re-export tracking · **Exports** — public/exported symbol detection · **Heritage** — class inheritance, interfaces, mixins · **Type Annotations** — explicit type extraction for receiver resolution · **Constructor Inference** — infer receiver type from constructor calls (`self`/`this` resolution included for all languages) · **Config** — language toolchain config parsing (tsconfig, go.mod, etc.) · **Frameworks** — AST-based framework pattern detection · **Entry Points** — entry point scoring heuristics

## Agent Skills

GitNexus ships with skill files that teach AI agents how to use the tools effectively:

- **Exploring** — Navigate unfamiliar code using the knowledge graph
- **Debugging** — Trace bugs through call chains
- **Impact Analysis** — Analyze blast radius before changes
- **Refactoring** — Plan safe refactors using dependency mapping

Installed automatically by both `gitnexus analyze` (per-repo) and `gitnexus setup` (global).

## Requirements

- Node.js >= 18
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

This crash was caused by a dependency URL format that is incompatible with
certain npm/arborist versions ([npm/cli#8126](https://github.com/npm/cli/issues/8126)).
It is fixed in **gitnexus v1.6.2+**. Upgrade to the latest version:

```bash
npx gitnexus@latest analyze          # always uses the newest release
# — or —
npm install -g gitnexus@latest       # upgrade a global install
```

If you still hit npm install issues after upgrading, these generic workarounds
may help:

```bash
npm install -g npm@latest            # update npm itself
npm cache clean --force              # clear a possibly corrupt cache
```

### Installation fails with native module errors

Some optional language grammars (Dart, Kotlin, Swift) require native compilation. If they fail, GitNexus still works — those languages will be skipped.

If `npm install -g gitnexus` fails on native modules:

```bash
# Ensure build tools are available (Linux/macOS)
# Ubuntu/Debian: sudo apt install python3 make g++
# macOS: xcode-select --install

# Retry installation
npm install -g gitnexus
```

### Analyze warns about unavailable FTS or VECTOR extensions

GitNexus uses optional DuckDB extensions for BM25 and vector search. The `gitnexus serve` and MCP read paths only ever try to `LOAD` the extensions — they never block on a network install. The `analyze` command, by default, attempts one bounded out-of-process `INSTALL` if `LOAD` fails and proceeds even when that install times out, so the index is always written to disk; BM25/vector search degrade gracefully until the extensions become available.

Configure the behavior with two environment variables:

| Variable | Values | Default | Effect |
|----------|--------|---------|--------|
| `GITNEXUS_LBUG_EXTENSION_INSTALL` | `auto`, `load-only`, `never` | `auto` | `auto` runs one bounded INSTALL if LOAD fails. `load-only` only uses already-installed extensions (recommended for offline / firewalled environments). `never` skips optional extensions entirely. |
| `GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS` | positive integer | `15000` | Wall-clock budget for the out-of-process `INSTALL` child before it is killed. |

```bash
# Offline/airgapped: never reach the network for extensions
GITNEXUS_LBUG_EXTENSION_INSTALL=load-only npx gitnexus analyze

# Slow network: give extension downloads more time
GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS=30000 npx gitnexus analyze
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

Worker parse timeouts are recoverable. GitNexus retries stalled worker jobs with backoff, splits large jobs to isolate slow files, and falls back to the sequential parser when needed. If a large repository needs more time per worker job, use either:

```bash
# CLI flag, in seconds
npx gitnexus analyze --worker-timeout 60

# Environment variable, in milliseconds
export GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS=60000
npx gitnexus analyze
```

For repositories with very large source files, `GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES` controls the worker job byte budget. The default is **8388608 bytes (8 MB)**.

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
