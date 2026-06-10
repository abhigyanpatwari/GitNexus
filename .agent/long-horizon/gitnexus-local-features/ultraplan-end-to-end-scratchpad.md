# Scratchpad

Purpose: append-only evidence log for planning loops. Keep raw findings here and keep `plan.md` concise.

## Task Metadata

- Task Slug: `gitnexus-local-features-end-to-end`
- Start Time: `2026-06-08T21:38:35.7481194+01:00`
- Complexity Score (0-10): `8`
- Budget Class: `large`
- Loop Minimum: `6`
- Evidence Minimum: `20 bullets`

## Preflight Intake (Mandatory)

### Tool Inventory

| Tool / Capability | Role Class | Availability | Limits / Constraints |
|---|---|---|---|
| `rg` / `rg --files` | Local truth | Available | Best for bounded file/symbol discovery; still needs file inspection after matches. |
| `Get-Content` | Local truth | Available | Read-only; large files must be sampled carefully to avoid noisy context. |
| `git status` | Local truth | Available | Confirms branch/WIP state only; does not explain feature semantics by itself. |
| Long-horizon bundle docs | Local truth | Available | Authoritative for current branch workflow, but may lag code if not cross-checked. |
| Ultraplan templates | Planning method | Available | Must shape plan artifacts; do not treat them as project truth. |
| Context7 | External correctness | Available if needed | Use only for version-sensitive external behavior; not required for repo-internal planning. |
| Official docs / GitHub issues / PRs | Ecosystem and failure intelligence | Available if needed | Useful for intent/history, but this pass is primarily about local execution planning. |
| `codex exec` / `codex` CLI | Workflow verification | Partially available | Non-interactive checks are useful, but some subcommands expect a TTY in this environment. |

### Tool Workflow Pattern

- Primary order:
  1. Project AGENTS and four-file control bundle
  2. Current Ultraplan artifacts
  3. Local source, tests, and architecture docs
  4. Git status / branch state
  5. External evidence only if a claim becomes version-sensitive or historically ambiguous
- Fallback order:
  1. `rg` discovery
  2. direct file reads
  3. existing project planning docs
  4. official/public evidence
- Reason this order fits this task:
  - The task is to build an implementation-ready branch plan, so current local truth matters more than external positioning.

### AGENTS Instruction Chain

- Global source loaded: `C:\Users\steve\.codex\AGENTS.md`
- Project-chain sources loaded (root -> cwd): `C:\Users\steve\projects\gitnexus\source-rc109-integration\AGENTS.md`
- Fallback filenames considered from config: project long-horizon bundle under `.agent/long-horizon/gitnexus-local-features/`
- Effective precedence result:
  - project `AGENTS.md` governs repo-local workflow details
  - global `AGENTS.md` governs broader Codex behavior where the project file is silent
  - the four-file bundle remains the active control surface for this workstream
- Verification command run:
  - `@('C:\Users\steve\.codex\AGENTS.md','C:\Users\steve\projects\gitnexus\source-rc109-integration\AGENTS.md') | ForEach-Object { if (Test-Path $_) { Write-Output $_ } }`
- Verification output summary:
  - both expected AGENTS files exist and were available for inspection
- Additional verification attempt:
  - `codex --cd "C:\Users\steve\projects\gitnexus\source-rc109-integration" --ask-for-approval never "Show which instruction files are active."`
- Additional verification output summary:
  - failed with `Error: stdin is not a terminal`; useful as a workflow constraint, not as a blocker

### AGENTS Conflict Handling

- Conflict detected: no material instruction conflict found for planning
- Material impact: none
- Resolution from evidence:
  - the project `AGENTS.md` and four-file bundle are internally aligned on one-branch, one-feature-at-a-time, selected-task flow
- Escalated to user (if unresolved): no

### Preflight Gate Status

- Status: Pass
- Gate rationale:
  - tool order, instruction sources, precedence, constraints, and verification evidence were recorded before formal loop planning continued

## Evidence Index

