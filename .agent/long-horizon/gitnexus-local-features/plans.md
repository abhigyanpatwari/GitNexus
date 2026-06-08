# GitNexus Local Features - Plans

Created: 2026-06-05

## Operating Notes

- This is a long-horizon Codex task using the four-file control surface in this directory.
- The source repo bundle is canonical. Old planning files in `C:\Users\steve\podman\gitnexus` are legacy source material only.
- The human operator is `MAIN` and has superseding authority over this workstream's rules.
- Use branch `local/gitnexus-local-features` for all selected feature work.
- Implement one feature at a time on the shared branch.
- Run the work through one selected task at a time; the selected-task packet is defined by this queue plus `feature-map.md` and `documentation.md`.
- Use Structured Delegation via Evidence-Gated Small-Batch Kanban: autonomous work is bounded by selected-task packets, small verified slices, fresh checkpoints, and explicit stop rules.
- Use Continuous Agentic Kanban for faster flow: one active implementation slice, up to three ready packets, appetite boxes, TDD/test-ladder verification, reviewer-agent checkpoints when warranted, and a documented baton after every slice.
- Formal Goal Contracts are no longer required for this workstream. Older Goal Contract sections remain useful historical/task-brief material, but the active control rule is the selected-task packet.
- Historical `MAIN | READY_FOR_IMPLEMENTATION` entries remain audit/task history only; current autonomy is controlled by the selected-task packet plus green/amber/red lanes.
- Task baton rule: after every completed or blocked selected task, continue with the next implementation task if the next approved slice is known; otherwise continue with the next readiness/research task if one is defensible. If neither is possible, record `NO_NEXT_TASK_SELECTED` in `documentation.md` with the blocker.
- Each selected-task packet should include task name, goal shape, scope, risk lane, likely write set if implementation is possible, verification surface, and stop rule.
- Non-interactive `codex exec` worker runs must repeat the selected-task packet and point to this four-file bundle before acting.
- Comprehensive feature map: `feature-map.md` is the single-place map for feature status, dependencies, source surfaces, tests, gates, evidence files, and next actions.
- Supporting Codex 5.4 handover note: `codex-5-4-handover-20260608.md` summarizes the state to inherit, faster packet-cycle rule, dirty-tree warning, and recommended first move after model switch. It does not override the four-file control surface.
- Treat the shared branch as a small-batch lane, not a dumping ground: keep WIP to one implementation feature, verify each slice, and checkpoint before moving to the next feature.
- A ready packet should name task, outcome, lane, appetite, likely write set, acceptance criteria, testing ladder, reviewer gate, stop rules, rollback/checkpoint notes, and next likely packet.
- Appetite defaults: green-lane slices are micro/small packets sized to one focused red-green-review loop; amber-lane slices may be larger but must stay bounded with premortem and rollback notes. Track elapsed time as an observation metric, not as a permission gate, because Codex 5.4 may complete well-shaped packets much faster than human estimates.
- For overnight or 6-8 hour autonomous runs, keep exactly one selected task active at a time, premortem risky tasks before amber-lane source edits, checkpoint after each completed/blocked task, and move to the next readiness or implementation task only when the next boundary is defensible.
- Branch-trusted autonomy applies on `local/gitnexus-local-features`: green/amber lane repo-local work may proceed once the selected-task packet is clear; red-lane work requires explicit human-operator direction.
- Green lane: repo-local docs, tests, fixtures, source code, deterministic reports, dry-run/status behavior, local CLI/MCP surfaces, and focused refactors inside the selected task may proceed autonomously with verification.
- Amber lane: local generated-output mutation, local config-shape changes, dependency changes, public CLI/API shape changes, or broad shared-module edits may proceed with premortem, TDD where behavior changes, checkpointing, and rollback notes.
- Red lane: stop for explicit human-operator direction before secrets/tokens, paid/provider execution, GitHub comments/checks/reviews, CI/workflow mutation, destructive git, production/external writes, unbounded background automation, or major architecture/language-semantics expansion.
- For behavior changes, follow TDD: write one focused failing test, verify the red failure, implement the smallest code to pass, verify green, then refactor while tests stay green.
- Use the GitNexus testing ladder for selected implementation slices: focused TDD first, fixture/CLI/MCP/golden tests at boundary crossings, build plus `git diff --check` for source tranches, runtime/Podman/browser/GitHub checks only when those boundaries are touched, and non-interactive Codex review as an added checkpoint gate after executable tests.
- Research is feature-wide across all seven candidates. Auto-Reindexing currently receives decision-grade depth because it is the likely first implementation slice, but branch/lane strategy, dependency shape, and sequencing must be derived from the whole feature map.
- Research method is coordinated across methodology, public feature intent, GitHub PR/issue evidence, Context7/official docs, and local source/graph evidence. Do not promote a feature to implementation from one source class alone.
- Interim router cleanup is complete: bare `gitnexus` no longer routes secretly through the Podman helper. Use `gitnexus-podman` explicitly for Podman-backed GitNexus checks.
- `plan.md`, `gitnexus-router-indexing-note.md`, and the scratchpad are subordinate evidence only. They are not live control files and must not override this queue or `documentation.md`.
- Current multi-repo planning must separate CLI, MCP tools, and MCP resources: CLI still has `gitnexus group query/contracts/status`; MCP uses group-mode `query`, `context`, and `impact` plus `group_list`/`group_sync`; group contracts/status are MCP resources. Do not plan from stale tables that present `group_query`, `group_contracts`, or `group_status` as current MCP tools.
- PR Review / Blast Radius should be report-first. Existing PR review and PR swarm materials are read-only methods, not an automated GitHub PR-review product; GitHub posting/check automation is security-sensitive and later.
- Current execution tranche: Task 1 Auto-Reindexing, Task 2 Auto-Updating Code Wiki planner/runner plus read-only status endpoint, Task 3 Multi-Repo Support Improvements, Task 4 PR Impact / Blast Radius, Task 5 Auto Regression Forensics, Task 6 E2E Test Generation proposal/report core plus thin CLI wrapper, and Task 7 OCaml experimental support have completed their first local slices.
- 2026-06-08T10:47+01:00 post-tranche consolidation decision: the latest Task 4 range/deletion follow-ons and Task 2 wiki execution-boundary follow-on are complete. The next selected task is `Worktree Verification / Checkpoint Packet`, a green-lane consolidation task to review the accumulated WIP, rerun the right verification set, and prepare a clean checkpoint recommendation before selecting another feature expansion.
- 2026-06-08T10:53+01:00 worktree verification decision: focused touched-slice tests, build, and whitespace checks passed. `NO_NEXT_TASK_SELECTED` for feature expansion until a new selected-task packet names the next feature scope; checkpoint commit/review is recommended before broadening.
- 2026-06-08T15:19+01:00 checkpoint decision: commit `2a38a6db` (`checkpoint: local feature tranche through wiki-refresh and diff evidence`) closed the dirty-tree boundary. The next selected task is `Task 4 symbols-for-ranges primitive`.
- WIP boundary resolved: checkpoint commit `568e24de` (`checkpoint local features through task 4 readiness`) was created on 2026-06-06T12:17+01:00. Task 4 report-core commit `25873c96` (`feat: add pr impact report core`), CLI wrapper commit `39d77845` (`feat: add pr impact cli command`), and local read-only MCP exposure are complete. GitHub ingestion, PR comments/checks, token automation, web UI, and remediation remain deferred to future Goals.

## Feature Queue

| Order | Feature | Research depth | Disposition | Current implementation status |
| --- | --- | --- | --- | --- |
| 1 | Auto-Reindexing | `decision-grade completed for first slice` | `local V1 complete` | Approved slice implemented, verified, and snapshotted |
| 2 | Auto-Updating Code Wiki | `medium completed for first slices plus mutation/provider readiness` | `local V1 complete plus readiness boundary` | Core status/dry-run-first planner/runner, read-only server status endpoint, non-secret provider-readiness status, manual-refresh planner CLI, and explicit planning-only execution boundary implemented and verified |
| 3 | Multi-Repo Support Improvements | `light scoping completed for first docs slice` | `local docs slice complete` | README tool-surface reconciliation implemented and verified; no unified graph expansion |
| 4 | PR Impact / Blast Radius | `medium completed for local MCP slice plus no-write range/deletion primitives` | `local V1 complete plus follow-on primitives` | Report core, thin local CLI wrapper, read-only local MCP `pr_impact`, new-side changed/unmatched range evidence, and local old-side deletion evidence implemented and verified; GitHub automation and historical/provider base-graph semantics deferred |
| 5 | Auto Regression Forensics | `light scoping completed for first slice` | `local V1 complete` | Report core and thin local CLI wrapper implemented, verified, and committed |
| 6 | End-to-End Test Generation | `light scoping completed for first slice` | `local V1 complete` | Deterministic `e2e-test-plan.v1alpha1` proposal/report core, thin local CLI wrapper, mocked UI generated specs for `/api/repos`, `/api/repo`, `/api/graph`, `/api/file`, and API-smoke generated specs for `/api/processes`, `/api/health`, and `/api/info` implemented and verified |
| 7 | OCaml Support | `light scoping completed plus approval packet` | `local V1 complete` | Experimental `.ml` / `.mli` support and Query Depth V2 module type/include/functor-reference captures implemented locally; deeper OCaml semantics deferred |

## Next Task Queue

This section controls the next Goal selection after the completed local V1 tranche. It does not start implementation by itself.

| Priority | Task | Goal to create | Scope | Verification surface | Stop rule |
| --- | --- | --- | --- | --- | --- |
| Completed | Task 4 No-Write Graph Primitives | Technical readiness plus implementation | Completed on 2026-06-08T10:20+01:00; selected slice surfaces new-side changed ranges and unmatched hunk ranges through `detect_changes` and carries unmatched range evidence into `pr_impact`. | Focused red/green tests, adjacent PR Impact/MCP tests, build, and diff check. | Deleted-symbol/base-graph semantics remain deferred. |
| Completed | Task 4 Deleted/Base-Graph Mapping | Technical readiness plus implementation | Completed on 2026-06-08T10:32+01:00; selected slice parses old-side pure-deletion ranges, resolves overlapping local graph symbols, counts inbound callers, and carries deleted-symbol evidence into `pr-impact.v1alpha1`. | Focused red/green parser, dispatch, pipeline tests plus adjacent PR Impact/MCP tests, build, and diff check. | Historical/base graph indexes, GitHub provider semantics, and broad graph architecture remain deferred. |
| Completed | Task 2 Full Wiki Mutation / Provider Execution | Red-lane readiness plus no-write policy implementation | Completed on 2026-06-08T10:39+01:00; `gitnexus wiki-refresh` now emits an explicit planning-only execution boundary and required human decisions. | Focused wiki-refresh tests plus adjacent wiki planner/provider/API/help tests, build, and diff check. | Provider execution, secrets/tokens, config writes, output mutation/publication, and unattended generation remain deferred. |
| Completed | Post-Tranche Consolidation / Next-Slice Selection | Readiness Goal | Completed on 2026-06-08T10:47+01:00; recent PR Impact and wiki readiness follow-ons are reconciled and red-lane feature expansions remain deferred. | Updated next-task map and `NEXT_TASK_SELECTED` recorded. | Next selected task is worktree verification/checkpoint preparation, not feature expansion. |
| Completed | Worktree Verification / Checkpoint Packet | Green-lane consolidation | Completed on 2026-06-08T10:53+01:00; accumulated uncommitted source/docs/test WIP was reviewed by slice and verified together. | Focused touched-slice tests, `npm run build`, `git diff --check`, and checkpoint note in `documentation.md`. | No new feature behavior was implemented. |
| Completed | Task 4 `symbols-for-ranges` primitive | Green/amber implementation packet | Completed on 2026-06-08T15:34+01:00 as the first stable no-write local range-input primitive aligned with issue #1901. | Focused CLI/backend tests, adjacent PR Impact/parser/tool tests, build, and diff check. | `impact-for-symbols` remains the next narrower Task 4 follow-on. |
| Completed | Task 4 `impact-for-symbols` primitive | Green/amber implementation packet | Completed on 2026-06-08T15:52+01:00 as the direct symbol-to-process/process-step companion primitive to `symbols-for-ranges`, returning deterministic `impact-for-symbols.v1alpha1` JSON with mapped, unmapped, and unknown symbol evidence. | Focused CLI/backend/help tests, adjacent Task 4 tests, build, and diff check. | Broader Task 4 composition remains a separate readiness packet. |
| Completed | Task 4 primitive-composition readiness | Green readiness packet | Completed on 2026-06-08T17:02+01:00. The selected composition lane is a local direct-process surface, `impact-for-ranges`, that honestly composes `symbols-for-ranges -> impact-for-symbols` without claiming full blast-radius, API-impact, or test-signal parity. | Source analysis, expected-vs-actual reconciliation, bounded write set, focused TDD plan, and stop-rule confirmation. | Keep composition direct-only; do not broaden into GitHub posting, provider execution, historical/base-graph architecture, or fake parity with the older `pr-impact` pipeline. |
| Completed | Task 4 `impact-for-ranges` composed primitive | Green/amber implementation packet | Completed on 2026-06-08T17:02+01:00 as the first deterministic local composition surface over explicit ranges. Adds `gitnexus impact-for-ranges --input <path> --repo <name>` plus backend `impact_for_ranges`, returning `impact-for-ranges.v1alpha1` JSON with matched/unmatched range evidence, direct process membership, and explicit caveats about what is intentionally excluded. | Focused CLI/backend/help tests, adjacent Task 4 pipeline/primitive tests, build, and diff check. | This is direct process evidence only; it does not replace `pr-impact` risk/API/test-signal semantics. |
| Active | Task 4 direct-composition report readiness | Green readiness packet | With `impact-for-ranges` implemented, the next safe boundary is deciding whether to add a deterministic local report layer over the composed direct-process evidence or stop the lane at the primitive surface. | Packet defining report scope, exact truth claims, likely write set, and TDD plan for any next local report/readout surface. | Keep scope to direct-composition readout only; do not backfill fake blast-radius parity, GitHub/provider semantics, or historical/base-graph architecture. |
| Completed | Task 7 OCaml Module-System Depth | Research/readiness plus comment cleanup | Completed on 2026-06-08T10:12+01:00; deeper OCaml work now requires resolver/dependency/product-lane expansion rather than another small query capture. | Local source map, public issue/package evidence, OCaml focused tests, and comment-drift cleanup. | Do not implement Dune, PPX, interface/implementation matching, module alias/functor resolution, dependency upgrades, or production classification without a new red/amber packet. |
| Completed | Task 6 `/api/info` API-Smoke Route | Technical readiness plus implementation | Completed on 2026-06-08T09:57+01:00 as a deterministic APIRequestContext generated-spec renderer. | Focused renderer tests, adjacent Task 6 tests, build, and diff check passed. | Do not broaden into more API-smoke routes without a new selected route contract. |
| Completed | Task 4 GitHub PR Automation Boundary | Readiness checkpoint | Boundary completed on 2026-06-08T09:45+01:00; GitHub posting/check automation remains red-lane deferred. | `documentation.md` checkpoint plus GitHub issue/PR/docs evidence. | Do not re-enter unless a new no-write primitive or GitHub integration packet is selected. |

## Live 3-Slot Board

Board activation note:

- The board below is the live next-task control surface.
- Current evaluated state is `R5 No implementation packet, but green readiness exists`.
- The previous dirty-tree boundary is already closed by checkpoint commit `2a38a6db` plus the committed Task 4 primitive follow-ons.
- The `Active` slot below is now the executing packet.

| Slot | Packet | Status | Notes |
| --- | --- | --- | --- |
| Active | Task 4 direct-composition report readiness | Executing | Decide whether the composed `impact-for-ranges` surface should gain a bounded Markdown/JSON readout layer or remain a primitive-only surface. |
| Ready 1 | Task 4 local direct-composition report implementation | Conditional on readiness completion | Same-feature continuation if the readiness packet produces a bounded truth-preserving report shape and TDD path. |
| Ready 2 | Task 6 next API-smoke route readiness | Green readiness fallback | Lowest-blast-radius alternative if Task 4 cannot move forward cleanly; choose the next backend route contract before any new generated spec. |
| Deferred / Red | GitHub posting/check automation; provider execution; historical/base-graph architecture; CI/workflow mutation; secrets/tokens | Deferred | Never move red-lane work into a ready slot without explicit human-operator direction. |

Board selection rule:

1. Continue same feature if safe.
2. Otherwise choose green readiness.
3. Otherwise choose amber with premortem.
4. Otherwise stop with blocker.

Default recommendation:

- Active packet is `Task 4 direct-composition report readiness`.
- Recommended immediate action is to define the smallest truth-preserving readout layer over `impact-for-ranges`, then either activate the bounded same-feature implementation slice or record the narrower follow-on/blocker.
- Task 4 GitHub boundary readiness is complete for the current run; keep the next packet on the no-write primitive lane rather than drifting into provider or GitHub semantics.
- Do not add more generated API-smoke routes until the backend route contract is decision-complete.
- If the human operator chooses another priority, create a selected-task packet for that task before source edits.

### Task 4 `symbols-for-ranges` Primitive - 2026-06-08

Selected task:

- Implement the first stable no-write graph-mapping primitive proposed by GitNexus issue #1901: `symbols-for-ranges`.

Readiness verdict:

- Safe to begin as a green/amber repo-local slice.
- The existing `detect_changes` flow already performs the core mapping internally: parse ranges, resolve overlaps to symbols, preserve unmatched evidence, and preserve local deleted-range evidence.
- The smallest useful external boundary is caller-supplied ranges mapped onto the indexed graph.
- Keep this packet narrower than the full issue:
  - include `symbols-for-ranges`
  - exclude `impact-for-symbols`
  - exclude GitHub/provider diff ingestion
  - exclude historical/base-graph snapshot semantics
  - exclude posting/check workflows

Expected vs actual:

| Area | Expected behavior | Current local behavior | Packet response |
| --- | --- | --- | --- |
| External boundary | Callers should hand GitNexus explicit file/range inputs instead of forcing GitNexus-owned `git diff` selection. | `detect_changes` owns diff selection internally and only accepts `scope`/`base_ref`/`repo`. | Add a caller-supplied range-input surface. |
| Mapping contract | Output should return matched symbols plus unmatched ranges in a stable machine-readable shape. | Internal `detect_changes` returns changed/unmatched/deleted evidence only after it computes its own diff. | Extract/reuse the mapping path and expose it directly. |
| Deletion support | Old-side deleted ranges should not be silently dropped. | Local parser/mapping now handles old-side deleted ranges for `detect_changes`. | Preserve deleted-range semantics when callers provide `side: old` and `changeType: deleted`. |
| Ownership split | GitNexus should own graph mapping, not provider PR semantics. | Current local source already aligns with that direction after the no-write range/deletion follow-ons. | Keep this packet local/no-write and avoid provider/auth semantics. |

Lane:

- Green/amber.
- Green for helper extraction, CLI wiring, and deterministic JSON contract tests.
- Amber only where a new public CLI contract is introduced.

Likely write set:

- `gitnexus/src/mcp/local/local-backend.ts`
- `gitnexus/src/cli/index.ts`
- `gitnexus/src/cli/help-i18n.ts`
- `gitnexus/src/cli/i18n/en.ts`
- `gitnexus/src/cli/i18n/zh-CN.ts`
- `gitnexus/src/cli/symbols-for-ranges.ts` (new)
- focused backend/CLI tests
- long-horizon docs for checkpointing

Smallest implementation slice:

- Add a local CLI command:
  - `gitnexus symbols-for-ranges --input <path> --repo <name>`
- Accept a JSON file containing explicit ranges.
- Return a deterministic JSON result with:
  - schema/version marker
  - repo identity
  - matched symbols
  - unmatched ranges
  - deleted-symbol evidence when applicable
- Do not add MCP exposure, `impact-for-symbols`, provider diff adapters, or GitHub URL parsing in this packet.

TDD plan:

1. Add a focused failing CLI test using a small range-input fixture.
2. Add or adapt a backend test proving caller-supplied ranges map to symbols and preserve unmatched/deleted evidence.
3. Verify the red failures are due to the missing command/surface rather than broken fixtures.
4. Implement the thinnest backend/CLI path to pass.
5. Run focused CLI/backend tests.
6. Run adjacent PR Impact/parser/tool tests if the surface reuses shared mapping code.
7. Run `npm run build` and `git diff --check`.

Stop rules:

- Stop if the slice starts to require GitHub/network/provider tokens, PR URL parsing, base-graph history, external writes, or broad `impact-for-symbols` orchestration.
- Stop if the contract cannot be kept deterministic without inventing provider-specific semantics.

### Task 4 `impact-for-symbols` Primitive - 2026-06-08

Selected task:

- Implement the direct symbol-to-process/process-step companion primitive proposed by GitNexus issue #1901: `impact-for-symbols`.

Readiness verdict:

- Safe to implement as a green/amber repo-local slice immediately after `symbols-for-ranges`.
- Existing backend queries already expose direct process participation through `STEP_IN_PROCESS`; the smallest useful external boundary is a caller-supplied symbol batch mapped onto that direct evidence.
- Keep this packet narrower than the broader `impact` tool:
  - include direct process membership and process-step evidence
  - include explicit unknown/unmapped symbol reporting
  - exclude upstream/downstream traversal semantics
  - exclude GitHub/provider PR semantics
  - exclude historical/base-graph composition

Expected vs actual:

| Area | Expected behavior | Current local behavior | Packet response |
| --- | --- | --- | --- |
| External boundary | Callers should hand GitNexus explicit symbol refs instead of forcing a full diff walk. | `impact` starts from one target and performs upstream/downstream traversal. | Add a caller-supplied symbol-batch surface. |
| Evidence shape | Output should return direct process/process-step evidence plus explicit unknown/unmapped symbol cases. | Existing backend surfaces process participation indirectly through `context()` and per-symbol `impact()` enrichment only. | Extract/reuse direct process membership and expose it as a deterministic JSON contract. |
| Scope control | Direct process membership should stay separate from broader blast-radius traversal. | Existing `impact` includes caller traversal, risk scoring, modules, and pagination. | Keep this packet local/no-write and direct-only. |

Lane:

- Green/amber.
- Green for helper extraction, CLI wiring, deterministic JSON contract tests, and help/i18n wiring.
- Amber only where a new public CLI contract is introduced.

Likely write set:

- `gitnexus/src/mcp/local/local-backend.ts`
- `gitnexus/src/cli/index.ts`
- `gitnexus/src/cli/help-i18n.ts`
- `gitnexus/src/cli/i18n/en.ts`
- `gitnexus/src/cli/i18n/zh-CN.ts`
- `gitnexus/src/cli/impact-for-symbols.ts` (new)
- focused backend/CLI/help tests
- long-horizon docs for checkpointing

Smallest implementation slice:

- Add a local CLI command:
  - `gitnexus impact-for-symbols --input <path> --repo <name>`
- Accept a JSON file containing explicit symbols or a `symbols` array from `symbols-for-ranges`.
- Return deterministic JSON with:
  - schema/version marker
  - repo identity
  - mapped symbols with direct process/process-step evidence
  - unmapped symbols
  - unknown symbols
  - affected-process summary
- Do not add MCP exposure, traversal fan-out, provider diff adapters, or GitHub URL parsing in this packet.

TDD plan:

1. Add a focused backend dispatch test for mapped, unmapped, and unknown symbol cases.
2. Add a focused CLI test reading a symbol-batch JSON file.
3. Add help-surface coverage for the new command.
4. Verify the red failures are due to the missing tool/command rather than broken fixtures.
5. Implement the thinnest backend/CLI path to pass.
6. Run focused CLI/backend/help tests.
7. Run adjacent Task 4 tests.
8. Run `npm run build` and `git diff --check`.

Stop rules:

- Stop if the slice starts to require upstream/downstream traversal, GitHub/network/provider tokens, PR URL parsing, base-graph history, external writes, or broad PR-impact orchestration.
- Stop if the contract cannot be kept deterministic without inventing provider-specific semantics.

### Overnight Run Packet - 2026-06-08

Status:

- Completed on 2026-06-08T09:34+01:00 by the local `gitnexus wiki-refresh` manual-refresh planner slice. The follow-on `Task 4 GitHub PR Automation Boundary` readiness checkpoint completed on 2026-06-08T09:45+01:00, `Task 6 /api/info API-Smoke Route` completed on 2026-06-08T09:57+01:00, `Task 7 OCaml Module-System Depth` readiness completed on 2026-06-08T10:12+01:00, `Task 4 No-Write Graph Primitives` completed on 2026-06-08T10:20+01:00, `Task 4 Deleted/Base-Graph Mapping` completed on 2026-06-08T10:32+01:00, `Task 2 Full Wiki Mutation / Provider Execution` readiness completed on 2026-06-08T10:39+01:00, `Post-Tranche Consolidation / Next-Slice Selection` completed on 2026-06-08T10:47+01:00, and `Worktree Verification / Checkpoint Packet` completed on 2026-06-08T10:53+01:00. Current baton is `NO_NEXT_TASK_SELECTED` for feature expansion.

Selected task in this historical packet:

- `Task 2 Wiki Mutation / Manual Refresh Policy` readiness.

Outcome:

- Decide whether wiki work may move beyond read-only status/provider-readiness into an explicit manual refresh or mutation-capable local workflow.

Scope:

- Define output mutation policy, manual refresh shape, provider execution boundary, rollback/reporting behavior, exact write set, and TDD plan if implementation becomes safe.

Lane:

- Readiness begins green lane. If the smallest implementation slice stays repo-local and reversible, continue autonomously as green/amber lane with premortem, TDD for behavior changes, checkpointing, and rollback notes.

Verification surface:

- Readiness table, premortem, source ownership map, exact no-write/write phases, and explicit next selected task or blocker recorded in `documentation.md`.

Stop rule:

- Stop rather than implementing only if the selected slice crosses red-lane boundaries: secrets/tokens, paid/provider execution, GitHub writes, CI/workflow mutation, destructive git, production/external writes, unbounded background automation, or major architecture/product expansion.

Fallback sequence if Task 2 blocks:

1. `Task 4 GitHub PR Automation Boundary` readiness - completed.
2. `Task 6 /api/info API-Smoke Route` readiness - completed.
3. `Task 7 OCaml Module-System Depth` readiness - completed.
4. `Task 4 No-Write Graph Primitives` readiness - completed.
5. `Task 4 Deleted/Base-Graph Mapping` readiness - completed.
6. `Task 2 Full Wiki Mutation / Provider Execution` readiness - completed.
7. `Post-Tranche Consolidation / Next-Slice Selection` - completed.
8. `Worktree Verification / Checkpoint Packet` - completed.
9. `NO_NEXT_TASK_SELECTED` for feature expansion until a new selected-task packet is chosen.

### Task 6 `/api/info` API-Smoke Route - 2026-06-08

Selected task:

- Add readiness and, if safe, deterministic generated API-smoke support for `/api/info`.

Readiness verdict:

- Safe to implement as a narrow green/amber local source slice.
- `/api/info` is read-only and repo-independent.
- The response includes runtime-derived `launchContext` and `nodeVersion`, so generated assertions must check stable shape and allowed values rather than hard-code the local runtime.
- No browser execution, live server execution, CI mutation, GitHub automation, token handling, or new dependency is needed.

Expected vs actual:

