# GitNexus Engineering Plan

> Task: Finish PR #2785's skill-evolution reliability/concurrency work, close the remaining workflow gaps, then perform a graph-backed pre-merge review.
> Evidence verified at commit f7a1c282915c6113cdb5b28d1d275070e298f503; enterprise GitNexus index reported 2026-08-22 but is incomplete for this PR head (new scheduler symbols absent), cannot be refreshed through the enterprise MCP runtime, and has no PDG layer; source evidence is weighted above graph evidence.
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 20 sorted entries; exact generated plan path excluded.

## 1. Objective

Complete the already-substantial PR without reopening its validated core design: retain its evidence-stream tolerance, shared session deadline, promotion schema v4, live progress, and deterministic wave concurrency; repair prior-evidence selection so failed evidence-bearing runs can seed the next proposal; make scheduled concurrency safely operator-configurable; reconcile current `main`; then require fresh validation and GitNexus review evidence before merge.

## 2. Current Behaviour

- [verified] The PR accepts exactly one Claude `result` followed only by `system` bookkeeping and cuts the evidence window at that result; any later non-system event still fails closed (`eval/workflow_bench/runner_sessions.py:350-454`).
- [verified] Both driver CLIs default to the shared 5,400-second session ceiling, and `evolve.runner_argv` forwards both timeout and workers into `workflow_bench.runner` (`eval/workflow_bench/runner_sessions.py:35-43`, `eval/workflow_bench/evolve.py:561-675`, `eval/workflow_bench/runner.py:1137-1240`).
- [verified] `run_managed(echo_stdout=True)` uses `read1` and writes child stdout to parent stderr while preserving bounded tails; the Claude-session call leaves echo disabled (`eval/workflow_bench/process_control.py:124-152,426-505,692-733`; `eval/workflow_bench/runner_sessions.py:418-428`).
- [verified] `sweep_task_cells` executes fixed-order waves, folds completed rows in submission order, keeps `workers=1` on the calling thread, and lets unexpected worker failures escape (`eval/workflow_bench/runner.py:643-698`). Each `run_cell` owns a unique clone and cell-local record while reusing immutable task/graph snapshots (`eval/workflow_bench/runner.py:701-960`; `eval/workflow_bench/runner_artifacts.py:300-339`; `eval/workflow_bench/task_assets.py:125-153`).
- [verified] `evaluate_candidate` excludes fully measured, mutually-unsolved tasks from the quality floor, per-task cap, and median; it emits `ungated_tasks` and refuses generations in which every task lacks quality signal (`eval/workflow_bench/evolution.py:478-675`). Producer and apply validation use promotion schema 4.
- [verified] The workflow now nests 19-hour step / 21-hour job / 24-hour host budgets, streams output, uploads evidence with `always()`, and exposes a manual `workers` input (`.github/workflows/gitnexus-skill-evolution.yml:89-154,304-351`).
- [verified] Repository variable `GITNEXUS_EVOLUTION_ENABLED` is currently `true`. Scheduled runs on Aug 8, 15, 22, and 29 executed and failed; the newest failure was exhausted API credit, not a code verdict. The Aug 22 artifact contained 36 cells, including seven trailing-system-event exclusions and six old-ceiling timeouts.
- [verified] PR #2785 is a cross-repository branch at `magyargergo/GitNexus:fix/skill-evolution-gate`, and GitHub reports `maintainerCanModify=true`; implementation commits must be pushed back to that branch, not to the read-only `refs/pull/2785/head` tracking ref.

## 3. Relevant Architecture

- [graph] Enterprise `query` found the driver flow rooted at `evolve.main`, with `required_candidate_arms`, `candidate_overlay_files`, and `_require_real_directory` as linked preparation steps. Source verification shows the driver launches `workflow_bench.runner`, which prepares one graph/task snapshot per task and then schedules `(run, arm)` cells.
- [graph] Bounded Cypher found 13 three-hop call paths from `runner.main` to `run_managed`, including `main → run_arm → run_claude → run_managed`, graph preparation, worktree creation, verification, overlay application, and hidden-oracle sanitation. `runner.main → evaluate_candidate` is a direct `CALLS` edge (confidence 0.85).
- [verified] The concurrency seam is deliberately above the cell: `TaskCellContext` is shared read-only; clone, sandbox, result, patch, and cleanup state are local to `run_cell`; result aggregation and JSONL append happen in `keep` on the scheduler thread (`eval/workflow_bench/runner.py:701-960,1333-1466`).
- [verified] Snapshot materialization validates sanitized identity, creates a per-destination staging directory, and publishes exact roots into each unique clone (`eval/workflow_bench/sanitized_graph.py:51-72`; `eval/workflow_bench/task_assets.py:125-175,1057-1086`).
- [graph] `tool_map` reports the repository's 17 OSS MCP tools are defined in `gitnexus/src/mcp/tools.ts`. The connected enterprise runtime exposes a branch-aware subset. Efficient use for this PR is: `query` once for discovery, exact `context`, `impact` summary then d=1 drill-down, `detect_changes` on the explicit file manifest, bounded `cypher` for missing trace/PDG questions, and source verification whenever graph/source disagree.