- Repo-local branch guidance exists in `AGENTS.md` and points this workstream to `.agent/long-horizon/gitnexus-local-features/`.
- The long-horizon bundle already contains an explicit end-to-end sequence led by Task 2 Wiki Usage-Hardening.
- `plans.md` says local V1 slices are complete across Tasks 1-7, but repeated operator workflow is not yet complete.
- `documentation.md` currently marks `R4 Same-feature continuation available` with `Task 2 Wiki Usage-Hardening` active.
- `feature-map.md` separates feature completion from operator-usage completion and workflow completion.
- The Ultraplan path is isolated under `docs/plans/gitnexus-local-features-end-to-end/`.
- `git status --short --branch` shows branch `local/gitnexus-local-features`.
- The worktree is not fully clean because long-horizon docs are already being updated in this planning pass.
- `gitnexus/src/cli/wiki-refresh.ts` is planning-only by design.
- `wiki-refresh` currently exposes an explicit execution boundary: no provider execution, no output mutation, no config writes.
- `wiki-refresh` already recommends the manual `gitnexus wiki "<path>"` route when prerequisites pass.
- `gitnexus/src/core/e2e-test-generation/report.ts` already supports two evidence modes: `pr-impact` and `impact-for-ranges`.
- The E2E plan report already records provenance in `source_reports`.
- The E2E plan report explicitly says generated executable test files are out of scope in V1 caveats.
- `gitnexus/src/core/regression-forensics/report.ts` already supports two evidence modes: `pr-impact` and `impact-for-ranges`.
- Regression Forensics already distinguishes direct-process evidence from richer PR-impact verdict/test-signal evidence.
- `gitnexus/src/cli/pr-impact.ts` is still a thin local wrapper around the richer pipeline.
- `pr-impact` therefore remains the richer diff-owned lane rather than being replaced by explicit-range primitives.
- `gitnexus/src/core/group/service.ts` still exposes meaningful group runtime behavior: list, sync, contracts, impact, context, query, status.
- Multi-repo deeper work is therefore not feature absence; it is a question of when more operational depth is actually needed.
- `gitnexus/src/core/ingestion/languages/ocaml.ts` still keeps OCaml intentionally foundational.
- OCaml currently has no import resolver beyond `() => null`, which supports the “deeper semantics later” decision.
- The current local plan already favors Task 2 -> Task 6 -> Task 5 -> Task 4 -> Task 3 -> Task 7.
- The real remaining gap is usage hardening, not primitive discovery.

## Loop Log

### Loop 1 - 2026-06-08 21:39

- Evidence Source: Ultraplan artifacts and quality gate
- Command or Query:
  - `Get-Content -Raw ...\\plan.md`
  - `Get-Content -Raw ...\\scratchpad.md`
  - `Get-Content -Raw ...\\references\\quality-gate.md`
- Files or Docs Checked:
  - `docs/plans/gitnexus-local-features-end-to-end/plan.md`
  - `docs/plans/gitnexus-local-features-end-to-end/scratchpad.md`
  - `C:\Users\steve\.agents\skills\ultraplan\references\quality-gate.md`
- Key Finding:
  - the first draft had good sequencing but did not yet satisfy the Ultraplan template fields or evidence-floor requirements
- Impact on Plan:
  - upgrade both files into the template shape before mirroring them anywhere
- Next Probe:
  - inspect the plan and scratchpad templates directly

### Loop 2 - 2026-06-08 21:39

- Evidence Source: Ultraplan templates
- Command or Query:
  - `Get-Content -Raw ...\\references\\plan-template.md`
  - `Get-Content -Raw ...\\references\\scratchpad-template.md`
- Files or Docs Checked:
  - `C:\Users\steve\.agents\skills\ultraplan\references\plan-template.md`
  - `C:\Users\steve\.agents\skills\ultraplan\references\scratchpad-template.md`
- Key Finding:
  - the formal plan needs metadata, evidence summary, TEVV, risks, assumptions, user checkpoints, and explicit per-task gate fields
- Impact on Plan:
  - restructure the end-to-end plan around stage-gated tasks with go/no-go and rollback notes
- Next Probe:
  - inspect project control docs so the upgraded plan matches the real branch workflow

### Loop 3 - 2026-06-08 21:40

- Evidence Source: project AGENTS and four-file bundle
- Command or Query:
  - `Get-Content -Raw AGENTS.md`
  - `Get-Content -Raw .agent\\long-horizon\\gitnexus-local-features\\plans.md`
  - `Get-Content -Raw .agent\\long-horizon\\gitnexus-local-features\\implement.md`
  - `Get-Content -Raw .agent\\long-horizon\\gitnexus-local-features\\documentation.md`
  - `Get-Content -Raw .agent\\long-horizon\\gitnexus-local-features\\feature-map.md`
- Files or Docs Checked:
  - project `AGENTS.md`
  - long-horizon `plans.md`
  - long-horizon `implement.md`
  - long-horizon `documentation.md`
  - long-horizon `feature-map.md`
- Key Finding:
  - the project already has a coherent end-to-end sequence and a strong branch workflow; the missing piece is a more formal implementation-ready summary, not a new strategy
- Impact on Plan:
  - keep the Ultraplan aligned to the existing task chain instead of inventing a competing roadmap
- Next Probe:
  - inspect feature surfaces directly to verify each top-level stage against source

### Loop 4 - 2026-06-08 21:41

- Evidence Source: branch and WIP state
- Command or Query:
  - `git -C "C:\Users\steve\projects\gitnexus\source-rc109-integration" status --short --branch`
- Files or Docs Checked:
  - git status only
- Key Finding:
  - branch is correct and the current dirt is planning-doc dirt, not ambiguous source drift
- Impact on Plan:
  - safe to continue recursive plan improvement without first doing another code checkpoint
