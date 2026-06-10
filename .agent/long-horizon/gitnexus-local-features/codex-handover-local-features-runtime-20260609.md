# Codex Handover - GitNexus Local Features Runtime

Created: 2026-06-09
Audience: next Codex/agent session taking over the GitNexus local-features workstream.

## Executive Summary

The GitNexus local-features project is on branch `local/gitnexus-local-features` in:

```text
C:\Users\steve\projects\gitnexus\source-rc109-integration
```

This branch contains the local enterprise-feature workstream. The latest committed checkpoint is:

```text
2dde6886 fix(analyze): avoid native close crash and create vector index
```

That commit fixed two important runtime issues in the local-features container image:

- force analyze no longer crashes on LadybugDB native close because short-lived analyze entrypoints use flush-only final teardown.
- embedding analyze now creates the LadybugDB VECTOR index because `CREATE_VECTOR_INDEX` is routed through raw statement execution instead of prepared execution.

The user now wants the local-features GitNexus runtime to become the active Codex GitNexus MCP route, replacing the standard GitNexus MCP route. This has been documented but not executed yet.

## Project Locations

| Purpose | Path |
| --- | --- |
| Source repo / worktree | `C:\Users\steve\projects\gitnexus\source-rc109-integration` |
| Long-horizon control bundle | `C:\Users\steve\projects\gitnexus\source-rc109-integration\.agent\long-horizon\gitnexus-local-features` |
| Repo AGENTS.md | `C:\Users\steve\projects\gitnexus\source-rc109-integration\AGENTS.md` |
| User Codex tools reference | `C:\Users\steve\.codex\Tools.md` |
| Codex config | `C:\Users\steve\.codex\config.toml` |
| Standard GitNexus Podman runtime | `C:\Users\steve\podman\gitnexus` |
| Local-features GitNexus Podman runtime | `C:\Users\steve\podman\gitnexus-local-features` |
| Local-features MCP route note | `C:\Users\steve\projects\gitnexus\source-rc109-integration\.agent\long-horizon\gitnexus-local-features\gitnexus-local-features-mcp-route-note.md` |

## Git State

Current branch:

```text
local/gitnexus-local-features
```

Latest commits observed:

```text
2dde6886 fix(analyze): avoid native close crash and create vector index
61ef1cd3 docs: close checkpoint packet state
8544ab82 checkpoint: complete explicit-range and api-smoke tranche
6a550c48 feat: add api clusters smoke renderer
5a8c4e1c feat: add impact-for-ranges markdown output
```

Current worktree is dirty. Known dirty/untracked buckets before this handover file was added:

- Long-horizon planning/status docs:
  - `.agent/long-horizon/gitnexus-local-features/documentation.md`
  - `.agent/long-horizon/gitnexus-local-features/feature-map.md`
  - `.agent/long-horizon/gitnexus-local-features/plans.md`
  - `.agent/long-horizon/gitnexus-local-features/gitnexus-local-features-mcp-route-note.md`
  - `.agent/long-horizon/gitnexus-local-features/gitnexus-specific-implementation-planning-brief.md`
  - `.agent/long-horizon/gitnexus-local-features/ultraplan-end-to-end-plan.md`
  - `.agent/long-horizon/gitnexus-local-features/ultraplan-end-to-end-scratchpad.md`
- Repo-level workflow doc:
  - `AGENTS.md`
- Wiki usage-hardening source/test WIP:
  - `gitnexus/src/cli/help-i18n.ts`
  - `gitnexus/src/cli/i18n/en.ts`
  - `gitnexus/src/cli/i18n/zh-CN.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/wiki-refresh.ts`
  - `gitnexus/src/core/wiki/provider-readiness.ts`
  - `gitnexus/test/unit/cli-index-help.test.ts`
  - `gitnexus/test/unit/wiki-provider-readiness.test.ts`
  - `gitnexus/test/unit/wiki-refresh-cli.test.ts`

Do not stage all files blindly. The runtime/vector fix is already committed. The current dirty tree contains separate documentation, MCP-route, and wiki-refresh work.

## Runtime Split

There are two Podman runtimes. Keep them distinct.

### Standard Runtime

Path:

```text
C:\Users\steve\podman\gitnexus
```

Purpose:

- existing workstation GitNexus runtime
- standard MCP fallback on port `4747`
- standard web UI on port `4173`

Do not delete or overwrite it.

### Local-Features Runtime