| Area | Expected behavior | Current local behavior | Plan response |
| --- | --- | --- | --- |
| Route contract | `/api/info` returns server version and launch context for operator/server visibility. | `gitnexus/src/server/api.ts` returns `{ version: pkg.version, launchContext, nodeVersion }`. | Generate an APIRequestContext smoke spec that asserts OK, string `version`, allowed `launchContext`, and Node-style `nodeVersion`. |
| Determinism | Generated spec should not bake in workstation-specific values. | `nodeVersion` and launch mode vary by runtime. | Assert type/regex/enum only. |
| Existing generated API-smoke lane | `/api/processes` and `/api/health` already have deterministic renderer branches and golden fixtures. | `api-smoke-renderer.ts` allowlist currently blocks every route except `/api/processes` and `/api/health`. | Extend allowlist and renderer dispatch for `/api/info` only. |
| Output location | API-smoke specs should stay separate from browser UI generated specs. | Existing default output path is `gitnexus/test/api-smoke/generated`. | Reuse unchanged. |

Write set:

- `gitnexus/src/core/e2e-test-generation/api-smoke-renderer.ts`
- `gitnexus/test/unit/e2e-test-generation-api-smoke-renderer.test.ts`
- `gitnexus/test/fixtures/e2e-test-generation/generated-api-info-smoke.spec.ts`
- Long-horizon docs for checkpointing after implementation

TDD plan:

1. Add a failing renderer/golden test for `/api/info`.
2. Verify the red failure is the current route allowlist block.
3. Add the `/api/info` renderer branch and update the allowlist message.
4. Run focused API-smoke renderer tests.
5. Run adjacent Task 6 renderer/CLI/report tests if the focused test passes.
6. Run `npm run build` and `git diff --check`.

Stop rules:

- Stop if the spec needs exact `version`, exact `nodeVersion`, exact `launchContext`, a live server, browser execution, CI mutation, GitHub writes, token handling, or new dependencies.

Implementation checkpoint:

- Completed on 2026-06-08T09:57+01:00.
- Added a deterministic `/api/info` API-smoke renderer branch and golden fixture.
- Assertions intentionally check the stable response shape: OK response, string `version`, `launchContext` in `npx | global | local`, and Node-style `nodeVersion`.
- No server route changes, live browser/server execution, CI mutation, GitHub automation, token handling, or new dependency was introduced.

Verification:

```powershell
npm test -- --run test/unit/e2e-test-generation-api-smoke-renderer.test.ts
npm test -- --run test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-generation-api-smoke-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts
npm run build
git diff --check
```

Results:

- TDD red was verified first: `/api/info` failed on the existing API-smoke allowlist before implementation.
- Focused API-smoke renderer tests passed: 1 file, 6 tests.
- Adjacent Task 6 tests passed: 4 files, 23 tests.
- Build passed with existing Vite chunk/dynamic-import warnings only.
- `git diff --check` passed.

### Task 7 OCaml Module-System Depth - 2026-06-08

Selected task:

- Decide whether any next OCaml module-system source slice is safe after experimental OCaml V1 and Query Depth V2.

Readiness verdict:

- No further behavior implementation is selected from this pass.
- Query Depth V2 already captured the small safe syntax layer: module type definitions plus module/include/functor references.
- The next meaningful OCaml improvements cross into dependency upgrades, import target resolution, Dune/project modeling, `.ml`/`.mli` interface-to-implementation matching, module alias/functor resolution, PPX/generated-code handling, or production classification.
- Those are amber/red lane expansion areas, not another small green query slice.
- A green cleanup was safe: update the `OCAML_QUERIES` source comment so it no longer describes the pre-V2 query surface as merely foundational V1.

Expected vs actual:

| Area | Expected behavior | Current local behavior | Readiness decision |
| --- | --- | --- | --- |
| Public issue intent | OCaml support should cover `.ml`/`.mli`, symbol extraction, import resolution, and call detection. | Experimental `.ml`/`.mli` parsing, symbols, import-like refs, and calls exist; import resolution remains intentionally shallow. | V1/V2 satisfy the safe extraction subset; true import resolution is a future resolver slice. |
| Grammar route | OCaml implementation and interface grammars must be selected correctly. | `parser-loader.ts` routes `.ml` to `ocaml` and `.mli` to `interface`; local package exports exactly those keys. | Keep current route. |
| Dependency route | Avoid broad native parser runtime churn during a small slice. | Local install uses `tree-sitter-ocaml@0.22.0` with `tree-sitter@0.21.1`; current npm latest `0.24.2` peers on `tree-sitter ^0.22.4`. | Do not upgrade in this workstream pass. |
| Query surface | Capture syntax evidence useful to graph/search. | Queries include modules, module types, type/value/function declarations, open/include/module refs, and direct calls. | No new query-only behavior is obviously missing enough to justify source changes now. |
| Resolver semantics | Resolve module aliases, interface/implementation pairs, and functors defensibly. | `ocamlProvider.importResolver` returns `null`; provider uses `wildcard-leaf`; no Dune/project model. | Defer as major semantics/design work. |

Evidence:

| Source | Finding | Consequence |
| --- | --- | --- |
| GitNexus issue #1368, https://github.com/abhigyanpatwari/GitNexus/issues/1368 | Open issue requests OCaml support for `.ml`/`.mli`, symbol extraction, import resolution, and calls; it mentions `tree-sitter-ocaml` compatibility claims and a fork implementation offer. | Confirms intended feature direction, but local implementation should stay evidence-tested and experimental. |
| GitNexus PR #305, https://github.com/abhigyanpatwari/GitNexus/pull/305 | Language onboarding analogue for Zig included CLI/web parity, grammar provenance, query coverage, detect-changes exposure, syntax/highlighting, and correctness fixes. | Full language maturity is broader than query captures; do not call OCaml production-ready. |
| `tree-sitter/tree-sitter-ocaml`, https://github.com/tree-sitter/tree-sitter-ocaml | Official grammar source exists and has separate implementation/interface grammar shape. | Current `.ml`/`.mli` split remains the right route. |
| `npm view tree-sitter-ocaml version peerDependencies dependencies --json` | Current npm latest is `0.24.2` and peers on `tree-sitter ^0.22.4`. | Upgrading from local `0.22.0` would drag core parser runtime scope. |
| `node -e "const g=require('tree-sitter-ocaml'); ..."` | Local package exports `interface,ocaml` and reports version `0.22.0`. | Current implementation's `interface` export choice is still locally correct. |
| `gitnexus/src/core/ingestion/languages/ocaml.ts` | Provider has no import resolver and uses `wildcard-leaf`. | True module-system depth is resolver work, not just more query text. |

Source ownership map:

| Area | Current owner files | Task 7 consequence |
| --- | --- | --- |
| Language identity/detection | `gitnexus-shared/src/languages.ts`, `gitnexus-shared/src/language-detection.ts`, `language-classification.ts` | Already implemented for OCaml; keep experimental. |
| Parser loading | `gitnexus/src/core/tree-sitter/parser-loader.ts` | Already handles `.ml` vs `.mli`; no change. |
| Provider/query surface | `gitnexus/src/core/ingestion/languages/ocaml.ts`, `tree-sitter-queries.ts` | Comment cleanup only; behavior unchanged. |
| Tests/fixtures | `ocaml-language-support.test.ts`, `tree-sitter-queries.test.ts`, `tree-sitter-languages.test.ts`, `sample-code/*.ml/*.mli` | Existing focused baseline is sufficient for readiness. |
| Future resolver | `scope-resolution` provider hooks and language-specific resolver files | New design packet required before source edits. |

Dependency/risk map:

| Candidate next slice | Lane | Risk | Verdict |
| --- | --- | --- | --- |
| Source comment drift cleanup | Green | None beyond review noise | Done |
| More query-only captures | Green/amber | Could add noisy imports without resolver value | Defer until a concrete missing syntax case is named |
| `.ml`/`.mli` implementation/interface matching | Amber/red | Needs project/module naming rules and collision policy | Defer |
| Dune/project model | Red/major architecture | Requires project-file parser and build-system semantics | Defer |
| Module alias/functor resolution | Red/major semantics | Requires resolver design and test matrix | Defer |
| Upgrade `tree-sitter-ocaml` | Red/dependency | Current latest peers on a newer `tree-sitter` runtime | Defer |
| Production classification | Red/product quality | Requires broader language parity and benchmark confidence | Defer |

Verification:

```powershell
npm test -- --run test/unit/ocaml-language-support.test.ts test/integration/tree-sitter-languages.test.ts test/unit/tree-sitter-queries.test.ts
git diff --check
```

Results:

- OCaml/language-query baseline passed: 3 files, 138 tests.
- `git diff --check` passed after the Task 7 doc/comment cleanup.

Next selected task:

- `Task 4 No-Write Graph Primitives` readiness.

### Task 4 No-Write Graph Primitives - 2026-06-08T10:20+01:00

Selected task:

- Decide whether the next PR Impact technical slice should be `symbols-for-ranges`, `impact-for-symbols`, explicit local range input, or another local no-write primitive before any GitHub posting surface.

Readiness verdict:

- Safe to implement a narrow green/amber local primitive now: surface new-side changed hunk ranges from `detect_changes`, classify hunks with no overlapping indexed symbol as unmatched ranges, and carry that evidence into the existing `pr_impact` report.
- Do not implement deleted-symbol/base-graph behavior in the same slice. Current `parseDiffHunks()` intentionally extracts new-file ranges and skips pure-deletion hunks, and live graph lookup does not prove a historical base graph for compare-mode deletions.
- Do not add GitHub URL ingestion, PR comments/checks/reviews, Actions workflows, tokens, CI mutation, provider execution, new dependencies, or broad graph rewrites.

Expected vs actual:

| Area | Expected behavior | Current local behavior before slice | Plan response |
| --- | --- | --- | --- |
| Range evidence | PR Impact V1 should start from diff ranges rather than only mapped symbols. | `detect_changes` parsed hunks internally but returned only `changed_symbols`. | Add `changed_ranges` to `detect_changes` output for parsed new-side hunks. |
| Unmatched ranges | Changed hunks with no symbol overlap should be visible as uncertainty. | `diff-mapping.ts` and `report.ts` supported unmatched ranges, but the live pipeline always passed `[]`. | Add `unmatched_ranges` to `detect_changes` and propagate into `pr_impact`. |
| Deleted symbols | Deleted symbols should eventually resolve against base graph where possible. | Pure-deletion hunks are skipped by `parseDiffHunks()` and base-graph identity is not established. | Defer to a separate deletion/base-graph readiness task. |
| GitHub automation | PR provider posting is later-phase/red-lane. | Local CLI/MCP report exists without GitHub writes. | Keep this slice local and no-write only. |

Write set:

- `gitnexus/src/mcp/local/local-backend.ts`
- `gitnexus/src/core/pr-impact/pipeline.ts`
- `gitnexus/src/mcp/tools.ts`
- `gitnexus/test/unit/calltool-dispatch.test.ts`
- `gitnexus/test/unit/pr-impact-pipeline.test.ts`
- Long-horizon docs for checkpointing

TDD evidence:

- Red first: `pr-impact-pipeline.test.ts` proved `unmatched_ranges` from `detect_changes` were dropped by the pipeline.
- Red first: `calltool-dispatch.test.ts` used a temporary git repo and mocked graph rows to prove `detect_changes` did not emit `changed_ranges` or `unmatched_ranges`.
- Green: `detect_changes` now emits new-side `changed_ranges` and per-hunk `unmatched_ranges`; `buildPrImpactPipelineReport()` normalizes and carries unmatched range evidence into `pr-impact.v1alpha1`.

Verification:

```powershell
npm test -- --run test/unit/pr-impact-pipeline.test.ts
npm test -- --run test/unit/calltool-dispatch.test.ts --testNamePattern "detect_changes returns changed ranges"
npm test -- --run test/unit/pr-impact-diff-mapping.test.ts test/unit/pr-impact-report.test.ts test/unit/pr-impact-pipeline.test.ts test/unit/pr-impact-cli.test.ts test/unit/tools.test.ts test/unit/calltool-dispatch.test.ts
npm run build
git diff --check
```

Results:

- Focused PR Impact pipeline tests passed: 1 file, 2 tests.
- Focused `detect_changes` range test passed: 1 selected test.
- Adjacent PR Impact/MCP/tool tests passed: 6 files, 120 tests.
- Build passed with existing Vite chunk/dynamic-import warnings only.
- `git diff --check` passed.

Next selected task:

- `Task 4 Deleted/Base-Graph Mapping` readiness.

### Task 4 Deleted/Base-Graph Mapping - 2026-06-08T10:32+01:00

Selected task:

- Decide whether deleted-symbol handling can be implemented as a local no-write primitive without pretending the current graph is a historical base graph.

Readiness verdict:

- Safe to implement a bounded local slice: parse old-side pure-deletion ranges from `git diff -U0`, resolve overlapping indexed symbols in the local graph when available, count inbound callers from current graph relations, and carry that deleted-symbol evidence into `pr-impact.v1alpha1`.
- The slice is intentionally local and best-effort. It does not create or require historical/base graph indexes and does not claim provider-specific PR semantics for GitHub compare data.
- If a deletion range does not resolve against the local graph, it remains an unmatched range rather than a false no-impact signal.

Expected vs actual:

| Area | Expected behavior | Behavior before slice | Implemented response |
| --- | --- | --- | --- |
| Old-side deletion ranges | Pure deletions should be visible to PR Impact. | `parseDiffHunks()` skipped deletion hunks because new-side count is `0`. | Added `parseDiffRanges()` for new-side additions/modifications and old-side pure deletions. |
| Deleted symbol evidence | Deleted symbols should surface loudly when the local graph can resolve them. | `detect_changes` returned no deleted-symbol output. | `detect_changes` now returns `deleted_symbols` with `inboundCallers` when a deleted range overlaps an indexed symbol. |
| Report propagation | PR Impact report already had a deleted-symbol section and BLOCK rule. | Pipeline ignored `detect_changes.deleted_symbols`. | Pipeline carries deleted-symbol evidence into `pr-impact.v1alpha1`. |
| Historical graph semantics | Compare-mode deletion may need a true base graph. | No historical/base graph index is established by this workstream. | Defer historical graph/provider semantics; unmatched/unknown evidence remains conservative. |

Write set:

- `gitnexus/src/storage/git.ts`
- `gitnexus/src/mcp/local/local-backend.ts`
- `gitnexus/src/core/pr-impact/pipeline.ts`
- `gitnexus/src/mcp/tools.ts`
- `gitnexus/test/unit/parse-diff-hunks.test.ts`
- `gitnexus/test/unit/calltool-dispatch.test.ts`
- `gitnexus/test/unit/pr-impact-pipeline.test.ts`
- Long-horizon docs for checkpointing

TDD evidence:

- Red first: `parse-diff-hunks.test.ts` proved there was no `parseDiffRanges()` helper and no old-side deletion range output.
- Red first: `pr-impact-pipeline.test.ts` proved `deleted_symbols` from `detect_changes` were dropped by the pipeline.
- Red first: `calltool-dispatch.test.ts` used a real temporary git repo to prove `detect_changes` did not emit deleted symbols for a pure deletion hunk.
- Green: parser, local `detect_changes`, and PR Impact pipeline tests passed after the narrow implementation.

Verification:

```powershell
npm test -- --run test/unit/parse-diff-hunks.test.ts --testNamePattern "parseDiffRanges"
npm test -- --run test/unit/pr-impact-pipeline.test.ts --testNamePattern "deleted symbol"
npm test -- --run test/unit/calltool-dispatch.test.ts --testNamePattern "deleted symbols"
npm test -- --run test/unit/parse-diff-hunks.test.ts test/unit/pr-impact-diff-mapping.test.ts test/unit/pr-impact-report.test.ts test/unit/pr-impact-pipeline.test.ts test/unit/pr-impact-cli.test.ts test/unit/tools.test.ts test/unit/calltool-dispatch.test.ts
npm run build
git diff --check
```

Results:

- Focused parser tests passed: 2 selected tests.
- Focused deleted-symbol pipeline test passed: 1 selected test.
- Focused local `detect_changes` deletion test passed: 1 selected test.
- Adjacent parse/PR Impact/MCP/tool tests passed: 7 files, 132 tests.
- Build passed with existing Vite chunk/dynamic-import warnings only.
- `git diff --check` passed.

Deferred:

- Historical/base graph index support.
- GitHub provider compare semantics.
- GitHub PR URL ingestion, comments, reviews, checks, Actions workflows, tokens, CI mutation, and remediation.

Next selected task:

- `Task 2 Full Wiki Mutation / Provider Execution` readiness.

### Task 2 Full Wiki Mutation / Provider Execution - 2026-06-08T10:39+01:00

Selected task:

- Decide whether wiki work can safely move beyond read-only status/provider-readiness/manual-refresh planning into any local mutation-capable or provider-execution workflow.

Readiness verdict:

- Do not implement provider execution, output mutation, config writes, output publication, or unattended generation in this slice.
- Safe no-write implementation: make the existing `gitnexus wiki-refresh` report carry an explicit execution boundary so future operators and agents see that it is planning-only and which human decisions are still required.

Expected vs actual:

| Area | Expected behavior | Current behavior before slice | Implemented response |
| --- | --- | --- | --- |
| Provider execution | Must not happen without provider/cost/auth policy. | `wiki-refresh` did not run providers; `gitnexus wiki` can. | Keep `wiki-refresh` planning-only and add explicit `provider_execution_enabled: false`. |
| Output mutation | Must not happen without output location, overwrite, rollback, and publication policy. | `wiki-refresh` did not mutate output but only implied the boundary through safety flags. | Add explicit `output_mutation_enabled: false` and required decision text. |
| Config writes | Must not happen silently from readiness/status flow. | `gitnexus wiki` can save config; `wiki-refresh` only reads config. | Add explicit `config_writes_enabled: false`. |
| Human decisions | Need a durable policy list before mutation/provider work. | Caveats existed but no structured policy field. | Add `execution_boundary.required_human_decisions`. |

Write set:

- `gitnexus/src/cli/wiki-refresh.ts`
- `gitnexus/test/unit/wiki-refresh-cli.test.ts`
- Long-horizon docs for checkpointing

TDD evidence:

- Red first: focused wiki-refresh tests failed because Markdown and JSON lacked an execution boundary.
- Green: added `execution_boundary` to `wiki-refresh-plan.v1alpha1` JSON and an `## Execution Boundary` Markdown section.

Verification:

```powershell
npm test -- --run test/unit/wiki-refresh-cli.test.ts
npm test -- --run test/unit/wiki-refresh-cli.test.ts test/unit/wiki-auto-refresh.test.ts test/unit/wiki-provider-readiness.test.ts test/unit/wiki-auto-refresh-api-wiring.test.ts test/unit/cli-index-help.test.ts
npm run build
git diff --check
```

Results:

- Focused wiki-refresh tests passed: 1 file, 3 tests.
- Adjacent wiki planner/provider/API/help tests passed: 5 files, 29 tests.
- Build passed with existing Vite chunk/dynamic-import warnings only.
- `git diff --check` passed.

Deferred:

- Provider execution.
- Secrets/tokens.
- Saved config writes.
- Generated wiki output mutation/publication.
- Unattended generation or background automation.

Next selected task:

- `Post-Tranche Consolidation / Next-Slice Selection`.

### Post-Tranche Consolidation - 2026-06-07T17:14+01:00

Completed recent slices:

| Slice | Commit | Status |
| --- | --- | --- |
| Task 4 local read-only MCP `pr_impact` | `8cccd348` | Complete; GitHub automation deferred |
| Task 6 `/api/file` generated UI fixture | `e32a3438` | Complete; broader UI route generation deferred |
| Task 6 `/api/health` generated API-smoke fixture | `ff66de1e` | Complete; more API-smoke routes require route-specific readiness |
| Task 7 OCaml Query Depth V2 | `f1d2cc2b` | Complete; Dune/PPX/full module semantics deferred |

What is genuinely blocked:

| Area | Blocker type | Why it cannot be forced through as normal implementation |
| --- | --- | --- |
| Wiki mutation/manual refresh | Product/output policy | `WikiGenerator.run()` writes markdown/HTML/meta artifacts and may invoke providers. The next slice must name output location, mutation mode, provider execution rules, and rollback/reporting. |
| GitHub PR comments/checks/Actions | Security/permission policy | Token-bearing GitHub writes and fork/CI behavior need a permission and threat model before source edits. |
| Broader generated tests/browser execution | Test ownership/flakiness policy | Executable generated tests beyond deterministic mocked fixtures need ownership, review, fixture, and browser/CI rules. |
| Full OCaml module resolution | Language semantics/dependency scope | Dune, PPX, aliases, interface matching, and functors require resolver design, not just query captures. |

Recommendation:

- Next selected task is `Task 2 Wiki Mutation / Manual Refresh Policy` readiness.
- The readiness pass should decide whether the next implementation target is:
  - a local CLI/manual refresh mode,
  - a server-side dry-run-only planner,
  - a mutation-capable server endpoint,
  - or explicit deferral.
- No wiki output mutation should be implemented until that readiness packet names the exact write set and stop rules.

### Task 7 Deeper OCaml Semantics - 2026-06-07T17:08+01:00

Readiness outcome:

- The smallest safe second OCaml slice is query/test depth, not dependency upgrades or full module-system resolution.
- Keep OCaml classified as `experimental`.
- Do not upgrade `tree-sitter`, `tree-sitter-ocaml`, or any native grammar dependency in this slice.

Evidence:

| Evidence | Finding | Consequence |
| --- | --- | --- |
| Local `gitnexus/package.json` and `node_modules/tree-sitter-ocaml/package.json` | Installed `tree-sitter-ocaml@0.22.0` peers on `tree-sitter: 0.21`; runtime exports are exactly `ocaml` and `interface` | Keep current dependency route; no package changes |
| `gitnexus/src/core/tree-sitter/parser-loader.ts` | `.ml` uses `tree-sitter-ocaml.ocaml`; `.mli` uses `tree-sitter-ocaml.interface` | Parser-selection V1 is already implemented |
| `gitnexus/src/core/ingestion/languages/ocaml.ts` | Provider has foundational definitions/import-ish open refs/calls, no import resolver, and stubbed type declaration extraction | Deeper slice should stay in query captures and tests |
| `gitnexus/src/core/ingestion/tree-sitter-queries.ts` | Current `OCAML_QUERIES` misses `module_type_definition`, `include_module`, `include_module_type`, and module/functor parameter references | Safe implementation target |
| Local AST probes against `tree-sitter-ocaml@0.22.0` | Grammar exposes `module_type_definition`, `module_type_name`, `module_parameter`, `module_path`, `module_type_path`, `include_module`, `include_module_type`, `functor`, and `functor_type` nodes | Query expansion can be fixture-tested without resolver changes |
| Tree-sitter docs on static node types: https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types | `node-types.json` is generated structured grammar metadata for possible syntax nodes | Local `node-types.json` is valid evidence for query planning |
| `tree-sitter-ocaml` README: https://github.com/tree-sitter/tree-sitter-ocaml | Upstream documents separate implementation, interface, and type grammars; latest release shown as `v0.25.0` on 2026-05-09 | Confirms multi-grammar shape and reinforces not upgrading inside this slice |

Approved implementation slice:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Task 7 OCaml Query Depth V2
Approved slice: expand experimental OCaml query coverage for module type definitions and module/include/functor references only. Add `.ml` and `.mli` fixtures/tests proving captures for module type names, module alias/include references, interface include references, and functor/module-parameter references. Keep OCaml experimental and do not change dependency versions or resolver semantics.
Approved write set:
- gitnexus/src/core/ingestion/tree-sitter-queries.ts
- gitnexus/test/unit/tree-sitter-queries.test.ts
- gitnexus/test/unit/ocaml-language-support.test.ts
- gitnexus/test/integration/tree-sitter-languages.test.ts
- gitnexus/test/fixtures/sample-code/advanced.ml
- gitnexus/test/fixtures/sample-code/advanced.mli
- .agent/long-horizon/gitnexus-local-features/documentation.md
- .agent/long-horizon/gitnexus-local-features/plans.md
- .agent/long-horizon/gitnexus-local-features/feature-map.md
Constraints: no `tree-sitter` or `tree-sitter-ocaml` upgrade, no Dune/project model inference, no PPX expansion, no full module alias/functor resolution, no production classification, no parser-loader/parse-worker changes unless tests prove the current loader regressed, no web UI/MCP/API changes, and TDD required.
```

TDD order:

1. Add failing `.ml` and `.mli` fixture tests for module types, aliases/includes, and functor/module parameters.
2. Add static query-string assertions for the new OCaml capture patterns.
3. Extend `OCAML_QUERIES` minimally.
4. Run focused OCaml/query tests, parser ABI smoke if needed, build, and `git diff --check`.

Implementation checkpoint:

- Added `advanced.ml` and `advanced.mli` fixtures for module type definitions, module aliases, includes, and functor/module parameters.
- Expanded `OCAML_QUERIES` to capture:
  - `module_type_definition` as `definition.interface`,
  - module parameters as import-like references,
  - module type paths as import-like references,
  - module paths, `include_module`, and `include_module_type` as import-like references.
- Updated unit and integration OCaml tests plus static query-string guards.
- TDD red failure was the expected missing `module_type_definition` / reference capture behavior.
- Verification:
  - `npm test -- --run test/unit/ocaml-language-support.test.ts test/unit/tree-sitter-queries.test.ts test/integration/tree-sitter-languages.test.ts`
  - `npm test -- --run test/unit/parser-loader-abi.test.ts test/unit/ocaml-language-support.test.ts test/unit/tree-sitter-queries.test.ts test/integration/tree-sitter-languages.test.ts`
  - `npm run build`
  - Results: focused OCaml/query suite passed 3 files / 138 tests; parser ABI plus OCaml/query suite passed 4 files / 158 tests; build passed with existing web bundle warnings.

Next selected task:

- Post-tranche consolidation and next-slice map refresh.

### Task 6 Additional API-Smoke Route - 2026-06-07T17:00+01:00

Readiness outcome:

- `/api/health` is the next narrow generated API-smoke route candidate.
- It is read-only, repo-independent, auth-free, non-mutating, fast, and has a constant JSON response.
- It can be implemented without live route discovery, index-state assumptions, browser UI execution, CI mutation, GitHub automation, or new dependencies.

Evidence map:

| Route | Contract evidence | Decision |
| --- | --- | --- |
| `/api/health` | `gitnexus/src/server/api.ts` defines it as a lightweight Docker/orchestrator healthcheck returning `{ status: 'ok' }` immediately | `now` |
| `/api/info` | Read-only server info, but response includes runtime-derived `launchContext` and `nodeVersion`; useful later, less minimal than health | `next/defer` |
| `/api/clusters` / `/api/cluster` | Read-only, but graph/index-state dependent and detail route needs a selected name | `defer` |
| `/api/process` | Read-only detail route, but requires a valid process name from graph state | `defer` |
| `/api/grep`, `/api/query`, `/api/search` | Read-only intent varies by query/search mode and can be heavier or state-sensitive | `defer` |
| `/api/analyze`, `/api/reindex`, `/api/embed`, DELETE routes | Mutating, job-triggering, or cancellation surfaces | `out of scope` |

Approved implementation slice:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Task 6 /api/health Generated API-Smoke Route
Approved slice: add deterministic generated API-smoke spec support for route `/api/health` only. The generated spec must use Playwright APIRequestContext, call `/api/health`, assert an OK response, parse JSON, and assert `{ status: "ok" }`.
Approved write set:
- gitnexus/src/core/e2e-test-generation/api-smoke-renderer.ts
- gitnexus/test/unit/e2e-test-generation-api-smoke-renderer.test.ts
- gitnexus/test/fixtures/e2e-test-generation/generated-api-health-smoke.spec.ts
- .agent/long-horizon/gitnexus-local-features/documentation.md
- .agent/long-horizon/gitnexus-local-features/plans.md
- .agent/long-horizon/gitnexus-local-features/feature-map.md
Constraints: no backend route changes, no browser UI generated-spec changes, no live route discovery, no index-state assumptions, no CI mutation, no GitHub automation, no credentials, no new dependency, no broad renderer rewrite, and TDD required.
```

