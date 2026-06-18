# Gemini — GitNexus

**Project:** GitNexus — a codebase knowledge-graph MCP server. Node.js monorepo with CLI indexer, React/Vite web UI, Claude/Cursor integrations, and a Python evaluation harness.

Follow **[AGENTS.md](AGENTS.md)** for the canonical rules. This file mirrors key info for Gemini sessions.

## Scope

| Boundary | Rule |
|----------|------|
| **Reads** | `gitnexus/`, `gitnexus-web/`, `gitnexus-shared/`, `eval/`, plugin packages, `.github/`, `.gitnexus/`, docs. |
| **Writes** | Only paths required for the change; keep diffs minimal. Update lockfiles when deps change. |
| **Executes** | `npm`, `npx`, `node` under `gitnexus/` and `gitnexus-web/`; `uv run` for Python under `eval/`. |
| **Off-limits** | Real `.env` / secrets, production credentials, unrelated repos, destructive git ops without confirmation. |

## Search exclusions

Exclude from grep/search: `node_modules/`, `dist/`, `.gitnexus/` (index data), `*.lock`.

## Packages

| Package | Path | Purpose |
|---------|------|---------|
| **CLI/Core** | `gitnexus/` | TypeScript CLI, indexing pipeline, MCP server |
| **Web UI** | `gitnexus-web/` | React/Vite thin client |
| **Shared** | `gitnexus-shared/` | Shared TypeScript types and constants |
| Eval | `eval/` | Python evaluation harness |

## Build & dev commands

```bash
cd gitnexus && npm run dev              # CLI: tsx watch mode
cd gitnexus-web && npm run dev          # Web UI: Vite on port 5173
npx gitnexus serve                      # HTTP API on port 4747

# Testing
cd gitnexus && npm test                 # full vitest suite (~2000 tests)
cd gitnexus && npx tsc --noEmit         # typecheck CLI
cd gitnexus-web && npm test             # vitest (~200 tests)
cd gitnexus-web && npx tsc -b --noEmit  # typecheck web
```

## Key conventions

- The CLI indexer does **not** call an LLM.
- Shared ingestion code (`gitnexus/src/core/ingestion/`) must not name languages — use `LanguageProvider` hooks.
- `npm install` in `gitnexus/` triggers native binding builds (`python3`, `make`, `g++` required).
- ESLint via `npx eslint .`; Prettier via lint-staged in pre-commit.

## Reference docs

- [AGENTS.md](AGENTS.md) — canonical rules, MCP tool reference, scope-resolution pipeline.
- [CLAUDE.md](CLAUDE.md) — Claude Code–specific deltas.
- [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), [GUARDRAILS.md](GUARDRAILS.md).
