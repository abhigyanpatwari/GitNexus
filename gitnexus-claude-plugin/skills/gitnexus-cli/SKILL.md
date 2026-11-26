---
name: gitnexus-cli
description: "Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean or remove an index, generate a wiki, sync a multi-repo group, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# GitNexus CLI Commands

Commands below use `node .gitnexus/run.cjs <command>` — the project-local runner `gitnexus analyze` drops next to the index. It auto-selects an available runner at call time (global `gitnexus`, else `pnpm dlx`, else `bunx`, else `npx`), so no package-manager assumption and no global install is required — including on a bun-only machine, which has no npm, npx or pnpm at all.

> **Not analyzed yet, or `node .gitnexus/run.cjs` reports `Cannot find module`** (the gitignored runner is absent — e.g. a fresh clone or `git clean`)? (Re)generate it with `npx gitnexus analyze` from the project root, or `bunx gitnexus@latest analyze` on a bun-only machine. On **npm 11.x**, if `npx` crashes during install (`node.target is null`), install once with `npm i -g gitnexus` (then `gitnexus analyze`), or use `bunx gitnexus@latest analyze`, or `pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter dlx gitnexus@latest analyze`. See [#1939](https://github.com/abhigyanpatwari/GitNexus/issues/1939).

## Execution provenance (floating vs pinned)

| Launcher | What it selects |
| --- | --- |
| `npx` / `bunx` / `pnpm dlx` **`gitnexus@latest`** | Floating registry tag — non-reproducible; may change between runs. Fine for bootstrap when no local runner exists. |
| `gitnexus setup` / persisted MCP config | Pins **`gitnexus@<installed version>`** so the MCP server matches the installed CLI. |
| `node .gitnexus/run.cjs <cmd>` | Project-local runner written by `analyze`. Prefers a global `gitnexus` binary when present; otherwise may still fall back to `pnpm dlx` / `bunx` / `npx` with `@latest`. |

Prefer `run.cjs` after the first successful analyze so the project carries its own entrypoint. Use an explicit `@latest` bootstrap only when recovering a missing runner — and remember that path is still floating until `setup` pins MCP or a global install exists.

## Commands

### analyze — Build or refresh the index

```bash
node .gitnexus/run.cjs analyze
```

> **Side effect:** writes the knowledge-graph index (LadybugDB) under the repo's storage path (default `<repo>/.gitnexus/`, or `GITNEXUS_STORAGE_PATH` / a slot under `GITNEXUS_STORAGE_ROOT`), may rewrite generated `AGENTS.md` / `CLAUDE.md` and install standard skills unless skip flags are set, and registers the repo in the global registry.

Run from the project root. This parses all source files, builds the knowledge graph, writes it to the configured storage path, and generates CLAUDE.md / AGENTS.md context files.

| Flag           | Effect                                                           |
| -------------- | ---------------------------------------------------------------- |
| `--watch`      | Keep a Git repository index current with serialized refreshes    |
| `--debounce <ms>` | Watch quiet period before refresh (default: 300 ms)            |
| `--force`      | Force full re-index even if up to date                           |
| `--embeddings` | Enable embedding generation for semantic search (off by default) |
| `--drop-embeddings` | Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` preserves them. |
| `--pdg` | Build the program-dependence layers used by `explain` and `pdg_query` (taint, CDG, and REACHING_DEF). |
| `--spring-actuator <path>` | Import opt-in Spring Boot Actuator mappings, beans, conditions, configprops, and env snapshots. Forces a full rebuild; unsupported with `--watch`. |
| `--asyncapi-spec <path>` | Read opt-in AsyncAPI 3.x documents (directory or single file) and mint `Destination` nodes from their operations. 2.x is refused, not mapped. Unsupported with `--watch`. |

**When to run:** First time in a project, after major code changes, or when `gitnexus://repo/{name}/context` reports the index is stale. In Claude Code, a PostToolUse hook detects staleness after `git commit` and `git merge` and notifies the agent to run `analyze` — the hook does not run analyze itself, to avoid blocking the agent for up to 120s and risking LadybugDB corruption on timeout.

For Spring runtime enrichment, pass a JSON bundle, one endpoint JSON file, or a directory containing endpoint files. Route evidence is authoritative only when `runtimeConfirmed === true`; `runtimeSource` records provenance and may also accompany `handler-conflict`. Env/configprops values are never persisted.

## Index storage and retention

Default location is `<repo>/.gitnexus/`. Override with environment variables (also documented in README):

| Env | Effect |
| --- | ------ |
| `GITNEXUS_STORAGE_PATH` | One complete external index directory. Wins if both storage vars are set. |
| `GITNEXUS_STORAGE_ROOT` | Absolute root; GitNexus creates an isolated `<repo-basename>-<12-hex>/` slot per repository. |
| `GITNEXUS_CONTENT_RETENTION` | `full` (default) keeps file text; `symbol` keeps snippets; `none` keeps the graph only. |

`list_repos`, `gitnexus://repo/{name}/context`, and HTTP `GET /api/repos` / `GET /api/repo` expose `storagePath`, `contentRetention`, and `sourceAvailable`. HTTP `/api/file` and `/api/grep` return 410 unless retention is `full`. MCP `include_content` may still return symbol spans when retention is `symbol`.

Use `node .gitnexus/run.cjs analyze --watch` for a long-lived local Git repository. It performs an initial analysis, queues scanner-admitted file changes, and retries intact failed batches with bounded backoff. Watch refreshes update only the graph: they skip AGENTS.md / CLAUDE.md injection and standard skill installation, so run a one-shot `analyze` when those generated files need updating. Watch rejects one-shot or context-output flags including `--force`, embedding flags, `--skills`, `--default-branch`, `--instruction-file`, `--skip-agents-md`, `--skip-skills`, `--no-stats`, `--self-commit`, `--index-only`, and `--skip-git`. It never pulls remotes. Scheduled remote clone/pull is a different command: `gitnexus auto-sync`. Bare `gitnexus watch` is reserved and does not start either job. Running MCP and `serve` processes periodically check for a published replacement and reopen it without a restart. MCP checks are throttled to once every five seconds, so a tool call before the next check can briefly use the previous index.

### status — Check index freshness

```bash
node .gitnexus/run.cjs status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
node .gitnexus/run.cjs clean
```

> **Side effect (destructive):** deletes the repo's index storage (default `<repo>/.gitnexus/`, or the configured external storage path) and **unregisters** the repo from the global registry. Scoped to the repo discovered from `cwd`. Without `--force`, prints a deletion preview and instructs you to re-run with `--force` to confirm.

Deletes the index storage for the current repo and unregisters it from the global registry. Use before re-indexing if the index is corrupt or after removing GitNexus from a project.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Actually delete (required); without it, preview only |
| `--all`   | Clean all indexed repos, not just the current one |

### remove — Delete a registered repo's index by name/path

```bash
node .gitnexus/run.cjs remove <target>
```

> **Side effect (destructive):** deletes that registered repo's index storage path and **unregisters** it. Unlike `clean`, the target is any registered alias/name/absolute path — you do **not** need to be inside the repo. Unknown targets are idempotent (warns and exits 0). An **ambiguous** target (multiple registry matches) fails with exit 1. Without `--force`, prints a deletion preview and requires `--force` to confirm.

| Flag      | Effect                                               |
| --------- | ---------------------------------------------------- |
| `--force` | Actually delete (required); without it, preview only |

### wiki — Generate documentation from the graph

```bash
node .gitnexus/run.cjs wiki
```

> **Side effect:** writes wiki output under the repo's **index storage** path (`<storage>/wiki`, default `<repo>/.gitnexus/wiki`, or the configured `GITNEXUS_STORAGE_PATH` / `GITNEXUS_STORAGE_ROOT` slot — not necessarily the checkout root), and may save the LLM API key to `~/.gitnexus/config.json` on first HTTP-provider use.

Generates repository documentation from the knowledge graph using an LLM. HTTP providers require an API key (saved to `~/.gitnexus/config.json` on first use). Local CLI providers (`--provider cursor|claude|codex|opencode|grok`) use your existing CLI login.

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration: group the files into modules again (an edited `module_tree.json` is kept) and rewrite every page. Also required to re-generate an existing wiki in a different language |
| `--provider <name>` | LLM provider: minimax, anthropic, openai, openrouter, azure, custom, cursor, claude, codex, opencode, or grok (default: minimax). Local CLIs (`cursor`, `claude`, `codex`, `opencode`, `grok`) use your existing CLI login and skip `--api-key`. `anthropic` calls the Anthropic Messages API with `ANTHROPIC_API_KEY` (or `GITNEXUS_API_KEY` / `--api-key`); default model `claude-opus-5-5`. |
| `--model <model>`   | LLM model (default: MiniMax-M3)           |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key                               |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--timeout <seconds>` | LLM request timeout in seconds (default: disabled) |
| `--retries <n>`     | Max LLM retry attempts per request (default: 3) |
| `--max-completion-tokens <n>` | Max completion tokens per LLM request (default: 16384). `GITNEXUS_MAX_COMPLETION_TOKENS` overrides `maxCompletionTokens` in `~/.gitnexus/config.json`; the flag overrides both. |
| `--lang <lang>`     | Output language for generated documentation (e.g. english, chinese, spanish, japanese) |
| `--gist`            | Publish wiki as a public GitHub Gist      |

> **Side effect (publication):** with `--gist`, or on an interactive TTY when `gh` is available and you accept the prompt (**default Yes** if you press Enter), publishes a **public** GitHub Gist under the **authenticated `gh` account**. Confirm account and visibility before publishing; non-interactive runs without `--gist` do not prompt.

### group sync — Rebuild multi-repo contracts

```bash
node .gitnexus/run.cjs group sync <name>
```

> **Side effect:** usually **writes/replaces** the group's contract registry (`contracts.json`) and related group artifacts (including `bridge.lbug`) under `~/.gitnexus/groups/`. Run after `group.yaml` changes or member re-index. MCP equivalent: `group_sync`.

### list — Show all indexed repos

```bash
node .gitnexus/run.cjs list
```

Lists all repositories registered in `~/.gitnexus/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `gitnexus://repo/{name}/context`** to verify the index loaded
2. Use the other GitNexus skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Wait for the next MCP tool call to reopen the published index; this normally takes no more than five seconds
- **Embeddings slow**: Omit `--embeddings` (it's off by default). For an **HTTP** embedding endpoint, set `GITNEXUS_EMBEDDING_URL`, `GITNEXUS_EMBEDDING_MODEL`, `GITNEXUS_EMBEDDING_API_KEY`, and `GITNEXUS_EMBEDDING_DIMS` (not a generic OpenAI API-key environment variable). For the **local** transformers.js path, model selection uses `GITNEXUS_EMBEDDING_MODEL_ID` (and dims still via `GITNEXUS_EMBEDDING_DIMS`). Match dims/model between analyze and query.
