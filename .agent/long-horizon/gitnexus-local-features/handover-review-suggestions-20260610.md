# Handover Review - Findings and Suggestions

Created: 2026-06-10
Reviews: `codex-handover-local-features-runtime-20260609.md`
Audience: user + next agent session on the GitNexus local-features workstream.

## Verdict

The handover document is accurate and ready to act on. Every factual claim
checked against the live system matched: branch/HEAD state, dirty-tree file
list, `.env` contents, command shim locations, referenced file paths, and the
not-yet-promoted Codex MCP route. The findings below are corrections,
runtime-state updates, and recommendations — not blockers.

## Runtime State (verified 2026-06-10)

Both Podman stacks are now up and healthy. The standard stack had been down
(all three containers exited, likely from a Podman machine restart) and was
restarted on 2026-06-10 via:

```powershell
podman compose -f C:\Users\steve\podman\gitnexus\compose.yaml --env-file C:\Users\steve\podman\gitnexus\.env up -d
```

| Runtime | Containers | Health | MCP endpoint |
| --- | --- | --- | --- |
| Standard (4747) | `gitnexus-server`, `gitnexus-web`, `llama-cpp-gitnexus-embeddings` | `{"status":"ok"}` | `OPTIONS /api/mcp` → 204 |
| Local-features (5747) | `gitnexus-local-features-server`, `-web`, `-embed` | `{"status":"ok"}` | `OPTIONS /api/mcp` → 204 |

Web UIs serving: standard `http://127.0.0.1:4173`, local-features
`http://127.0.0.1:5174`.

## Findings (doc corrections)

### 1. Standard runtime (4747) is not a reliable fallback

At review time the standard runtime was completely down, so Codex's active
GitNexus MCP route pointed at a dead endpoint. The doc frames 4747 as the
"standard MCP fallback", but neither stack auto-starts with the Podman
machine. Rollback to 4747 requires manually starting that stack first.

**Suggested doc edit:** in "Runtime Split", note that neither runtime
auto-starts and that rollback requires `podman compose ... up -d` on the
standard stack before restoring the 4747 URL.

### 2. "Current config" snippet is stale — promotion is a one-line edit

The doc shows the active Codex stanza as only a `url` line. The real stanza
(`~/.codex/config.toml:27-30`) already contains the timeout settings:

```toml
[mcp_servers.gitnexus]
url = "http://127.0.0.1:4747/api/mcp"
startup_timeout_sec = 300.0
tool_timeout_sec = 300.0
```

The promotion is therefore a single URL edit (`4747` → `5747`), not a stanza
replacement.

### 3. Claude Code is already promoted; doc covers only Codex

`~/.claude.json` already points the GitNexus MCP at
`http://127.0.0.1:5747/api/mcp`. The two clients are intentionally split right
now:

| Client | GitNexus MCP route | Status |
| --- | --- | --- |
| Claude Code | `5747` (local-features) | already promoted |
| Codex | `4747` (standard) | promotion pending |

**Suggested doc edit:** add this table to "MCP Route Status" so the next agent
does not mistake the split for drift.

### 4. Dirty-tree bucket conflates modified vs untracked

The doc groups everything under "dirty/untracked". The distinction matters
when checkpointing slices separately (which the doc itself advises):

- **Modified (tracked):** `documentation.md`, `feature-map.md`, `plans.md`,
  `AGENTS.md`, and all `gitnexus/src` + `gitnexus/test` wiki-refresh WIP files.
- **Untracked (new):** `gitnexus-local-features-mcp-route-note.md`,
  `gitnexus-specific-implementation-planning-brief.md`,
  `ultraplan-end-to-end-plan.md`, `ultraplan-end-to-end-scratchpad.md`,
  the handover doc itself, and this file.

## Recommendations

### R1. Make both stacks survive Podman machine restarts

Today a machine restart silently kills both runtimes (this is what took 4747
down). Options, in order of preference:

1. Add `restart: unless-stopped` to services in both `compose.yaml` files.
2. Or generate systemd/Quadlet units inside the Podman machine.
3. Or a scheduled task on the Windows host that runs the two
   `podman compose ... up -d` commands after machine start.

### R2. Execute the Codex promotion (still pending)

Pre-conditions are now all green: 5747 healthy, MCP endpoint responding,
local-features index verified per the handover doc. Remaining steps:

1. Edit `~/.codex/config.toml` line 28: `4747` → `5747`.
2. Restart Codex.
3. Verify `list_repos` shows the local-features repo and `query`/`context`
   finds `processExitFriendlyTeardown`.

Rollback: restore `4747` in the config, start the standard stack if it is
down, restart Codex.

### R3. Checkpoint the dirty tree in separate slices

Three independent slices are currently mixed in the working tree:

1. **Docs/MCP-route slice:** long-horizon `.md` files (modified + untracked).
2. **AGENTS.md slice:** repo workflow doc.
3. **Wiki-refresh WIP slice:** `gitnexus/src` + `gitnexus/test` files — still
   WIP; commit only after its tests pass.

Commit 1 and 2 (or 1+2 together) before resuming feature work so the WIP
slice is the only dirty state left.

### R4. Minor doc hygiene

- Apply the corrections from Findings 1-3 to the handover doc.
- The handover doc and route note are untracked — they are lost to any
  `git clean`. Checkpointing them (R3 slice 1) protects them.