## 4. GitNexus Findings

- [graph] `detect_changes(scope="compare", base_ref="c6b24162…", changed_files=<13 paths>)` mapped 226 symbols and 15 cross-community processes at `HIGH` risk. New YAML structure is not symbol-indexed, so workflow contracts still require direct review.
- [graph] `impact(target="run_managed", direction="upstream", maxDepth=3, includeTests=true)` returned `CRITICAL`: 91 total, 30 direct (d1), 27 d2, 34 d3, spanning both `evolve.main` and `runner.main` process families.
- [graph] `impact(target="evaluate_candidate", …)` returned `HIGH`: 24 total, 15 direct. `impact(target="run_claude", …)` returned `LOW`: 17 total, 4 direct.
- [graph] `context` confirms `run_claude → run_managed`; `run_arm` plus three hardening tests call `run_claude`; `runner.main` plus 14 gate tests call `evaluate_candidate`.
- [graph] `run_cell` and `sweep_task_cells` return `not found` / `UNKNOWN`, despite being present at the pinned PR head. The graph therefore cannot authorize edits to those symbols or claim their dependent set is empty.
- [verified] The exact PR diff applies cleanly to current `main` (`b9613ee8…`); a merge-tree produced `da75fad3…`. The only overlapping touched path since the PR merge-base is `runtime_mounts.py` from the v1.6.10 release, and the merge resolves it without conflict.
- [verified] Blocking workflow defect: prior-evidence selection uses `gh run list --status success`, while every recent scheduled run is a failure and the last successful `main` artifacts are expired (`.github/workflows/gitnexus-skill-evolution.yml:257-302`). This excludes the Aug 22 evidence-bearing failure and leaves the weekly proposer memoryless.
- [verified] Rollout gap: scheduled events evaluate `inputs.workers || '1'`; changing only the dispatch input default cannot enable scheduled concurrency (`.github/workflows/gitnexus-skill-evolution.yml:89-93,147-151`). The activation checklist also still marks the enabled evolution variable as unset (`:61-64`).

## 5. Statement-Level PDG Findings

- [graph] No statement-level slice can be produced from the enterprise index: node inventory has no `BasicBlock`, and bounded Cypher returned zero `CDG`, `REACHING_DEF`, `TAINTED`, `SANITIZES`, or `TAINT_PATH` relationships. The enterprise runtime also registers no `explain` or `pdg_query` tool. This is unavailable coverage, not a clean taint result.
- [verified] Source-level trust-boundary constraints to preserve: untrusted task setup and model sessions remain inside preflighted sandboxes; `run_managed` retains per-call process ownership; Claude stdout remains captured and redacted before persistence rather than echoed; candidate error details are redacted before live output/JSONL; graph and task snapshots are immutable inputs materialized into unique clones.
- [inferred] A current enterprise `--pdg` branch index is still required for a genuine pre-merge taint verdict. Until that exists, review must explicitly inspect argv/env/stdin/stdout, file publication, symlink/path checks, GitHub artifact input, and secret-bearing error paths rather than infer safety from zero taint rows.

## 6. Proposed Changes

