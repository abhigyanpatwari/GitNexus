# GitNexus Interim Pre-Main Work Plan - Disable Hidden Router

Created: 2026-06-05

Status: executed on 2026-06-05. The hidden bare-router files were quarantined, the host/npm CLI was later aligned to `1.6.6-rc.109`, and the redundant `gitnexus-host` helper was subsequently quarantined. Current workflow is bare `gitnexus` for host/npm and `gitnexus-podman` for Podman.

Authority note: this file is a historical interim execution record only. It is subordinate evidence for `documentation.md` and `plans.md`; it is not a fifth live control file and must not be treated as a competing task queue.

Supersession note: any `gitnexus-host` commands below are pre-quarantine historical evidence. Do not use `gitnexus-host` in new workflow.

## Purpose

This is an interim blocker-removal plan before the main GitNexus local-features work resumes.

The immediate aim is to remove ambiguity caused by the workstation-local `gitnexus` router shim. This is CLI/workstation cleanup only. It must not change GitNexus source code, Podman containers, indexes, compose topology, ports, or the promoted normal runtime.

## Summary

The pre-quarantine hidden router at `C:\Users\steve\.local\bin\gitnexus.py` was workstation drift, not upstream GitNexus or Docker behavior.

Expected Docker/Podman behavior should be explicit:

- use the normal HTTP runtime on `127.0.0.1:4747` / `127.0.0.1:4173`
- use explicit container execution when needed, such as `podman compose exec gitnexus-server gitnexus ...`
- use `gitnexus-podman` only as an explicit local helper
- do not let bare `gitnexus` secretly route into Podman

Before main feature implementation resumes, keep the hidden bare-router quarantined so agents and humans do not accidentally test or implement against an undocumented path.

## Pre-Quarantine Observed State

- `gitnexus` resolves first to `C:\Users\steve\.local\bin\gitnexus.cmd`, which calls `C:\Users\steve\.local\bin\gitnexus.py`.
- `gitnexus-host --version` reports `1.6.6-rc.53`.
- `gitnexus-podman --version` reports `1.6.6-rc.109`.
- `gitnexus --version` reports `1.6.6-rc.109` because the hidden router currently prefers the Podman path.
- The normal runtime remains the Podman backend on `127.0.0.1:4747` and web on `127.0.0.1:4173`.
- The evidence note is `C:\Users\steve\projects\gitnexus\source-rc109-integration\.agent\long-horizon\gitnexus-local-features\gitnexus-router-indexing-note.md`.

## Non-Goals

- Do not change GitNexus source code.
- Do not change compose files, containers, images, indexes, registry data, or runtime ports.
- Do not update the host npm GitNexus install unless explicitly approved as a later task.
- Do not delete router files; quarantine or rename them so rollback is possible.
- Do not replace or retarget the normal runtime.
- Do not begin enterprise/local-feature implementation from this step.

## Executed End State

- Bare `gitnexus` no longer secretly auto-routes through `gitnexus.py`.
- `gitnexus-podman` remains available as an explicit Podman-backed helper.
- Historical at execution time: `gitnexus-host` remained available as an explicit host/npm CLI helper. Superseded on 2026-06-05 by helper quarantine; use bare `gitnexus`.
- The documentation explains the expected Docker/Podman path.
- Rollback commands are recorded.
- The host/npm CLI has been aligned to rc.109, but it remains a separate route from the Podman runtime.

## Task Sequence

### Task 0 - Baseline Capture

Historical pre-quarantine command set. These commands worked only while the hidden bare-router still existed, before the disabled-file rename:

```powershell
Get-Command gitnexus -All
gitnexus --version
gitnexus-host --version
gitnexus-podman --version
gitnexus --gitnexus-router-diagnostics
Invoke-RestMethod http://127.0.0.1:4747/api/health
```

Exit criteria:

- Current command resolution is recorded.
- Host and Podman GitNexus versions are recorded.
- Normal runtime health is confirmed.

### Task 1 - Quarantine the Hidden Router

Rename the hidden bare-router files with a date-stamped disabled suffix:

```powershell
Rename-Item -LiteralPath "C:\Users\steve\.local\bin\gitnexus.cmd" -NewName "gitnexus-router.disabled-20260605.cmd"
Rename-Item -LiteralPath "C:\Users\steve\.local\bin\gitnexus.py" -NewName "gitnexus-router.disabled-20260605.py"
```

Preserve these explicit helpers:

- `gitnexus-podman.*`
- `gitnexus-host.*`

Exit criteria:

- Hidden bare-router files are quarantined, not deleted.
- Explicit helper commands remain present.

### Task 2 - Verify Command Resolution

Run:

```powershell
Get-Command gitnexus -All
gitnexus --version
gitnexus-host --version
gitnexus-podman --version
gitnexus-podman list
Invoke-RestMethod http://127.0.0.1:4747/api/health
```

Expected result:

- `Get-Command gitnexus -All` no longer resolves first to `C:\Users\steve\.local\bin\gitnexus.cmd`.
- `gitnexus-podman --version` still reports the rc.109 Podman path.
- `gitnexus-podman list` can still see the intended Podman-indexed repos.
- Normal runtime health remains OK.
- After host CLI alignment, bare `gitnexus --version` should report `1.6.6-rc.109`.
- Use `gitnexus-podman` for authoritative Podman-runtime checks even though the host CLI is now version-aligned.

### Task 3 - Update Documentation

Update `C:\Users\steve\.codex\Tools.md` so it no longer presents the hidden router as the expected current workflow.

The documentation should state:

- `gitnexus-podman` is the explicit Podman/container helper.
- Historical at execution time: `gitnexus-host` was the explicit host/npm helper. Superseded on 2026-06-05 by helper quarantine; use bare `gitnexus`.
- bare `gitnexus` may resolve to the host install after router quarantine and must not be assumed to be the promoted rc.109 runtime.
- the quarantined router is historical/rollback context only.

Also update the local evidence note, as completed during this interim cleanup:

- `C:\Users\steve\projects\gitnexus\source-rc109-integration\.agent\long-horizon\gitnexus-local-features\gitnexus-router-indexing-note.md`

Exit criteria:

- Current docs match the intended architecture.
- Any router references are clearly marked as historical, diagnostic, or rollback-only.

### Task 4 - Host CLI Alignment Decision

Do not perform this automatically. Record it as a separate follow-up decision.

Options:

- Completed: update the host npm GitNexus CLI to the intended pinned version, `1.6.6-rc.109`.
- Rejected for now: keep the host CLI stale but avoid bare `gitnexus` for important work.
- Deferred: add a clear refusal shim later, with approval, if accidental bare CLI usage remains risky.

Exit criteria:

- The host CLI mismatch was explicitly tracked and then closed by aligning the host/npm CLI to `1.6.6-rc.109`.

### Task 5 - Resume Main Work

Only resume the main local feature queue after router cleanup is verified.

The next main-track work remains the local-features queue in:

- `C:\Users\steve\projects\gitnexus\source-rc109-integration\.agent\long-horizon\gitnexus-local-features\plans.md`

## Acceptance Criteria

- Hidden router files are quarantined, not deleted.
- `gitnexus-podman` still works and remains explicit.
- Historical at execution time: `gitnexus-host` still worked and remained explicit. Superseded on 2026-06-05 by helper quarantine; use bare `gitnexus`.
- Normal GitNexus runtime health on `127.0.0.1:4747` remains OK.
- Documentation no longer describes the hidden router as the expected current workflow.
- Rollback commands are documented.
- No GitNexus source, container, image, index, compose, or port changes occur as part of this interim plan.

## Rollback

If the router quarantine needs to be reversed:

```powershell
Rename-Item -LiteralPath "C:\Users\steve\.local\bin\gitnexus-router.disabled-20260605.cmd" -NewName "gitnexus.cmd"
Rename-Item -LiteralPath "C:\Users\steve\.local\bin\gitnexus-router.disabled-20260605.py" -NewName "gitnexus.py"
gitnexus --gitnexus-router-diagnostics
```

The diagnostic command works only after the disabled router files are restored. If a different disabled filename is used, adjust the rollback command to match the actual quarantine names.

## Risks

- Historical risk closed: the host npm CLI exposed `1.6.6-rc.53` immediately after quarantine, but it has since been aligned to `1.6.6-rc.109`.
- `PATH` may still contain `C:\Users\steve\.local\bin`; `Get-Command gitnexus -All` must be used to confirm actual resolution.
- Some docs or agents may still assume the hidden router exists; search must catch those references.
- Do not confuse this hidden GitNexus CLI router with any unrelated llama.cpp model-router references in old embedding or Prometheus notes.

## Test Plan

Run the baseline and post-quarantine command checks in Tasks 0 and 2.

Search documentation for stale router language:

```powershell
rg -n "gitnexus-router|Podman-backed wrapper|gitnexus --gitnexus-router-diagnostics" "C:\Users\steve\.codex\Tools.md" "C:\Users\steve\projects\gitnexus\source-rc109-integration\.agent\long-horizon\gitnexus-local-features"
```

Expected result:

- Remaining matches are historical, diagnostic, or rollback-only.
- No current instruction tells agents to rely on the hidden bare-router path.

## Assumptions

- The intended architecture is no hidden host-side GitNexus router.
- This plan is pre-main/interim work and must complete before further local-feature implementation or index-set expansion.
- The explicit Podman runtime remains desired.
- Normal runtime promotion and existing indexes are already outside the scope of this interim cleanup.

## Work Log

Append dated evidence here while executing this interim plan. Keep entries concise and include the command or observation that changed the state.

### 2026-06-05 - Review

- Reviewed this plan against `gitnexus-router-indexing-note.md` and `C:\Users\steve\.codex\Tools.md`.
- Deficiency found: the plan had no live work log even though the work must be documented as it proceeds.
- Deficiency found: post-quarantine `gitnexus --version` may expose the stale host CLI and should remain diagnostic only, not an authoritative rc.109 check.
- Correction applied: added this work log and clarified the bare-CLI caveat in Task 2.

### 2026-06-05T09:35:46+01:00 - Baseline

- `Get-Command gitnexus -All` showed `C:\Users\steve\.local\bin\gitnexus.cmd` first, ahead of the npm shims in `C:\Users\steve\AppData\Roaming\npm`.
- `gitnexus --version` reported `1.6.6-rc.109` through the hidden router.
- `gitnexus-host --version` reported `1.6.6-rc.53`.
- `gitnexus-podman --version` reported `1.6.6-rc.109`.
- `gitnexus --gitnexus-router-diagnostics` selected `C:\Users\steve\.local\bin\gitnexus-podman.cmd`, with container `gitnexus-server` running and `C:\Users\steve` unmapped as a repo.
- `Invoke-RestMethod http://127.0.0.1:4747/api/health` returned `{ "status": "ok" }`.
- `C:\Users\steve\.local\bin` contained the expected explicit helpers plus the two hidden bare-router files: `gitnexus.cmd` and `gitnexus.py`.

### 2026-06-05T09:36:51+01:00 - Router Quarantined

- Renamed `C:\Users\steve\.local\bin\gitnexus.cmd` to `C:\Users\steve\.local\bin\gitnexus-router.disabled-20260605.cmd`.
- Renamed `C:\Users\steve\.local\bin\gitnexus.py` to `C:\Users\steve\.local\bin\gitnexus-router.disabled-20260605.py`.
- Preserved `gitnexus-podman.cmd`, `gitnexus-podman.py`, `gitnexus-host.cmd`, and `gitnexus-host.py` during the original router quarantine. The `gitnexus-host` helper files were later quarantined separately.
- `Get-Command gitnexus -All` now resolves to `C:\Users\steve\AppData\Roaming\npm\gitnexus.ps1` first, then the npm `.cmd` and extensionless shims.
- Immediately after router quarantine and before host alignment, `gitnexus --version` reported `1.6.6-rc.53`, matching the host/npm CLI caveat.
- Immediately after router quarantine and before host alignment, `gitnexus-host --version` reported `1.6.6-rc.53`.
- `gitnexus-podman --version` reports `1.6.6-rc.109`.
- `gitnexus-podman list` sees `deepwiki-open` and `Prometheus`.
- `Invoke-RestMethod http://127.0.0.1:4747/api/health` still returns `{ "status": "ok" }`.
- Updated `C:\Users\steve\.codex\Tools.md` and `gitnexus-router-indexing-note.md` to describe explicit routing as the current workflow.

### 2026-06-05 - Host CLI Aligned

- npm package metadata reported `gitnexus` dist-tags as `latest: 1.6.5` and `rc: 1.6.6-rc.148`.
- Confirmed `gitnexus@1.6.6-rc.109` exists on npm and installed that exact pinned version globally.
- `gitnexus --version`, `gitnexus-host --version`, and `gitnexus-podman --version` now all report `1.6.6-rc.109`.
- Normal runtime health on `127.0.0.1:4747` remained OK.
- The workstation remains pinned to rc.109 for this task; this did not retarget the source branch or normal runtime to npm's newer `rc` dist-tag.