Path:

```text
C:\Users\steve\podman\gitnexus-local-features
```

Important files:

```text
C:\Users\steve\podman\gitnexus-local-features\compose.yaml
C:\Users\steve\podman\gitnexus-local-features\.env
```

Observed `.env` values:

```env
SERVER_IMAGE=localhost/gitnexus:local-features-vectorfix-20260609
WEB_IMAGE=ghcr.io/abhigyanpatwari/gitnexus-web:1.6.6-rc.109
EMBED_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda

SERVER_CONTAINER_NAME=gitnexus-local-features-server
WEB_CONTAINER_NAME=gitnexus-local-features-web
EMBED_CONTAINER_NAME=gitnexus-local-features-embed

SERVER_HOST_PORT=5747
WEB_HOST_PORT=5174
GITNEXUS_BACKEND_URL=http://127.0.0.1:5747

GITNEXUS_EMBEDDING_MODEL=snowflake-arctic-embed-l-v2.0
GITNEXUS_EMBEDDING_DIMS=1024
GITNEXUS_EMBEDDING_API_KEY=unused

GITNEXUS_REPO_SOURCE_RC109_INTEGRATION=C:\Users\steve\projects\gitnexus\source-rc109-integration
GITNEXUS_INDEX_SOURCE_RC109_INTEGRATION=C:\Users\steve\podman\gitnexus-local-features\indexes\source-rc109-integration
GITNEXUS_SOURCE_RC109_GITFILE=C:\Users\steve\podman\gitnexus-local-features\git-bridge\source-rc109-integration.git
GITNEXUS_SOURCE_RC109_COMMON_GITDIR=C:\Users\steve\projects\gitnexus\source\.git
GITNEXUS_EMBEDDING_MODELS_DIR=C:\Users\steve\models\gguf\embeddings
GITNEXUS_LBUG_HOME=C:\Users\steve\podman\gitnexus-local-features\lbdb-home
```

Current local-features model:

- backend/API/MCP: `http://127.0.0.1:5747`
- web UI: `http://127.0.0.1:5174`
- internal embedding sidecar: `gitnexus-local-features-embed:8080`
- repo source is mounted read-only
- `.gitnexus` index storage is isolated under `C:\Users\steve\podman\gitnexus-local-features\indexes\source-rc109-integration`

## Command Routes

| Command | Meaning |
| --- | --- |
| `gitnexus` | host/npm CLI, separate from Podman runtimes |
| `gitnexus-podman` | standard Podman runtime helper |
| `gitnexus-podman-local-features` | local-features Podman runtime helper |

Observed command locations:

```text
C:\Users\steve\AppData\Roaming\npm\gitnexus.ps1
C:\Users\steve\.local\bin\gitnexus-podman.cmd
C:\Users\steve\.local\bin\gitnexus-podman-local-features.cmd
```

Use `gitnexus-podman-local-features` for the feature-branch runtime/index checks.

## MCP Route Status

Current active Codex config still points GitNexus MCP at the standard runtime:

```toml
[mcp_servers.gitnexus]
url = "http://127.0.0.1:4747/api/mcp"
```

Target route for promotion:

```toml
[mcp_servers.gitnexus]
url = "http://127.0.0.1:5747/api/mcp"
startup_timeout_sec = 300.0
tool_timeout_sec = 300.0
```

The switch has not been performed yet. The detailed procedure is in:

```text
C:\Users\steve\projects\gitnexus\source-rc109-integration\.agent\long-horizon\gitnexus-local-features\gitnexus-local-features-mcp-route-note.md
```

## How To Promote Local-Features MCP

Follow the route note, but the core sequence is:

1. Start/recreate local-features backend:

```powershell
podman compose -f C:\Users\steve\podman\gitnexus-local-features\compose.yaml --env-file C:\Users\steve\podman\gitnexus-local-features\.env up -d --force-recreate gitnexus-local-features-server
```

2. Verify backend health:

```powershell
Invoke-RestMethod http://127.0.0.1:5747/api/health
```

3. Verify MCP endpoint reachability:

```powershell
Invoke-WebRequest http://127.0.0.1:5747/api/mcp -Method Options -UseBasicParsing
```

4. Verify local-features CLI/index route:

```powershell
gitnexus-podman-local-features list
gitnexus-podman-local-features query "embedding pipeline" --repo <repo-name-from-list> --limit 5
```

