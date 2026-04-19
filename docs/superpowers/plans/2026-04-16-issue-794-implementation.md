# Issue #794 — Cross-repo impact + MCP surface cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement two-phase cross-repo impact via `bridge.lbug`, expose it through `GroupService.groupImpact` and **`groupContext`**, add CLI `gitnexus group impact`, and apply the MCP refactor aligned with [Issue #794](https://github.com/abhigyanpatwari/GitNexus/issues/794): remove three read-only `group_*` tools, add two MCP resources, extend `impact` / `query` / `context` with `repo: "@group"` and `service`.

### MCP dispatch model

Tools named `group_*` (`group_list`, `group_sync`) are dispatched **only** via the `method.startsWith('group_')` branch — **not** the same code path as `impact`, `query`, or `context`. For `impact`, `query`, and `context`, when `repo` is `"@<groupName>"`, `callTool` branches **before** `resolveRepo` and calls `GroupService.groupImpact`, `groupQuery`, or `groupContext`. These flows use the standard tool names (`impact` / `query` / `context`); they are **not** `group_*` MCP tool names and must not be routed through the `group_*` dispatcher.

**Architecture:** Phase 1 — local impact walk in the selected group member (with timeout and bound validation). Phase 2 — fan-out via contracts and Cypher against `bridge.lbug` (LadybugDB), without merging per-repo indexes. MCP: one entry point for single-repo and group flows using the `@` prefix on `repo` plus a `service` filter for monorepos.

**Tech Stack:** TypeScript, Vitest (`--pool=forks`), LadybugDB/`@ladybugdb/core`, existing `gitnexus/src/core/group/*` modules, `LocalBackend`, MCP tools/resources.

**Authoritative requirements:** Issue #794 body (including which tools are removed/extended and resource URIs). RFC: `docs/superpowers/specs/2026-03-31-cross-index-impact-design.md` — algorithm, terminology, constraints; where the RFC diverges from #794 on MCP, **#794 wins**.

**Supersedes for MCP scope:** The plan in `docs/superpowers/plans/2026-03-31-cross-index-impact-plan.md` added separate `group_*` tools and `group_impact`; for this workstream **do not** grow the tool surface under that scheme — follow #794.

**Language policy:** All documentation files intended for merge (RFC updates, migration tables, this plan, `docs/specs/*` copies) must be written in **English**.

## Issue #794 traceability (stay on scope)