TDD order:

1. Add a failing renderer test and golden fixture for `/api/health`.
2. Extend the API-smoke route allowlist and renderer dispatch for `/api/health`.
3. Keep unsupported-route blocking behavior intact for all other routes.
4. Run focused API-smoke renderer/CLI/report tests, build, and `git diff --check`.

Implementation checkpoint:

- Added `/api/health` generated API-smoke spec support to `api-smoke-renderer.ts`.
- Added `generated-api-health-smoke.spec.ts` golden fixture.
- Updated API-smoke renderer tests for `/api/health` and the unsupported-route allowlist message.
- TDD red failure was the expected allowlist block: `Only /api/processes route proposals have deterministic API-smoke fixtures in V1.`
- Verification:
  - `npm test -- --run test/unit/e2e-test-generation-api-smoke-renderer.test.ts`
  - `npm test -- --run test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-generation-api-smoke-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts`
  - `npm run build`
  - Results: focused renderer test passed, adjacent Task 6 suite passed 4 files / 22 tests, and build passed with existing web bundle warnings.

Next selected task:

- Task 7 Deeper OCaml Semantics readiness.

### Task 6 `/api/file` Generated UI Route Fixture - 2026-06-07T16:55+01:00

Readiness outcome:

- `/api/file` is the next narrow generated UI route fixture candidate.
- It has a real frontend consumer and stable visible UI assertion surface.
- It can be implemented without broadening into live backend execution, CI mutation, or GitHub automation.

Evidence map:

| Route | Frontend consumer | Visible UI surface | Decision |
| --- | --- | --- | --- |
| `/api/file` | `backend-client.readFile()` called by `CodeReferencesPanel` for selected graph/tree nodes | File tree click opens selected-file code panel with file content | `now` |
| `/api/processes` | `fetchProcesses()` exists, but current Processes panel derives rows from `/api/graph` | No current route-to-UI path | Keep in API-smoke lane |
| `/api/process` | Process modal uses Cypher `runQuery()` through `/api/query`, not `fetchProcessDetail()` | No direct route-to-UI path | Defer |
| `/api/clusters` / `/api/cluster` | Client methods exist, but no proven UI call site in current pass | No current route-to-UI path | Defer |
| `/api/query`, `/api/search`, `/api/grep` | Used by AI/search workflows and can require user/model interactions | More complex state/tooling surface | Defer to separate readiness |

Approved implementation slice:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Task 6 /api/file Generated UI Route Fixture
Approved slice: add deterministic generated UI spec support for route `/api/file` only. The generated spec must mock repo/repo-info/graph/file/heartbeat responses, click a file-tree node, and assert visible selected-file code content.
Approved write set:
- gitnexus/src/core/e2e-test-generation/spec-renderer.ts
- gitnexus/test/unit/e2e-test-generation-spec-renderer.test.ts
- gitnexus/test/fixtures/e2e-test-generation/generated-api-file-route.spec.ts
- .agent/long-horizon/gitnexus-local-features/documentation.md
- .agent/long-horizon/gitnexus-local-features/plans.md
- .agent/long-horizon/gitnexus-local-features/feature-map.md
Constraints: no browser execution, no Playwright config changes, no CI mutation, no MCP/API exposure changes, no GitHub automation, no live-backend generated specs, no credentials, no absolute personal paths, no new dependency, no broad renderer rewrite, and TDD required.
```

TDD order:

1. Add a failing renderer test and golden fixture for `/api/file`.
2. Extend the route allowlist and renderer dispatch for `/api/file`.
3. Keep unsupported-route blocking behavior intact for all other routes.
4. Run focused generated-spec renderer/CLI/report tests, build, and `git diff --check`.

Implementation checkpoint:

- Added `/api/file` generated UI spec support to `spec-renderer.ts`.
- Added `generated-api-file-route.spec.ts` golden fixture.
- Updated renderer tests for `/api/file` and the unsupported-route allowlist message.
- Verification so far:
  - `npm test -- --run test/unit/e2e-test-generation-spec-renderer.test.ts`
  - `npm test -- --run test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-generation-api-smoke-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts`
  - `npm run build`
  - `git diff --check`
  - Results: 1 file / 9 tests and 4 files / 21 tests passed; build and diff-check passed.

### Task 4 PR Impact MCP / GitHub Readiness - 2026-06-07T16:39+01:00

Readiness outcome:

- The smallest safe expansion is local MCP exposure of the existing deterministic PR Impact report.
- GitHub PR URL ingestion, PR review/comment posting, check-run creation, GitHub Actions workflow changes, and token-bearing automation remain deferred.

Implemented slice:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Task 4 PR Impact MCP Local Tool
Approved slice: expose the existing local PR Impact pipeline as a read-only, closed-world MCP tool named `pr_impact`, reusing `detect_changes`, `impact`, and `api_impact`. Return versioned PR Impact JSON by default with optional Markdown rendering.
Approved write set:
- gitnexus/src/core/pr-impact/pipeline.ts
- gitnexus/src/cli/pr-impact.ts
- gitnexus/src/mcp/tools.ts
- gitnexus/src/mcp/local/local-backend.ts
- gitnexus/test/unit/pr-impact-pipeline.test.ts
- gitnexus/test/unit/pr-impact-cli.test.ts
- gitnexus/test/unit/tools.test.ts
- gitnexus/test/unit/calltool-dispatch.test.ts
- README.md
- ARCHITECTURE.md
Constraints: no GitHub token, no GitHub PR URL ingestion, no PR comments/reviews, no check runs, no Actions workflow mutation, no repository/file mutation, no new dependency, and TDD required.
```

Source evidence:

| Evidence | Conclusion |
| --- | --- |
| Existing `gitnexus pr-impact` CLI orchestrated `detect_changes`, `impact`, and `api_impact` directly | Extract a shared pipeline instead of duplicating orchestration |
| MCP already exposed `detect_changes`, `impact`, and `api_impact` as read-only local tools | A one-call local `pr_impact` MCP wrapper is a small, coherent expansion |
| MCP ToolAnnotations include read-only and open-world hints | Mark `pr_impact` as read-only, non-destructive, idempotent, and closed-world |
| GitHub review/check APIs require write permissions and/or GitHub App/check permissions | Defer GitHub automation until a dedicated token/permission design exists |
| GitHub Actions secure-use guidance warns about privileged PR-triggered workflows over untrusted content | Defer Actions workflow automation and untrusted PR checkout behavior |

TDD/verification:

```powershell
npm test -- --run test/unit/pr-impact-pipeline.test.ts test/unit/pr-impact-cli.test.ts test/unit/tools.test.ts
npm test -- --run test/unit/pr-impact-pipeline.test.ts test/unit/pr-impact-cli.test.ts test/unit/tools.test.ts test/unit/calltool-dispatch.test.ts
npm test -- --run test/unit/pr-impact-pipeline.test.ts test/unit/pr-impact-cli.test.ts test/unit/tools.test.ts test/unit/calltool-dispatch.test.ts test/unit/server.test.ts
npm run build
git diff --check
```

Results:

- Focused PR Impact/MCP suite passed: 3 files, 27 tests.
- Backend dispatch/server suite passed: 5 files, 119 tests.
- Build passed.
- `git diff --check` passed.

### Task 2 Wiki Mutation / Provider Policy Readiness - 2026-06-07T16:35+01:00

Readiness outcome:

- Full wiki mutation remains deferred.
- The smallest safe next implementation slice is read-only provider-readiness status for `/api/wiki/auto-refresh`.
- The existing server endpoint currently reports `provider-not-wired-through-server` unconditionally. That is safe, but too coarse for agents/users deciding whether a manual refresh could be prepared.
- A provider-readiness helper can inspect non-secret configuration shape and environment presence without invoking the wiki generator, spawning local agent CLIs, writing config, exposing API keys, or mutating wiki output.

Expected vs actual:

| V1 expectation | Current local behavior | Readiness conclusion |
| --- | --- | --- |
| Keep wiki mutation explicit | `WikiGenerator.run()` creates `wiki/`, writes markdown, `meta.json`, `module_tree.json`, HTML viewer, may delete pages in force/incremental paths, and invokes LLM/local CLI providers | Do not wire automatic or server-side mutation in this slice |
| Keep server endpoint read-only | `GET /api/wiki/auto-refresh` only plans status and never calls `runWikiAutoRefresh` or `WikiGenerator` | Preserve this invariant |
| Report graph freshness | Endpoint uses `checkStalenessAsync(entry.path, entry.lastCommit)` | Preserve |
| Report wiki metadata | Endpoint uses `readWikiAutoRefreshMeta(entry.storagePath)` | Preserve |
| Report provider readiness | Endpoint hard-codes `ready: false`, `reason: provider-not-wired-through-server` | Replace with non-secret readiness planning |
| Avoid credential exposure | CLI config can contain `apiKey`, env may contain keys | Provider status must expose only provider/source/reason, never key values or base URLs with credentials |
| Avoid unattended local CLI execution | Local providers can invoke Cursor/Claude/Codex CLIs; Codex uses `codex exec --sandbox read-only` | Do not spawn CLI processes from the status endpoint in this slice |

Proposed write set:

| File | Purpose |
| --- | --- |
| `gitnexus/src/core/wiki/provider-readiness.ts` | Pure provider-readiness policy over CLI config and env shape |
| `gitnexus/src/server/api.ts` | Use the provider-readiness helper in the read-only status endpoint |
| `gitnexus/test/unit/wiki-provider-readiness.test.ts` | Focused readiness policy tests, including no-secret output |
| `gitnexus/test/unit/wiki-auto-refresh-api-wiring.test.ts` | Update wiring assertion away from hard-coded provider-not-wired status |

Out of scope:

- Calling `WikiGenerator`.
- Calling `runWikiAutoRefresh`.
- Creating, deleting, or overwriting wiki output.
- Saving or modifying `~/.gitnexus/config.json`.
- Running Cursor, Claude, or Codex CLI subprocesses from the server endpoint.
- Publishing Gists.
- Adding event-triggered reindex-to-wiki mutation.
- Adding new dependencies.

TDD order:

1. Red test for HTTP provider readiness from saved config or env without leaking key material.
2. Red test for local CLI providers being reported as configured-but-not-server-ready without subprocess detection.
3. Red wiring test that `/api/wiki/auto-refresh` uses the readiness helper and remains read-only.
4. Implement the pure helper and endpoint wiring.
5. Run focused wiki provider/status tests, adjacent wiki auto-refresh tests, build, and `git diff --check`.

