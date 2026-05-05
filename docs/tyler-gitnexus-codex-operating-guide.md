# Tyler GitNexus + Codex Operating Guide

Last verified locally: 2026-05-05

## What GitNexus Does Here

GitNexus indexes a repository into a local knowledge graph: files, symbols, imports, calls, routes, tools, communities, and execution flows. In this repo, the CLI/MCP package lives in `gitnexus/`, the web UI lives in `gitnexus-web/`, and shared types live in `gitnexus-shared/`.

The daily AI-assisted development path is CLI + MCP:

1. Run `gitnexus analyze` in a target repo.
2. GitNexus writes a local `.gitnexus/` index and registers the repo in `~/.gitnexus/registry.json`.
3. Codex connects to the GitNexus MCP server.
4. Codex can query code context, inspect symbols, run impact analysis, and detect changed areas before commit.

## Local Prerequisites

- Node.js 20 or newer. The web package currently declares `^20.19.0 || >=22.12.0`.
- npm, because this repo has `package-lock.json` files and no `pnpm-lock.yaml` or `yarn.lock`.
- Git, because `analyze` expects a Git repository unless `--skip-git` is used.

Package locations:

- Root tooling: `package.json`
- CLI/MCP/core: `gitnexus/package.json`
- Web UI: `gitnexus-web/package.json`
- Shared package: `gitnexus-shared/package.json`

## Install Locally

From the repo root:

```bash
npm install
cd gitnexus-shared && npm install
cd ../gitnexus && npm install
cd ../gitnexus-web && npm install
```

The CLI package `prepare` script builds the CLI and bundled web UI. Native tree-sitter bindings may build during install.

## Build and Check

Use the repo's actual scripts:

```bash
npm run lint
cd gitnexus-shared && npm run build
cd ../gitnexus && npx tsc --noEmit && npm run build && npm test
cd ../gitnexus-web && npx tsc -b --noEmit && npm run build && npm test
```

Useful narrower checks:

```bash
cd gitnexus && npm run test:unit
cd gitnexus && npm run test:integration
cd gitnexus-web && npm run test:e2e
```

Web E2E requires both `gitnexus serve` and the Vite dev server.

## Index a Repo

From the target repo root:

```bash
npx gitnexus analyze --skip-embeddings
```

Generate repo-specific skills as well:

```bash
npx gitnexus analyze --skills --skip-embeddings
```

Use embeddings only when you want vector search and have the runtime budget:

```bash
npx gitnexus analyze --embeddings --skills
```

Plain `analyze` preserves existing embeddings recorded in `.gitnexus/meta.json`. Use `--drop-embeddings` only when intentionally wiping vectors.

## Check Status

```bash
npx gitnexus status
npx gitnexus list
```

`status` reports whether the current repo is indexed and whether the index is stale. `list` shows all repos registered for MCP discovery.

## Re-Index

Refresh after code changes:

```bash
npx gitnexus analyze --skip-embeddings
```

Force a full rebuild when the index seems corrupt or stale at the same commit:

```bash
npx gitnexus analyze --force --skip-embeddings
```

Regenerate skills:

```bash
npx gitnexus analyze --skills --skip-embeddings
```

## Clean the Index

Current repo only:

```bash
npx gitnexus clean
```

Skip confirmation:

```bash
npx gitnexus clean --force
```

All registered repos:

```bash
npx gitnexus clean --all --force
```

Do not run clean commands unless you are intentionally deleting local GitNexus index data.

## Connect Codex Through MCP

Documented Codex command:

```bash
codex mcp add gitnexus -- npx -y gitnexus@latest mcp
```

Expected TOML config:

```toml
[mcp_servers.gitnexus]
command = "npx"
args = ["-y", "gitnexus@latest", "mcp"]
```

Config locations to inspect:

- Global: `~/.codex/config.toml`
- Project: `.codex/config.toml`

Do not overwrite an existing Codex config. Back it up first, then merge the GitNexus server block.

## Generated Files

Typical generated files and directories:

- `.gitnexus/` - local graph index and metadata
- `AGENTS.md` - agent instructions with GitNexus context block
- `CLAUDE.md` - Claude-oriented context when generated
- `.claude/skills/` - GitNexus skills
- `.claude/skills/generated/` - repo-specific generated skills from `--skills`
- `~/.gitnexus/registry.json` - global registry of indexed repos

## What Should Not Be Committed

Do not commit:

- `.gitnexus/`
- `node_modules/`
- real `.env` files or secrets
- API keys, tokens, private URLs, cookies, or local credentials
- machine-specific Codex or editor global config

Commit generated `AGENTS.md`, `CLAUDE.md`, or generated skills only when the project maintainers intentionally want those files versioned.

## Troubleshooting

- `npm` or `npx` missing: install Node/npm locally first. Do not install global GitNexus unless docs explicitly require it.
- npm network `ENOTFOUND`: the environment cannot reach the npm registry. Retry with approved network access.
- LadybugDB FTS extension cannot write to `~/.lbdb`: rerun outside the sandbox or allow the process to write its extension cache.
- MCP says no repos: run `npx gitnexus analyze` in the target repo, then restart the editor MCP session if needed.
- Wrong repo in MCP tools: call `list_repos`, then pass the desired `repo` argument.
- LadybugDB lock or busy errors: stop overlapping `analyze`, `serve`, or MCP processes and retry.
- Web test `localStorage.removeItem is not a function`: this is a test-environment issue observed locally with Node's built-in localStorage warning, not proof that the built app is broken.