| #794 deliverable | Implementation / tests |
|------------------|----------------------|
| `cross-impact.ts` + two-phase traversal | `gitnexus/src/core/group/cross-impact.ts`, `test/unit/group/cross-impact.test.ts`, `test/unit/group/impact-by-uid.test.ts` |
| `GroupService.groupImpact` | `service.ts`, `service.test.ts`, `test/integration/group/group-impact.test.ts` |
| `gitnexus group impact` | `gitnexus/src/cli/group.ts`, `test/integration/group/group-cli.test.ts` |
| Remove `group_contracts`, `group_query`, `group_status` from MCP tools | `gitnexus/src/mcp/tools.ts`; `test/unit/group/group-tools.test.ts` |
| Keep `group_list`, `group_sync` | `tools.ts` + `group_*` dispatcher in `local-backend.ts` |
| Extend `impact` / `query` / `context` with `@group` + `service` | `tools.ts`, `local-backend.ts`, `test/unit/mcp/group-repo-routing.test.ts` |
| Resources `gitnexus://group/{name}/contracts` and `.../status` | `resources.ts`, `local-backend.ts`, `test/unit/resources.test.ts` |
| **`groupContext`** (plan + #794 follow-up) | `service.ts`, `group-service-group-mode.test.ts`, routing tests |
| No **`group_impact`** MCP tool | Not registered; use `impact` + `repo: "@name"` only |
| RFC migration table for MCP consumers | `docs/superpowers/specs/2026-03-31-cross-index-impact-design.md` — Section 6 / MCP migration |

## Current codebase (this branch)

- **Bridge:** `gitnexus/src/core/group/bridge-db.ts`, `bridge-schema.ts` — read-only bridge access for Phase 2 fan-out.
- **`GroupService`:** `groupQuery`, `groupContracts`, `groupStatus`, **`groupImpact`**, **`groupContext`**.
- **MCP:** `impact` / `query` / `context` route `repo` values starting with `@` to `GroupService` before single-repo `resolveRepo`; `group_*` MCP branch handles **`group_list`** and **`group_sync`** only.
- **Resources:** `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status` in `resources.ts` + `readResource` wiring.
- **Optional duplicate RFC** under `docs/specs/` — not added (superpowers RFC is canonical for this workstream).

---

## File map (create or materially change)

| Role | Path |
|------|------|
| Cross-impact algorithm | `gitnexus/src/core/group/cross-impact.ts` (new) |
| Cross-impact helpers (optional) | `gitnexus/src/core/group/cross-impact-helpers.ts` — only if **1.2** splits private helpers |
| Orchestration | `gitnexus/src/core/group/service.ts` — `groupImpact`, **`groupContext`**, `groupContracts` fixes (safe meta) |
| Graph port | `gitnexus/src/core/group/service.ts` — extend `GroupToolPort` if needed |
| CLI | `gitnexus/src/cli/group.ts` — `impact` subcommand |
| MCP schemas | `gitnexus/src/mcp/tools.ts` |
| MCP resources | `gitnexus/src/mcp/resources.ts` — extend **`parseUri`** + templates / **`readResource`** dispatch for `gitnexus://group/...` |
| Dispatch | `gitnexus/src/mcp/local/local-backend.ts` — `callTool`, `impact`/`query`/`context` handlers, resource providers |
| Agent hints | `gitnexus/src/cli/ai-context.ts` |
| Canonical doc (optional duplicate) | `docs/specs/2026-03-31-cross-index-impact-design.md` or update superpowers RFC + MCP migration table |
| Tests | `gitnexus/test/unit/group/cross-impact.test.ts`, optional `cross-impact-helpers.test.ts` if split; edits to `service.test.ts` (`groupImpact`, **`groupContext`**), `test/unit/group/group-tools.test.ts`, `test/unit/tools.test.ts`, `test/integration/group/group-impact.test.ts`, `test/integration/group/group-cli.test.ts`, Phase **3.3a** / **3.3b** coverage, `test/unit/mcp/group-repo-routing.test.ts` (Phase 3.3b / 5), `test/unit/resources.test.ts` if present |

---

## Phase 1 — Types and `cross-impact` core

- [x] **1.1** Define public result types in `gitnexus/src/core/group/types.ts` or next to `cross-impact.ts`, consistent with Issue #794 and existing group DTOs:
  - **`GroupImpactResult`:** include `truncationReason?`; **`crossDepthWarning?`** as a **string** (human-readable warning when cross-depth is clamped); **`timeoutMs`** — document behavior (timeout boundary for the local-impact leg; partial/paginated semantics tie to `truncationReason` when the walk stops early).
  - **`GroupContextResult`** (new): minimal contract aligned with Issue #794 / existing DTO style — e.g. `{ group: string, target?: string, error?: string, results: Array<{ repoPath: string; registryName: string; payload: unknown }> }` or equivalent; must support **per-repo** entries in `results` and a top-level **`error`** for unrecoverable failures. Multi-repo aggregation is **explicit**: a list per repo, not an undefined merge of payloads.

- [x] **1.2** Implement `cross-impact.ts`:
  - constant `MAX_SUPPORTED_CROSS_DEPTH`;
  - validate inputs (ranges for depth, confidence, timeout, crossDepth, direction);
  - **`safeLocalImpact`:** configurable **`timeoutMs`** — default **30_000** ms unless Issue #794 specifies otherwise (“choose default consistent with Issue #794 if specified, else 30s”); on timeout return a partial result with **`truncationReason: 'timeout'`** (or shared enum with **1.1**) so callers can distinguish timeout from other truncation.
  - Phase 1: call local impact through the port with **`safeLocalImpact`**; `resolveGroupRepo` failures must not extend graph traversal past the timeout;
  - **`resolveGroupRepo`:** implement as a **private helper** in `cross-impact.ts` (or `cross-impact-helpers.ts` if splitting keeps the main file readable) — maps group config + path to `GroupToolPort.resolveRepo`; **not** a new public MCP surface. If a helper file is added, list it in the **File map** above.
  - Phase 2 fan-out: use the **existing** `bridge-db.ts` / `bridge-schema.ts` on `main` — open a read-only bridge handle, respect/validate **schema version** as appropriate; **if schema version mismatches, fail fast with a clear error** (do not silently query the wrong schema). Do not duplicate bridge wiring in new files.
  - Keep **all Cypher strings** in `cross-impact.ts` (not in `service.ts`).
  - *(Optional, high level)* Document which bridge queries fan out to neighbor repos (for maintainers), without moving query strings out of `cross-impact.ts`.

- [x] **1.3** Unit tests `cross-impact.test.ts`: at least truncation, invalid params, isolated port/bridge mocks; **timeout** path (`truncationReason` / partial result); **`crossDepthWarning`** string when cross-depth is clamped.

**Verify:** `cd gitnexus && npx vitest run test/unit/group/cross-impact.test.ts --pool=forks`

---

## Service parameter semantics (fix before implementation)

Align handlers before coding Phase 5 routing. Per Issue #794, `service` scopes differently per tool. For edge cases beyond this table, see the RFC *service-boundaries* section in `docs/superpowers/specs/2026-03-31-cross-index-impact-design.md`.

| Tool | What `service` filters |
|------|------------------------|
| `impact` | Impact walk + cross-repo fan-out (monorepo service boundary for symbols / traversal). |
| `query` | Which processes (or process-related scope) participate in the query. |
| `context` | Module vs process vs overview-style context selection within the group flow. |

**Normative rules:**

- **Format:** `service` is a **relative path string** with `/` separators (e.g. `services/auth`); normalize by trimming trailing slashes. **Case sensitivity:** match repo filesystem conventions — treat path segments as **case-sensitive** unless the host OS dictates otherwise; document the chosen behavior next to validation.
- **Matching:** default **prefix match** on file paths / service roots for `impact` and `context`. For **`query`**, filter processes/symbols whose paths fall under that prefix (exact filtering follows implementation but must align with the RFC *service-boundaries* section).
- **Omitted `service`:** apply no extra filter beyond group scope (full group scope for that tool).
- **Invalid `service` or no matches:** return **empty results** (empty lists / no hits) for both **`groupContext`** and **`groupImpact`** — same rule for both; use the top-level **`error`** field from **1.1** only for **unrecoverable** failures, not for “no matches”.

---

## Phase 2 — GroupService: `groupImpact`, `groupContext`, resilient `groupContracts`

- [x] **2.1** Add `async groupImpact(params: Record<string, unknown>): Promise<unknown>` in `service.ts`, delegating to `cross-impact` and the existing `GroupToolPort` (`impact`, `impactByUid`).

- [x] **2.1b** Add `async groupContext(params: Record<string, unknown>): Promise<GroupContextResult>` (or the **1.1** alias) in `service.ts`, delegating to per-repo **`context`** with **`service` scoping** per Issue #794 (`repo: "@group"`). **`GroupToolPort` must expose a `context(...)`-like call** if not present today — **2.3** extends the port accordingly; delegation goes through that port surface. Mirror patterns from existing `groupQuery` where helpful (group resolution, params, error surfaces).

- [x] **2.2** Implement `safeParseMeta` (or equivalent) on **contract registry / listing** paths only: on a corrupt row — **skip the row**, optionally increment **`skippedCorrupt`** in debug/metadata if useful, **log at `warn` once per bad row**, and **do not** abort listing (not for unrelated meta elsewhere).

- [x] **2.3** Extend/refine `GroupToolPort` in `service.ts` as needed for **`groupImpact` and `groupContext`** (and any shared port shapes those delegates require).

- [x] **2.4** Extend `service.test.ts` for `groupImpact`, **`groupContext`**, and contract-registry meta edge cases.

**Verify:** `npx vitest run test/unit/group/service.test.ts --pool=forks`

---

## Phase 3 — Integration tests for impact / CLI (3.1–3.2 and **3.3a** before MCP; **3.3b** after Phase 5)

- [x] **3.1** `test/integration/group/group-impact.test.ts` — e2e with group fixtures (existing `test/fixtures/group` or extended), scenarios matching Issue #794 intent.

- [x] **3.2** `test/integration/group/group-cli.test.ts` — invoke **`npx gitnexus group impact <name> --target <symbol> --repo <groupPath>`** (Issue #794 example; adjust only if CLI naming differs after `commander` wiring).

- [x] **3.3a** (before MCP) Unit/integration tests for **`GroupService.groupQuery`** and **`groupContext`** with `repo: "@..."` **without** going through `LocalBackend.callTool` where possible — mock `GroupToolPort` (e.g. `test/unit/group/group-service-group-mode.test.ts`).
- [x] **3.3b** (after Phase 5) Add **`test/unit/mcp/group-repo-routing.test.ts`** (or extend an existing MCP test file) for **`LocalBackend.callTool`** with `impact` / `query` / `context` + `repo: "@..."` + optional `service` — **only after** `@group` routing exists in `callTool`.

**Verify:** Issue #794 “How to verify” commands for these files, including **3.3a** when present; **3.3b** once Phase 5 routing lands.

---

## Phase 4 — MCP: schemas and tool removal

- [x] **4.1** In `tools.ts` **remove** definitions: `group_contracts`, `group_query`, `group_status`.

- [x] **4.2** In `impact`, `query`, `context` tool descriptions:
  - state explicitly that `repo` may be `"@<groupName>"` for group mode;
  - add optional `service` (monorepo service path string) with per-tool wording as in Issue #794.

- [x] **4.3** JSON schema: set `minimum`/`maximum` on numeric fields to **match** server-side validation in `groupImpact`, **`groupContext`** (where applicable), and cross-impact. Add optional **`service`** on `impact`, `query`, and `context`: `type: string`, **`minLength: 1`** when the property is present; document that an empty string is **rejected server-side** even if a client omits schema validation.

- [x] **4.4** Update `test/unit/tools.test.ts` and `test/unit/group/group-tools.test.ts`: expected tool names without the three removed tools; adjust tool-count assertions if needed.

**Verify:** `npx vitest run test/unit/tools.test.ts test/unit/group/group-tools.test.ts --pool=forks`

---

## Phase 5 — MCP: `callTool` and group routing

- [x] **5.0** Phase **4** (tool removal) and Phase **5** (`@group` routing in `callTool`) live on the same branch (`gitnexus/src/mcp/tools.ts` + `gitnexus/src/mcp/local/local-backend.ts`); merge as **squash** so the two land atomically. No feature flag needed — there is no inconsistent half-state to guard. *(Process gate: keep this single-PR/squash discipline at merge time for #794.)*

- [x] **5.1** In `callTool` **before** `resolveRepo` (or in a dedicated branch): for `method` ∈ `impact` | `query` | `context`, if `params.repo` is a string and `params.repo.startsWith('@')`, **do not** call normal single-repo `resolveRepo`; dispatch to `GroupService` with parsed group name and `service`, `target`, and other params per tool (see **5.1a**).

- [x] **5.1a** Explicit mapping for **5.1** (standard MCP tool names only; **not** `group_*` tool names):
  | `method` + `repo` prefix `@` | `GroupService` |
  |------------------------------|----------------|
  | `impact` + `@…` | `groupImpact` |
  | `query` + `@…` | `groupQuery` |
  | `context` + `@…` | `groupContext` |

- [x] **5.2** **`handleGroupTool` / `callTool`:** the `group_*` branch **only** dispatches **`group_list`** and **`group_sync`**. Remove branches for deleted tools. Any other `group_*` method name → **clear error** (those tools no longer exist).

- [x] **5.3** Implement `service` semantics per tool per the **Service parameter semantics** table above; use the RFC service-boundaries section only for **edge cases** not covered here.

- [x] **5.4** Manual smoke per Issue #794 checklist: **`impact`**, **`query`**, and **`context`** with `repo: "@myproduct"` (and appropriate targets/params per tool), not `impact` alone. *Automated as the* `Issue #794 manual smoke checklist (automated)` *block in `gitnexus/test/unit/mcp/group-repo-routing.test.ts` — table-driven across the three tools with `repo: "@myproduct"` + `service: "app/backend"`, asserting `GroupService.{groupImpact,groupQuery,groupContext}` is invoked and the leading `@` is stripped before delegation.*

**Verify:** `npx tsc --noEmit` in `gitnexus`; vitest for group-tools.

---

## Phase 6 — MCP resources

- [x] **6.1** In `resources.ts` register (and extend **`parseUri`** so `gitnexus://group/...` resolves consistently with other resource templates):
  - **Supported URIs:** `gitnexus://group/{name}/contracts` (query: **`type`**, **`repo`**, **`unmatchedOnly`**) and `gitnexus://group/{name}/status`. Parse **`name`** from the path; parse query **`type`**, **`repo`**, **`unmatchedOnly`** — coerce **`unmatchedOnly`** from the strings `"true"` / `"false"` to boolean as needed.
  - **Malformed** URI or unknown resource tail: **throw** or return a structured error that **`readResource`** turns into a **clear string** for the client (match existing `resources.ts` error style).
  - **Unknown group** (optional): defer to the handler so the resource body is YAML or an error line — **consistent with existing repo resource errors**.

- [x] **6.2** In `local-backend.ts` (or a resource-handler module) wire URI reads to `GroupService.groupContracts` / `groupStatus`.

- [x] **6.3** Update `test/unit/resources.test.ts` if it asserts resource counts/names. **Require:** add coverage for the **two new templates** if not already covered — assert template registration and **`parseUri` round-trip** for sample `gitnexus://group/...` URIs (contracts + status).

**Verify:** vitest for resources; manual resource reads from Issue #794.

---

## Phase 7 — Documentation and UX strings

- [x] **7.1** Add an **English** MCP migration table to the RFC: `group_contracts` → resource `.../contracts`; `group_status` → `.../status`; `group_query` → `query` + `repo: "@name"`; group-level impact → `impact` + `repo: "@name"`.

- [x] **7.2** `ai-context.ts`: remove references to non-existent `group_impact`; describe the new surface (#794). Strings must be **English**.

---

## Final verification (from Issue #794)

```bash
cd gitnexus
npx tsc --noEmit
npx vitest run test/unit/group/cross-impact.test.ts --pool=forks
npx vitest run test/unit/group/service.test.ts --pool=forks
npx vitest run test/unit/group/group-service-group-mode.test.ts --pool=forks
npx vitest run test/integration/group/group-impact.test.ts --pool=forks
npx vitest run test/integration/group/group-cli.test.ts --pool=forks
npx vitest run test/unit/group/group-tools.test.ts --pool=forks
npx vitest run test/unit/tools.test.ts --pool=forks
npx vitest run test/unit/resources.test.ts --pool=forks
npx vitest run test/unit/mcp/group-repo-routing.test.ts --pool=forks
```

### Test ordering

Prefer adding **failing tests early** in the same phase as the code they exercise (TDD-friendly). Checkbox order in this plan is **logical**, not a strict execution order — reorder within a phase if it reduces rework.

---

## Risks and rollback

- **Breaking:** MCP clients that depend on the three removed tools — see migration table in the RFC.
- **Bridge schema drift:** A `bridge-schema` / packaged schema version mismatch is a **hard error** until **`gitnexus group sync`** (or equivalent) rebuilds `bridge.lbug` to match the running code — document this in operator-facing notes if not already in Issue #794.
- **Partial delivery:** If **`groupContext`** or **group `query`** paths slip relative to **`groupImpact`**, the MCP surface can look complete while group modes are incomplete — mitigated by Phase **2.1b**, **3.3a** / **3.3b**, **5.4**, and explicit verification commands. Shared **contract types in 1.1** reduce implementation drift between services and MCP handlers.
- **Rollback:** `git revert` the feature merge commit (per Issue #794). **Operational note:** reverting code may leave `bridge.lbug` at a **newer** schema than the rolled-back binary expects — re-run **`gitnexus group sync`** for affected groups if bridge read errors appear after rollback.

---

## Execution handoff

Plan file: `docs/superpowers/plans/2026-04-16-issue-794-implementation.md`.

All phases are closed on this branch. Final verification snapshot (`Final verification` block above, Windows / Node, `npx`):

- `npx tsc --noEmit` — clean.
- `npx vitest run … --pool=forks` over the 7 unit suites listed in the plan: **101/101** passing.
- `npx vitest run test/integration/group/group-impact.test.ts test/integration/group/group-cli.test.ts --pool=forks`: **7/7** passing.
- `npx vitest run test/unit/mcp/group-repo-routing.test.ts --pool=forks`: **14/14** passing (includes the automated #794 manual-smoke table-driven block from **5.4**).

Merge guidance: keep `tools.ts` removal and `local-backend.ts` `@group` routing in **one squash commit** (Phase **5.0**); rerun the `Final verification` block before pressing merge.