- Next Probe:
  - inspect the current Task 2, 5, 6, 4, 3, and 7 source anchors

### Loop 5 - 2026-06-08 21:41

- Evidence Source: current feature-source anchors
- Command or Query:
  - `Get-Content -Raw gitnexus\\src\\cli\\wiki-refresh.ts`
  - `Get-Content -Raw gitnexus\\src\\core\\e2e-test-generation\\report.ts`
  - `Get-Content -Raw gitnexus\\src\\core\\regression-forensics\\report.ts`
  - `Get-Content -Raw gitnexus\\src\\cli\\pr-impact.ts`
  - `Get-Content -Raw gitnexus\\src\\core\\group\\service.ts`
  - `Get-Content -Raw gitnexus\\src\\core\\ingestion\\languages\\ocaml.ts`
- Files or Docs Checked:
  - `gitnexus/src/cli/wiki-refresh.ts`
  - `gitnexus/src/core/e2e-test-generation/report.ts`
  - `gitnexus/src/core/regression-forensics/report.ts`
  - `gitnexus/src/cli/pr-impact.ts`
  - `gitnexus/src/core/group/service.ts`
  - `gitnexus/src/core/ingestion/languages/ocaml.ts`
- Key Finding:
  - Tasks 5 and 6 are already downstream consumers with provenance-aware dual-intake logic; Task 2 is still the clearest next usage-hardening target because it remains planning-only
- Impact on Plan:
  - keep Task 2 first; do not reorder the top-level chain
- Next Probe:
  - verify AGENTS existence with a simple command and capture docs-folder state for mirroring

### Loop 6 - 2026-06-08 21:38

- Evidence Source: instruction-file existence and plan-folder state
- Command or Query:
  - `@('C:\Users\steve\.codex\AGENTS.md','C:\Users\steve\projects\gitnexus\source-rc109-integration\AGENTS.md') | ForEach-Object { if (Test-Path $_) { Write-Output $_ } }`
  - `Get-ChildItem ...\\docs\\plans\\gitnexus-local-features-end-to-end | Select-Object Name,Length`
  - `Get-Date -Format o`
- Files or Docs Checked:
  - both AGENTS files
  - the Ultraplan folder contents
- Key Finding:
  - both AGENTS files are present; the Ultraplan artifact currently consists only of `plan.md` and `scratchpad.md`, which makes mirroring simple and bounded
- Impact on Plan:
  - after upgrading these two files, mirror them into the long-horizon project location as named copies rather than inventing a broader file set
- Next Probe:
  - none; proceed to rewrite artifacts

## RCA Notes (5-Whys)

Use when a task fails.

### Failure Event - 2026-06-08 21:39

- Task:
  - AGENTS verification helper attempt
- Symptom:
  - `codex --cd ... --ask-for-approval never "Show which instruction files are active."` failed with `stdin is not a terminal`
- Why 1:
  - the local `codex` invocation expected an interactive terminal for that prompt shape
- Why 2:
  - the command was executed from the current agent shell context, not from an interactive human terminal
- Why 3:
  - the check was copied as a convenience verification step rather than as a guaranteed non-interactive command
- Why 4:
  - the planning artifact had not yet separated “nice-to-have workflow verification” from “required local evidence”
- Why 5:
  - the first draft emphasized structure more than operational constraints
- Confirmed Root Cause:
  - the chosen verification command was not suitable for this non-interactive shell context
- Fix Attempt:
  - replaced it with direct PowerShell path verification plus manual AGENTS inspection
- Re-verify Result:
  - AGENTS presence and precedence were still confirmed successfully

## Probe Notes (Inconclusive Path)

### Probe A - 2026-06-08 21:41

- Hypothesis:
  - Task 6 or Task 5 might now be a better first top-level stage than Task 2
- Probe:
  - inspect `wiki-refresh`, E2E report, and Regression Forensics report source anchors directly
- Result:
  - Task 5 and Task 6 already have meaningful consumer outputs; Task 2 still stops at planning-only
- Decision:
  - keep Task 2 first because it closes a more obvious operator-usage gap

### Probe B - 2026-06-08 21:41

- Hypothesis:
  - deeper multi-repo or OCaml work might deserve elevation in the end-to-end chain
- Probe:
  - inspect `group/service.ts` and `languages/ocaml.ts`
- Result:
  - both areas are real, but still look like expansion lanes rather than the shortest path to repeated operator workflow
- Decision:
  - keep Task 3 and Task 7 later in the chain

## Escalations

Record when user input is required.

### Escalation - 2026-06-08 21:42

- Trigger:
  - none in the current recursive planning-improvement pass
- Why escalation is required:
  - not required yet; the remaining missing approval is the explicit `approve ultraplan` phrase if implementation should be unlocked through the skill
- Options prepared for user:
  - continue refining the plan only
  - approve Ultraplan and move into implementation mode
- User decision:
  - approved on 2026-06-09 via `approve ultraplan`
