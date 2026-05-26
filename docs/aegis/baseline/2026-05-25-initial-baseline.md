# Initial Baseline Snapshot

**Date:** 2026-05-25
**Project:** GitNexus
**Evidence read:** `README.md`, `AGENTS.md`, `CLAUDE.md`, `GUARDRAILS.md`, `ARCHITECTURE.md`, root `package.json`, existing `docs/superpowers/specs/2026-04-02-pr626-high-fixes-design.md`

## Project Structure

| Path | Role |
|------|------|
| `gitnexus/` | TypeScript CLI, MCP server, HTTP API, ingestion pipeline, graph persistence, embeddings, wiki generation |
| `gitnexus-web/` | Vite React graph explorer and AI chat UI |
| `gitnexus-shared/` | Shared TypeScript types and constants |
| `eval/` | Python evaluation harness |
| `.github/` | CI, release, security, and PR automation |
| `docs/` | Project guides and design records |

## Tech Stack

- TypeScript and Node.js for core packages.
- React, Vite, Vitest, and Playwright for the web UI.
- Python with `uv` for evaluation tooling.
- LadybugDB for local graph persistence.
- Tree-sitter for source parsing.
- ESLint and Prettier for style checks.

## Ownership Mapping

| Concern | Canonical owner |
|---------|-----------------|
| CLI commands and flags | `gitnexus/src/cli/` |
| Parsing and graph construction | `gitnexus/src/core/ingestion/` |
| Graph schema and persistence | `gitnexus/src/core/lbug/` |
| Search and embeddings | `gitnexus/src/core/search/`, `gitnexus/src/core/embeddings/` |
| MCP tools and resources | `gitnexus/src/mcp/` |
| Cross-repo group logic | `gitnexus/src/core/group/` |
| Web UI | `gitnexus-web/src/` |
| Shared contracts | `gitnexus-shared/src/` |
| Evaluation | `eval/` |

## Contract Inventory

- CLI commands such as `analyze`, `mcp`, `serve`, `query`, `context`, `impact`, `group`, `wiki`, and setup utilities.
- MCP tools including repository discovery, query, context, impact, rename, route mapping, tool mapping, shape checks, and group operations.
- HTTP bridge served by `gitnexus serve` for the web UI.
- Shared graph and language contracts in `gitnexus-shared/src/`.
- `.gitnexus/` local index artifacts and user registry under `~/.gitnexus/`.

## Dependency Direction Convention

- Shared package types are consumed by CLI/core and web.
- CLI, MCP, HTTP, and web surfaces consume graph/query services rather than owning graph construction.
- Ingestion builds the graph and persistence/query layers serve it.
- Evaluation harnesses call the product surface rather than becoming runtime dependencies.

## Test System

- Root scripts include formatting and linting.
- `gitnexus/` uses Vitest and TypeScript checks.
- `gitnexus-web/` uses Vitest, TypeScript checks, and Playwright.
- `eval/` uses Python tests through `uv`.

## Build And Deploy

- npm packages build through TypeScript and package-specific scripts.
- Dockerfiles and docker compose exist for CLI/server and web packaging.
- CI lives under `.github/workflows/` with quality, tests, e2e, release, CodeQL, dependency review, gitleaks, trivy, and scorecard workflows.

## Known Anti-Patterns To Avoid

- Editing shared symbols without impact analysis when graph tooling is available.
- Broad find-and-replace renames.
- Unreviewed destructive cleanup of indexes or user data.
- Adding new graph owners or parallel semantic stores without a migration plan.
- Treating generated memory or agent outputs as authoritative without provenance.

## Last Review Findings

- Current workspace had uncommitted changes before this design task: `gitnexus/src/server/api.ts` modified and `gitnexus-web-screenshot.png` untracked.
- No existing `docs/aegis/` workspace was present.
- Existing design records live under `docs/superpowers/` and favor targeted scoped specs.

## Compatibility Boundaries

- Do not break CLI command contracts, MCP tool names, graph schema semantics, web HTTP API consumers, or local registry/index layout without explicit migration.
- Preserve contributor guardrails around secrets, destructive commands, and impact analysis.