5. Capture current active config stanza:

```powershell
Select-String -LiteralPath C:\Users\steve\.codex\config.toml -Pattern '\[mcp_servers\.gitnexus\]','http://127\.0\.0\.1:4747/api/mcp','http://127\.0\.0\.1:5747/api/mcp'
```

6. Edit `C:\Users\steve\.codex\config.toml` so `[mcp_servers.gitnexus]` uses `5747`.

7. Restart Codex.

8. In the restarted session, verify GitNexus MCP sees the local-features index:

- `list_repos` returns the local-features repo.
- `query` or `context` can find `processExitFriendlyTeardown`.
- Codex logs do not show GitNexus MCP attempting `127.0.0.1:4747`.

Rollback is to restore `url = "http://127.0.0.1:4747/api/mcp"` and restart Codex.

## What Was Recently Fixed And Verified

Committed fix:

```text
2dde6886 fix(analyze): avoid native close crash and create vector index
```

Files changed in that commit:

- `gitnexus/src/cli/analyze.ts`
- `gitnexus/src/core/embeddings/embedding-pipeline.ts`
- `gitnexus/src/core/lbug/lbug-adapter.ts`
- `gitnexus/src/core/lbug/lbug-config.ts`
- `gitnexus/src/core/run-analyze.ts`
- `gitnexus/src/server/analyze-worker.ts`
- `gitnexus/test/unit/embedding-pipeline.test.ts`
- `gitnexus/test/unit/lbug-config-wal.test.ts`
- `gitnexus/test/unit/run-analyze-fts-repair.test.ts`

Prior verification reported:

- `npx vitest run test/unit/embedding-pipeline.test.ts` passed.
- `npx vitest run test/unit/run-analyze-fts-repair.test.ts test/unit/lbug-config-wal.test.ts` passed.
- `npm run build` passed.
- `git diff --check` passed.
- local-features Podman force analyze with `--force --index-only --drop-embeddings` passed without `free(): invalid pointer`.
- local-features Podman embedding analyze with `--index-only --embeddings` produced:
  - `embeddings: 32035`
  - `vectorProvider: ladybugdb-vector`
  - `vectorStatus: vector-index`
  - `nodes: 32936`
  - `edges: 52957`

## Current Feature Maturity Snapshot

Approximate status from the current branch:

| Area | Status |
| --- | --- |
| Auto-reindexing | local base implemented earlier |
| Wiki refresh | dirty WIP exists for `wiki-refresh --execute` usage-hardening |
| PR Impact / Blast Radius | local CLI/MCP/report primitives implemented; GitHub-facing automation still deferred |
| `symbols-for-ranges` / `impact-for-symbols` / `impact-for-ranges` | implemented and useful as local explicit-range primitives |
| Regression forensics | dual intake from `pr-impact` and `impact-for-ranges` exists |
| E2E test planning | dual intake plus deterministic generated API-smoke/spec renderers exist |
| Multi-repo improvements | local/docs/tool-surface improvements exist; deeper behavior remains later |
| OCaml support | experimental local V1 and query-depth work exist; deeper module semantics deferred |
| Runtime embeddings/vector | latest fix committed and runtime verified in local-features image |

## Important Cautions

- Do not conflate standard GitNexus runtime (`4747`) with local-features runtime (`5747`).
- Do not delete `C:\Users\steve\podman\gitnexus`.
- Do not assume MCP has switched until `C:\Users\steve\.codex\config.toml` is changed and Codex has restarted.
- Do not stage unrelated dirty files together. There are multiple work slices in the tree.
- Use `git diff --check` after markdown/source edits.
- Use the repo's testing ladder from `AGENTS.md` and `.agent/long-horizon/gitnexus-local-features/implement.md`.

## Recommended Next Agent Actions

1. Read:
   - `AGENTS.md`
   - `.agent/long-horizon/gitnexus-local-features/gitnexus-local-features-mcp-route-note.md`
   - `.agent/long-horizon/gitnexus-local-features/documentation.md`
2. Confirm branch and dirty tree:

```powershell
git status --short --branch
git diff --name-status
```

3. Decide whether to checkpoint the documentation/MCP-route notes separately from the wiki-refresh WIP.
4. If the user wants MCP promotion now, follow the route note exactly.
5. After MCP promotion and Codex restart, verify with branch-local MCP queries for `processExitFriendlyTeardown`.
6. Only then resume feature implementation work.