1. [verified] `.github/workflows/gitnexus-skill-evolution.yml` — replace the single `--status success` seed lookup with a bounded newest-first scan of completed `main` runs. For each prior numeric run ID, download into its own runner-temp directory, skip expired/download-failed/empty artifacts, and select the highest `gen-N/bench/results.jsonl` from the first usable run. Preserve best-effort behavior and never let missing history consume a generation.
2. [verified] `.github/workflows/gitnexus-skill-evolution.yml` — define `WORKERS` as manual input, else a repository variable such as `GITNEXUS_EVOLUTION_WORKERS`, else `'1'`. Update the checklist to mark `GITNEXUS_EVOLUTION_ENABLED` complete and document that the scheduled worker variable stays `1` until a funded `workers=3` proof run passes; rollback is setting it to `1`.
3. [verified] `gitnexus/test/unit/skill-evolution-workflow.test.ts` — add structural contracts proving seed selection considers completed failures, retries past unusable artifacts, remains bounded, and emits only one usable seed; assert the scheduled-worker variable/fallback expression and corrected activation text.
4. [verified] `eval/tests/test_evolve.py` — strengthen `test_runner_argv_pairs_each_incumbent_with_its_candidate` with a non-default worker count and assert its exact forwarding, closing the current gap between parser plumbing and the YAML string assertion.
5. [inferred] Keep the core `run_managed`, `run_claude`, `evaluate_candidate`, `run_cell`, and `sweep_task_cells` implementations unchanged unless fresh merge-head validation exposes a regression; their focused PR-head suite currently passes and their blast radius is HIGH/CRITICAL.

## 7. Implementation Sequence

1. Add/fetch the contributor fork remote, bind local `pr-2785` to `magyargergo/GitNexus:fix/skill-evolution-gate`, fetch current `origin/main`, and merge it without rebasing/force-pushing. Resolve the release-version overlap while preserving the PR's removal of the literal runtime pin. Recompute exact base/head/merge-base and rerun enterprise `detect_changes` on the merged head before edits.
2. Change only the workflow seed/worker/checklist contract described in §6. Keep the candidate artifact as untrusted input: bounded run history, numeric run IDs, runner-temp destinations, no symlink-following search, and fail-open only to “no seed,” never to an unvalidated path.
3. Update the TypeScript workflow contract tests and the Python runner-argv test in the same logical change. Exercise: newest failed artifact usable; newest artifact empty then older usable; all downloads unavailable; scheduled worker variable absent/present; explicit dispatch input wins.
4. Run focused validation, then the full eval suite and GitNexus type/unit checks. Do not run a paid benchmark as an implicit test.
5. Before each commit, run enterprise `detect_changes` with the actual changed-file manifest and confirm `partial`/`truncated` are absent; source-confirm any `UNKNOWN`. Commit the workflow/test hardening atomically after the required checks.
6. Run the canonical `gitnexus-review` workflow on the synchronized exact head. Use enterprise `check`/`explain`/`pdg_query` if the runtime has gained them; otherwise record their absence, use bounded Cypher for graph invariants, and do not claim taint coverage. Request changes for any concrete finding before merge.
7. Merge only after current CI is green and GitHub reports the branch current/mergeable. Then restore API credit, run a protected `main` dispatch with `workers=3`, monitor live progress/artifact upload, require zero excluded runs, compare mean cell duration with the 48-minute serial baseline, and only then set `GITNEXUS_EVOLUTION_WORKERS=3` for scheduled runs.

## 8. Test Strategy

- Workflow selection: recent failed run with `results.jsonl` → selected; recent empty/expired run followed by usable older failure → older selected; no usable artifacts → warning and no seed; scan count remains bounded.
- Worker routing: workflow dispatch `workers=3` → runner argv `--workers 3`; scheduled run with repo variable `3` → `WORKERS=3`; absent variable → serial `1`; invalid `0` → existing parser failure.
- Preserve existing session evidence cases: trailing system teardown accepted; trailing assistant event rejected; zero/duplicate result events rejected; timeout remains an excluded session error.
- Preserve process/concurrency cases: `read1` reaches the log before EOF; echo remains off by default; sibling process trees survive another cell's timeout; waves fold deterministically; outage breaker overrun is bounded; workers=1 stays on the calling thread.
- Preserve promotion cases: mutually-unsolved fully measured task is reported but ungated; all-ungated generation is insufficient; schema 3 is rejected and schema 4 accepted.
- Verification commands:
  - `git diff --check`
  - `cd eval && uv run --locked --extra dev python -m pytest tests/`
  - `cd gitnexus && npx vitest run test/unit/skill-evolution-workflow.test.ts`
  - `cd gitnexus && npm run test:unit`
  - `cd gitnexus && npx tsc --noEmit`
  - CI: actionlint, zizmor, CodeQL Python/TypeScript, locked eval pytest, platform containment, and the normal CI gate.
- Baseline observed during planning: targeted eval set passed 191 tests with 4 platform skips. Local Vitest could not start because dependencies were absent; the PR-head CI had passed it, but synchronized-head validation must rerun it.

## 9. Risk and Impact Analysis