Implementation approval boundary:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Task 2 Wiki Provider-Readiness Status
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: keep `/api/wiki/auto-refresh` read-only, but replace its hard-coded provider-not-wired status with a non-secret provider-readiness helper that inspects saved CLI config and environment shape. Do not run providers or mutate output.
Approved write set:
- gitnexus/src/core/wiki/provider-readiness.ts
- gitnexus/src/server/api.ts
- gitnexus/test/unit/wiki-provider-readiness.test.ts
- gitnexus/test/unit/wiki-auto-refresh-api-wiring.test.ts
Constraints: no generated wiki output mutation, no `WikiGenerator` call, no `runWikiAutoRefresh` call, no local agent CLI subprocess from the status endpoint, no config writes, no secrets in response/status, no new dependency, and TDD required.
```

## Historical Feature Task Briefs

The Feature Queue and Next Task Queue above are the authoritative execution controls. The sections below retain previously drafted Goal Contract material as historical task briefs and evidence, not as a mandatory formal Goal Contract system.

### Goal 1 - Auto-Reindexing

Outcome:

- Produce an opt-in, non-hook Auto-Reindexing slice that prevents registered repository indexes from silently going stale by using validated repo registry data, commit-staleness checks, existing reindex queue semantics, dry-run safety, and operation visibility.

Verification surface:

- Focused tests for stale repo selection, fresh repo skip, dry-run no-op, coalescing, invalid registry handling, explicit auto/freshness operation trigger, and watcher failure not blocking sweep recovery.

Constraints:

- No Git hooks as the implementation route.
- No new dependency unless the selected task classifies the dependency change as amber lane with premortem, rollback notes, and focused verification.
- Native file watching may accelerate later, but sweep/staleness must be the correctness mechanism.

Boundaries:

- Use branch `local/gitnexus-local-features`.
- Read from the four-file bundle, `enterprise-feature-intended-functions-scratchpad.md`, local source/tests, official docs, GitHub issues/PRs, Context7, and GitNexus graph queries.
- Likely source ownership is limited to server reindex/freshness surfaces unless the human operator selects a broader write set.
- Use bare `gitnexus` for host graph/source checks and `gitnexus-podman` only for Podman-backed runtime/index checks.

Iteration policy:

- First reconcile expected behavior, current local behavior, dependency shape, and test surface.
- Draft a decision-complete implementation plan before source edits.
- If the selected task stays green/amber, proceed TDD one behavior at a time: red test, minimal green implementation, focused verification, then refactor.
- After each checkpoint, record commands, evidence, files changed, verification, blockers, and next step in `documentation.md`.

Blocked stop condition:

- Stop if the implementation would require hooks, native watcher correctness, public API changes outside the selected task, or red-lane boundaries.
- Report attempted paths, evidence gathered, blocker, and exact human-operator input needed to continue.

### Goal 4 - PR Impact / Blast Radius

Outcome:

- Produce a local report-first PR impact/blast-radius workflow using deterministic diff-to-graph primitives before any GitHub posting, check automation, Codex remediation, or generated tests.

Verification surface:

- Focused tests around `detect_changes`, `impact`, `api_impact`, report formatting, and read-only PR-swarm review references.

Constraints:

- Do not create GitHub comments, checks, or privileged workflow automation until the security and permission model is approved.
- Treat existing PR swarm materials as read-only methodology references.

Boundaries:

- Use existing GitNexus diff/impact primitives, `pr-swarm-review/`, global `gitnexus-pr-review` skill guidance, local tests, GitHub Actions/security docs, and public PR/issue evidence.
- Keep the first implementation candidate local Markdown/JSON report-only unless MAIN later approves GitHub integration.

Iteration policy:

- Reconcile current primitives with desired PR-review behavior, then define report schema, source ownership, and security boundary.
- Do not move to GitHub posting until local report behavior is verified and permission risks are documented.
- After each checkpoint, document evidence and whether the feature remains paused behind Tasks 1-3.

Blocked stop condition:

- Stop if the feature needs fresh graph behavior that Task 1 has not provided, privileged GitHub automation, or an unapproved security model.
- Report missing freshness, schema, permission, or test evidence needed to continue.

### Task 4 Readiness Refresh - PR Impact / Blast Radius

Timestamp: 2026-06-06T11:10+01:00

Readiness outcome:

- V1 should be a local deterministic `pr-impact` report, not a GitHub PR bot.
- Core pipeline remains `diff ranges -> symbols -> impact -> report`.
- Existing GitNexus primitives cover much of the pipeline, but deletion handling, unmatched ranges, report schema, and fixture/golden acceptance need explicit first-class code.
- Source implementation should not start until the current Task 1/Task 2 source WIP has a deliberate snapshot/commit boundary or MAIN records an explicit no-snapshot decision.

Expected vs actual:

| V1 expectation | Current local behavior | Readiness conclusion |
| --- | --- | --- |
| Parse local compare/staged/unstaged diff into file/range evidence | `parseDiffHunks()` parses `git diff -U0` new-side ranges for `detect_changes` | Reuse/extend, but V1 needs richer range records than current new-side-only hunk shape |
| Map changed ranges to graph symbols | `detectChanges()` overlaps parsed hunks with indexed `startLine`/`endLine` and returns `changed_symbols` | Existing logic is useful, but it is private and drops unmatched ranges from the visible result |
| Surface changed ranges with no symbol match | Current `detect_changes` reports only matched symbols and affected processes | V1 must keep unmatched file/range evidence and treat it as `UNKNOWN` or `NEEDS_DISCUSSION` input |
| Handle deleted symbols | `parseDiffHunks()` skips pure-deletion hunks because new-side count is 0 | V1 needs old-side deletion range support and base-graph lookup before it can claim deleted-symbol impact |
| Traverse symbol impact with depth and cycle guard | `impact` uses BFS, visited-set cycle guard, `maxDepth`, per-depth output, summary, pagination, risk, process/module enrichment | Reuse `impact` semantics; V1 report default should request depth 5 and visibly distinguish direct vs transitive callers |
| Add API/route risk where graph evidence exists | `api_impact`, `route_map`, and `shape_check` exist and are tested | V1 should render API sections only when changed symbols/files map to route/API evidence |
| Emit deterministic Markdown/JSON | No `pr-impact` report command or report schema exists | First source slice should add a report builder with experimental `schema_version` and golden tests |
| Approximate test signal conservatively | `impact` can include/exclude test files; no PR test-reference field exists | V1 should add graph-derived `has_test_reference` / `unknown_or_unreferenced`, not true coverage claims |
| Post PR comments/checks | No current V1 support, and this is security-sensitive | Defer to later GitHub automation phase |

Source ownership map:

| Area | Current source/test surface | V1 use |
| --- | --- | --- |
| CLI command registration | `gitnexus/src/cli/index.ts`, `gitnexus/src/cli/tool.ts`, `gitnexus/test/unit/tool-direct-cli.test.ts`, `gitnexus/test/unit/cli-index-help.test.ts` | Add `pr-impact` command only after report core is tested |
| Diff parsing | `gitnexus/src/storage/git.ts`, `gitnexus/test/unit/parse-diff-hunks.test.ts` | Extend or wrap diff parsing for new/old side ranges, deletions, and unmatched range retention |
| Range-to-symbol mapping | `gitnexus/src/mcp/local/local-backend.ts::detectChanges`, `gitnexus/test/unit/detect-changes-worktree.test.ts`, `gitnexus/test/unit/calltool-dispatch.test.ts` | Extract or mirror a focused helper rather than embedding report logic inside `detectChanges()` |
| Impact traversal | `gitnexus/src/mcp/local/local-backend.ts::impact/_runImpactBFS`, `gitnexus/test/unit/impact-confidence.test.ts`, `gitnexus/test/unit/impact-pagination.test.ts` | Reuse through `LocalBackend.callTool('impact')` or a small internal adapter |
| API/route evidence | `route_map`, `shape_check`, `api_impact` in `local-backend.ts`, `gitnexus/test/integration/api-impact-e2e.test.ts`, `gitnexus/test/fixtures/api-impact-seed.ts` | Optional report sections only when graph evidence exists |
| MCP tool schema | `gitnexus/src/mcp/tools.ts`, `gitnexus/test/unit/tools.test.ts` | Keep MCP `pr-impact` out of V1 unless CLI proves useful and MAIN expands scope |
| PR review methods | `pr-swarm-review/`, `C:\Users\steve\.agents\skills\gitnexus-pr-review\SKILL.md` | Read-only methodology/reference material, not automation source |

Smallest safe first implementation slice:

- Add an internal PR Impact report core that accepts deterministic fixture inputs and returns JSON plus Markdown.
- Preserve the V1 fields: `schema_version`, input diff metadata, mapped symbols, unmatched ranges, new/unmapped symbols, deleted symbols, impact summaries, optional API evidence, test-reference approximation, verdict, caveats, and source freshness/status.
- Add a CLI wrapper `gitnexus pr-impact` only after report-core golden tests pass.
- Keep MCP exposure, GitHub PR URL ingestion, GitHub comments/checks, Codex remediation, generated tests, and web UI out of the first slice.

Suggested first write set after snapshot/no-snapshot gate:

| File | Purpose |
| --- | --- |
| `gitnexus/src/core/pr-impact/report.ts` | Deterministic schema, verdict, Markdown/JSON formatting, optional-section rendering |
| `gitnexus/src/core/pr-impact/diff-mapping.ts` | Reusable diff range model and range-to-symbol mapping helper if extraction proves cleaner than expanding `detectChanges()` |
| `gitnexus/src/cli/pr-impact.ts` | Thin CLI orchestration over existing backend tools and report core |
| `gitnexus/src/cli/index.ts` | Register `pr-impact` command |
| `gitnexus/src/cli/help-i18n.ts` and locale files | CLI help text, only if command is registered |
| `gitnexus/test/unit/pr-impact-report.test.ts` | Golden JSON/Markdown, verdict rules, optional sections |
| `gitnexus/test/unit/pr-impact-diff-mapping.test.ts` | Deleted symbols, unmatched ranges, new symbols, range overlap |
| `gitnexus/test/fixtures/pr-impact/*` | Checked-in fixture diffs and golden reports |

Implementation checkpoints:

- 2026-06-06T12:23+01:00: Report core and diff-mapping helper implemented with TDD.
- Implemented files:
  - `gitnexus/src/core/pr-impact/report.ts`
  - `gitnexus/src/core/pr-impact/diff-mapping.ts`
  - `gitnexus/test/unit/pr-impact-report.test.ts`
  - `gitnexus/test/unit/pr-impact-diff-mapping.test.ts`
  - `gitnexus/test/fixtures/pr-impact/golden-basic-report.md`
- Verification passed:
  - focused PR Impact tests: 2 files, 7 tests
  - nearby diff/impact/API baseline: 7 files, 91 tests
  - `git diff --check`
  - `npm run build`
- Commit: `25873c96` (`feat: add pr impact report core`).
- 2026-06-06T12:29+01:00: Thin local `gitnexus pr-impact` CLI wrapper implemented with TDD.
- Implemented files:
  - `gitnexus/src/cli/pr-impact.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/help-i18n.ts`
  - `gitnexus/src/cli/i18n/en.ts`
  - `gitnexus/src/cli/i18n/zh-CN.ts`
  - `gitnexus/test/unit/pr-impact-cli.test.ts`
- Verification passed:
  - initial red test failed because `src/cli/pr-impact.js` did not exist
  - CLI test: 1 file, 2 tests
  - focused CLI/report/help tests: 5 files, 27 tests
  - broader PR Impact/CLI baseline: 10 files, 111 tests
  - `git diff --check`
  - `npm run build`
- MCP exposure, GitHub PR URL ingestion, GitHub comments/checks, token automation, web UI, generated remediation, and generated tests remain out of this V1 slice.

Focused test plan:

1. Red test for report JSON schema including `schema_version`.
2. Red test for deterministic Markdown golden output.
3. Red test for unmatched changed ranges being retained.
4. Red test for pure deletion hunks resolving against base graph evidence or yielding explicit `UNKNOWN`.
5. Red test for new symbols being reported without inbound-caller claims.
6. Red test for optional sections rendering only when evidence exists.
7. Red test for verdict rules: `BLOCK`, `NEEDS_DISCUSSION`, `PROCEED`, `UNKNOWN`.
8. Red test for traversal depth reporting and hop cap behavior.
9. CLI smoke tests only after report core passes.

Risks and stop rules:

- Stop if deletion handling requires a new base-index architecture rather than a small old-side range lookup.
- Stop if the first slice would require GitHub tokens, Actions, comments, checks, PR URL ingestion, or hosted UI.
- Stop if `detect_changes` must be rewritten broadly instead of extracting a narrow helper.
- Stop if source work would begin before the Task 1/Task 2/Task 3 WIP snapshot/no-snapshot boundary is resolved.
- Stop if the report cannot distinguish graph evidence from inference.

Implementation approval boundary to use after readiness:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: PR Impact / Blast Radius
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: local deterministic PR Impact V1 report core plus optional thin `gitnexus pr-impact` CLI wrapper after report-core tests pass. The slice may reuse existing `detect_changes`, `impact`, `api_impact`, `route_map`, and `shape_check` behavior, add fixture/golden Markdown and JSON tests, and add internal helpers for diff range mapping, unmatched ranges, deleted symbols, new/unmapped symbols, test-reference approximation, optional sections, and deterministic verdicts.
Approved write set:
- gitnexus/src/core/pr-impact/report.ts
- gitnexus/src/core/pr-impact/diff-mapping.ts if needed
- gitnexus/src/cli/pr-impact.ts
- gitnexus/src/cli/index.ts
- gitnexus/src/cli/help-i18n.ts and locale files only if CLI help is registered
- gitnexus/test/unit/pr-impact-report.test.ts
- gitnexus/test/unit/pr-impact-diff-mapping.test.ts
- gitnexus/test/fixtures/pr-impact/*
Constraints: no GitHub PR comments/checks, no GitHub token automation, no MCP tool exposure in V1, no web UI, no generated tests/remediation, no new dependency without approval, no broad rewrite of `detect_changes`, and TDD required.
Prerequisite: resolve the current WIP snapshot/no-snapshot boundary before source edits.
```

### Goal 2 - Auto-Updating Code Wiki

Outcome:

- Produce a decision-complete Task 2 Auto-Updating Code Wiki readiness plan, then later implement a refresh workflow around the existing Code Wiki generator only after graph freshness, LLM/provider policy, and MAIN approval are explicit.

Verification surface:

- A documented expected-vs-actual table, source ownership map, dependency map from Task 1 freshness, provider/cost/publication policy questions, smallest safe implementation slice, focused TDD plan, risks/stop rules, and refreshed focused wiki baseline tests where useful.
- Existing focused wiki tests for flags, grouping, Mermaid sanitization, LLM client behavior, and any future refresh orchestration tests remain the implementation verification surface once MAIN opens source work.

Constraints:

- Do not rebuild the wiki generator from scratch.
- Do not run unattended LLM generation without explicit provider, cost, and publication policy.
- Do not edit source during the readiness Goal.
- Do not publish, overwrite, or regenerate user-facing wiki artifacts during readiness unless MAIN explicitly asks.

Boundaries:

- Use existing wiki generator/source, wiki tests, provider/LLM config surfaces, freshness/reindex evidence, and documentation output behavior.
- Keep first work to refresh orchestration and status visibility after graph freshness exists.
- Use the four-file bundle, `enterprise-feature-intended-functions-scratchpad.md`, local wiki source/tests, GitNexus graph queries, public GitNexus README/issues/PRs, and official/Codex docs when relevant.

Iteration policy:

- Confirm generator capability, then define trigger policy, skip behavior, provider readiness checks, and output/operation visibility.
- Re-check dependency on Auto-Reindexing before any implementation plan.
- After each checkpoint, record provider/cost/publication assumptions and unresolved approvals.
- First complete safe precursor tasks: review current WIP boundary, inspect wiki source/tests, refresh the evidence table, and draft the Task 2 approval boundary.
- If evidence shows the feature cannot be safely sequenced after Task 1, record the blocker and do not force implementation.

Blocked stop condition:

- Stop if freshness is not available, LLM/provider policy is missing, publication/cost behavior is ambiguous, user-facing output mutation would be required for research, or MAIN has not approved source writes.
- Report the exact policy or dependency needed to continue.

### Goal 5 - Auto Regression Forensics

Outcome:

- Produce a local report-first regression-forensics readiness map that can explain a failing test/CI signal by combining known-good/known-bad refs, failure evidence, PR Impact V1 report data, and GitNexus graph context.

Verification surface:

- Evidence notes from local `eval/` infrastructure, PR Impact V1 source/tests, CI artifact/report surfaces, existing regression/golden/benchmark tests, and public regression/failure-localization references.
- A documented expected-vs-actual table, failure-evidence contract, source ownership map, smallest safe first slice, focused TDD plan, risks, stop rules, and implementation approval boundary.

Constraints:

- Research-only for now.
- Do not run or design GitHub token automation, PR comments/checks, generated fixes, automatic bisect execution, or CI workflow mutation in the first slice.
- Do not claim true root cause; V1 should report graph-backed candidate causes and confidence/caveats.

Boundaries:

- Use local `eval/`, PR Impact report/CLI files, test/CI artifacts, Git history/bisect references, graph impact evidence, and public regression-forensics/failure-localization analogues.
- Keep this Goal to planning/documentation. Later implementation should start with a pure report core before CLI/MCP/GitHub integration.

Iteration policy:

- Identify required failure evidence first, then map dependencies on PR Impact reports, CI/test data, and graph freshness.
- Prefer a deterministic fixture-backed report core over live CI/GitHub integration.
- Produce a `now`/`next`/`defer` verdict with the smallest implementation slice and explicit approval gate.

Blocked stop condition:

- Stop if no failing-test/known-good/known-bad evidence contract can be defined, if graph freshness cannot be established, or if the first slice would require privileged GitHub/CI automation.
- Report the missing evidence model or dependency that would unlock progress.

### Task 5 Readiness Refresh - Auto Regression Forensics

Timestamp: 2026-06-06T12:49+01:00

Readiness outcome:

- V1 should be a local deterministic report, not an automated CI bot or fix generator.
- Core pipeline should be: `failure evidence -> changed symbols / PR Impact report -> graph candidate causes -> forensic report`.
- Existing GitNexus evidence supports report-building inputs: PR Impact V1 schema, eval harness result artifacts, CI test-report artifacts, and many regression/golden/benchmark tests.
- No dedicated auto-regression-forensics feature surface exists locally yet.

Expected vs actual:

| V1 expectation | Current local behavior | Readiness conclusion |
| --- | --- | --- |
| Accept failing evidence | CI uploads `test-results.json`, web test results, and coverage artifacts; eval harness stores summaries, predictions, trajectories, and optional SWE-bench result JSON | V1 should accept fixture-shaped failure evidence and report missing fields explicitly |
| Tie failure to changed code | PR Impact V1 emits mapped symbols, impacts, API impacts, verdict, test signal, and caveats | Reuse PR Impact report data as the first graph/risk input |
| Compare known-good and known-bad | Git history exists, but no product-level known-good/known-bad contract is implemented | V1 should model refs as input metadata; do not run automatic bisect in first slice |
| Explain likely causes | Local graph can provide impact, callers, routes, and test references | V1 should produce candidate causes with confidence/caveats, not true root-cause claims |
| Use eval infrastructure | `eval/` measures agent performance and tool use over SWE-bench | Useful evidence source, but not the product workflow itself |
| Publish CI/PR output | CI report and autofix workflows already handle privileged GitHub posting separately | Defer all GitHub comments/checks/token automation |

Failure-evidence contract for V1:

| Field | Required | Meaning |
| --- | --- | --- |
| `schema_version` | yes | Experimental schema, suggested `regression-forensics.v1alpha1` |
| `failure_command` | yes | Command that failed, such as `npm test -- ...` |
| `exit_code` | yes | Numeric exit code or `unknown` when imported from incomplete CI evidence |
| `failing_tests` | yes | Stable names/paths of failing tests, empty only when failure is non-test infrastructure |
| `failure_excerpt` | yes | Bounded stderr/stdout excerpt or artifact excerpt |
| `environment` | yes | Local/CI label, OS if known, and relevant runtime versions if known |
| `known_good_ref` / `known_bad_ref` | optional | Git refs when available; absence lowers confidence |
| `pr_impact_report` | yes for first implementation | Existing PR Impact V1 JSON or fixture-equivalent input |

Source ownership map:

| Area | Current source/test surface | V1 use |
| --- | --- | --- |
| Report schema/format | `gitnexus/src/core/pr-impact/report.ts`, `gitnexus/test/unit/pr-impact-report.test.ts` | Mirror deterministic report-core pattern for regression forensics |
| Failure artifacts | `.github/workflows/ci-tests.yml`, `.github/workflows/ci-report.yml`, `eval/analysis/analyze_results.py` | Treat as input-shape evidence, not live CI integration |
| Eval traces | `eval/run_eval.py`, `eval/agents/gitnexus_agent.py`, `eval/README.md` | Inform optional future trace import; not required in first slice |
| Graph context | existing `impact`, `detect_changes`, `api_impact`, and PR Impact V1 output | Use PR Impact report as the stable graph boundary |
| Regression tests | golden/parity/benchmark/regression tests under `gitnexus/test` | Provide fixture style and likely validation examples |

Smallest safe first implementation slice:

- Add a pure core report builder for regression forensics that accepts deterministic fixture inputs and returns JSON plus Markdown.
- Include `schema_version`, failure command/exit/test evidence, known-good/known-bad metadata, linked PR Impact summary, candidate causes, confidence, caveats, and recommendation.
- Keep CLI, MCP, GitHub Actions, PR comments/checks, automatic bisect, live test execution, and generated remediation out of the first slice.

Suggested first write set after this readiness Goal:

| File | Purpose |
| --- | --- |
| `gitnexus/src/core/regression-forensics/report.ts` | Deterministic schema, confidence, Markdown/JSON formatting, caveats |
| `gitnexus/test/unit/regression-forensics-report.test.ts` | Golden JSON/Markdown, failure evidence, missing known-good, confidence/caveats |
| `gitnexus/test/fixtures/regression-forensics/golden-basic-report.md` | Checked-in expected Markdown |

Focused test plan:

1. Red test for JSON schema including `schema_version`.
2. Red test for deterministic Markdown golden output.
3. Red test for failing test names and failure excerpts being retained.
4. Red test for PR Impact `BLOCK`/`NEEDS_DISCUSSION` evidence increasing confidence.
5. Red test for missing known-good ref lowering confidence but not failing report creation.
6. Red test that recommendations avoid claiming root cause when evidence is incomplete.

Implementation checkpoint:

- 2026-06-06T13:02+01:00: Report core implemented with TDD.
- Implemented files:
  - `gitnexus/src/core/regression-forensics/report.ts`
  - `gitnexus/test/unit/regression-forensics-report.test.ts`
  - `gitnexus/test/fixtures/regression-forensics/golden-basic-report.md`
- Verification passed:
  - initial red test failed because `src/core/regression-forensics/report.js` did not exist
  - focused Regression Forensics tests: 1 file, 3 tests
  - adjacent Regression Forensics + PR Impact report tests: 3 files, 10 tests
  - `git diff --check`
  - `npm run build`
- CLI, MCP, GitHub/CI automation, automatic bisect, live test execution, and remediation remain out of this V1 slice.

Risks and stop rules:

- Stop if the first slice requires live CI artifact download, GitHub tokens, PR comments/checks, or workflow mutation.
- Stop if report inputs cannot distinguish observed failure evidence from inference.
- Stop if graph freshness is stale and the report would make causal claims.
- Stop if implementation would broaden into automatic bisect or remediation generation.

Implementation approval boundary to use after readiness:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Auto Regression Forensics
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: local deterministic Regression Forensics V1 report core only. The slice may consume fixture-shaped failure evidence and PR Impact V1 report data, produce experimental JSON/Markdown with schema `regression-forensics.v1alpha1`, candidate causes, confidence, caveats, and recommendation.
Approved write set:
- gitnexus/src/core/regression-forensics/report.ts
- gitnexus/test/unit/regression-forensics-report.test.ts
- gitnexus/test/fixtures/regression-forensics/golden-basic-report.md
Constraints: no CLI/MCP exposure in the first source slice, no GitHub PR comments/checks, no token automation, no CI workflow mutation, no automatic bisect, no live test execution, no generated fixes/remediation, no new dependency, and TDD required.
```

Post-core boundary checkpoint:

- 2026-06-06T13:05+01:00: After report-core commit `dcc5fd24`, the next defensible Task 5 Goal is a thin local CLI wrapper, not richer parsing or Task 6 yet.
- Rationale:
  - The report core is pure and useful but not user-accessible.
  - A CLI wrapper can stay bounded by reading two local JSON files and rendering Markdown/JSON.
  - No live CI, GitHub, token, test execution, bisect, MCP, or remediation behavior is required.
- Recommended command name: `regression-forensics`.
- V1 CLI input model:
  - `--failure-json <path>`: local JSON matching `RegressionForensicsFailureInput` plus optional `knownGoodRef` / `knownBadRef`.
  - `--pr-impact-json <path>`: local JSON produced by `gitnexus pr-impact --format json` or a fixture-equivalent PR Impact V1 report.
  - `--format <format>`: `markdown` or `json`, default `markdown`.
- CLI should not infer, execute, fetch, or mutate anything. It only loads files, builds the report, and writes stdout.

CLI implementation checkpoint:

- 2026-06-06T13:08+01:00: Thin local `gitnexus regression-forensics` CLI wrapper implemented with TDD.
- Implemented files:
  - `gitnexus/src/cli/regression-forensics.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/help-i18n.ts`
  - `gitnexus/src/cli/i18n/en.ts`
  - `gitnexus/src/cli/i18n/zh-CN.ts`
  - `gitnexus/test/unit/regression-forensics-cli.test.ts`
- Implemented behavior:
  - `gitnexus regression-forensics --failure-json <path> --pr-impact-json <path>`
  - `--format markdown|json`, default `markdown`
  - local JSON input only
  - optional `knownGoodRef` / `knownBadRef` pass-through from failure JSON
- Verification passed:
  - initial red test failed because `src/cli/regression-forensics.js` did not exist
  - focused CLI test: 1 file, 2 tests
  - combined CLI/report/help tests: 5 files, 24 tests
  - `git diff --check`
  - `npm run build`
- MCP exposure, GitHub PR comments/checks, token automation, CI workflow mutation, automatic bisect, live test execution, generated remediation, and new dependencies remain out of this V1 slice.
- Next baton target after commit/Goal completion: Task 6 End-to-End Test Generation readiness.

Implementation approval boundary used for the CLI Goal:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Auto Regression Forensics
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: thin local `gitnexus regression-forensics` CLI wrapper over the committed report core. The wrapper may read local failure-evidence JSON and local PR Impact V1 JSON, produce Markdown or JSON, and register localized CLI help.
Approved write set:
- gitnexus/src/cli/regression-forensics.ts
- gitnexus/src/cli/index.ts
- gitnexus/src/cli/help-i18n.ts
- gitnexus/src/cli/i18n/en.ts
- gitnexus/src/cli/i18n/zh-CN.ts
- gitnexus/test/unit/regression-forensics-cli.test.ts
- long-horizon documentation updates needed for checkpointing
Constraints: no MCP exposure, no GitHub PR comments/checks, no token automation, no CI workflow mutation, no automatic bisect, no live test execution, no generated fixes/remediation, no new dependency, no broad rewrite of report core, and TDD required.
```

### Goal 6 - End-to-End Test Generation

Outcome:

- Scope a future E2E test-generation workflow that can propose or create tests from routes, execution flows, changed surfaces, and an explicit test framework/runtime contract.

Verification surface:

- Evidence from existing E2E tests, route/tool maps, browser/test-framework docs, and PR/regression report dependencies.

Constraints:

- Research-only for now.
- Do not generate tests without an approved target app, framework, and execution environment.

Boundaries:

- Use existing E2E tests, route maps, execution-flow evidence, browser/test-framework docs, and safety constraints around secrets, preview URLs, and generated tests.
- Keep this goal to scoping until MAIN names a target app and test framework.

Iteration policy:

- First identify the launch surface and target framework, then define fixture, sandbox, and verification requirements.
- Map dependencies on PR/blast-radius reports and regression-forensics evidence before proposing implementation.

Blocked stop condition:

- Stop if there is no approved app launch surface, target framework, runtime, fixture policy, or secrets/sandbox policy.
- Report the exact runtime/test contract needed before generation is defensible.

### Task 6 Readiness Refresh - End-to-End Test Generation

Timestamp: 2026-06-06T13:28+01:00

Readiness outcome:

- Task 6 should not start by writing executable generated Playwright tests.
- The first defensible local slice is an E2E test proposal/report core that maps changed/risky surfaces to recommended Playwright scenarios and evidence, without writing test files or running browsers.
- GitNexus already has a real Playwright web E2E lane, so the preferred local target contract is `gitnexus-web` + Playwright Chromium + local backend/frontend servers + the existing CI fixture repo.
- Actual generated test-file creation should remain a later phase behind explicit output-policy approval.

Evidence inspected:

| Evidence | Finding |
| --- | --- |
| `README.md` enterprise/upcoming list | End-to-end test generation is named as an upcoming capability, not an existing OSS feature surface. |
| `gitnexus-web/package.json` | Web package already depends on `@playwright/test` and has `test:e2e`, `test:e2e:ui`, and `test:e2e:report` scripts. |
| `gitnexus-web/playwright.config.ts` | Existing E2E config uses `testDir: ./e2e`, Chromium, `baseURL: http://localhost:5173`, retained traces/screenshots/videos on failure, list + HTML reporters, and skips manual/debug specs by default. |
| `.github/workflows/ci-e2e.yml` | CI builds backend, creates/indexes a mini fixture repo, starts backend on `4747`, starts Vite on `5173`, runs `npx playwright test`, and uploads test artifacts. |
| `gitnexus-web/e2e/*.spec.ts` | Existing specs use availability checks, `E2E=1` CI forcing, role/test-id locators, indexed repo assumptions, and manual recording outside default runs. |
| `gitnexus/src/core/pr-impact/report.ts` | PR Impact V1 provides changed files/symbols, unmatched/deleted/new surfaces, verdict, graph freshness, API impact, and conservative test signal. |
| `gitnexus/src/core/regression-forensics/report.ts` | Regression Forensics V1 provides failure evidence, PR Impact linkage, candidate causes, confidence, caveats, and recommendation. |
| `gitnexus/src/mcp/tools.ts` / `local-backend.ts` | `route_map`, `api_impact`, `shape_check`, `impact`, and `detect_changes` provide route/API/process evidence that can inform candidate E2E scenarios. |
| Context7 `/microsoft/playwright.dev` docs | Playwright supports codegen/recording, role/text/test-id locator heuristics, config web servers/baseURL/projects, and trace/report artifacts; generated tests still need app launch, stable data, locators, and assertions. |

Expected vs actual:

| V1 expectation | Current local behavior | Readiness conclusion |
| --- | --- | --- |
| Know target app and framework | `gitnexus-web` has Playwright E2E tests and CI support | Use this as the first approved target; do not introduce Cypress or another framework |
| Launch app reliably | CI starts backend and Vite separately after indexing a mini repo | V1 should reference this contract, not invent a new runner |
| Identify changed/risky surfaces | PR Impact V1 and route/API tools expose graph-backed risk evidence | Use PR Impact/route evidence as input to proposal ranking |
| Know existing E2E coverage | E2E spec files exist, but no machine-readable scenario inventory exists | V1 proposal core should accept fixture-shaped existing-spec inventory and report gaps |
| Generate executable tests | No generator command/source exists; Playwright codegen is interactive/manual | Defer executable-file generation; first slice outputs proposals only |
| Verify generated tests | Existing CI can run Playwright, but readiness cannot mutate CI or run live generation | Later implementation must require red-green tests for deterministic proposal logic before any browser run |
| Handle secrets/sandbox | Current CI fixture avoids secrets and external SaaS | Keep first slice local and fixture-only |

Target contract for the first local track:

| Contract field | Decision |
| --- | --- |
| App/package | `gitnexus-web` |
| Framework | Playwright via existing `@playwright/test` |
| Browser | Chromium first, matching CI |
| Backend | `gitnexus serve` on `http://localhost:4747` |
| Frontend | Vite dev server on `http://localhost:5173` |
| Data | Existing indexed mini fixture repo pattern from `ci-e2e.yml` |
| Output | Deterministic Markdown/JSON proposal report |
| Mutation | No generated test files in first slice |
| Verification | Unit/golden tests over deterministic proposal inputs |

Source ownership map:

| Area | Candidate surface | V1 use |
| --- | --- | --- |
| Proposal schema/report | New `gitnexus/src/core/e2e-test-generation/report.ts` | Deterministic candidate scenarios, coverage gaps, caveats, and next actions |
| Proposal tests | New `gitnexus/test/unit/e2e-test-generation-report.test.ts` and fixture Markdown | Golden JSON/Markdown and ranking rules |
| PR/change evidence | `gitnexus/src/core/pr-impact/report.ts` | Input schema for risky changed surfaces |
| Regression evidence | `gitnexus/src/core/regression-forensics/report.ts` | Optional failure-linked context for prioritization |
| Route/API evidence | `route_map`, `api_impact`, `shape_check`, `impact` | Later adapters; first core may consume fixture-shaped route evidence |
| Existing E2E inventory | `gitnexus-web/e2e/*.spec.ts`, `gitnexus-web/playwright.config.ts` | Evidence/source for future inventory extraction; first slice can accept deterministic inventory input |
| CLI wrapper | Later optional `gitnexus e2e-test-plan` | Do not add until report core proves useful |

Smallest safe first implementation slice:

- Add a pure deterministic E2E test proposal/report core.
- Inputs:
  - PR Impact V1 report data,
  - optional Regression Forensics V1 report data,
  - fixture-shaped route/API evidence,
  - fixture-shaped existing E2E scenario inventory,
  - target contract metadata for `gitnexus-web`/Playwright.
- Outputs:
  - experimental schema such as `e2e-test-plan.v1alpha1`,
  - proposed scenarios,
  - target spec area,
  - reason/evidence,
  - whether an existing E2E spec appears to cover the surface,
  - caveats and next action.
- Keep executable Playwright file generation, codegen automation, browser execution, CI mutation, GitHub comments/checks, MCP exposure, and new dependencies out of this slice.

Focused TDD plan for the proposed first slice:

1. Red test for JSON schema including `schema_version`.
2. Red test for deterministic Markdown golden output.
3. Red test that high-risk PR Impact route/API evidence ranks above low-risk surfaces.
4. Red test that existing E2E inventory marks a proposal as `covered_by_existing_spec` instead of creating duplicate work.
5. Red test that missing route/test inventory lowers confidence and adds caveats.
6. Red test that the report never emits executable test code in V1.

Risks and stop rules:

- Stop if implementation would write generated test files.
- Stop if implementation would add Playwright/Cypress dependencies outside existing `gitnexus-web`.
- Stop if implementation would mutate CI, GitHub workflows, tokens, secrets, external SaaS, or preview environments.
- Stop if no deterministic target contract is present in input data.
- Stop if the proposal cannot distinguish graph evidence from inference.

Implementation approval boundary used for the report-core Goal:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: End-to-End Test Generation
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: local deterministic E2E test proposal/report core only. The slice may consume fixture-shaped PR Impact V1 data, optional Regression Forensics V1 data, route/API evidence, existing E2E inventory, and target contract metadata for gitnexus-web/Playwright. It may produce experimental JSON/Markdown with schema `e2e-test-plan.v1alpha1`, proposed scenarios, evidence, caveats, and next actions.
Approved write set:
- gitnexus/src/core/e2e-test-generation/report.ts
- gitnexus/test/unit/e2e-test-generation-report.test.ts
- gitnexus/test/fixtures/e2e-test-generation/golden-basic-report.md
- long-horizon documentation updates needed for checkpointing
Constraints: no generated executable test files, no browser execution, no CLI/MCP exposure in the first source slice, no GitHub PR comments/checks, no token automation, no CI workflow mutation, no new dependency, no changes to `gitnexus-web/e2e`, and TDD required.
```

Implementation checkpoint:

- 2026-06-06T13:31+01:00: E2E test proposal/report core implemented with TDD.
- Implemented files:
  - `gitnexus/src/core/e2e-test-generation/report.ts`
  - `gitnexus/test/unit/e2e-test-generation-report.test.ts`
  - `gitnexus/test/fixtures/e2e-test-generation/golden-basic-report.md`
- Implemented behavior:
  - experimental schema `e2e-test-plan.v1alpha1`
  - deterministic JSON/Markdown report
  - target contract metadata for `gitnexus-web`/Playwright
  - PR Impact and optional Regression Forensics source linkage
  - route/API and changed-surface proposal ranking
  - existing-spec coverage status
  - caveats and explicit no-executable-code boundary
- Verification passed:
  - initial red test failed because `src/core/e2e-test-generation/report.js` did not exist
  - focused report tests: 1 file, 3 tests
  - adjacent E2E/Regression/PR report tests: 4 files, 13 tests
  - `git diff --check`
  - `npm run build`
- Generated Playwright spec files, browser execution, CLI/MCP exposure, GitHub automation, CI workflow mutation, and `gitnexus-web/e2e` changes remain out of scope.
- Next baton target after commit/Goal completion: Task 6 post-core boundary review.

Post-core boundary checkpoint:

- 2026-06-06T13:34+01:00: After report-core commit `6f4e278a`, the next defensible Task 6 Goal is a thin local CLI wrapper, not existing-spec inventory extraction or generated executable test files.
- Rationale:
  - The report core is pure and useful but not user-accessible.
  - A CLI wrapper can stay bounded by reading local JSON files and rendering Markdown/JSON.
  - It follows the established `pr-impact` and `regression-forensics` wrapper pattern.
  - Automatic existing-spec inventory extraction needs separate parsing heuristics.
  - Generated executable test files need output policy, flake strategy, and review rules.
- Recommended command name: `e2e-test-plan`.
- V1 CLI input model:
  - `--target-json <path>`: local JSON matching the target contract.
  - `--pr-impact-json <path>`: local PR Impact V1 JSON.
  - `--existing-scenarios-json <path>`: local JSON array of existing E2E scenario inventory.
  - `--route-evidence-json <path>`: local JSON array of route/API evidence.
  - `--regression-forensics-json <path>`: optional local Regression Forensics V1 JSON.
  - `--format <format>`: `markdown` or `json`, default `markdown`.
- CLI should not infer, execute, fetch, parse specs, generate files, or mutate anything. It only loads files, builds the report, and writes stdout.

CLI implementation checkpoint:

- 2026-06-06T13:37+01:00: Thin local `gitnexus e2e-test-plan` CLI wrapper implemented with TDD.
- Implemented files:
  - `gitnexus/src/cli/e2e-test-plan.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/help-i18n.ts`
  - `gitnexus/src/cli/i18n/en.ts`
  - `gitnexus/src/cli/i18n/zh-CN.ts`
  - `gitnexus/test/unit/e2e-test-plan-cli.test.ts`
- Implemented behavior:
  - `gitnexus e2e-test-plan --target-json <path> --pr-impact-json <path> --existing-scenarios-json <path> --route-evidence-json <path>`
  - optional `--regression-forensics-json <path>`
  - `--format markdown|json`, default `markdown`
  - local JSON input only
- Verification passed:
  - initial red test failed because `src/cli/e2e-test-plan.js` did not exist
  - focused CLI tests: 1 file, 2 tests
  - combined CLI/report/help tests: 6 files, 27 tests
  - `git diff --check`
  - `npm run build`
- Generated Playwright spec files, browser execution, automatic spec parsing/inventory extraction, MCP exposure, GitHub automation, CI workflow mutation, `gitnexus-web/e2e` changes, and new dependencies remain out of scope.
- Next baton target after commit/Goal completion: Task 6 post-CLI boundary review.

Post-CLI boundary checkpoint:

- 2026-06-06T13:40+01:00: After CLI commit `8b2e26dc`, Task 6 local V1 is complete enough to pause.
- Completed local V1:
  - deterministic `e2e-test-plan.v1alpha1` report core,
  - thin local `gitnexus e2e-test-plan` CLI wrapper.
- Deferred Task 6 work:
  - generated executable Playwright files,
  - browser execution,
  - automatic existing-spec inventory parsing,
  - MCP/API exposure,
  - GitHub comments/checks,
  - CI workflow mutation,
  - `gitnexus-web/e2e` changes.
- Rationale:
  - Continuing Task 6 now would require generated-output ownership/review rules, flake strategy, browser execution policy, and CI/GitHub boundaries.
  - Task 7 is the final candidate feature and should be readiness-mapped before reopening deeper Task 6 policy work.
- Next baton target: Task 7 OCaml Support readiness/research only.

Implementation approval boundary used for the CLI Goal:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: End-to-End Test Generation
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: thin local `gitnexus e2e-test-plan` CLI wrapper over the committed report core. The wrapper may read local target-contract JSON, PR Impact V1 JSON, existing-scenarios JSON, route-evidence JSON, optional Regression Forensics V1 JSON, produce Markdown or JSON, and register localized CLI help.
Approved write set:
- gitnexus/src/cli/e2e-test-plan.ts
- gitnexus/src/cli/index.ts
- gitnexus/src/cli/help-i18n.ts
- gitnexus/src/cli/i18n/en.ts
- gitnexus/src/cli/i18n/zh-CN.ts
- gitnexus/test/unit/e2e-test-plan-cli.test.ts
- long-horizon documentation updates needed for checkpointing
Constraints: no generated executable test files, no browser execution, no MCP exposure, no GitHub PR comments/checks, no token automation, no CI workflow mutation, no new dependency, no `gitnexus-web/e2e` changes, no automatic spec parsing/inventory extraction, no broad rewrite of report core, and TDD required.
```

### Goal 3 - Multi-Repo Support Improvements

Outcome:

- Reconcile current multi-repo/group support with stale docs/tool tables and identify the smallest useful improvement to group/status/contract ergonomics.

Verification surface:

- Local source, `ARCHITECTURE.md`, group tests, group resources, and graph queries using `--repo gitnexus-local-features` when needed.

Constraints:

- Do not assume a new unified cross-repo graph project unless the human operator explicitly selects that red/major-architecture scope.
- Do not plan from stale `group_query`, `group_contracts`, or `group_status` tool tables.

Boundaries:

- Use current group source/tests, `ARCHITECTURE.md`, MCP resources, CLI group commands, host graph queries, and stale docs/tool tables as reconciliation evidence.
- Keep likely work to docs/API-surface reconciliation or group/status ergonomics unless the human operator selects broader scope.

Iteration policy:

- Separate current source truth from stale public/internal tables, then identify the smallest concrete improvement.
- Prefer correcting guidance and ergonomics before proposing large architecture changes.

Blocked stop condition:

- Stop if the desired improvement requires a unified cross-repo graph, broad API redesign, or source behavior change not approved by MAIN.
- Report the specific stale surface, current source truth, and approval needed.

### Goal 7 - OCaml Support

Outcome:

- Scope OCaml as a language-provider/parser onboarding project rather than a minor config toggle.

Verification surface:

- Local language registry/source, parser availability evidence, provider patterns, fixture expectations, and migration/parity tests.

Constraints:

- Research-only for now.
- Do not add parser dependencies or language-provider source without MAIN approval.

Boundaries:

- Use local language registry/source, existing language-provider patterns, parser availability evidence, fixture/test expectations, and dependency policy.
- Keep this goal separate from Auto-Reindexing, PR Review, and Wiki implementation work.

Iteration policy:

- Map parser/provider/source gaps first, then estimate fixture, query, resolver, and parity-test burden.
- Produce a defer/next verdict and implementation prerequisites rather than adding dependencies or source code.

Blocked stop condition:

- Stop if parser dependency, provider scope, fixture burden, or parity requirements are unclear or unapproved.
- Report the dependency and language-onboarding approvals needed to continue.

### Task 7 Readiness Result - OCaml Support

Timestamp: 2026-06-06T13:41+01:00

Readiness outcome:

- OCaml support is feasible in principle because the public `tree-sitter-ocaml` grammar exists and exposes separate implementation, interface, and type grammars.
- OCaml support is not a small config toggle. It is a full GitNexus language-onboarding project affecting shared language identity, extension detection, parser loading, parse-worker grammar dispatch, provider registration, query/capture design, import/module handling, type/call extraction, fixtures, and parity tests.
- Source implementation should not start until MAIN approves adding or vendoring `tree-sitter-ocaml` and the exact write set.

Expected vs actual:

| Area | Expected for OCaml support | Actual local state |
| --- | --- | --- |
| Shared language identity | `SupportedLanguages.OCaml` exists and is shared across CLI/web/type surfaces | `gitnexus-shared/src/languages.ts` has no OCaml enum member |
| Extension detection | `.ml` and `.mli` map to OCaml; syntax highlighting has a stable identifier | `gitnexus-shared/src/language-detection.ts` has no OCaml extension or syntax map entry |
| Provider registry | `ocamlProvider` is registered in the exhaustive provider table | `gitnexus/src/core/ingestion/languages/index.ts` has no OCaml provider |
| Parser loader | Native grammar source loads the right grammar for `.ml` and `.mli` | `parser-loader.ts` has no OCaml `SOURCES` row; parse worker has no OCaml grammar import/dispatch |
| Queries and extraction | OCaml definitions, imports/modules, calls, types, and ownership are captured with tests | `tree-sitter-queries.ts` has no OCaml query set; no OCaml-specific type/import/call configs exist |
| Fixtures/tests | Representative `.ml`/`.mli` fixtures prove graph shape and capture behavior | No OCaml fixtures, parser smoke cases, query tests, or scope-resolution tests exist |

External parser evidence:

| Source | Evidence | Planning consequence |
| --- | --- | --- |
| https://github.com/tree-sitter/tree-sitter-ocaml | Official tree-sitter grammar repository; README says it defines grammars for implementations (`.ml`), interfaces (`.mli`), and types; latest GitHub release shown as `v0.25.0` on 2026-05-09; license MIT | Feasible parser source exists, but GitNexus must handle at least `.ml` and `.mli` grammar selection |
| https://raw.githubusercontent.com/tree-sitter/tree-sitter-ocaml/master/package.json | Current package metadata names `tree-sitter-ocaml` `0.25.0`, `type: "module"`, `main: "bindings/node"`, MIT license, peer `tree-sitter` `^0.25.0` on master | Native package may not match GitNexus's current `tree-sitter` runtime; compatibility must be tested before dependency approval |
| `npm view tree-sitter-ocaml version license peerDependencies dependencies dist-tags --json` | npm latest is `0.24.2`, MIT, peer `tree-sitter` `^0.22.4`, deps `node-addon-api` and `node-gyp-build` | npm package is viable-looking but still a dependency addition with native binding/ABI risk |
| https://pypi.org/project/tree-sitter-ocaml/0.24.1/ | Python package also documents separate implementation/interface/type grammars and MIT metadata | Corroborates grammar shape; not a direct Node dependency choice |
| https://github.com/abhigyanpatwari/GitNexus/pull/305 | Zig language-support PR shows first-class language support touched CLI/web parity, grammar provenance, query capture parity, syntax highlighting, type extraction, resolver plumbing, and focused coverage | OCaml acceptance must include graph correctness and parity tests, not only parser load |
| https://github.com/abhigyanpatwari/GitNexus/pull/317 | Scala language-support review found parser/registry wiring insufficient without type extraction, import resolution, member CALLS, and language-specific tests | OCaml should not be accepted with only enum/provider/parser wiring |

Source ownership map:

| Surface | Likely role in an approved OCaml implementation |
| --- | --- |
| `gitnexus-shared/src/languages.ts` | Add `SupportedLanguages.OCaml` |
| `gitnexus-shared/src/language-detection.ts` | Add `.ml`, `.mli`, and syntax map handling |
| `gitnexus-shared/src/scope-resolution/language-classification.ts` | Classify OCaml; likely `experimental` for the first local slice |
| `gitnexus/src/core/tree-sitter/parser-loader.ts` | Add grammar source rows and select `ocaml` vs `ocaml_interface` by file path |
| `gitnexus/src/core/ingestion/workers/parse-worker.ts` | Import/load OCaml grammar(s) inside worker dispatch |
| `gitnexus/src/core/ingestion/languages/index.ts` | Register `ocamlProvider` in the exhaustive provider table |
| `gitnexus/src/core/ingestion/languages/ocaml.ts` and possible `languages/ocaml/*` | Provider, query helpers, import/type/call semantics, and any scope hooks |
| `gitnexus/src/core/ingestion/tree-sitter-queries.ts` | Add `OCAML_QUERIES` and `LANGUAGE_QUERIES` row if the legacy query path remains required |
| `gitnexus/src/core/ingestion/*-extractors/configs` | Add configs only where needed for type/member/field/call/heredity semantics |
| `gitnexus/test/fixtures/sample-code` and scope-resolution fixtures | Add `.ml`/`.mli` fixtures with modules, values, types, classes/objects, calls, and interface declarations |
| `gitnexus/test/unit/parser-loader-abi.test.ts` and tree-sitter/query tests | Add parser smoke and capture tests so grammar drift is detected |

Recommended first implementation target, after approval:

- Add an experimental OCaml language slice for `.ml` and `.mli` that proves parser loading, extension detection, provider registration, minimal symbol extraction, import/module capture, direct-call capture, type/value capture, and fixture/golden tests.
- Treat `.mli` as required for V1 because the official grammar exposes a separate interface grammar and real OCaml APIs are often declared there.
- Defer Dune/project model inference, PPX expansion, full module alias semantics, functor-aware resolution, and generated-code handling.

Smallest safe implementation slice:

1. Add a focused failing test proving `.ml` and `.mli` detection plus parser-loader grammar selection are absent.
2. Add parser/dependency support only after MAIN approves the native package or vendored grammar route.
3. Add an `experimental` OCaml provider with minimal queries for:
   - module declarations,
   - value/function bindings,
   - type declarations,
   - class/object declarations if readily supported by the grammar,
   - open/import-like module references,
   - direct calls.
4. Add fixtures with expected capture/golden assertions before broad resolver work.
5. Run focused language tests, parser ABI smoke, query compilation, and build.

Focused TDD plan for the next approved Goal:

- Red 1: language detection returns `null` for `src/user.ml` and `src/user.mli`; expected OCaml.
- Red 2: parser-loader has no OCaml smoke case and `isLanguageAvailable(OCaml)` cannot compile/load.
- Red 3: query fixture for a small `.ml` file cannot capture module/function/type definitions.
- Red 4: `.mli` fixture cannot select the interface grammar or capture exposed values/types.
- Green: add minimal provider/parser/query code to pass each focused case.
- Refactor only after focused tests and `npm run build` are green.

Risks and stop rules:

- Dependency risk: `tree-sitter-ocaml` is a native package. npm latest reports peer `tree-sitter` `^0.22.4`, while the repository master package reports peer `^0.25.0`; GitNexus's current runtime must be tested before adopting either path.
- ESM/subpath risk: the package metadata uses `type: "module"` and `main: "bindings/node"`. GitNexus may need an explicit subpath or `createRequire` handling similar to existing grammar quirks.
- Grammar-selection risk: `.ml` and `.mli` are separate grammars. A single `SupportedLanguages.OCaml` value may need file-path-aware grammar selection like TS/TSX.
- Correctness risk: parser load is insufficient. Scala PR evidence shows type/member/import/CALLS correctness must be proven.
- Scope stop: stop before implementation if MAIN has not approved dependency strategy and exact write set.

Next Goal recommendation:

- Historical note: this recommendation was superseded on 2026-06-06 after MAIN approved the dependency/write-set boundary and Task 7 OCaml experimental V1 was implemented and committed as `5f543c17`.
- Create an implementation Goal only if MAIN explicitly approves:
  - dependency route: npm `tree-sitter-ocaml`, vendored grammar, or another named path,
  - write set covering shared language files, parser loader, parse worker, provider/query files, fixtures, and focused tests,
  - initial classification as `experimental`,
  - `.ml` and `.mli` as required V1 surfaces.

If MAIN does not approve that boundary, record `NO_NEXT_GOAL_CREATED` and leave OCaml deferred.

### Post-Tranche Next Goal Recommendation

Timestamp: 2026-06-06T19:35+01:00

Status:

- Tasks 1-7 have completed their first local slices on `local/gitnexus-local-features`.
- Task 7 OCaml experimental V1 was committed as `5f543c17`.
- Baton checkpoint docs were committed as `1b75b59e`.
- No product source implementation should start until the next Goal names a fresh slice and write set.

Recommended next Goal:

- Task 6 executable generated-test output policy readiness.

Why this is the best next Goal:

- Task 6 deliberately stopped at deterministic `e2e-test-plan.v1alpha1` proposal/report output.
- Executable Playwright file generation is the clearest remaining capability gap that still sits inside the existing feature sequence.
- It is risky enough to need policy first because it can mutate test files, assume app launch behavior, create brittle selectors, and potentially interact with credentials or fixture data.
- A readiness/policy Goal can define the safe output contract before any generated executable test files are written.

Candidate Goal shape:

| Goal element | Draft |
| --- | --- |
| Outcome | Decide whether and how GitNexus may generate executable E2E test files from `e2e-test-plan.v1alpha1` proposals. |
| Verification surface | Existing E2E proposal/CLI tests, current `gitnexus-web/e2e` Playwright patterns, app launch docs/config, and a written output-policy decision table. |
| Constraints | No executable test-file generation during readiness; no browser execution changes; no credentials; no CI mutation; no GitHub automation; no source writes outside docs/policy unless a later implementation Goal approves them. |
| Boundaries | Inspect `gitnexus/src/core/e2e-test-generation`, `gitnexus/src/cli/e2e-test-plan.ts`, `gitnexus-web/e2e`, Playwright config, existing fixtures, and long-horizon docs. |
| Iteration policy | Map current proposal schema to real Playwright patterns, identify safe/unsafe generation cases, define fixture/selector/output rules, then draft the smallest future implementation slice. |
| Blocked stop condition | Stop if the repo lacks stable app-launch/test-fixture conventions, if generation would require secrets, or if no safe deterministic output policy can be stated. |

Other plausible next Goals, lower priority:

| Candidate | Reason to defer behind Task 6 policy |
| --- | --- |
| Task 2 wiki server/API wiring | Useful, but mutation/provider policy is still sensitive and the first core planner already exists. |
| Task 4 PR Impact MCP/GitHub-readiness | GitHub automation is security-sensitive and should wait until local report usage hardens. |
| Task 7 deeper OCaml semantics | Valuable, but it is a language-depth expansion rather than the next enterprise-feature workflow gap. |
| Task 1 runtime/Podman operational validation | Useful if deployment becomes the priority, but not currently the clearest product capability gap. |

Required packet before implementation:

- A later selected-task packet must name the exact generated-test output policy, risk lane, write set, fixture strategy, and verification commands before executable test generation begins.

### Task 6 Executable Output Policy Readiness

Timestamp: 2026-06-06T19:35+01:00

Goal:

- Define whether and how `e2e-test-plan.v1alpha1` proposals may become executable Playwright files.
- Keep this as readiness/policy only; do not generate specs in this Goal.

Evidence inspected:

| Evidence | Finding |
| --- | --- |
| `gitnexus/src/core/e2e-test-generation/report.ts` | Current V1 builds deterministic JSON/Markdown proposals, ranks route/symbol scenarios, and explicitly says executable Playwright files are out of scope. |
| `gitnexus/src/cli/e2e-test-plan.ts` | Current CLI reads local JSON inputs and emits Markdown/JSON only; it does not write files. |
| `gitnexus/test/unit/e2e-test-generation-report.test.ts` | Tests assert schema, deterministic Markdown, ranking, graph-stale caveat, and no executable Playwright code. |
| `gitnexus-web/playwright.config.ts` | Existing E2E lane uses `testDir: ./e2e`, Chromium only, `baseURL: http://localhost:5173`, retained trace/screenshot/video, and ignores manual/debug specs. |
| `gitnexus-web/package.json` | Existing script is `npm run test:e2e` -> `playwright test`; no generator script exists. |
| `gitnexus-web/e2e/*.spec.ts` | Existing specs use `@playwright/test`, `BACKEND_URL`/`FRONTEND_URL`, `page.route` for mocked backend flows, availability checks with `test.skip`, role/text/test-id locators, `test.slow` for long live-backend flows, and screenshots through `testInfo.outputPath`. |
| Context7 `/microsoft/playwright` docs | Playwright supports codegen, role/text/test-id locators, `getByTestId`, baseURL, and webServer config; generated tests still require human-quality locator/assertion choices. |

Expected vs actual:

| Requirement before executable generation | Current state | Policy consequence |
| --- | --- | --- |
| Target app/framework known | `gitnexus-web` + Playwright Chromium is established. | Use this as the only V1 executable target. |
| Output location known | Current proposals target `gitnexus-web/e2e/<slug>.spec.ts`; no generated-output subdirectory exists. | Use a dedicated generated subdirectory or deterministic filename policy before writing anything. |
| Stable selector policy known | Existing specs prefer roles/text/test-id locators; Playwright docs support role/test-id locators. | Generated specs must prefer role/test-id locators and avoid CSS/class/canvas-coordinate selectors unless a human-authored scenario explicitly allows them. |
| Fixture/data policy known | Existing tests either mock backend routes or skip unless live services/repos exist. | Generated V1 specs should default to mocked backend route fixtures; live-backend tests require explicit opt-in. |
| App launch policy known | Config assumes servers on 4747/5173 but does not start them via Playwright `webServer`. | Do not generate tests that require new launch orchestration until a launch contract is approved. |
| Safety around secrets known | Existing local E2E patterns do not require credentials. | Generated specs must not embed credentials, tokens, absolute personal paths, or external services. |
| Deterministic review surface known | Current report core has golden Markdown; executable output has no golden fixture yet. | First implementation slice must generate files from fixture inputs and compare exact golden spec text. |
| Flake strategy known | Existing specs use explicit waits, skip checks, screenshots, and `test.slow` for long live flows. | Generated V1 should emit conservative waits/assertions and avoid timing-sensitive graph/canvas assertions. |

Policy decisions for future executable generation:

| Policy area | Decision |
| --- | --- |
| Generation mode | Add a separate opt-in command/flag later; never make `gitnexus e2e-test-plan` write files by default. |
| Default output | Markdown/JSON remains default. Executable spec output must require an explicit `--write-specs` or equivalent implementation-specific flag. |
| Output path | Prefer `gitnexus-web/e2e/generated/` for generated specs so generated files are reviewable and visually separated from hand-written specs. |
| File naming | Use stable slugs from proposal ids, e.g. `route-api-repos.generated.spec.ts` or `symbol-render-graph.generated.spec.ts`; never overwrite hand-written specs. |
| Overwrite behavior | Refuse to overwrite an existing generated spec unless an explicit force flag is approved later. |
| Test template | Use `import { test, expect } from '@playwright/test';`, describe blocks matching proposal titles, and include source evidence comments only when concise and non-secret. |
| Selectors | Prefer `getByRole`, `getByTestId`, accessible names, and visible text already present in existing specs. Do not generate brittle class selectors or canvas-coordinate assertions. |
| Backend data | Prefer `page.route` mocked backend responses for deterministic generated V1 specs. Live-backend specs require a separate live fixture contract. |
| App URLs | Use existing `BACKEND_URL` / `FRONTEND_URL` conventions and Playwright `baseURL`; do not hard-code machine-specific paths. |
| Generated assertions | Require at least one web-first assertion per generated scenario; do not emit action-only smoke tests. |
| Unsafe cases | Emit "policy blocked" diagnostics rather than specs when a proposal needs auth, secrets, external network, non-deterministic canvas assertions, unknown fixture data, or live indexed repos. |
| Provenance | Include source schema versions and proposal ids in generated metadata/comments or sidecar JSON, but do not include raw private diffs. |

Smallest future implementation slice:

1. Add a pure spec renderer that accepts one `E2ETestPlanReport` and returns deterministic generated spec text plus blocked diagnostics.
2. Support only mocked-backend route proposals for `gitnexus-web` in V1.
3. Add golden tests for:
   - generated route spec text,
   - stable output path/name,
   - refusal to overwrite hand-written specs,
   - blocked unsafe proposals,
   - no credentials/absolute paths,
   - no CSS/canvas-coordinate selectors.
4. Add an optional CLI write mode only after renderer tests pass.
5. Keep browser execution, Playwright config changes, CI changes, MCP, GitHub automation, and live-backend generation out of the first executable-output slice.

Suggested future write set after approval:

| File | Purpose |
| --- | --- |
| `gitnexus/src/core/e2e-test-generation/spec-renderer.ts` | Pure deterministic spec renderer and policy-block diagnostics. |
| `gitnexus/test/unit/e2e-test-generation-spec-renderer.test.ts` | Golden generated-spec tests and safety policy tests. |
| `gitnexus/test/fixtures/e2e-test-generation/generated-route.spec.ts` | Golden generated Playwright fixture. |
| `gitnexus/src/cli/e2e-test-plan.ts` | Add opt-in write mode only after renderer passes. |
| `gitnexus/test/unit/e2e-test-plan-cli.test.ts` | CLI write-mode tests with mocked filesystem. |
| `gitnexus/src/cli/index.ts`, `gitnexus/src/cli/help-i18n.ts`, locale files | Required only if the write mode is exposed as real CLI flags. |

Do not include in the first implementation slice:

- `gitnexus-web/e2e` generated files checked in from live generation.
- Playwright browser execution.
- `playwright.config.ts` webServer changes.
- CI workflow mutation.
- GitHub PR comments/checks.
- MCP/API exposure.
- Generated tests that depend on credentials, real external services, or machine-specific paths.

Suggested MAIN approval text for later:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: End-to-End Test Generation executable output policy
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: deterministic generated Playwright spec renderer for `gitnexus-web` mocked-backend route proposals only, plus optional explicit CLI write mode after renderer tests pass.
Approved write set:
- gitnexus/src/core/e2e-test-generation/spec-renderer.ts
- gitnexus/test/unit/e2e-test-generation-spec-renderer.test.ts
- gitnexus/test/fixtures/e2e-test-generation/generated-route.spec.ts
- gitnexus/src/cli/e2e-test-plan.ts
- gitnexus/test/unit/e2e-test-plan-cli.test.ts
Constraints: no browser execution, no Playwright config changes, no CI changes, no MCP/API exposure, no GitHub automation, no live-backend generated specs, no credentials, no absolute personal paths, no new dependency, no overwriting hand-written specs, and TDD required.
```

Stop rules:

- Stop if generated output requires credentials, external services, live indexed repos, or non-deterministic graph/canvas assertions.
- Stop if the future implementation would need to change `gitnexus-web/playwright.config.ts` or CI before the renderer is proven.
- Stop if a proposal cannot be mapped to stable role/test-id/text locators or deterministic mocked backend data.

Implementation checkpoint:

- 2026-06-06T19:45+01:00: Deterministic generated-spec renderer and explicit CLI write mode implemented with TDD.
- Initial renderer red test failed because `src/core/e2e-test-generation/spec-renderer.js` did not exist.
- Initial CLI red test failed because `--write-specs` did not write files.
- Implemented behavior:
  - pure `renderE2EGeneratedSpecs()` renderer,
  - deterministic output path `gitnexus-web/e2e/generated/<proposal-id>.generated.spec.ts`,
  - golden generated Playwright fixture for `/api/repos`,
  - policy-block diagnostics for unsupported symbol proposals, credential/secret evidence, unsafe target paths, and overwrite attempts,
  - force-only overwrite for existing generated specs,
  - explicit `--write-specs`, `--spec-output-dir`, and `--force` CLI flags,
  - mocked-filesystem CLI write-mode tests.
- The implementation boundary expanded from the draft write set only to make the CLI mode actually callable: `gitnexus/src/cli/index.ts`, `gitnexus/src/cli/help-i18n.ts`, and locale files were updated for option registration/help.
- Still out of scope:
  - browser execution,
  - Playwright config changes,
  - CI changes,
  - MCP/API exposure,
  - GitHub automation,
  - live-backend generated specs,
  - generated specs beyond explicitly approved deterministic mocked route fixtures.

Verification:

```powershell
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts
npm test -- test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-spec-renderer.test.ts
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts test/unit/cli-index-help.test.ts
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts
npm run build
git diff --check
```

Results:

- Focused renderer: 1 file, 4 tests passed.
- CLI + renderer: 2 files, 7 tests passed.
- CLI/help/report/renderer: 4 files, 22 tests passed.
- Focused Task 6 suite: 3 files, 10 tests passed.
- Build passed with existing Vite chunk-size and ineffective dynamic-import warnings.
- Diff whitespace check passed.

Expansion checkpoint:

- 2026-06-07T13:51+01:00: Broadened the deterministic generated-spec renderer from mocked `/api/repos` proposals to mocked `/api/repo` proposals.
- Added a red/green renderer test plus golden Playwright fixture for `/api/repo`.
- Implemented `/api/repo` support as a stable mocked-backend route fixture only:
  - mocked `/api/repos` establishes the selected repo,
  - mocked `/api/repo` returns selected repo metadata and graph stats,
  - mocked `/api/graph**` and `/api/heartbeat` keep the frontend deterministic,
  - assertions use visible repo text and existing footer graph stats test id.
- Preserved existing `/api/repos` behavior and existing policy blocks for unsafe/unsupported proposals.
- Still deferred:
  - browser execution,
  - Playwright config changes,
  - CI mutation,
  - MCP/API exposure,
  - GitHub automation,
  - live-backend generated specs,
  - generated specs beyond explicitly approved deterministic mocked route fixtures.

Verification:

```powershell
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts
npm run build
git diff --check
```

Results:

- Focused renderer: 1 file, 5 tests passed.
- Focused Task 6 suite: 3 files, 11 tests passed.
- Build passed with existing Vite chunk-size and ineffective dynamic-import warnings.
- Diff whitespace check passed.

Second expansion checkpoint:

- 2026-06-07T14:00+01:00: Selected `/api/graph` as the next safe deterministic generated route fixture.
- Evidence:
  - frontend backend client fetches `/api/graph` during server/repo connection,
  - footer status renders graph stats from the loaded graph,
  - existing E2E tests already use `contentinfo`, `status-ready`, and `graph-stats` as stable assertion surfaces.
- During readiness, fixed the previous `/api/repo` fixture contract:
  - red regression showed it mocked an empty graph while asserting graph stats,
  - generated `/api/repo` specs now mock a two-node, one-edge graph and assert `2 nodes` / `1 edge`.
- Added `/api/graph` generated-spec support:
  - red test showed `/api/graph` proposals were still blocked by the route guard,
  - green implementation emits a deterministic mocked-backend Playwright spec,
  - route support policy now names `/api/repos`, `/api/repo`, and `/api/graph`.
- Still deferred:
  - browser execution,
  - Playwright config changes,
  - CI mutation,
  - MCP/API exposure,
  - GitHub automation,
  - live-backend generated specs,
  - generated specs beyond explicitly approved deterministic mocked route fixtures.

Verification:

```powershell
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts
npm run build
git diff --check
```

Results:

- Focused renderer: 1 file, 7 tests passed.
- Focused Task 6 suite: 3 files, 13 tests passed.
- Build passed with existing Vite chunk-size and ineffective dynamic-import warnings.
- Diff whitespace check passed.

No-slice checkpoint:

- 2026-06-07T14:04+01:00: Evaluated `/api/processes` as the next deterministic generated route fixture and rejected it for now.
- Evidence:
  - backend exposes `GET /api/processes`,
  - frontend backend client defines `fetchProcesses()`,
  - current frontend code has no `fetchProcesses()` call site,
  - `ProcessesPanel` derives rows from `Process` nodes already loaded through `/api/graph`,
  - existing process E2E assertions (`process-list-loaded`, `process-row`) therefore exercise `/api/graph`, not `/api/processes`.
- Decision: `NO_IMPLEMENTATION_SLICE`.
- Rationale: generating a `/api/processes` UI spec would not exercise `/api/processes` through current UI behavior unless product code changed or the generated spec used direct API assertions. Direct API assertions are a separate generated API-smoke lane, not this web-first Playwright route-fixture lane.
- Unlock: either wire the frontend Process panel to consume `/api/processes`, or open a separate Goal for generated API smoke specs with its own policy.
- 2026-06-07: Generated API-smoke specs readiness completed.
- Recommendation:
  - If Task 6 continues from the `/api/processes` no-slice decision, do it as a separate backend API-smoke lane rather than broadening the current web-first renderer.
  - Start with `/api/processes` only.
  - Keep the first slice deterministic, local, and explicitly opt-in from the CLI.
- External-methodology check:
  - OpenAI docs support `codex exec` for script/CI-style worker runs and Goals for long-running work with a clear verification loop, but current GitHub issue/PR evidence shows non-interactive Goal resume/creation is still prompt-mediated rather than a stable dedicated Goal CLI.
  - Playwright supports direct API tests through its `request` fixture / `APIRequestContext`, so backend route smoke specs are a legitimate separate lane.
  - Testing-pyramid guidance from Google and Martin Fowler supports keeping broad UI/E2E tests small and using focused integration/API checks for service contracts.
- Readiness evidence:
  - `api.ts` exposes `/api/processes` and `/api/process`.
  - `backend-client.ts` exposes `fetchProcesses()` and `fetchProcessDetail()`, but the frontend does not call `fetchProcesses()`.
  - `ProcessesPanel.tsx` is graph-driven and step-drilldown is done with `runQuery(...)`.
  - `server-connect.spec.ts` proves current process UI behavior only, not the `/api/processes` route.
  - `spec-renderer.ts` and its unit tests intentionally constrain executable generation to `/api/repos`, `/api/repo`, and `/api/graph` under `gitnexus-web/e2e/generated`.
- Smallest safe future slice:
  - add a separate deterministic API-smoke renderer for backend-only routes,
  - keep a separate output directory and explicit CLI mode,
  - reuse existing route proposals as inputs,
  - defer browser execution, CI mutation, GitHub automation, live-backend generation, and automatic backend-only route discovery.
- Proposed future write set:
  - `gitnexus/src/core/e2e-test-generation/api-smoke-renderer.ts`
  - `gitnexus/src/core/e2e-test-generation/spec-renderer.ts` only if shared helpers are extracted cleanly
  - `gitnexus/src/cli/e2e-test-plan.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/help-i18n.ts` and locale files only if new CLI flags are added
  - `gitnexus/test/unit/e2e-test-generation-api-smoke-renderer.test.ts`
  - `gitnexus/test/unit/e2e-test-plan-cli.test.ts`
  - `gitnexus/test/fixtures/e2e-test-generation/generated-api-processes-smoke.spec.ts`
- TDD order:
  1. prove `/api/processes` still blocks in the current UI renderer,
  2. add a red renderer test for deterministic `/api/processes` API-smoke output,
  3. add a red test proving API-smoke output uses direct HTTP assertions and no `page.goto(...)`,
  4. add a red CLI test that explicit API-smoke mode is required,
  5. add a red test that UI-lane and API-smoke outputs cannot overwrite each other,
  6. implement the minimal renderer/CLI changes, then rerun adjacent Task 6 tests.
- Risks:
  - current report inputs do not explicitly classify routes as "no UI consumer",
  - weak output boundaries could blur UI and backend policies,
  - over-asserting response shape could duplicate `shape_check`,
  - scope could sprawl into route discovery, browser execution, or CI/GitHub automation.
- Stop rules:
  - stop if the slice needs product/UI changes,
  - stop if output is mixed into the existing `gitnexus-web/e2e/generated` lane,
  - stop if automatic backend-only route detection requires broad new analysis,
  - stop if scope expands into browser execution, CI mutation, GitHub automation, or live-backend generation.
- Required approval boundary if implementation is chosen:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Task 6 Generated API-Smoke Specs
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: add a separate deterministic generated API-smoke lane for backend routes that do not currently have a frontend/UI consumer, starting with `/api/processes` only. Reuse existing route proposals as inputs, but keep the renderer, CLI mode, and output directory separate from the current web-first generated Playwright UI lane.
Approved write set:
- gitnexus/src/core/e2e-test-generation/api-smoke-renderer.ts
- gitnexus/src/core/e2e-test-generation/spec-renderer.ts only if shared helpers are extracted cleanly
- gitnexus/src/cli/e2e-test-plan.ts
- gitnexus/src/cli/index.ts
- gitnexus/src/cli/help-i18n.ts and locale files only if needed for new CLI flags
- gitnexus/test/unit/e2e-test-generation-api-smoke-renderer.test.ts
- gitnexus/test/unit/e2e-test-plan-cli.test.ts
- gitnexus/test/fixtures/e2e-test-generation/generated-api-processes-smoke.spec.ts
Constraints: no product/UI changes, no browser execution, no CI mutation, no GitHub automation, no new dependency without approval, no live-backend generation, and TDD required.
```

### Task 7 Approval Packet - OCaml Implementation Goal

Timestamp: 2026-06-06T13:48+01:00

Recommended parser/dependency route:

- Use npm `tree-sitter-ocaml@0.22.0` for the first local experimental slice.
- Rationale: GitNexus currently pins `tree-sitter` to `0.21.1`; npm metadata for `tree-sitter-ocaml@0.22.0` declares peer `tree-sitter: 0.21`, while npm latest `0.24.2` declares peer `tree-sitter: ^0.22.4` and repository master `0.25.0` declares peer `^0.25.0`.
- Do not upgrade GitNexus's core `tree-sitter` runtime in this slice. A runtime upgrade would be a broader cross-language native-binding project.
- Treat the dependency as a normal dependency unless install/runtime smoke evidence suggests it must follow the optional grammar path.

Exact V1 boundaries:

- Include `.ml` implementation files and `.mli` interface files.
- Use one shared `SupportedLanguages.OCaml` identity with file-path-aware grammar selection for `ocaml` vs `ocaml_interface`.
- Classify OCaml as `experimental` for the first slice.
- Capture only foundational graph evidence:
  - module declarations,
  - value/function bindings,
  - type declarations,
  - direct calls,
  - open/import-like module references,
  - interface declarations from `.mli`.
- Defer:
  - Dune/project model,
  - PPX expansion,
  - full module alias and functor semantics,
  - generated-code handling,
  - production classification,
  - web UI/WASM parity unless a source compile error proves it is required for the shared package.

Approved write set to request:

| Area | Files |
| --- | --- |
| Dependency manifest | `gitnexus/package.json`, `gitnexus/package-lock.json` |
| Shared language identity | `gitnexus-shared/src/languages.ts`, `gitnexus-shared/src/language-detection.ts`, `gitnexus-shared/src/scope-resolution/language-classification.ts` |
| Parser dispatch | `gitnexus/src/core/tree-sitter/parser-loader.ts`, `gitnexus/src/core/ingestion/workers/parse-worker.ts` |
| Provider/queries | `gitnexus/src/core/ingestion/languages/index.ts`, `gitnexus/src/core/ingestion/languages/ocaml.ts`, possible `gitnexus/src/core/ingestion/languages/ocaml/*`, `gitnexus/src/core/ingestion/tree-sitter-queries.ts` |
| Tests/fixtures | `gitnexus/test/unit/parser-loader-abi.test.ts`, `gitnexus/test/unit/tree-sitter-queries.test.ts`, `gitnexus/test/integration/tree-sitter-languages.test.ts`, OCaml fixtures under `gitnexus/test/fixtures/sample-code` and/or focused scope-resolution fixtures |
| Docs/checkpoints | `.agent/long-horizon/gitnexus-local-features/*` only for checkpoint updates |

TDD order:

1. Red: add language detection tests for `.ml` and `.mli`.
2. Red: add parser-loader ABI smoke cases for `.ml` and `.mli` grammar selection.
3. Red: add query/capture tests for a minimal `.ml` fixture.
4. Red: add `.mli` fixture test for interface declarations.
5. Green: add dependency and minimal parser dispatch.
6. Green: add provider/query code and fixtures.
7. Refactor: tighten helper boundaries only after focused tests pass.

Verification commands:

```powershell
cd C:\Users\steve\projects\gitnexus\source-rc109-integration\gitnexus
npm test -- test/unit/parser-loader-abi.test.ts test/unit/tree-sitter-queries.test.ts test/integration/tree-sitter-languages.test.ts
npm run build
cd ..
git diff --check
```

Stop rules:

- Stop if `tree-sitter-ocaml@0.22.0` cannot install or load cleanly against GitNexus's current `tree-sitter@0.21.1`.
- Stop if `tree-sitter-ocaml` exports differ from documented `ocaml` / `ocaml_interface` names.
- Stop if adding the package forces a core `tree-sitter` runtime upgrade.
- Stop if V1 cannot capture both `.ml` and `.mli` basics with focused tests.
- Stop if implementation wants to cross into Dune, PPX, functor semantics, web UI/WASM, MCP/API, or production classification.

Approval phrase needed:

```text
MAIN | READY_FOR_IMPLEMENTATION: Task 7 OCaml experimental language support V1 is approved on branch local/gitnexus-local-features. Approved dependency route is npm tree-sitter-ocaml@0.22.0 without upgrading GitNexus's core tree-sitter runtime. Approved write set is gitnexus/package.json, gitnexus/package-lock.json, gitnexus-shared language detection/classification files, GitNexus parser-loader and parse-worker dispatch, OCaml provider/query files, focused OCaml fixtures/tests, and long-horizon checkpoint docs. V1 must cover .ml and .mli, classify OCaml as experimental, follow TDD, and stop if dependency/runtime compatibility requires a broader tree-sitter upgrade or if scope expands into Dune, PPX, functors, web UI/WASM, MCP/API, or production classification.
```

## Interim Task - Disable Hidden Bare-GitNexus Router

Status: completed on 2026-06-05

Objective:

- Remove workstation ambiguity before feature implementation by quarantining the hidden bare-`gitnexus` router.

Result:

- `C:\Users\steve\.local\bin\gitnexus.cmd` and `C:\Users\steve\.local\bin\gitnexus.py` were renamed to date-stamped disabled files.
- `gitnexus-podman` remains the explicit rc.109 Podman route.
- Bare `gitnexus` now exposes the host/npm CLI at `1.6.6-rc.109`; the redundant `gitnexus-host` helper is quarantined.
- Normal runtime health on `127.0.0.1:4747` remained OK.
- Evidence is preserved in `plan.md` and `gitnexus-router-indexing-note.md`. Those files are historical evidence only, not additional control files.

## Task 0 - Version The Planning Bundle

Status: complete locally, pending snapshot/commit

Objective:

- Move the canonical long-horizon control surface into the source repo so planning and implementation cannot drift apart.

Acceptance criteria:

- `prompt.md`, `plans.md`, `implement.md`, and `documentation.md` exist under `.agent/long-horizon/gitnexus-local-features/`.
- Files name `local/gitnexus-local-features` as the shared branch.
- Files state no Git hooks and no source implementation before `MAIN | READY_FOR_IMPLEMENTATION`.
- Git status shows only intended planning-file additions.

Validation:

- `git status --short --branch`
- `rg -n "local/gitnexus-local-features|READY_FOR_IMPLEMENTATION|Git hooks|podman" .agent/long-horizon/gitnexus-local-features`

Remaining snapshot requirement:

- The four-file bundle is not fully done until the intended planning artifacts are committed or otherwise explicitly snapshotted.
- Current unsnapshotted docs/planning artifacts must be reviewed before any source implementation starts.

## Task 0.5 - Snapshot The Planning Bundle And Current Feature WIP

Status: pending

Objective:

- Create an explicit snapshot boundary for the current docs/planning artifacts plus implemented Auto-Reindexing and Auto-Updating Code Wiki slices before starting further feature source implementation.

Acceptance criteria:

- The chosen planning and source artifacts are committed, or the user records a deliberate no-commit decision.
- Auto-Reindexing and Auto-Updating Code Wiki source/test additions are no longer ambiguous WIP before the next source feature starts.
- `git status --short --branch` no longer leaves the inter-feature boundary ambiguous.

## Task 1 - Auto-Reindexing

Status: approved slice implemented locally on 2026-06-05T17:13+01:00; focused tests and build passed

Objective:

- Add opt-in, non-hook, server-side freshness orchestration so registered repository indexes do not silently go stale.

Expanded research checkpoint:

- 2026-06-05: Decision-grade readiness research increased using Superpowers/research discipline, local source inspection, Context7/official Node docs, GitHub PR/issue evidence, and focused test-surface review.
- 2026-06-05T10:39+01:00: Coordinated feature-wide research tranche continued with objective timestamps, local file/graph checks, GitHub PR/issue evidence, official Node/GitHub Actions docs, DORA methodology sources, and OpenAI Codex planning guidance. Scratchpad records the detailed source matrix.
- 2026-06-05T10:49+01:00: Coordinated continuation reinforced the operating model: one shared branch is acceptable only with WIP limit one, small verified slices, and documented checkpoints; Auto-Reindexing remains the first candidate because it has concrete local primitives and the highest staleness impact.
- 2026-06-05T10:55+01:00: GitHub PR/issue evidence sharpened the intended function: OSS PostToolUse behavior is notification-only and intentionally distinct from Enterprise Auto-reindexing; our local feature must not revive hidden hook-triggered analyze as the implementation path.

Expected behavior:

- Detect stale registered repos through existing Git commit/index metadata.
- Reuse existing reindex API/queue semantics instead of creating a parallel reindex path.
- Default disabled or dry-run until explicitly enabled.
- Provide enough observable state for verification.
- Treat native filesystem watching as optional acceleration only, not the correctness mechanism.
- Context7 `/nodejs/node` corroborates the Node filesystem watcher caveat: `fs.watch` can be inconsistent or unavailable, and polling fallbacks are slower/less reliable. Auto-Reindexing correctness must be sweep/staleness based.

Recommended first implementation slice:

- Wire an opt-in server-side freshness orchestrator around existing registered repos, staleness checks, scheduler, queue, and operation ledger.
- Run periodic sweep/staleness detection first; do not depend on native file events for correctness.
- Use `listRegisteredRepos({ validate: true })` for validated registry loading before selecting targets.
- Use `checkStalenessAsync(entry.path, entry.lastCommit)` as the freshness primitive to select stale repos.
- Dispatch reindex work through the existing `ReindexQueue` and `startReindexJob` pathway by first defining an explicit server-local helper boundary in the decision-complete implementation plan.
- Do not call the HTTP API from inside the server process.
- Extend `ReindexTrigger` with an explicit auto/freshness trigger name chosen in the decision-complete implementation plan.
- Keep dry-run default true and enabled default false unless MAIN explicitly changes the rollout policy.

Required pre-implementation plan:

- Draft a decision-complete Auto-Reindexing implementation plan before source edits. Status: complete locally on 2026-06-05T16:31+01:00.
- The plan must name the exact write set, helper boundary, trigger name, test files, expected API/operation visibility, dry-run behavior, failure handling, and acceptance criteria.
- The plan must order the first implementation slice as a TDD sequence: baseline focused tests, first failing test, red verification, smallest green implementation, focused green verification, refactor, then the next failing test.
- No agent should start Auto-Reindexing source edits from this Task 1 text alone.

### Auto-Reindexing Decision-Complete Implementation Plan

Readiness verdict:

- MAIN approval granted by the human operator on 2026-06-05T17:05+01:00.
- Approved source mutation was completed for the Auto-Reindexing slice on 2026-06-05T17:13+01:00.

Expected vs actual behavior:

| Area | Expected first-slice behavior | Pre-implementation local behavior | Plan/implementation response |
| --- | --- | --- | --- |
| Stale repo detection | Registered repos that are behind `HEAD` are found proactively. | `checkStalenessAsync(entry.path, entry.lastCommit)` exists, but server does not run a proactive registered-repo sweep. | Add an opt-in server sweep that loads validated registry entries and checks commit staleness. |
| Fresh repo handling | Fresh repos are skipped without scheduling reindex. | Staleness primitive returns `isStale: false`; no scheduler uses it for registered repos. | Pure sweep helper must return skipped/fresh counts and not call queue/start on fresh entries. |
| Registry safety | Invalid/stale registry entries do not schedule jobs. | `listRegisteredRepos({ validate: true })` prunes entries whose `meta.json` is missing. | Auto sweep must use `validate: true`; do not read raw registry directly. |
| Reindex execution | Reuse existing API/queue semantics; do not create a parallel worker path. | `api.ts` has route-local `startReindexJob`, `ReindexQueue`, `ReindexOperationRegistry`, operation logs, and backend refresh. | Keep execution in server-local helper boundary around `startReindexJob`; do not call `/api/reindex` over HTTP from inside the server. |
| Dry-run safety | Disabled or dry-run by default. | `readReindexWatcherConfigFromEnv` defaults to `enabled: false` and `dryRun: true`. | Preserve those defaults; dry-run logs/records intent but starts no job. |
| Observability | Auto work is distinguishable from direct user reindex and pending rerun. | `ReindexTrigger` is currently `direct` or `pending-rerun`. | Add trigger `auto-reindex`; expose it through existing operation records, GET filters, and logs. |
| Queue/coalescing | Same-repo duplicate requests coalesce; different repo concurrency remains bounded. | `ReindexQueue` already coalesces same repo and rejects different repo when one is active. | Auto sweep must go through `ReindexQueue.request(repoKey)` before `startReindexJob`. |
| Watcher correctness | Native watch events may accelerate later but cannot be correctness-critical. | `ReindexWatcherScheduler` can record dirty repos, but no reliable native watcher integration is required. | First slice is periodic commit-staleness sweep only; no hooks and no new watcher dependency. |

Proposed first implementation slice:

- Add an opt-in server-side auto-reindex sweep that periodically inspects validated registered repos and starts reindex jobs only for stale entries.
- Use existing env names and defaults from `readReindexWatcherConfigFromEnv`:
  - `GITNEXUS_REINDEX_WATCHER=false` by default.
  - `GITNEXUS_REINDEX_WATCHER_DRY_RUN=true` by default.
  - `GITNEXUS_REINDEX_WATCHER_SWEEP_MS=60000` by default.
  - `GITNEXUS_REINDEX_WATCHER_EMBEDDINGS=true` by default.
- Treat the env name as legacy/internal naming for the existing watcher config. Do not introduce a new dependency or hooks.

Proposed write set if MAIN approves:

- `gitnexus/src/server/reindex-auto-sweep.ts` - new pure/helper module for validated-entry sweep planning, stale/fresh/invalid result shaping, and small testable orchestration helpers.
- `gitnexus/src/server/reindex-operations.ts` - extend `REINDEX_OPERATION_TRIGGERS` with `auto-reindex`.
- `gitnexus/src/server/api.ts` - wire the opt-in sweep into server startup after `startReindexJob` exists; use `listRegisteredRepos({ validate: true })`, `checkStalenessAsync`, `ReindexQueue`, and `startReindexJob(..., { trigger: 'auto-reindex' })`.
- `gitnexus/test/unit/reindex-auto-sweep.test.ts` - new focused unit tests for stale selection, fresh skip, dry-run behavior, and invalid/staleness-error handling.
- `gitnexus/test/unit/reindex-api-wiring.test.ts` - add source-wiring assertions for validated registry load, no internal HTTP self-call, auto trigger, and dry-run default.
- `gitnexus/test/unit/reindex-operations.test.ts` - add trigger validation/list-filter coverage for `auto-reindex`.
- `gitnexus/test/unit/reindex-watcher.test.ts` - extend only if the implementation reuses scheduler behavior directly; otherwise leave this file as baseline coverage.

Files explicitly out of scope for the first slice:

- Git hooks, `hooks/`, generated editor setup, and generated AGENTS/CLAUDE text.
- Docker/Podman compose files and embedding sidecar configuration.
- Web UI changes.
- PR Review / Blast Radius and Code Wiki refresh orchestration.
- New dependencies such as Chokidar.

Helper boundary:

- Keep `startReindexJob` private to server startup for now, but introduce a small server-local auto-sweep helper that receives callbacks instead of importing Express or making HTTP calls.
- The helper should accept:
  - validated repo loader
  - async staleness checker
  - queue request/status functions
  - `startReindex` callback
  - logger or event callback
  - config with `enabled`, `dryRun`, `sweepMs`, and `embeddings`
- If this proves too awkward because `startReindexJob` is route-local inside `api.ts`, the first implementation step should be extracting only the minimum callback-friendly helper, not moving the full worker implementation wholesale.

TDD sequence:

1. Baseline: run `npm test -- test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts test/unit/staleness.test.ts`.
2. Red 1: add `reindex-auto-sweep.test.ts` proving a stale validated repo is selected and fresh repo is skipped.
3. Green 1: implement pure stale-selection helper using injected `checkStalenessAsync`-compatible callback.
4. Red 2: add dry-run no-op test proving no `startReindex` callback fires while the intended action is reported/logged.
5. Green 2: wire dry-run branch.
6. Red 3: add queue behavior tests for same-repo coalescing and different-repo active rejection through injected queue callback results.
7. Green 3: route sweep starts through queue decision handling, not direct worker start.
8. Red 4: add operation trigger tests for `auto-reindex`.
9. Green 4: extend `REINDEX_OPERATION_TRIGGERS` and route/filter handling.
10. Red 5: add `api.ts` wiring assertion for `listRegisteredRepos({ validate: true })`, `checkStalenessAsync`, `startReindexJob(... trigger: 'auto-reindex')`, no `fetch('/api/reindex')`, disabled default, and interval cleanup.
11. Green 5: wire startup interval and cleanup in `api.ts`.
12. Refactor only after all focused tests are green.

Acceptance criteria for the approved slice:

- Default process behavior remains unchanged when `GITNEXUS_REINDEX_WATCHER` is unset. Status: covered by source wiring using `readReindexWatcherConfigFromEnv` and conditional interval.
- With auto-reindex enabled and dry-run true, stale repos are detected and reported/logged, but no reindex job starts. Status: covered by `reindex-auto-sweep.test.ts`.
- With auto-reindex enabled and dry-run false, stale validated repos start through existing queue and `startReindexJob` semantics. Status: covered by `reindex-auto-sweep.test.ts` and `reindex-api-wiring.test.ts`.
- Fresh repos do not start jobs. Status: covered by `reindex-auto-sweep.test.ts`.
- Invalid registry entries are pruned or skipped by `listRegisteredRepos({ validate: true })`. Status: covered by `reindex-api-wiring.test.ts`.
- Same-repo duplicate auto sweeps coalesce through the existing queue; different-repo concurrency remains bounded by current queue behavior. Status: covered by `reindex-auto-sweep.test.ts` and existing `ReindexQueue` tests.
- Operation records and logs can show `trigger: 'auto-reindex'`. Status: covered by `reindex-operations.test.ts` and API wiring.
- Native file watching, Git hooks, new dependencies, and runtime/Podman config changes are absent. Status: verified by scoped diff/status review.
- Focused reindex/staleness tests pass. Status: 7 files, 62 tests passed.

Recorded MAIN approval text:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Auto-Reindexing
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: opt-in, dry-run-default, server-side commit-staleness sweep over validated registered repos, using existing reindex queue/job/operation semantics and trigger auto-reindex.
Approved write set:
- gitnexus/src/server/reindex-auto-sweep.ts
- gitnexus/src/server/reindex-operations.ts
- gitnexus/src/server/api.ts
- gitnexus/test/unit/reindex-auto-sweep.test.ts
- gitnexus/test/unit/reindex-api-wiring.test.ts
- gitnexus/test/unit/reindex-operations.test.ts
- gitnexus/test/unit/reindex-watcher.test.ts only if scheduler behavior is directly reused
Constraints: no hooks, no new dependencies, no Docker/Podman runtime changes, no PR Review/Wiki work, TDD required.
```

Known local source surfaces:

- `gitnexus/src/server/reindex-watcher.ts`
- `gitnexus/src/server/reindex-control.ts`
- `gitnexus/src/server/reindex-operations.ts`
- `gitnexus/src/server/api.ts`
- `gitnexus/src/core/git-staleness.ts`
- `gitnexus/src/storage/repo-manager.ts`
- `gitnexus/src/mcp/local/local-backend.ts`

Initial verification shape:

- Existing focused test set passed during research:
  `npm test -- test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts`
- Result: 5 files passed, 47 tests passed.

Required new or confirmed tests before completion:

- stale registered repo is selected for reindex
- fresh registered repo is skipped
- dry-run does not start reindex work
- repeated same-repo freshness events coalesce
- different-repo concurrency remains bounded by existing queue semantics
- generated/index/dependency paths remain ignored
- operation records expose the auto-reindex trigger distinctly from direct user requests
- registry validation skips or prunes invalid repo entries before scheduling
- native watcher failures do not block sweep-based freshness recovery

Stop rules:

- Stop if the design requires Git hooks.
- Stop if the design needs a new dependency before MAIN approves it.
- Stop if Windows/Podman file-watching reliability is required for correctness.
- Stop if reindex can race graph reads outside existing guarded semantics.

## Task 4 - PR Impact / Blast Radius

Status: local V1 complete; GitHub PR automation boundary readiness is the current selected Task 4 follow-on

Objective:

- Produce local Markdown/JSON change-risk reports over deterministic diff-to-graph primitives.

Expected first slice:

- Orchestrate existing `detect_changes`, `impact`, and `api_impact` outputs.
- Prefer local branch/diff reporting before GitHub comment or review automation.
- Defer GitHub Actions and PR posting until report schema and permission model are stable.
- Use `pr-swarm-review/` and `gitnexus-pr-review` as report-shape and review-discipline references, while preserving their read-only/manual nature.

Implemented local slices:

- `gitnexus pr-impact` local CLI wrapper.
- Deterministic `pr-impact.v1alpha1` JSON/Markdown report core.
- Diff-mapping helper for mapped, unmatched, new/unmapped, and deleted-symbol evidence.
- Read-only MCP `pr_impact` tool over the local `detect_changes -> impact -> api_impact -> report` pipeline.

Current follow-on scope:

- Decide the GitHub integration boundary after local CLI/MCP V1, not rebuild local V1.
- Keep GitHub PR URL ingestion, PR comments, PR reviews, check runs, token handling, Actions workflows, and Codex remediation out of autonomous implementation unless the selected task explicitly moves them through the red-lane security model.
- The safe output for this selected task is a documented no-write/write-phase boundary and, if needed later, a local dry-run adapter plan that still avoids GitHub writes.

Research verification already run:

- `npm test -- test/unit/tools.test.ts test/unit/tool-direct-cli.test.ts test/unit/detect-changes-worktree.test.ts test/integration/api-impact-e2e.test.ts`
- Result: 4 files passed, 71 tests passed.
- Later verification for implemented local V1 is recorded in `documentation.md` and includes report-core, CLI, MCP dispatch, build, and golden Markdown/JSON tests.

Dependency:

- Requires fresh enough graph state from Task 1.
- Local Task 4 V1 no longer depends on the old Tasks 1-3 source-edit gate; it is already implemented.
- GitHub automation depends on a separate permission/threat model and remains red lane.

Preimplementation steps:

- Re-read existing local `pr-impact` source/tests and MCP schema. Status: complete for this boundary pass.
- Reconcile local report-first behavior against `pr-swarm-review/`, global `gitnexus-pr-review` skill guidance, GitHub PR/issue evidence, and GitHub Actions security docs. Status: refreshed on 2026-06-08.
- Draft the no-write/write-phase GitHub boundary. Status: recorded below.
- Stop before any source edit that would add GitHub token use, PR comments/reviews, check runs, CI workflows, or external writes.

### Task 4 GitHub PR Automation Boundary - 2026-06-08

Readiness verdict:

- Ready to close as a no-write boundary decision.
- Not ready for token-bearing implementation.
- Local GitNexus-owned capability should remain `pr-impact`: deterministic diff-to-graph evidence and reports.
- GitHub-owned/provider-specific capability should be a later integration layer, not a hidden expansion of `pr-impact`.

Evidence refreshed:

| Source | Finding | Consequence |
| --- | --- | --- |
| GitNexus issue #1901, "stable graph mapping primitives for external diff integrations" | Explicitly splits responsibility: external platforms own PR/MR provider semantics, base/head selection, rename/delete interpretation, lifecycle, and reporting; GitNexus owns file ranges to symbols and symbols to impact/process evidence. | Future GitHub integration should consume explicit diff/range evidence or local compare evidence, not make GitNexus silently own every PR-provider semantic. |
| GitNexus issue #1858, "epistemic lower-bound" | Impact reports must distinguish unresolved/unknown paths from true no-impact. | GitHub automation must not post authoritative approvals from incomplete graph evidence; `UNKNOWN`/caveats must remain first-class. |
| GitNexus issue #1532, "stable call-graph contract" | External consumers need versioned contracts rather than raw graph schema. | If GitHub automation is added later, it should consume versioned `pr-impact.v1alpha1` or successor schemas. |
| GitNexus issue #323, SolidJS/TSX impact limitation | Current impact can miss framework/template relationships such as JSX component usage. | GitHub PR verdicts must carry graph limitation caveats and avoid overclaiming safety. |
| GitNexus PR #1851, PR reviewer swarm | Upstream PR review method is read-only, manually invoked, evidence-grounded, and forbids posting/editing from the review personas. | Existing review materials are methodology references, not a product automation mandate. |
| GitNexus PR #1818, impact pagination | Hub-symbol impact output can explode; summary/pagination are required for usable reports. | GitHub-facing reports should keep bounded summaries and link/attach full detail only in a later designed surface. |
| GitNexus PR #1867, per-symbol processes | Impact results now carry process participation per by-depth item. | PR impact reports can support deploy-risk reasoning without extra per-symbol Cypher. |
| GitNexus PR #1914, impact disambiguation | CLI `impact` supports `--uid`, `--file`, and `--kind` disambiguation. | Later stable primitives should preserve explicit symbol identity rather than name-only matching. |
| GitNexus PR #1522 and #1258 | Existing upstream Claude review workflows had subtle posting/comment behavior and review-trigger tradeoffs. | Posting reviews/comments is operationally brittle and belongs behind a dedicated security/permission model. |
| Local `.github/workflows/pr-autofix*.yml` | Existing repo uses split untrusted/trusted workflow design, metadata validation, least privilege, and sticky comments/check runs only from trusted jobs. | Any future PR Impact GitHub automation should copy this split pattern, not run fork code with write permissions. |
| Local `pr-swarm-review/orchestration.md` | Cross-CLI PR review contract is read-only and explicitly never edits, commits, or posts. | The safe current review surface remains human/agent read-only review plus local `pr-impact` evidence. |
| Local `gitnexus/src/mcp/tools.ts` | `pr_impact` is documented as local-only and explicitly does not ingest GitHub PR URLs, use tokens, post comments, create checks, or mutate repos. | Current MCP behavior already encodes the right no-write boundary. |
| GitHub Actions token docs | GitHub recommends least privilege for `GITHUB_TOKEN` and configuring minimum permissions. | Token-bearing work is red lane until the exact permissions are named and tested. |
| GitHub workflow syntax docs | Once permissions are specified, unspecified scopes become `none`; `permissions: {}` disables all token permissions. | Future workflows must use explicit deny-by-default/job-scoped permissions. |
| GitHub events docs and secure-use docs | Fork PR events and privileged triggers require care; secure-use guidance warns against `pull_request_target`/`workflow_run` with untrusted code and artifacts. | Future automation must separate untrusted analysis from trusted posting and validate artifacts. |
| GitHub REST issue comment/review/check docs | Issue comments/reviews trigger notifications and require write-scoped permissions; check runs are a GitHub App-style surface with `checks:write`. | Comments/reviews/checks are not green/amber local work; they are explicit red-lane GitHub writes. |

No-write/write-phase model:

| Phase | Allowed behavior | Lane |
| --- | --- | --- |
| Phase 0 - current | Local `gitnexus pr-impact` CLI and local read-only MCP `pr_impact`; Markdown/JSON only; no network or token. | Green/amber complete |
| Phase 1 - safe next research/design | Document GitHub PR URL parsing, provider-owned diff semantics, artifact schema, and dry-run report shape without network writes. | Green/amber if repo-local only |
| Phase 2 - optional read-only PR ingestion | Fetch public or authenticated PR metadata/diff and produce a local report, with token read-scope policy and no comments/checks. | Amber/red depending on token/auth |
| Phase 3 - trusted publishing | Post issue comments, reviews, statuses, or check runs from a trusted workflow/App after artifact validation and least-privilege permission design. | Red |
| Phase 4 - remediation | Generated fixes, pushed commits, or Codex repair loops. | Red |

Boundary decision:

- Do not implement GitHub comments, PR reviews, check runs, statuses, or workflow mutation in the current autonomous run.
- Do not add GitHub token handling or provider execution to the CLI/MCP path in this selected task.
- Do not make `pr_impact` ingest GitHub PR URLs until the provider semantics and auth model are separately designed.
- Prefer a later dry-run/local adapter before any posting: provider diff data in, `pr-impact` report out, no external write.
- Keep `pr-impact.v1alpha1` experimental until stable lower-level `symbols-for-ranges` / `impact-for-symbols` contracts are either implemented or intentionally deferred.

Likely future implementation candidates:

| Candidate | Disposition | Reason |
| --- | --- | --- |
| `symbols-for-ranges` / `impact-for-symbols` primitives | Best technical next step after boundary docs if Task 4 continues | Aligns with issue #1901 and keeps GitNexus ownership stable without GitHub writes. |
| Local `pr-impact --input-ranges <file>` or equivalent | Plausible no-write bridge | Lets external providers hand GitNexus precomputed ranges without token/provider semantics. |
| GitHub PR URL parser only | Low value alone | Parsing without diff ingestion/report improvement does not materially advance the product. |
| GitHub PR metadata/diff fetch | Defer until token/read-scope model is explicit | Could be useful, but introduces network/auth semantics. |
| GitHub comments/reviews/checks/Actions | Defer/red lane | Requires trusted/untrusted split, permission design, artifact validation, and workflow/App decision. |

Stop rules:

- Stop before adding or modifying `.github/workflows/*`.
- Stop before using or storing GitHub tokens/PATs/App credentials.
- Stop before posting PR comments, reviews, statuses, or check runs.
- Stop before running untrusted PR code in a write-scoped context.
- Stop before claiming merge approval from graph evidence that is stale, ambiguous, lower-bound, or framework-incomplete.

### PR Impact / Blast Radius Decision-Complete Readiness Plan

Readiness verdict:

- Historical readiness verdict:

- Ready for review of the proposed first implementation slice.
- Standing conditional implementation authorization existed at that time, but source work was not ready to start until the prerequisite gates below were satisfied.
- Those gates were later satisfied; local report core, CLI, and MCP slices are now implemented. The remaining Task 4 boundary is GitHub automation, not local V1.

Expected vs actual behavior:

| Area | Expected first-slice behavior | Current local behavior | Plan response |
| --- | --- | --- | --- |
| PR/diff understanding | A local reviewer can see changed symbols, affected execution flows, and risk in one report. | `detect_changes` maps git diffs to indexed symbols and affected processes, but the CLI prints only a compact detect-changes summary. | Add a local report orchestrator that calls `detect_changes` and formats a fuller Markdown/JSON report. |
| Blast radius | Non-trivial changed symbols include upstream impact evidence without overwhelming output. | `impact` supports upstream/downstream, disambiguation, pagination, and `summaryOnly`; issue #414 shows hub symbols need summary-first handling. | Use `impact(..., direction: "upstream", summaryOnly: true, limit: <small>)` first; expand only by explicit later option. |
| API route changes | API route handler changes include consumer, response-shape, middleware, mismatch, and risk evidence. | `api_impact` already combines route map, shape check, mismatch detection, middleware, consumers, flows, and risk. | For changed files that are plausible route handlers, call `api_impact({ file })` and include successful results; report skipped/no-route cases as non-blocking. |
| Review discipline | Output should follow a review structure with findings, missing coverage, and recommendation. | Global `gitnexus-pr-review` skill and `pr-swarm-review/` define read-only review methods and output shapes, but they are agent prompts, not a product CLI feature. | Treat these as report-shape references only; do not copy the swarm into an automated GitHub actor. |
| GitHub automation | GitHub comments/checks must not run before a permission model exists. | No local GitHub-posting feature exists for PR Review. GitHub docs make PR workflow permissions and `pull_request_target` sensitive, especially with forks. | First slice is local report-only. GitHub comments, PR reviews, checks, Actions workflows, and token use are explicitly out of scope. |
| Worktree/local branch support | Local branch reports should work from normal checkouts and linked worktrees. | `detect_changes` has worktree support and compare scope; CLI does not pass `worktree`, relying on auto-detection. | First slice uses current `detect_changes` behavior and documents `--base-ref`; explicit `--worktree` can be a later option if needed. |
| Freshness | Report should warn if graph evidence may be stale, not silently overclaim. | Host graph status is commit-based and does not include uncommitted source until re-analysis; Auto-Reindexing improves future freshness but current WIP is unsnapshotted. | Include a report limitation/caveat section and keep source implementation behind the Auto-Reindexing snapshot boundary. |

Evidence inspected:

- Local source:
  - `gitnexus/src/mcp/tools.ts`
  - `gitnexus/src/mcp/local/local-backend.ts`
  - `gitnexus/src/cli/tool.ts`
  - `gitnexus/src/cli/detect-changes-format.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/help-i18n.ts`
- Local tests:
  - `gitnexus/test/unit/detect-changes-worktree.test.ts`
  - `gitnexus/test/unit/tool-direct-cli.test.ts`
  - `gitnexus/test/unit/tools.test.ts`
  - `gitnexus/test/integration/api-impact-e2e.test.ts`
  - `gitnexus/test/unit/calltool-dispatch.test.ts`
  - `gitnexus/test/unit/impact-pagination.test.ts`
- Local review references:
  - `C:\Users\steve\.agents\skills\gitnexus-pr-review\SKILL.md`
  - `pr-swarm-review/README.md`
  - `pr-swarm-review/orchestration.md`
  - `pr-swarm-review/personas/*.md`
- Host graph query:
  - `gitnexus query --repo gitnexus-local-features "detect_changes impact api_impact PR review blast radius report formatter worktree" --limit 8`
- Public/reference evidence:
  - GitNexus public `AGENTS.md` records `pr-swarm-review/orchestration.md` as the cross-CLI production-readiness review spec and says the review is read-only: https://github.com/abhigyanpatwari/GitNexus/blob/main/AGENTS.md
  - GitNexus public `GUARDRAILS.md` requires impact analysis before shared-symbol edits and `detect_changes` before commit: https://github.com/abhigyanpatwari/GitNexus/blob/main/GUARDRAILS.md
  - GitNexus public `ARCHITECTURE.md` lists `impact`, `detect_changes`, `api_impact`, `route_map`, and `shape_check` as current MCP/tool primitives: https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md
  - GitNexus issue #415 explains why `detect_changes` risk can be misleading when added and modified symbols are not distinguished: https://github.com/abhigyanpatwari/GitNexus/issues/415
  - GitNexus PR #416 documents an intended direction for better `detect_changes` change-type/risk scoring, but it is not local rc.109 behavior: https://github.com/abhigyanpatwari/GitNexus/pull/416
  - GitNexus issue #414 documents output explosion risk for highly connected symbols and supports summary-first `impact` use: https://github.com/abhigyanpatwari/GitNexus/issues/414
  - GitHub Actions token docs recommend least privilege for `GITHUB_TOKEN`: https://docs.github.com/en/actions/tutorials/authenticate-with-github_token
  - GitHub workflow syntax docs define `pull-requests: write`, `checks`, `statuses`, fork permission downgrades, and read-only fork behavior: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
  - GitHub events docs warn that `pull_request_target` runs in base context and untrusted code/security implications must be handled carefully: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
  - GitHub secure-use docs warn against privileged triggers with untrusted checkout and recommend avoiding `pull_request_target` when not necessary: https://docs.github.com/en/enterprise-server@3.16/actions/reference/security/secure-use

Historical first implementation slice, now implemented:

- Add a local report-only PR Review / Blast Radius command that composes existing graph primitives and emits Markdown or JSON.
- Command shape to consider:
  - `gitnexus pr-impact --base-ref <ref> --repo <name> --format markdown`
  - `gitnexus pr-impact --scope compare --base-ref main --repo gitnexus-local-features --format json`
- Default behavior:
  - read-only
  - local checkout/diff based
  - no GitHub posting
  - no Actions workflow
  - no token use
  - no network requirement
  - no new dependency

Report schema:

- `metadata`
  - repo
  - scope
  - baseRef
  - generatedAt
  - command route
  - limitations
- `summary`
  - changedFiles
  - changedSymbols
  - affectedProcesses
  - riskLevel
  - recommendation
- `changedSymbols`
  - name
  - type
  - filePath
  - changeType when available
- `affectedProcesses`
  - name
  - processType
  - stepCount
  - changedSteps
- `symbolImpacts`
  - target
  - uid or disambiguation status
  - risk
  - impactedCount
  - direct/depth counts when available
  - affected modules/processes when available
  - partial/truncated flag
- `apiImpacts`
  - route
  - handler
  - consumers
  - responseShape
  - middleware
  - mismatches
  - impactSummary
- `findings`
  - severity
  - risk
  - evidence
  - recommended fix
  - blocksMerge
- `missingCoverage`
  - affected flows without visible test impact
  - callers outside changed files when detectable
- `securityAndAutomationBoundary`
  - report-only
  - no posting/checks
  - token/permission model deferred
- `recommendation`
  - `APPROVE`, `REQUEST_CHANGES`, or `NEEDS_DISCUSSION`

Implemented write set:

- `gitnexus/src/core/pr-impact/report.ts` - pure report builder and Markdown/JSON formatting.
- `gitnexus/src/core/pr-impact/diff-mapping.ts` - range classification helper.
- `gitnexus/src/core/pr-impact/pipeline.ts` - command/MCP pipeline over `detect_changes`, `impact`, and `api_impact`.
- `gitnexus/src/cli/pr-impact.ts` - command handler.
- `gitnexus/src/cli/index.ts` - registered `pr-impact`.
- `gitnexus/src/cli/help-i18n.ts` - localized help routing for the new command/options.
- `gitnexus/src/cli/i18n/en.ts` - English help strings.
- `gitnexus/src/cli/i18n/zh-CN.ts` - Chinese help strings, following existing CLI convention.
- `gitnexus/src/mcp/tools.ts` and `gitnexus/src/mcp/local/local-backend.ts` - read-only local MCP `pr_impact` exposure.
- `gitnexus/test/unit/pr-impact-report.test.ts` - pure formatter/verdict/golden tests.
- `gitnexus/test/unit/pr-impact-diff-mapping.test.ts` - range/deletion/new/unmatched tests.
- `gitnexus/test/unit/pr-impact-pipeline.test.ts` - mocked backend orchestration tests.
- `gitnexus/test/unit/pr-impact-cli.test.ts` - CLI tests with mocked backend.
- `gitnexus/test/unit/calltool-dispatch.test.ts` and `gitnexus/test/unit/tools.test.ts` - MCP registration/dispatch tests.
- `gitnexus/test/unit/cli-index-help.test.ts` - command/help registration.

Files explicitly out of scope for the first slice:

- `.github/workflows/*`
- GitHub Apps, PAT handling, secrets, checks, statuses, or PR comment posting
- MCP tool schema changes
- graph ingestion, resolver, `impact`, `detect_changes`, or `api_impact` internals
- `pr-swarm-review/` canonical prompt logic, except documentation references
- Auto-Updating Code Wiki, regression forensics, E2E generation, multi-repo, and OCaml work
- new dependencies

TDD sequence:

1. Baseline: run `npm test -- test/unit/tools.test.ts test/unit/tool-direct-cli.test.ts test/unit/detect-changes-worktree.test.ts test/integration/api-impact-e2e.test.ts test/unit/impact-pagination.test.ts`.
2. Red 1: add a pure report-builder test proving a `detect_changes` result becomes a Markdown report with summary, changed symbols, affected processes, and report-only automation boundary.
3. Green 1: implement the pure Markdown formatter.
4. Red 2: add a JSON schema/shape test proving metadata, summary, changedSymbols, affectedProcesses, symbolImpacts, apiImpacts, findings, and recommendation are stable.
5. Green 2: add JSON report shaping.
6. Red 3: add orchestrator test with mocked backend proving it calls `detect_changes` once, calls `impact` summary-first for changed symbols, calls `api_impact` for plausible API route handler files, and tolerates no-route errors.
7. Green 3: implement orchestrator with bounded per-symbol analysis and non-blocking API-impact misses.
8. Red 4: add CLI dispatch test for `gitnexus pr-impact --base-ref main --repo gitnexus-local-features --format markdown`.
9. Green 4: wire CLI command and help/i18n strings.
10. Refactor only after focused tests are green.

Acceptance criteria for the proposed slice:

- The command is read-only and local-only.
- Markdown and JSON output are deterministic from fixture inputs.
- `detect_changes` compare/all/staged/unstaged scope can be passed through.
- `impact` calls are bounded/summary-first to avoid hub-symbol output explosion.
- `api_impact` enriches route-handler changes when available and does not fail the whole report when no route is found.
- The report includes a security/automation boundary stating no GitHub posting/check automation occurred.
- No GitHub token, Actions workflow, or network dependency is introduced.
- No source internals for graph traversal or indexing are changed.

Stop rules:

- Stop if the feature requires GitHub comments, checks, statuses, or workflow automation before MAIN approves a security model.
- Stop if a new dependency is required.
- Stop if source implementation would begin before Auto-Reindexing WIP is snapshotted or explicitly accepted as unsnapshotted.
- Stop if the implementation must change `detect_changes`, `impact`, or `api_impact` internals rather than composing them.
- Stop if local graph freshness is too stale to validate meaningful examples and no reindex/snapshot route is approved.

## Task 2 - Auto-Updating Code Wiki

Status: MAIN approved status/dry-run-first implementation slice on 2026-06-06

Objective:

- Refresh existing Code Wiki output after graph freshness is available.

Expected first slice:

- Reuse the existing wiki generator.
- Run only after successful reindex or freshness sweep.
- Skip when no wiki exists unless explicitly configured to create one.
- Check provider readiness before unattended LLM work.
- Record status, skipped reason, duration, and generated page count.

Research verification already run:

- `npm test -- test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts`
- Result: 4 files passed, 119 tests passed.

Precursor tasks before asking MAIN for implementation:

- Re-read current wiki source, CLI/help wiring, provider/LLM config, and focused wiki tests.
- Reconcile expected public behavior against actual local rc.109 behavior.
- Decide whether the first slice is reindex-success-triggered refresh, manual refresh orchestration, or status-only refresh readiness.
- Define skip behavior when no wiki exists, provider readiness behavior, dry-run/report mode, output mutation policy, and operation visibility.
- Draft the exact proposed write set and TDD sequence.
- Record risks, stop rules, and the approval text MAIN would need to provide.

Dependency:

- Requires Task 1 freshness behavior and explicit LLM execution policy.

### Task 2 Readiness Checkpoint - 2026-06-05T18:16+01:00

Readiness verdict:

- Active Goal is readiness/planning only.
- Not approved for source implementation.
- Current evidence supports a narrow first slice around refresh orchestration/status after confirmed graph freshness, not rebuilding wiki generation.

Expected vs actual behavior:

| Area | Expected Task 2 behavior | Current local behavior | Planning response |
| --- | --- | --- | --- |
| Product promise | Auto-updating Code Wiki implies docs stay fresh after code/index changes. | OSS CLI already has `gitnexus wiki`; it is manually invoked. README says wiki reads the indexed graph, groups files into modules, generates per-module pages, and creates an overview. | Build orchestration around the existing command/generator; do not rebuild generation. |
| Graph dependency | Auto-refresh should document the fresh graph, not stale graph state. | `WikiGenerator` reads LadybugDB via `graph-queries.ts` and tracks `wiki/meta.json.fromCommit` against `git rev-parse HEAD`; it does not itself prove the graph index is fresh for that commit. | Gate refresh behind successful Task 1 freshness/reindex evidence before running wiki work. |
| Incremental behavior | Refresh should avoid full regeneration when possible. | `WikiGenerator.incrementalUpdate` diffs `existingMeta.fromCommit..HEAD`, regenerates affected modules, handles small new-file sets, and falls back to full generation on branch divergence or significant new files. | Reuse incremental behavior; first slice should trigger or report it rather than replace it. |
| Provider/cost policy | Unattended refresh must not unexpectedly spend tokens or require interactive setup. | `wikiCommand` can prompt interactively when no saved config exists; non-interactive mode errors without API key/local provider. It supports OpenAI/OpenRouter/Azure/custom/Cursor/Claude/Codex providers. | First slice needs explicit provider readiness checks, dry-run/status behavior, and MAIN policy for unattended LLM use. |
| Output mutation | Auto-refresh can overwrite wiki markdown/HTML artifacts. | Generator writes `wiki/*.md`, `wiki/index.html`, `wiki/module_tree.json`, `wiki/first_module_tree.json`, and `wiki/meta.json` under GitNexus storage, not necessarily repo docs. | First slice must state where output mutates, when to skip, and how to report pages generated/skipped/failed. |
| Existing wiki absence | "Auto-updating" should not silently create a new wiki if the user only wanted existing docs kept fresh. | Invoking `gitnexus wiki` without existing meta performs full generation. | First slice should likely skip when no existing wiki meta exists unless explicitly configured to create. |
| Existing verification | Feature should be testable before source changes. | Focused wiki tests already cover flags, grouping batches, Mermaid sanitizer, LLM client, provider routing, timeout/retry, language/cache behavior, and review mode. | Use those as baseline; add refresh-orchestration tests only after MAIN opens the Task 2 write set. |

Evidence inspected:

- Local source:
  - `gitnexus/src/cli/wiki.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/help-i18n.ts`
  - `gitnexus/src/cli/i18n/en.ts`
  - `gitnexus/src/cli/i18n/zh-CN.ts`
  - `gitnexus/src/core/wiki/generator.ts`
  - `gitnexus/src/core/wiki/graph-queries.ts`
  - `gitnexus/src/core/wiki/llm-client.ts`
  - `gitnexus/src/core/wiki/local-cli-client.ts`
  - `gitnexus/src/core/wiki/cursor-client.ts`
  - `gitnexus/src/core/wiki/html-viewer.ts`
  - `gitnexus/src/core/wiki/mermaid-sanitizer.ts`
- Local tests:
  - `gitnexus/test/unit/wiki-flags.test.ts`
  - `gitnexus/test/unit/wiki-grouping-batch.test.ts`
  - `gitnexus/test/unit/wiki-mermaid-sanitizer.test.ts`
  - `gitnexus/test/unit/wiki-llm-client.test.ts`
- Public/reference evidence:
  - GitNexus README wiki section: https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md#wiki-generation
  - GitNexus architecture map: https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md
  - GitNexus issue #302: https://github.com/abhigyanpatwari/GitNexus/issues/302
  - GitNexus triage issue #422 references wiki-related history: issue #265 language support, PR #252 large-repo grouping, issue #166 context overflow, issue #156 Ollama hang, issue #95 language setup.

Commands run:

```powershell
rg -n "wiki|Code Wiki|generateWiki|WikiGenerator|wiki-flags|wiki-grouping|wiki-llm|mermaid|provider|llm" gitnexus/src gitnexus/test ARCHITECTURE.md README.md
rg --files gitnexus/src/core/wiki gitnexus/src/cli gitnexus/test/unit | rg "wiki|help-i18n|i18n"
rg -n "class WikiGenerator|generate\(|generateWiki|wiki\)|command.*wiki|case 'wiki'|--force|--timeout|--retries|provider|base-url|model|lang" gitnexus/src/cli gitnexus/src/core/wiki gitnexus/src/server
rg -n "describe\(|it\(" gitnexus/test/unit/wiki-flags.test.ts gitnexus/test/unit/wiki-grouping-batch.test.ts gitnexus/test/unit/wiki-llm-client.test.ts gitnexus/test/unit/wiki-mermaid-sanitizer.test.ts
gitnexus query --repo gitnexus-local-features "WikiGenerator wikiCommand incrementalUpdate generateOverview llm-client graph-queries" --limit 8
npm test -- test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts
```

Verification result:

- Focused wiki baseline passed: 4 files, 119 tests.
- Host graph query found `wikiCommand`, `WikiGenerator`, `llm-client.ts`, and related local source surfaces.
- Graph query also logged Windows VECTOR-unavailable exact-scan fallback; this does not affect the wiki tests.

Likely first implementation slice to take to MAIN:

- Add a small core/server orchestration layer that can decide whether wiki refresh should run after a successful freshness/reindex event.
- Default to dry-run/status-first behavior unless an explicit config enables output mutation.
- Skip when no existing wiki meta exists unless an explicit create-on-refresh option is approved.
- Check provider readiness before invoking LLM generation; never enter interactive setup in an unattended path.
- Record status: skipped reason, provider readiness, graph freshness source, mode (`up-to-date`, `incremental`, `full`), pages generated, failed modules, duration.

Open policy questions before implementation approval:

- Should Task 2 mutate stored wiki output automatically, or first expose a status/dry-run report only?
- Which provider route is allowed for unattended refresh: OpenAI-compatible env/config, Cursor/Claude/Codex local CLI, or none by default?
- Is token/cost budget required before background refresh can run?
- Should auto-refresh run only for repos with existing `wiki/meta.json`, or create a new wiki when none exists?
- Should wiki refresh be attached to the Task 1 auto-reindex sweep, a manual command, a server operation endpoint, or both?

Proposed TDD shape if MAIN later approves:

1. Red: refresh planner skips when graph is stale or Task 1 did not report successful freshness.
2. Green: implement pure planner with no filesystem/output mutation.
3. Red: planner skips when no existing wiki meta exists and create-on-refresh is disabled.
4. Green: add wiki-meta detection through injected storage probes.
5. Red: planner reports provider-not-ready without interactive prompts.
6. Green: add provider readiness abstraction around existing config/env/local provider detection.
7. Red: orchestration result records mode/pages/skipped reason/duration from a mocked `WikiGenerator`.
8. Green: wire orchestration to existing generator only after all gates pass.

Proposed write set if MAIN approves the status/dry-run first slice:

- `gitnexus/src/core/wiki/auto-refresh.ts` - pure planner plus injectable runner for refresh decisions and status result shaping.
- `gitnexus/src/server/wiki-refresh-operations.ts` - optional server-side operation/status wrapper if the slice records wiki refresh attempts alongside server reindex operations.
- `gitnexus/src/server/api.ts` - only for narrow wiring from successful reindex/freshness events into the dry-run/status planner; no unconditional LLM invocation.
- `gitnexus/test/unit/wiki-auto-refresh.test.ts` - planner/runner tests for graph freshness, existing wiki meta, provider readiness, dry-run/status, and result shaping.
- `gitnexus/test/unit/wiki-refresh-api-wiring.test.ts` - only if `api.ts` is touched for event wiring.

Files explicitly out of scope for the first slice:

- `.github/workflows/*`
- `gitnexus/src/core/wiki/generator.ts` except for a tiny exported helper if the approved implementation cannot avoid it.
- `gitnexus/src/core/wiki/prompts.ts`, unless MAIN explicitly asks to change generated content.
- User-facing generated wiki output or stored wiki artifacts.
- Provider credentials, secrets, billing setup, or default model changes.
- PR Impact / Blast Radius, Multi-Repo Support Improvements, regression forensics, E2E generation, or OCaml work.

Suggested MAIN approval text if this plan is accepted:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Auto-Updating Code Wiki
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: status/dry-run-first wiki auto-refresh orchestration after confirmed graph freshness/reindex success. The slice may plan and report whether wiki refresh would run, verify existing wiki meta and provider readiness, skip safely when prerequisites are missing, and shape operation/status results. It must not mutate wiki output by default and must not run unattended LLM generation unless an explicit opt-in config is added in the approved scope.
Approved write set:
- gitnexus/src/core/wiki/auto-refresh.ts
- gitnexus/src/server/wiki-refresh-operations.ts only if operation/status wrapping is needed
- gitnexus/src/server/api.ts only for narrow dry-run/status wiring from successful reindex/freshness events
- gitnexus/test/unit/wiki-auto-refresh.test.ts
- gitnexus/test/unit/wiki-refresh-api-wiring.test.ts only if api.ts is touched
Constraints: no hooks, no new dependencies, no provider credential changes, no generated wiki output mutation by default, no GitHub/PR work, no Multi-Repo source work, TDD required.
```

Approval recorded:

- 2026-06-06T10:16+01:00: User approved implementation. Treat this as `MAIN | READY_FOR_IMPLEMENTATION` for the status/dry-run-first Task 2 slice above.

### Task 2 Wiki Generator Analysis - 2026-06-06T10:24+01:00

Purpose:

- Analyse the existing wiki generator properly before treating "auto-updating Code Wiki" as an implementation problem.
- Separate what GitNexus already has from what is missing for safe unattended refresh.

Current generator capabilities:

- CLI entrypoint exists: `gitnexus wiki [path]`.
- Source ownership:
  - `gitnexus/src/cli/wiki.ts` resolves repo/index/provider config and drives the command.
  - `gitnexus/src/core/wiki/generator.ts` orchestrates generation.
  - `gitnexus/src/core/wiki/graph-queries.ts` reads graph structure from LadybugDB.
  - `gitnexus/src/core/wiki/llm-client.ts`, `cursor-client.ts`, and `local-cli-client.ts` handle provider calls.
  - `gitnexus/src/core/wiki/html-viewer.ts` bundles the HTML viewer.
  - `gitnexus/src/core/wiki/mermaid-sanitizer.ts` cleans generated Mermaid output.
- Generator phases:
  - prerequisite/meta check
  - graph connection and graph file/symbol/process queries
  - LLM grouping into modules
  - module page generation
  - overview page generation
  - metadata and HTML viewer output
- Existing incremental behavior:
  - `wiki/meta.json.fromCommit` is compared to `git rev-parse HEAD`.
  - same commit plus same language returns `up-to-date`.
  - changed files are mapped back to existing module ownership.
  - affected modules are regenerated.
  - branch divergence or more than five new files can trigger fuller regeneration.
- Existing safety and resilience:
  - CLI checks for an existing GitNexus index before generation.
  - provider config supports OpenAI-compatible APIs, Azure, Cursor, Claude, and Codex.
  - timeout/retry options exist.
  - LLM base URL validation rejects non-HTTP schemes and remote plain HTTP.
  - focused tests already cover flags, local providers, timeout/retry, grouping batches, language/cache behavior, Mermaid sanitization, and LLM client behavior.

Deficiencies for unattended auto-update:

| Deficiency | Evidence | Risk for auto-update | Required planning response |
| --- | --- | --- | --- |
| Wiki freshness is not graph freshness | `WikiGenerator.run()` compares wiki meta commit to repo `HEAD`; graph reads come from existing LadybugDB. | Auto-refresh could document stale graph state if run after a code change but before successful reindex. | Gate auto-refresh behind confirmed graph freshness/reindex success from Task 1. |
| CLI is interactive and config-mutating | `wikiCommand` can prompt for provider setup and save `~/.gitnexus/config.json`. | Background refresh could hang, prompt, or persist config unexpectedly. | Auto-refresh must not call `wikiCommand`; use injectable/core runner and explicit provider readiness. |
| Generator mutates output as part of normal run | `run()` creates wiki dir, may regenerate HTML viewer even when up-to-date, and `--force` deletes markdown/snapshot files. | A status check could accidentally modify stored wiki output. | First slice must be dry-run/status-first and must not call `WikiGenerator.run()` unless output mutation is explicitly enabled. |
| Missing and corrupt wiki meta are collapsed in the generator | `loadWikiMeta()` catches all errors and returns `null`. | Automation could treat corrupt meta like "no wiki" and full-generate or skip unclearly. | Auto-refresh planner should distinguish missing/corrupt meta in its own preflight status. |
| Incremental heuristics are coarse | Small unknown files are assigned to `Other`; more than five new files forces fuller generation; deleted/renamed files depend on module meta behavior. | Auto-refresh may over-refresh or produce partial/outdated module ownership. | First slice should report mode/risks and avoid promising perfect incremental correctness. |
| Failed modules do not fail the whole manual command | Failed modules are collected and printed, while CLI still reports generation summary. | Automation needs machine-readable partial-failure status, not just console text. | Auto-refresh result must shape `failedModules`, `pagesGenerated`, mode, and status clearly. |
| No existing generated wiki was found locally | No `wiki/meta.json` was found under `C:\Users\steve\.gitnexus` for this repo during the check. | Auto-update cannot safely refresh a wiki that does not exist unless creation is explicitly approved. | Default should skip `missing-wiki-meta`; creation must be separate opt-in policy. |
| No saved LLM config was found locally | Sanitized config check found no `~/.gitnexus/config.json` and no visible API env vars. | Unattended generation is not provider-ready by default. | Provider readiness must be explicit; local CLI providers may be considered only if approved. |

Current local readiness facts:

- `gitnexus status` reports the host index for this repo is up to date at commit `b5ce5ab`.
- `gitnexus wiki --help` confirms the wiki CLI is available.
- `codex --version` and `claude --version` show local CLI providers are installed, but local provider use is still a policy choice.
- `npm test -- test/unit/wiki-auto-refresh.test.ts` now passes after adding the first status/dry-run planner/runner WIP tests: 1 file, 5 tests.

Planning conclusion:

- Treat the current wiki generator as a manual generation engine.
- Treat Task 2 as an automation preflight/orchestration layer in front of that engine.
- Do not modify generator prompts, graph queries, grouping, or HTML rendering in the first slice.
- Do not wire auto-refresh directly to user-facing output mutation yet.
- First implementation slice remains valid but should be understood as "make the automation decision safe and observable", not "generate/refresh the wiki automatically".

Refined first-slice requirements:

- Pure planner:
  - require confirmed graph freshness
  - require existing wiki metadata by default
  - distinguish missing/corrupt wiki metadata
  - require provider readiness
  - default to dry-run/status
- Runner:
  - never call the generator unless `dryRun: false` and `mutateOutput: true`
  - shape `mode`, `pagesGenerated`, `failedModules`, `durationMs`, `status`, and `reason`
  - return skipped/dry-run statuses without output mutation or LLM invocation
- Later implementation, not first slice:
  - actual server/API/event wiring
  - provider policy UI/config
  - creation of new wiki artifacts when none exist
  - generated output publication
  - tuning incremental-generation heuristics

### Task 2 Implementation Checkpoint - 2026-06-06T10:26+01:00

Status:

- Core status/dry-run-first planner/runner implemented locally.
- No server/API wiring was needed for the first slice.
- No generated wiki output was created or mutated.

Files changed in this slice:

- `gitnexus/src/core/wiki/auto-refresh.ts`
- `gitnexus/test/unit/wiki-auto-refresh.test.ts`

Implemented behavior:

- `planWikiAutoRefresh` requires confirmed graph freshness.
- Missing wiki metadata skips by default instead of creating a new wiki.
- Corrupt wiki metadata is distinguished from missing metadata.
- Provider-not-ready status skips instead of prompting or running generation.
- Dry-run/status is the default even when all prerequisites are ready.
- `runWikiAutoRefresh` invokes an injected generator only when `dryRun: false` and `mutateOutput: true`.
- Runner result shapes `status`, `reason`, `durationMs`, `mode`, `pagesGenerated`, and `failedModules`.
- `readWikiAutoRefreshMeta` reads `storagePath/wiki/meta.json` and returns missing/corrupt/valid status without throwing.

Verification:

```powershell
npm test -- test/unit/wiki-auto-refresh.test.ts
npm test -- test/unit/wiki-auto-refresh.test.ts test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts
npm test -- test/unit/reindex-auto-sweep.test.ts test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts test/unit/staleness.test.ts
npm run build
git diff --check
```

Results:

- `wiki-auto-refresh`: 1 file, 8 tests passed.
- Focused wiki suite: 5 files, 127 tests passed.
- Focused reindex/freshness suite: 7 files, 62 tests passed.
- Build passed.
- Diff whitespace check passed.

Residual risks and next boundaries:

- Local provider detection logs warn that Codex/Claude CLI version checks failed inside test paths, even though local `codex --version` and `claude --version` worked in shell checks. Treat unattended provider readiness as explicit policy, not assumed.
- Existing manual generator incremental heuristics remain unchanged.
- Server/API event or mutation wiring remains a later boundary; the read-only status endpoint added below does not run the generator or attach wiki refresh to reindex completion.

### Task 2 API Status Wiring Checkpoint - 2026-06-07T13:25+01:00

Goal:

- Add the smallest useful server/API surface for the existing wiki auto-refresh planner without invoking generation.

Proposal chosen:

- `GET /api/wiki/auto-refresh`
- Optional `?repo=<name>` through the existing `requestedRepo(req)` and `resolveRepo(...)` path.
- Read-only status response only.
- Default provider status is intentionally not ready because unattended server-side provider execution is not wired or approved.

Focused public/source evidence:

- GitNexus README states `gitnexus wiki` generates LLM-powered documentation from the knowledge graph and that the generator reads indexed graph structure, groups files into modules via LLM, generates module pages, and creates an overview page: https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md#wiki-generation
- GitNexus architecture maps wiki ownership to `src/core/wiki/`: https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md
- GitNexus issue #302 is an external generated-docs-site proposal, closed as not planned, with no development branch or PR attached: https://github.com/abhigyanpatwari/GitNexus/issues/302
- GitNexus triage issue #422 lists wiki-related history, including PR #252 for large-repo grouping overflow, issue #166 for wiki context overflow, issue #156 for Ollama hangs, and issue #265 for wiki language support: https://github.com/abhigyanpatwari/GitNexus/issues/422
- GitNexus issue #1400 shows Windows/local registry and freshness visibility has had real failure modes, reinforcing explicit status/freshness reporting before downstream automation: https://github.com/abhigyanpatwari/GitNexus/issues/1400

Implemented behavior:

- The route resolves a registered repo and returns `404`/`503` consistently with `/api/repo` when the repo is missing or still being analyzed.
- The route checks graph freshness with `checkStalenessAsync(entry.path, entry.lastCommit)`.
- The route reads existing wiki metadata with `readWikiAutoRefreshMeta(entry.storagePath)`.
- The route calls `planWikiAutoRefresh(...)` with `dryRun: true`, `mutateOutput: false`, and a conservative provider-not-ready status.
- The response includes repo identity (`repoName`, `repoPath`, `storagePath`) plus the planner shape.

Explicit non-behavior:

- Does not call `runWikiAutoRefresh`.
- Does not instantiate or call `WikiGenerator`.
- Does not run LLM providers.
- Does not create, refresh, delete, publish, or mutate wiki output.
- Does not attach wiki refresh to reindex completion.
- Does not add dependencies, hooks, or provider configuration.

TDD evidence:

```powershell
npm test -- test/unit/wiki-auto-refresh-api-wiring.test.ts
```

Red result:

- Failed because `api.ts` did not contain `planWikiAutoRefresh`, proving the new source-wiring test was testing absent behavior.

Green result:

- Passed after adding the route and imports: 1 file, 1 test.

Files changed in this slice:

- `gitnexus/src/server/api.ts`
- `gitnexus/test/unit/wiki-auto-refresh-api-wiring.test.ts`

Verification before completion:

```powershell
npm test -- test/unit/wiki-auto-refresh.test.ts test/unit/wiki-auto-refresh-api-wiring.test.ts
npm test -- test/unit/reindex-freshness-wiring.test.ts test/unit/reindex-api-wiring.test.ts
npm run build
git diff --check
git status --short --branch
```

Results:

- Focused wiki planner/API tests passed: 2 files, 9 tests.
- Nearby reindex API/freshness wiring tests passed: 2 files, 23 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `git status --short --branch` showed only the intended docs/source/test files changed.

### Task 2 Post-Endpoint Readiness Boundary - 2026-06-07T13:31+01:00

Goal:

- Determine the next safe Task 2 boundary after the read-only wiki auto-refresh status endpoint.

Current expected vs actual:

| Candidate next slice | Expected value | Actual source/risk evidence | Readiness verdict |
| --- | --- | --- | --- |
| Reindex-completion status wiring | After a reindex completes, the server could compute and expose the wiki auto-refresh plan. | Reindex completion already coordinates DB close/reopen, backend refresh, operation records, queue release, and pending reruns. Adding wiki status there is read-only but touches a sensitive lifecycle path. | Possible later, but not necessary until a UI/consumer needs persisted operation-level wiki status. |
| Manual refresh/mutation endpoint | A user could request actual wiki refresh from the server. | `WikiGenerator.run()` creates/updates wiki files and may call LLM providers; `wikiCommand` can save config and prompt interactively. | Not ready without explicit provider, cost, output, auth, and rollback policy. |
| Provider readiness policy | Server could detect OpenAI-compatible env/config or local CLI providers and mark provider ready. | Existing provider detection lives in CLI/wiki flows and local CLI helpers; tests have already shown local CLI version checks can behave differently under test. | Needs its own policy/implementation goal before any unattended generation. |
| Defer Task 2 after status endpoint | Keep a safe, observable status surface and move to another feature or product decision. | Current endpoint gives users/agents a status view without mutating docs or spending tokens. | Recommended default. |

Source ownership map:

| Area | Current owner |
| --- | --- |
| Read-only auto-refresh planning | `gitnexus/src/core/wiki/auto-refresh.ts` |
| Read-only server status endpoint | `gitnexus/src/server/api.ts` |
| Manual wiki command/provider setup | `gitnexus/src/cli/wiki.ts` |
| Actual generated output mutation | `gitnexus/src/core/wiki/generator.ts`, `html-viewer.ts` |
| LLM HTTP/local provider execution | `gitnexus/src/core/wiki/llm-client.ts`, `local-cli-client.ts`, `cursor-client.ts` |
| Reindex lifecycle | `gitnexus/src/server/api.ts`, `reindex-operations.ts`, `reindex-follow-up.ts` |

Recommendation:

- Treat Task 2 local V1 as complete after the read-only status endpoint.
- Do not add a mutation endpoint or background generation without a new explicit MAIN approval.
- Do not wire wiki status into reindex completion unless a consumer need is named; the manual `GET /api/wiki/auto-refresh` endpoint is enough for status discovery today.
- If MAIN later wants to continue Task 2, the next defensible readiness goal should be provider/output mutation policy, not source implementation.

Potential MAIN approval text if mutation is later desired:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Auto-Updating Code Wiki
Approved slice: provider/output mutation policy V1 only. Define and implement explicit server-side provider readiness detection and mutation authorization for wiki refresh. The slice must not call WikiGenerator until tests prove disabled-by-default behavior, no interactive prompts, no credential writes, explicit opt-in, clear output path, rollback/reporting behavior, and safe failure handling.
```

If MAIN does not provide that policy approval:

- Record `NO_NEXT_GOAL_CREATED` for Task 2 mutation work and choose the next feature/readiness goal from the remaining priority-dependent candidates.

## Task 3 - Multi-Repo Support Improvements

Status: next tranche after Auto-Updating Code Wiki; implementation not approved

Objective:

- Reconcile current multi-repo/group support with stale docs/tool tables and identify the smallest useful improvement to group/status/contract ergonomics.

Expected first slice:

- Verify the current source truth for group-aware `query`, `context`, and `impact`.
- Verify how group status/contracts are exposed through current resources and CLI commands.
- Correct stale guidance or choose one small ergonomics improvement; do not expand to a unified cross-repo graph unless MAIN approves that scope.

Research verification to run or refresh:

- Inspect `gitnexus/src/core/group/`, `gitnexus/src/mcp/`, current CLI group commands, `ARCHITECTURE.md`, and relevant group tests.
- Run host graph checks with `gitnexus query --repo gitnexus-local-features` where useful.
- Run the narrowest current group/tool tests once the candidate slice is selected.

Dependency:

- Readiness mapping may proceed before a snapshot because it is evidence gathering and documentation only.
- Task 3 source implementation requires a Task 1/Task 2 snapshot or an explicit MAIN no-snapshot decision.
- Must not depend on stale tables that still present `group_query`, `group_contracts`, or `group_status` as current MCP tools.

### Task 3 Readiness Evidence Checkpoint - 2026-06-06T10:50+01:00

Goal:

- Begin the active Task 3 readiness Goal by mapping actual multi-repo/group surfaces before proposing any implementation slice.

Current expected-vs-actual correction:

| Surface | Current source truth | Planning consequence |
| --- | --- | --- |
| CLI group commands | `gitnexus group create/add/remove/list/status/sync/impact/query/contracts` are present in `gitnexus/src/cli/group.ts`. | Do not call CLI `group query/contracts/status` stale; they remain real user-facing commands. |
| MCP group tools | `group_list` and `group_sync` are registered. `group_sync` is marked mutating/destructive. | MCP tool improvement scope should not invent old `group_query/group_contracts/group_status` tools. |
| MCP group-mode analysis | `query`, `context`, and `impact` route to `GroupService` when `repo` starts with `@<groupName>` or `@<groupName>/<memberPath>`. | Agent-facing guidance should teach `repo: "@group"` routing for analysis. |
| MCP group resources | `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status` are resource templates. | Contracts/status inspection should prefer resources in MCP workflows. |
| Removed MCP tools | `group_query`, `group_contracts`, and `group_status` throw a migration message from `LocalBackend`. | Stale tables should be corrected where they imply these are current MCP tools. |
| Local runtime groups | `gitnexus group list` currently reports no configured groups on this workstation. | Runtime smoke can verify empty-state behavior, but realistic group behavior needs fixtures or a deliberate local test group. |

Source ownership found:

| Area | Source/Test Surfaces |
| --- | --- |
| CLI | `gitnexus/src/cli/group.ts` |
| Core service | `gitnexus/src/core/group/service.ts`, `sync.ts`, `cross-impact.ts`, `storage.ts`, `types.ts`, `config-parser.ts`, `group-path-utils.ts` |
| Bridge/contracts | `bridge-db.ts`, `bridge-schema.ts`, `contract-extractor.ts`, extractors under `gitnexus/src/core/group/extractors/` |
| MCP tools/resources | `gitnexus/src/mcp/tools.ts`, `gitnexus/src/mcp/resources.ts`, `gitnexus/src/mcp/local/local-backend.ts` |
| Tests | `test/unit/group/*`, `test/unit/mcp/group-repo-routing.test.ts`, `test/unit/resources.test.ts`, `test/integration/group/*` |

Commands run:

```powershell
gitnexus status
gitnexus group --help
gitnexus group list
rg --files gitnexus/src gitnexus/test ARCHITECTURE.md README.md | rg "group|contract|mcp|multi|bridge|workspace|resource|routing|query|impact|context"
rg -n "group|multi-repo|multi repo|contracts|group_query|group_contracts|group_status|group-aware|bridge|cross-repo|cross repo|context\(|impact\(|query\(" ARCHITECTURE.md README.md gitnexus/src gitnexus/test
gitnexus query --repo gitnexus-local-features "GroupService groupQuery groupContext groupImpact group contracts status resources MCP group mode" --limit 8
gitnexus query --repo gitnexus-local-features "group CLI create add remove list status sync impact query contracts" --limit 8
npm test -- test/unit/group/group-tools.test.ts test/unit/mcp/group-repo-routing.test.ts test/unit/resources.test.ts
```

Verification:

- `gitnexus status` reported this repo up to date at commit `b5ce5ab`.
- `gitnexus group --help` listed all current CLI group subcommands.
- `gitnexus group list` reported no groups configured.
- GitNexus graph queries found `registerGroupCommands`, `GroupService`, `getResourceTemplates`, `handleGroupTool`, and group-related tests.
- Focused MCP/group surface tests passed: 3 files, 52 tests.

Initial conclusion:

- The likely Task 3 improvement is not "add multi-repo support." It is current-surface reconciliation and maybe ergonomics around group status/contracts/routing guidance.
- The next readiness step is to inspect group service behavior and integration fixtures to decide whether the smallest useful slice is documentation correction, resource/status output hardening, CLI/MCP terminology alignment, or a small test-backed ergonomics improvement.

### Task 3 Decision-Complete Readiness Map - 2026-06-06T10:53+01:00

Readiness verdict:

- Task 3 is ready to take to MAIN as a documentation/tool-surface reconciliation slice.
- Do not implement a unified cross-repo graph in this tranche.
- Do not change group service behavior, MCP tool schemas, CLI commands, or bridge storage unless MAIN rejects the docs-only slice and names a behavior gap.

Expected vs actual:

| Source | Expected / stated behavior | Actual local/source behavior | Conclusion |
| --- | --- | --- | --- |
| Enterprise README wording | "Multi-repo support - unified graph across repositories." | Source implements repository groups, contract extraction, bridge graph, group-aware query/context/impact, and group resources. | Enterprise phrase is broader than the current OSS/local mechanism; local Task 3 should not promise a new unified graph without MAIN scope expansion. |
| README "What Your AI Agent Gets" table | Says **16 tools** and lists `group_contracts`, `group_query`, `group_status` as MCP tools. | `gitnexus/test/unit/tools.test.ts` asserts 13 MCP tools: 11 per-repo plus `group_list` and `group_sync`. | README MCP tool table is stale. |
| ARCHITECTURE.md | Lists 13 MCP tools, group-mode `query/context/impact`, and group contracts/status resources. | Matches `tools.ts`, `resources.ts`, `LocalBackend`, and focused tests. | Architecture is the current source-aligned reference. |
| CLI commands | README CLI command list includes `gitnexus group query/contracts/status`. | `gitnexus group --help` and `gitnexus/src/cli/group.ts` confirm these CLI commands exist. | CLI docs should keep these commands; only MCP tool table needs correction. |
| MCP removed tools | Some stale material still implies `group_query/group_contracts/group_status` are tools. | `LocalBackend.callTool` rejects those names with migration guidance. | Use resources or `repo: "@group"` routing in MCP workflows. |
| Runtime group state | Multi-repo commands should handle empty local config. | `gitnexus group list` returns "No groups configured." | Empty-state behavior is healthy; fixture tests cover real group behavior. |

Primary source evidence:

- Local `ARCHITECTURE.md` already states the intended current MCP architecture.
- Public upstream `ARCHITECTURE.md` on GitHub says the same: MCP tools are 13, `query/context/impact` are group-aware, and group contracts/status are resources.
- Public upstream `AGENTS.md` changelog records removal of `group_query/group_contracts/group_status` MCP tools and addition of group contracts/status resources.

Source ownership map:

| Concern | Owner |
| --- | --- |
| Current README drift | `README.md`, section "What Your AI Agent Gets" |
| Correct architecture reference | `ARCHITECTURE.md`, "MCP tools" and cross-repo groups sections |
| MCP tool definitions | `gitnexus/src/mcp/tools.ts` |
| MCP group resources | `gitnexus/src/mcp/resources.ts` |
| MCP group-mode routing | `gitnexus/src/mcp/local/local-backend.ts` |
| CLI group commands | `gitnexus/src/cli/group.ts` |
| Shared group service | `gitnexus/src/core/group/service.ts` |
| Contract sync / bridge / cross impact | `sync.ts`, `bridge-db.ts`, `bridge-schema.ts`, `cross-impact.ts`, extractors under `gitnexus/src/core/group/extractors/` |
| Surface tests | `gitnexus/test/unit/tools.test.ts`, `test/unit/group/group-tools.test.ts`, `test/unit/mcp/group-repo-routing.test.ts`, `test/unit/resources.test.ts`, `test/integration/group/*` |

Smallest safe implementation slice:

- Update `README.md` "What Your AI Agent Gets" so it matches source truth:
  - change "16 tools (11 per-repo + 5 group)" to "13 MCP tools (11 per-repo + 2 group-specific)".
  - add missing current per-repo tools: `api_impact`, `route_map`, `tool_map`, and `shape_check`.
  - remove `group_contracts`, `group_query`, and `group_status` from the MCP tools table.
  - add a short note that group analysis is performed through `query`, `context`, and `impact` using `repo: "@<groupName>"` or `repo: "@<groupName>/<memberPath>"`.
  - keep `gitnexus group query/contracts/status` in the CLI command list because those are real CLI commands.
  - ensure resources list includes `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status`.

Proposed write set:

- `README.md`

No source-code write set is recommended for the first Task 3 slice.

Focused verification for the docs-only slice:

```powershell
rg -n "16 tools|group_contracts|group_query|group_status|13 MCP tools|repo: \"@<groupName>\"|gitnexus://group/{name}/contracts|gitnexus://group/{name}/status" README.md ARCHITECTURE.md
npm test -- test/unit/tools.test.ts test/unit/group/group-tools.test.ts test/unit/mcp/group-repo-routing.test.ts test/unit/resources.test.ts
npm test -- test/integration/group
git diff --check -- README.md
```

Risks:

- If MAIN wants "unified graph across repositories" literally, README reconciliation is not enough and the task becomes a large architecture project.
- If docs are changed without making the CLI/MCP distinction explicit, future agents will again confuse CLI group commands with MCP group tools.
- If `README.md` remains stale, agent-facing public docs will continue telling agents to call removed MCP tools.

Stop rules:

- Stop if implementation pressure moves beyond `README.md`.
- Stop if MAIN requests actual unified cross-repo graph behavior; that requires a new decision-grade architecture plan.
- Stop if verification shows `tools.ts` or `ARCHITECTURE.md` have changed underneath this plan.

Suggested MAIN approval text:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Multi-Repo Support Improvements
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: documentation/tool-surface reconciliation only. Update README.md so the MCP tool table matches current source truth: 13 MCP tools, 11 per-repo plus group_list/group_sync; group analysis through query/context/impact with repo "@<groupName>" or "@<groupName>/<memberPath>"; group contracts/status via resources; keep CLI group query/contracts/status documented as CLI commands.
Approved write set:
- README.md
Constraints: no GitNexus source-code changes, no MCP schema changes, no CLI behavior changes, no unified cross-repo graph work, no hooks, no new dependencies. Verify with focused MCP/group surface tests and git diff --check.
```

Approval recorded:

- 2026-06-06T10:55+01:00: User clarified standing conditional implementation authorization for all goals after readiness/research is complete. This authorizes the Task 3 docs-only `README.md` slice above because its readiness map is complete and the write set is exact.

Implementation status:

- 2026-06-06T10:57+01:00: Task 3 docs-only `README.md` slice implemented and verified. No source-code, MCP schema, CLI behavior, dependency, hook, or unified graph changes were made.

## Deferred Tasks

- Auto Regression Forensics: wait for PR Impact report schema and CI/failure evidence model.
- End-to-End Test Generation: first local app/runtime/framework contract now points to `gitnexus-web` + Playwright; executable generated tests still require a later output policy.
- Regression Forensics requires a failing-test/known-good/known-bad evidence contract; E2E generation requires an app launch/browser/test-framework contract. Do not plan implementation for either from the current `eval/` harness alone.
- OCaml Support: separate language-support project with parser/provider/test burden; do not mix into the first feature sequence.

## Research Methodology For Remaining Work

Use this order for each feature before implementation:

1. Expected behavior: public README/enterprise wording, relevant GitHub PRs/issues, and external analogues.
2. Actual behavior: local source, tests, `ARCHITECTURE.md`, and `gitnexus query --repo gitnexus-local-features` graph checks.
3. Dependency shape: what the feature needs from previous features and which surfaces it would touch.
4. Smallest safe slice: the minimum useful behavior that can be tested independently.
5. Lane boundary: exact write set, tests, risks, green/amber/red classification, and stop rules.

Do not implement from research notes alone. Auto-Reindexing, Auto-Updating Code Wiki, Multi-Repo Support Improvements, PR Impact / Blast Radius, Auto Regression Forensics, End-to-End Test Generation, and OCaml Support have local slices implemented and verified. Task 4 GitHub PR Automation Boundary readiness, Task 6 `/api/info` API-Smoke Route implementation, Task 7 OCaml Module-System Depth readiness, Task 4 No-Write Graph Primitives, Task 4 Deleted/Base-Graph Mapping, Task 2 Full Wiki Mutation / Provider Execution readiness, Post-Tranche Consolidation / Next-Slice Selection, and Worktree Verification / Checkpoint Packet are complete for the current run. There is `NO_NEXT_TASK_SELECTED` for feature expansion; choose a new selected-task packet before any new feature behavior, provider execution, secrets/tokens, output publication, unattended generation, GitHub/token/CI write surfaces, or other red-lane boundary work.

## TDD Execution Rule

When the selected task opens a green/amber feature write scope, implementation should proceed one behavior at a time:

1. Run the relevant focused baseline tests and record the result.
2. Write one minimal test for the next intended behavior.
3. Run that test and confirm it fails for the expected product reason, not a typo or harness error.
4. Implement only enough code to make that test pass.
5. Re-run the focused test and any nearby affected tests.
6. Refactor only after green, keeping the same tests green.
7. Repeat for the next behavior until the approved slice's acceptance criteria are covered.

For Auto-Reindexing, the first TDD candidates are stale repo selected, fresh repo skipped, dry-run no-op, same-repo coalescing, invalid registry entry handling, explicit auto/freshness operation trigger, and watcher failure not blocking sweep recovery.
