# GitNexus Local-Features MCP Route Note

Created: 2026-06-09
Status: documentation-first route promotion plan; active Codex config not yet changed in this step.

## Purpose

Promote the local-features GitNexus runtime as the active Codex GitNexus MCP route so Codex uses the feature-branch server and indexes when invoking GitNexus tools.

This is an operational workstation-routing change. It must not delete or overwrite the preserved standard GitNexus Podman runtime.

## Route Decision

Use one active Codex MCP server identity:

```toml
[mcp_servers.gitnexus]
url = "http://127.0.0.1:5747/api/mcp"
startup_timeout_sec = 300.0
tool_timeout_sec = 300.0
```

Retire the standard runtime from the active Codex MCP slot:

```toml
[mcp_servers.gitnexus]
url = "http://127.0.0.1:4747/api/mcp"
```

Keep the MCP server name as `gitnexus` so existing Codex tool expectations remain stable.

## Runtime Meaning

| Route | Meaning | Status |
| --- | --- | --- |
| `http://127.0.0.1:5747/api/mcp` | Local-features GitNexus MCP backed by `gitnexus-local-features-server` | Intended active Codex MCP route |
| `http://127.0.0.1:4747/api/mcp` | Standard GitNexus MCP backed by `gitnexus-server` | Preserved fallback, not intended active Codex MCP route after promotion |
| `gitnexus-podman-local-features` | CLI helper for the local-features Podman runtime | Use for local-features runtime/index checks |
| `gitnexus-podman` | CLI helper for the standard Podman runtime | Preserve for standard runtime checks |
| `gitnexus` | Host/npm CLI | Separate from both Podman MCP runtimes |

## Current Evidence Before Switch

- `C:\Users\steve\.codex\config.toml` currently has `[mcp_servers.gitnexus]` pointing at `http://127.0.0.1:4747/api/mcp`.
- `C:\Users\steve\podman\gitnexus-local-features\.env` points the local-features server image at `localhost/gitnexus:local-features-vectorfix-20260609`.
- `gitnexus-local-features-server` exposes backend port `5747` when running.
- `gitnexus-local-features-web` exposes web port `5174` and points at backend `http://127.0.0.1:5747`.
- At the time this note was drafted, both `127.0.0.1:5747` and `127.0.0.1:4747` refused health requests because both backend containers were stopped.

## Promotion Procedure

1. Start or recreate the local-features backend:

```powershell
podman compose -f C:\Users\steve\podman\gitnexus-local-features\compose.yaml --env-file C:\Users\steve\podman\gitnexus-local-features\.env up -d --force-recreate gitnexus-local-features-server
```

2. Verify local-features backend health:

```powershell
Invoke-RestMethod http://127.0.0.1:5747/api/health
```

3. Verify local-features MCP endpoint reachability before changing Codex config:

```powershell
Invoke-WebRequest http://127.0.0.1:5747/api/mcp -Method Options -UseBasicParsing
```

Expected result: the endpoint responds from the local-features server. The exact status code may depend on StreamableHTTP transport behavior, but the request must not fail with connection refused or route-not-found.

4. Verify local-features CLI/runtime route and capture the exact repo registry name:

```powershell
gitnexus-podman-local-features list
gitnexus-podman-local-features query "embedding pipeline" --repo <repo-name-from-list> --limit 5
```

Do not assume the registry name. Use the repo name returned by `gitnexus-podman-local-features list`.

5. Capture the current active GitNexus MCP stanza before editing:

```powershell
Select-String -LiteralPath C:\Users\steve\.codex\config.toml -Pattern '\[mcp_servers\.gitnexus\]','http://127\.0\.0\.1:4747/api/mcp','http://127\.0\.0\.1:5747/api/mcp'
```

6. Change `C:\Users\steve\.codex\config.toml`:

```toml
[mcp_servers.gitnexus]
url = "http://127.0.0.1:5747/api/mcp"
startup_timeout_sec = 300.0
tool_timeout_sec = 300.0
```

7. Restart Codex so MCP config reloads.

8. Verify GitNexus MCP now sees the local-features index:

- `list_repos` should show the local-features indexed repo. Use the exact repo name it returns for follow-up checks.
- `query` should find branch-local feature code such as `impact-for-ranges`, `api-smoke-renderer`, or `processExitFriendlyTeardown`.
- `context` or `query` for `processExitFriendlyTeardown` should prove the MCP tool is backed by the local-features image/index, because that symbol belongs to the local vector/native-close fix slice.
- Codex logs should not show GitNexus MCP traffic trying `127.0.0.1:4747`.

## Rollback

If the local-features MCP route fails, restore the standard route:

```toml
[mcp_servers.gitnexus]
url = "http://127.0.0.1:4747/api/mcp"
startup_timeout_sec = 300.0
tool_timeout_sec = 300.0
```

Then restart Codex.

## Risks And Guardrails

- Do not delete `C:\Users\steve\podman\gitnexus`; it remains the preserved standard runtime.
- Do not rename the MCP server from `gitnexus` during promotion; a name change would create avoidable tool-routing drift.
- Do not assume local-features MCP is live until `5747` health and MCP/tool checks pass.
- Keep `gitnexus-podman-local-features` and `gitnexus-podman` distinct in docs and commands.
- After promotion, update any remaining current guidance that says Codex GitNexus MCP uses `4747`.