- `run_managed` — `CRITICAL`, 30 direct dependents. Production dependents accounted for: `evolve.main`, `sanitize_clone_for_hidden_oracles`, `run_checked`, `committed_destination_base_digests`, `preflight_bubblewrap`, `make_worktree`, `run_verify`, `run_claude`, `resolve_task_bindings`, `_run_graph_cli`, and `SandboxSession.run`. Test dependents accounted for: `test_outer_runner_pid_namespace_kills_setsid_descendant`; the 16 direct process-control tests for exited parents, stdin, interrupts, capture bounds, namespace enforcement, timeout/kill, and Windows jobs; plus the two real-Bubblewrap proposer-sandbox tests. The proposed follow-up does not edit this function.
- `evaluate_candidate` — `HIGH`, 15 direct dependents. Production: `runner.main`. Tests: the oracle-assets weakened-test guard plus 13 candidate-gate tests covering quality/efficiency, resolution margin, cost availability, paired runs, exclusions, cleanup failure, and metric warnings. The proposed follow-up does not edit this function.
- `run_claude` — `LOW`, four direct dependents: `run_arm` and three runner-hardening failure/transcript tests. The proposed follow-up does not edit this function.
- `run_cell` / `sweep_task_cells` — `UNKNOWN` because the enterprise branch index cannot resolve them. Current source and tests prove their presence, but not their graph blast radius; no edit is planned unless the synchronized review finds a concrete defect.
- Workflow seed artifacts cross a GitHub/network-to-filesystem boundary. Keep downloads scoped to same-repository `main` workflow runs, bounded by count, isolated by numeric run ID, and consumed only through existing bounded evidence parsers. A download or malformed artifact must degrade to no seed, not arbitrary path use or gate evidence.
- Parallelism can increase CPU contention and timeout exclusions. Preserve serial default and require measured rollout; do not infer the advertised ~5-hour run until a funded host-sized trial supplies data.
- The PR's old green CI is stale relative to current `main`. A clean merge-tree is conflict evidence, not behavioral validation.

## 10. Files Expected to Change

| File | Symbols / section | Reason |
| ---- | ----------------- | ------ |
| `.github/workflows/gitnexus-skill-evolution.yml` | `jobs.evolve.env`, seed step, activation checklist | Select newest usable evidence from completed runs and make scheduled worker rollout explicit/safe. |
| `gitnexus/test/unit/skill-evolution-workflow.test.ts` | workflow contract cases | Pin seed fallback, boundedness, activation, and scheduled-worker semantics. |
| `eval/tests/test_evolve.py` | `test_runner_argv_pairs_each_incumbent_with_its_candidate` | Assert non-default worker forwarding into the runner. |

