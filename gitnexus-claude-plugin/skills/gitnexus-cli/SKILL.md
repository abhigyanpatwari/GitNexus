---
name: gitnexus-cli
description: 'Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: "Index this repo", "Reanalyze the codebase", "Generate a wiki"'
---

# GitNexus CLI Commands

Commands below use `node .gitnexus/run.cjs <command>` — the project-local runner `gitnexus analyze` drops next to the index. It auto-selects an available runner at call time (global `gitnexus`, else `pnpm dlx`, else `bunx`, else `npx`), so no package-manager assumption and no global install is required — including on a bun-only machine, which has no npm, npx or pnpm at all.

> **Not analyzed yet, or `node .gitnexus/run.cjs` reports `Cannot find module`** (the gitignored runner is absent — e.g. a fresh clone or `git clean`)? (Re)generate it with `npx gitnexus analyze` from the project root, or `bunx gitnexus@latest analyze` on a bun-only machine. On **npm 11.x**, if `npx` crashes during install (`node.target is null`), install once with `npm i -g gitnexus` (then `gitnexus analyze`), or use `bunx gitnexus@latest analyze`, or `pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter dlx gitnexus@latest analyze`. See [#1939](https://github.com/abhigyanpatwari/GitNexus/issues/1939).

## Commands

### analyze — Build or refresh the index

```bash
node .gitnexus/run.cjs analyze
```

Run from the project root. This parses all source files, builds the knowledge graph, writes it to `.gitnexus/`, and generates CLAUDE.md / AGENTS.md context files.

| Flag                | Effect                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `--force`           | Force full re-index even if up to date                                                                |
| `--embeddings`      | Enable embedding generation for semantic search (off by default)                                      |
| `--drop-embeddings` | Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` preserves them.  |
| `--pdg`             | Build the program-dependence layers used by `explain` and `pdg_query` (taint, CDG, and REACHING_DEF). |

**When to run:** First time in a project, after major code changes, or when `gitnexus://repo/{name}/context` reports the index is stale.

### status — Check index freshness

```bash
node .gitnexus/run.cjs status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
node .gitnexus/run.cjs clean
```

Deletes the `.gitnexus/` directory and unregisters the repo from the global registry. Use before re-indexing if the index is corrupt or after removing GitNexus from a project.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
node .gitnexus/run.cjs wiki
node .gitnexus/run.cjs wiki --profile engineering-wiki --lang chinese
node .gitnexus/run.cjs wiki --profile ieee-1016-sdd --lang chinese
```

Generates repository documentation from the knowledge graph using an LLM. Requires an API key (saved to `~/.gitnexus/config.json` on first use).

| Flag                | Effect                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `--profile <id>`    | `default`, `engineering-wiki`, `arc42`, `ieee-1016-sdd`, or `iso-42010-ad` (default: `default`) |
| `--lang <lang>`     | Generated prose language; standard-profile fixed UI supports `en`/`zh-CN`                       |
| `--force`           | Full regeneration; discards reviewed module tree/document plan state                            |
| `--review`          | Stop after the editable module tree or standard document plan is written                        |
| `--model <model>`   | LLM model (default: MiniMax-M3)                                                       |
| `--base-url <url>`  | LLM API base URL                                                                                |
| `--api-key <key>`   | LLM API key                                                                                     |
| `--concurrency <n>` | Parallel LLM calls (default: 3)                                                                 |
| `--timeout <s>`     | Per-request timeout (default: disabled)                                                         |
| `--retries <n>`     | Maximum retry attempts per request (default: 3)                                                 |
| `--gist`            | Publish wiki as a public GitHub Gist                                                            |

`default` preserves the legacy Wiki topology. Its module names, H1 headings, slugs, and filenames remain stable English values while `--lang` controls generated prose. Non-default profiles localize titles, navigation, fixed text, statuses, and coverage with `--lang chinese` or `--lang zh-CN`; profile/section IDs, slugs, filenames, evidence IDs, JSON enums, and official standard names remain stable English values. `engineering-wiki` adds 27 engineering pages, a required evidence-backed overall architecture diagram, and visible repository-relative source tables. An unsupported display language falls back to English and records the fallback in `meta.json` and `coverage.json`.

Complete generations are stored under `.gitnexus/wiki/.generations/<generation-id>/`; the atomic `.gitnexus/wiki/.state/current.json` pointer selects the readable manifest. Root files remain compatibility mirrors. Non-default profiles add `document_plan.json`, `manifest.json`, `coverage.json`, `coverage.md`, per-section pages, and an aggregate document.

Profile coverage validates structure and evidence references, not semantic entailment. Profile coverage checks do not establish standards conformance. The standard profiles use independent wording and do not reproduce standards text.

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
- **Index is stale after re-analyzing**: Restart Claude Code to reload the MCP server
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `OPENAI_API_KEY` for faster API-based embedding