Core Python production files are expected to remain unchanged unless merge-head validation produces a concrete failure.

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Finish PR #2785 by repairing workflow evidence seeding and scheduled-worker rollout, then synchronize, validate, review, and merge without changing the validated core runner design unnecessarily."
  acceptance_criteria:
    - "A recent failed run with a usable benchmark artifact can seed the next proposal."
    - "Seed selection skips unusable newer artifacts within a bounded history and safely falls back to no seed."
    - "Scheduled workers are controlled by an explicit repository variable with serial fallback; manual input still wins."
    - "The activation checklist matches live repository state."
    - "Core eval tests, workflow contract test, typecheck, CI, graph change analysis, and pre-merge review pass on a current-main head."
    - "Post-merge funded workers=3 proof has zero excluded runs before scheduled concurrency is raised."
  evidence_provenance:
    schema_version: 2
    head_commit: "f7a1c282915c6113cdb5b28d1d275070e298f503"
    generated_plan_path: "docs/plans/2026-09-03-gitnexus-plan-skill-evolution-merge-readiness.md"
    global_dirty_digest:
      algorithm: "sha256"
      canonicalization: "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records"
      value: "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
    cited_path_manifest:
      - {path: ".github/workflows/gitnexus-skill-evolution.yml", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:7da7450c574a29819fbcdace0952f7a14fef08ee93ecf8635b88fd3512f7c359", index_digest: "sha256:7da7450c574a29819fbcdace0952f7a14fef08ee93ecf8635b88fd3512f7c359", worktree_digest: "sha256:7da7450c574a29819fbcdace0952f7a14fef08ee93ecf8635b88fd3512f7c359", untracked_digest: "absent"}
      - {path: "AGENTS.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:8a550f44b537eda1c9fc237de7eeec62cc58ca332d6721016a279efb7b41615d", index_digest: "sha256:8a550f44b537eda1c9fc237de7eeec62cc58ca332d6721016a279efb7b41615d", worktree_digest: "sha256:8a550f44b537eda1c9fc237de7eeec62cc58ca332d6721016a279efb7b41615d", untracked_digest: "absent"}
      - {path: "GUARDRAILS.md", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:15da599ede0fb6edfc6e50d2dd4411ed1464f4bfe07221be7aa0ea35dd8a9540", index_digest: "sha256:15da599ede0fb6edfc6e50d2dd4411ed1464f4bfe07221be7aa0ea35dd8a9540", worktree_digest: "sha256:15da599ede0fb6edfc6e50d2dd4411ed1464f4bfe07221be7aa0ea35dd8a9540", untracked_digest: "absent"}
      - {path: "eval/pyproject.toml", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:dfdebd7fd8c7e856f457f353dfeb3f9435eccb7f39f954ea4d7bc405f57dba04", index_digest: "sha256:dfdebd7fd8c7e856f457f353dfeb3f9435eccb7f39f954ea4d7bc405f57dba04", worktree_digest: "sha256:dfdebd7fd8c7e856f457f353dfeb3f9435eccb7f39f954ea4d7bc405f57dba04", untracked_digest: "absent"}
      - {path: "eval/tests/test_evolve.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:9ba6f3c71cade820afc552b03200d8b5ba6fdb22cf6a7d8a48e2bb66a121de81", index_digest: "sha256:9ba6f3c71cade820afc552b03200d8b5ba6fdb22cf6a7d8a48e2bb66a121de81", worktree_digest: "sha256:9ba6f3c71cade820afc552b03200d8b5ba6fdb22cf6a7d8a48e2bb66a121de81", untracked_digest: "absent"}
      - {path: "eval/tests/test_process_control.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:9c6d033abfef91c743e28169c573ed43e97af8489da439758a9ff085552faaed", index_digest: "sha256:9c6d033abfef91c743e28169c573ed43e97af8489da439758a9ff085552faaed", worktree_digest: "sha256:9c6d033abfef91c743e28169c573ed43e97af8489da439758a9ff085552faaed", untracked_digest: "absent"}
      - {path: "eval/tests/test_runner_hardening.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:ea7d2f31626ac8b4997ed441fba32c60a16801d62edd8de1a3aa74e875840964", index_digest: "sha256:ea7d2f31626ac8b4997ed441fba32c60a16801d62edd8de1a3aa74e875840964", worktree_digest: "sha256:ea7d2f31626ac8b4997ed441fba32c60a16801d62edd8de1a3aa74e875840964", untracked_digest: "absent"}
      - {path: "eval/tests/test_workflow_bench_evolution.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:e893b056647d593170d27c08dfd2bbc38268a7f32aec74db4e49cf9c385f424b", index_digest: "sha256:e893b056647d593170d27c08dfd2bbc38268a7f32aec74db4e49cf9c385f424b", worktree_digest: "sha256:e893b056647d593170d27c08dfd2bbc38268a7f32aec74db4e49cf9c385f424b", untracked_digest: "absent"}
      - {path: "eval/tests/test_workflow_bench_sessions.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:a940303afa7f3f1c509133733a83d4922cfe0bd3f76cb98a43e0fc95c43a53e2", index_digest: "sha256:a940303afa7f3f1c509133733a83d4922cfe0bd3f76cb98a43e0fc95c43a53e2", worktree_digest: "sha256:a940303afa7f3f1c509133733a83d4922cfe0bd3f76cb98a43e0fc95c43a53e2", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/evolution.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:f4cb63dbec55666daf893a527843235a389a7f882f7c094b0b8f4f1b081c3bb7", index_digest: "sha256:f4cb63dbec55666daf893a527843235a389a7f882f7c094b0b8f4f1b081c3bb7", worktree_digest: "sha256:f4cb63dbec55666daf893a527843235a389a7f882f7c094b0b8f4f1b081c3bb7", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/evolve.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:371357512902a442b6318a9e16bfc543135a742a2f32ad2f16e340eeb3d50f37", index_digest: "sha256:371357512902a442b6318a9e16bfc543135a742a2f32ad2f16e340eeb3d50f37", worktree_digest: "sha256:371357512902a442b6318a9e16bfc543135a742a2f32ad2f16e340eeb3d50f37", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/process_control.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:9c1ec1b4e3b39d815a2a529f2c22cb5aa3962715cc3b89ced704c734c1996619", index_digest: "sha256:9c1ec1b4e3b39d815a2a529f2c22cb5aa3962715cc3b89ced704c734c1996619", worktree_digest: "sha256:9c1ec1b4e3b39d815a2a529f2c22cb5aa3962715cc3b89ced704c734c1996619", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/runner.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:65192c57c0482123269929cca157700d20d1ef6e4618a27e8bfa25cfba49eeb1", index_digest: "sha256:65192c57c0482123269929cca157700d20d1ef6e4618a27e8bfa25cfba49eeb1", worktree_digest: "sha256:65192c57c0482123269929cca157700d20d1ef6e4618a27e8bfa25cfba49eeb1", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/runner_artifacts.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:001b155b31ebf5f2c55df620edb8e2ce344bea427e34b25fc46d9fe391a9a952", index_digest: "sha256:001b155b31ebf5f2c55df620edb8e2ce344bea427e34b25fc46d9fe391a9a952", worktree_digest: "sha256:001b155b31ebf5f2c55df620edb8e2ce344bea427e34b25fc46d9fe391a9a952", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/runner_sessions.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:56c438fdf869d50f3569b7cf80672f7138453215edd0c9f2cd29b3f63fbc5613", index_digest: "sha256:56c438fdf869d50f3569b7cf80672f7138453215edd0c9f2cd29b3f63fbc5613", worktree_digest: "sha256:56c438fdf869d50f3569b7cf80672f7138453215edd0c9f2cd29b3f63fbc5613", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/runtime_mounts.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:84acb2e7d047647d2293a282ec6553c85d79200a7ccc560efe0c05121f82bd58", index_digest: "sha256:84acb2e7d047647d2293a282ec6553c85d79200a7ccc560efe0c05121f82bd58", worktree_digest: "sha256:84acb2e7d047647d2293a282ec6553c85d79200a7ccc560efe0c05121f82bd58", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/sanitized_graph.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:91b611201aef6abbba56576597cf122ea26a00eb9abd0fea450f36a69ae8db57", index_digest: "sha256:91b611201aef6abbba56576597cf122ea26a00eb9abd0fea450f36a69ae8db57", worktree_digest: "sha256:91b611201aef6abbba56576597cf122ea26a00eb9abd0fea450f36a69ae8db57", untracked_digest: "absent"}
      - {path: "eval/workflow_bench/task_assets.py", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:4d52da8f846b0d42ab3109eb6c8f980744db067f6b8c1ae099468b090c967d40", index_digest: "sha256:4d52da8f846b0d42ab3109eb6c8f980744db067f6b8c1ae099468b090c967d40", worktree_digest: "sha256:4d52da8f846b0d42ab3109eb6c8f980744db067f6b8c1ae099468b090c967d40", untracked_digest: "absent"}
      - {path: "gitnexus/package.json", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:97c414c56eca08dc84d6818eb4a9400de939e06e7ad9a3e77abbd1fcc05e5e60", index_digest: "sha256:97c414c56eca08dc84d6818eb4a9400de939e06e7ad9a3e77abbd1fcc05e5e60", worktree_digest: "sha256:97c414c56eca08dc84d6818eb4a9400de939e06e7ad9a3e77abbd1fcc05e5e60", untracked_digest: "absent"}
      - {path: "gitnexus/test/unit/skill-evolution-workflow.test.ts", object_kind: {head: "regular", index: "regular", worktree: "regular", untracked: "absent"}, state: "clean", rename_from: null, rename_to: null, head_digest: "sha256:cadd72dbc24d49f4362f913e1e7544db69c44bbb15671232f151f8b059db9a97", index_digest: "sha256:cadd72dbc24d49f4362f913e1e7544db69c44bbb15671232f151f8b059db9a97", worktree_digest: "sha256:cadd72dbc24d49f4362f913e1e7544db69c44bbb15671232f151f8b059db9a97", untracked_digest: "absent"}
  primary_symbols:
    - {symbol: "run_managed", file: "eval/workflow_bench/process_control.py", lines: "692-733", role: "Shared owned-process boundary and optional progress passthrough"}
    - {symbol: "run_claude", file: "eval/workflow_bench/runner_sessions.py", lines: "350-530", role: "Claude event-stream evidence boundary"}
    - {symbol: "evaluate_candidate", file: "eval/workflow_bench/evolution.py", lines: "478-675", role: "Deterministic promotion gate"}
    - {symbol: "sweep_task_cells", file: "eval/workflow_bench/runner.py", lines: "643-698", role: "Deterministic wave scheduler and outage fold"}
    - {symbol: "run_cell", file: "eval/workflow_bench/runner.py", lines: "736-960", role: "Per-cell clone/sandbox/evidence ownership"}
  related_symbols:
    - {symbol: "evolve.main", relationship: "launches runner and applies promotion", relevance: "Workflow driver"}
    - {symbol: "runner_argv", relationship: "forwards timeout/workers", relevance: "CLI contract"}
    - {symbol: "generation_timeout_seconds", relationship: "bounds runner child", relevance: "Nested deadline safety"}
    - {symbol: "TaskAssetSnapshot.materialize", relationship: "called per cell", relevance: "Immutable snapshot publication"}
    - {symbol: "SanitizedGraphSnapshot.materialize", relationship: "called per cell", relevance: "Sanitized identity enforcement"}
    - {symbol: "make_worktree", relationship: "called per cell and reaches run_managed", relevance: "Unique clone/process isolation"}
  execution_path:
    - "GitHub schedule/dispatch enters jobs.evolve under protected environment."
    - "Seed step locates prior benchmark evidence for the proposer."
    - "evolve.main proposes/freezes an overlay and launches workflow_bench.runner with workers/timeout."
    - "runner.main prepares immutable task and graph snapshots once per task."
    - "sweep_task_cells submits fixed waves; each run_cell owns clone, sandbox, sessions, patch, and cleanup."
    - "Main-thread keep callback appends canonical results and updates outage streak in submission order."
    - "evaluate_candidate emits schema-4 decisions; evolve validates and may apply the overlay."
    - "Workflow uploads evidence, bounds changed skill trees, and opens a human-reviewed promotion PR."
  pdg_constraints:
    - description: "Enterprise PDG/taint coverage unavailable: no BasicBlock or dependence/taint edges and no first-class tools."
      affected_statements: ["eval/workflow_bench/runner.py:736", "eval/workflow_bench/runner_sessions.py:420", "eval/workflow_bench/process_control.py:458"]
      implementation_consequence: "Preserve sandbox/process/redaction boundaries via source review and tests; require enterprise --pdg refresh before claiming taint-clean."
    - description: "Claude stdout is evidence and must not use echo_stdout."
      affected_statements: ["eval/workflow_bench/runner_sessions.py:420-428", "eval/workflow_bench/process_control.py:485-488"]
      implementation_consequence: "Only the benchmark runner's ordinary log stdout may be echoed; redact every error-detail sink."
  architectural_patterns:
    - {pattern: "Bounded fail-open optional history", example_location: ".github/workflows/gitnexus-skill-evolution.yml:257", usage_guidance: "Failure to seed warns and continues; it never authorizes unvalidated evidence."}
    - {pattern: "Immutable shared snapshot, unique mutable clone", example_location: "eval/workflow_bench/runner.py:701", usage_guidance: "Prepare shared inputs on main thread, materialize only into per-cell destinations."}
    - {pattern: "Graph navigation then source proof", example_location: "AGENTS.md", usage_guidance: "Use query/context/impact/detect_changes first; resolve UNKNOWN/stale results in current source."}
  files_to_modify:
    - {file: ".github/workflows/gitnexus-skill-evolution.yml", symbols: ["jobs.evolve.env", "Seed the proposer with the previous run's evidence", "activation checklist"], intended_change: "Bounded completed-run fallback, scheduled worker variable, truthful operator guidance."}
    - {file: "gitnexus/test/unit/skill-evolution-workflow.test.ts", symbols: ["gitnexus skill-evolution workflow contract"], intended_change: "Pin seed and scheduled-worker behavior."}
    - {file: "eval/tests/test_evolve.py", symbols: ["test_runner_argv_pairs_each_incumbent_with_its_candidate"], intended_change: "Assert non-default workers are forwarded."}
  tests:
    - {file: "gitnexus/test/unit/skill-evolution-workflow.test.ts", scenarios: ["failed run with evidence -> selected", "newest empty then older usable -> fallback", "all unavailable -> no seed", "scheduled worker var absent/present", "dispatch input wins"]}
    - {file: "eval/tests/test_evolve.py", scenarios: ["--workers 3 -> runner argv contains --workers 3"]}
    - {file: "eval/tests/test_process_control.py", scenarios: ["preserve prompt echo and sibling process-tree ownership regressions"]}
    - {file: "eval/tests/test_runner_hardening.py", scenarios: ["preserve wave ordering, breaker bound, concurrent execution, workers=1 main-thread behavior"]}
    - {file: "eval/tests/test_workflow_bench_evolution.py", scenarios: ["preserve ungated-task and no-quality-signal decisions"]}
    - {file: "eval/tests/test_workflow_bench_sessions.py", scenarios: ["preserve trailing-system acceptance and strict result-count rules"]}
  verification_commands:
    - "git diff --check"
    - "cd eval && uv run --locked --extra dev python -m pytest tests/"
    - "cd gitnexus && npx vitest run test/unit/skill-evolution-workflow.test.ts"
    - "cd gitnexus && npm run test:unit"
    - "cd gitnexus && npx tsc --noEmit"
  risks:
    - "run_managed CRITICAL blast radius: 91 upstream symbols, 30 direct."
    - "evaluate_candidate HIGH blast radius: 24 upstream symbols, 15 direct."
    - "Enterprise branch graph is stale/incomplete and has no PDG/taint layer."
    - "GitHub artifact history is external, fallible, and potentially malformed; selection must be bounded and validation-preserving."
    - "Parallel workers can convert CPU contention into excluded timeouts; rollout requires measurement."
  assumptions:
    - "Re-verify current origin/main and enterprise branch evidence immediately before work; PR is currently behind."
    - "Verify authenticated push access to magyargergo/GitNexus:fix/skill-evolution-gate using GitHub's maintainer-edit permission before creating implementation commits."
    - "Verify how the enterprise service refreshes branch indexes with PDG before using taint absence as a merge signal."
    - "Verify runner API credit and the out-of-band needrestart policy before the paid proof run."
  open_questions:
    - "What contention threshold relative to the 48-minute serial mean should block workers=3 rollout?"
    - "Has the self-hosted runner's manual-restart needrestart drop-in been applied?"
  avoid:
    - "Do not repeat full repository discovery."
    - "Do not replace established process/snapshot/security patterns without evidence."
    - "Do not use OSS GitNexus for code context; keep enterprise MCP explicit."
    - "Do not treat UNKNOWN or zero taint rows on a no-PDG index as safe."
    - "Do not echo Claude session stdout or expose auth-token-bearing errors."
    - "Do not enable scheduled workers=3 before a funded host-sized proof run."
    - "Do not rebase/force-push the contributor history without explicit approval."
```

## 12. Assumptions and Open Questions

- [assumed] Enterprise branch-index refresh/PDG enablement is an external service operation unavailable through the connected runtime; obtain the supported enterprise path before final review if taint evidence is mandatory.
- [assumed] The self-hosted runner has enough CPU/memory for three cells only after the documented resize; confirm the actual instance and needrestart policy out of band.
- [assumed] API credit will be restored before the paid proof run. The Aug 29 failure cannot validate code behavior.
- [inferred] A merge commit is safer than rebasing this long-lived contributor PR because its history already contains periodic `main` merges and force-pushing would rewrite the contributor branch.
- Open: define the acceptable workers=3 mean-cell regression versus the 48-minute serial baseline; zero excluded runs remains non-negotiable.
- Deferred: improving the enterprise MCP runtime's schema compatibility (`query` vs `search_query`, `cypher` vs `statement`) and exposing `check`/`trace`/`explain`/`pdg_query` is valuable but outside PR #2785.

## 13. Definition of Done

- Current `main` is merged into `magyargergo/GitNexus:fix/skill-evolution-gate` without unresolved or semantic conflicts; PR metadata points at the reviewed exact head.
- Prior evidence selection consumes the newest usable completed-run artifact, including failure runs, skips unusable newer runs within a bounded window, and safely continues without a seed when none qualify.
- Scheduled concurrency has an explicit repository-variable rollout/rollback path with serial default; activation documentation matches live state.
- Added workflow/Python contract tests pass; full locked eval tests, GitNexus unit tests, focused workflow test, typecheck, formatting, actionlint, zizmor, CodeQL, and CI gate are green.
- Enterprise `detect_changes` is complete/non-truncated at the final head; HIGH/CRITICAL and UNKNOWN results are explicitly accounted for. Final review does not claim PDG/taint coverage unless a current enterprise PDG index exists.
- Canonical `gitnexus-review` returns no blocking findings on the exact merge head; GitHub reports mergeable/current and required checks pass before merge.
- After merge, a funded protected-main workers=3 dispatch streams progress, uploads evidence even on failure, reaches a deterministic gate decision with zero excluded runs, and meets the agreed contention threshold before the scheduled worker variable is raised.
