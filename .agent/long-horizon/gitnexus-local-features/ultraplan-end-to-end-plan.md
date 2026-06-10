# Plan

## Metadata

- Task Slug: `gitnexus-local-features-end-to-end`
- Date Started: `2026-06-08`
- Complexity Score (0-10): `8`
- Budget Class: `large`
- Planning Floor: `15 minutes`
- Planning Cap: `30 minutes`
- Minimum Loop Count: `6`
- Current Loop Count: `6`

## Goal

Produce an implementation-ready end-to-end execution plan for the remaining GitNexus local-features branch so autonomous work can proceed through bigger vertical slices without losing the branch workflow, verification discipline, or operator-usage focus already established in the project control bundle.

## Success Criteria

- The plan matches the actual branch control surface:
  - `AGENTS.md`
  - `.agent/long-horizon/gitnexus-local-features/plans.md`
  - `.agent/long-horizon/gitnexus-local-features/implement.md`
  - `.agent/long-horizon/gitnexus-local-features/documentation.md`
  - `.agent/long-horizon/gitnexus-local-features/feature-map.md`
- The remaining work is organized as meaningful vertical stages rather than a pile of isolated primitives.
- Each stage states objective, dependencies, primary path, verification, contingencies, gate state, and rollback note.
- The plan preserves the existing task order unless source evidence justifies change.
- The plan is strong enough to be mirrored back into the long-horizon project location as a durable reference.
- Non-goals:
  - no source implementation in this planning pass
  - no branch strategy change
  - no CI/GitHub/provider mutation
  - no attempt to collapse all feature lanes into one mega-slice

## Constraints

- Planning only until the user explicitly says `approve ultraplan`.
- Keep the existing branch model:
  - branch `local/gitnexus-local-features`
  - one shared branch
  - one active feature slice at a time
- Do not override the four-file long-horizon control surface; this plan must align with it.
- Preserve the project’s green/amber/red risk-lane model.
- Favor repeated operator workflow value over primitive proliferation.
- Treat external GitHub writes, CI mutation, provider execution, secrets/tokens, and major architecture expansion as later or separately governed work.

## Evidence Summary

- Scratchpad Loop 1:
  - the initial Ultraplan draft had workable sequencing but was missing required template fields and evidence-floor coverage
- Scratchpad Loop 3:
  - the project already has a coherent workflow and task chain; the main value is consolidation into an implementation-ready formal plan
- Scratchpad Loop 5:
  - Task 2 remains the best first stage because it is still planning-only while Tasks 5 and 6 already have meaningful downstream outputs
- Scratchpad Loop 6:
  - AGENTS presence, branch context, and the bounded two-file Ultraplan artifact make safe mirroring straightforward

## Task List (Stage-Gated)

### Task 1: Task 2 Wiki Usage-Hardening

- Objective:
  - turn Task 2 from planning/readiness/manual-refresh guidance into the first genuinely usable bounded local wiki workflow
- Inputs/Dependencies:
  - Task 1 graph freshness base
  - existing wiki auto-refresh planner
  - provider-readiness reporting
  - current `gitnexus wiki` workflow
- Primary Execution Path:
  - define the first supported writable local wiki path
  - make mutation conditions explicit
  - preserve report-before-write behavior
  - add post-write result reporting and verification
  - keep provider and freshness conditions visible in operator output
- Verification Criteria:
  - focused Task 2 tests pass
  - build passes
  - diff hygiene passes
  - the first writable workflow is explicit and repeatable
- Checkpoint Outcome Chosen (1-5):
  - `1 (Success -> Next Task)`
- Gate Decision (Go / No-Go):
  - `Go`
- Retry Count:
  - `0`
- Probe Count:
  - `1`
- Rollback Complexity Note:
  - moderate; output mutation must be bounded and reversible, but remains local to wiki-related surfaces
- Contingency 1 (Success -> Next Task):
  - checkpoint the first writable wiki workflow and proceed to Task 2
- Contingency 2 (Recoverable Failure -> RCA/Fix/Re-verify):
  - narrow the write boundary to a safer manual-refresh path and rerun focused tests
- Contingency 3 (Inconclusive -> Probe x2 then escalate):
  - inspect wiki generator/output semantics more deeply, then choose the smallest verified writable shape
- Contingency 4 (Material Scope/Risk Change -> pause + user approval):
  - pause if the slice starts requiring provider execution policy, saved-config writes, or wider server mutation than the selected boundary
- Contingency 5 (External Blocker -> unblock/rescope/park):
  - if writable behavior cannot be bounded safely, keep Task 2 at planning/report level and move to Task 2

### Task 2: Task 6 Executable-Output Hardening

- Objective:
  - make Task 6 outputs easier to run, verify, and trust in repeated operator workflow
- Inputs/Dependencies:
  - existing `e2e-test-plan.v1alpha1`
  - existing generated-spec and API-smoke renderers
  - source-report provenance already present in the current report core
- Primary Execution Path:
  - strengthen generated-output metadata and provenance
  - make execution expectations clearer
  - distinguish mocked UI specs, API-smoke specs, and broader executable outputs more explicitly
  - improve post-generation verification guidance
- Verification Criteria:
  - focused Task 6 tests pass
  - build passes
  - diff hygiene passes
  - operator-facing outputs are clearer about how they should be used
- Checkpoint Outcome Chosen (1-5):
  - `1 (Success -> Next Task)`
- Gate Decision (Go / No-Go):
  - `Go`
- Retry Count:
  - `0`
- Probe Count:
  - `1`
- Rollback Complexity Note:
  - low to moderate; most changes should stay in report/CLI/output-shaping layers
- Contingency 1 (Success -> Next Task):
  - checkpoint clearer executable outputs and proceed to Task 3
- Contingency 2 (Recoverable Failure -> RCA/Fix/Re-verify):
  - narrow to report wording, provenance, and output-shape clarification only
- Contingency 3 (Inconclusive -> Probe x2 then escalate):
  - compare current rendered outputs against the intended operator journey and choose the narrowest high-signal improvement
- Contingency 4 (Material Scope/Risk Change -> pause + user approval):
  - pause if the slice starts requiring CI mutation, live browser orchestration, or broad generated-file policy changes
- Contingency 5 (External Blocker -> unblock/rescope/park):
  - limit the slice to report/provenance hardening and defer execution-facing changes

### Task 3: Task 5 Usage-Oriented Regression-Forensics Refinement

- Objective:
  - improve how operators consume, interpret, and trust regression-forensics output in real use
- Inputs/Dependencies:
  - current Regression Forensics report/CLI
  - dual intake from classic `pr-impact` and explicit-range `impact-for-ranges`
  - caveat/provenance model already in place
- Primary Execution Path:
  - improve candidate-cause readability and ranking clarity
  - strengthen evidence-mode and caveat signaling
  - make recommended follow-up checks more explicit
- Verification Criteria:
  - focused Task 5 tests pass
  - output remains deterministic
  - build passes
  - diff hygiene passes
- Checkpoint Outcome Chosen (1-5):
  - `1 (Success -> Next Task)`
- Gate Decision (Go / No-Go):
  - `Go`
- Retry Count:
  - `0`
- Probe Count:
  - `0`
- Rollback Complexity Note:
  - low; primarily a report/CLI/readability refinement slice
- Contingency 1 (Success -> Next Task):
  - checkpoint the refined operator-facing reports and proceed to Task 4
- Contingency 2 (Recoverable Failure -> RCA/Fix/Re-verify):
  - reduce scope to clearer evidence/caveat presentation without changing recommendation logic too broadly
- Contingency 3 (Inconclusive -> Probe x2 then escalate):
  - inspect current fixtures and operator-readout gaps to isolate the smallest high-value refinement
- Contingency 4 (Material Scope/Risk Change -> pause + user approval):
  - pause if the slice starts implying live bisect, CI remediation, or automated external execution
- Contingency 5 (External Blocker -> unblock/rescope/park):
  - keep the slice local/report-only and defer automation-facing ambitions

### Task 4: Task 4 GitHub-Facing PR Impact Expansion

- Objective:
  - extend Task 4 from local/report-first usefulness toward a stronger PR-oriented workflow without collapsing immediately into token-bearing GitHub automation
- Inputs/Dependencies:
  - existing richer `pr-impact` pipeline
  - coexistence decision that explicit-range primitives remain a separate operator-owned lane
  - downstream experience from Tasks 2, 5, and 6
- Primary Execution Path:
  - strengthen local PR-oriented report packaging
  - improve compare/ingestion boundaries where justified
  - preserve honest distinction between local evidence generation and GitHub write automation
- Verification Criteria:
  - focused Task 4 tests pass
  - coexistence with explicit-range lane stays truthful
  - build passes
  - diff hygiene passes
- Checkpoint Outcome Chosen (1-5):
  - `1 (Success -> Next Task)`
- Gate Decision (Go / No-Go):
  - `Go`
- Retry Count:
  - `0`
- Probe Count:
  - `1`
- Rollback Complexity Note:
  - moderate; this lane can easily drift toward external automation if not kept bounded
- Contingency 1 (Success -> Next Task):
  - checkpoint the stronger local PR workflow and proceed to Task 5
- Contingency 2 (Recoverable Failure -> RCA/Fix/Re-verify):
  - keep the slice local/report-first and remove over-broad packaging or ingestion ideas
- Contingency 3 (Inconclusive -> Probe x2 then escalate):
  - inspect what PR-oriented value is still missing after Tasks 2, 5, and 6, then pick the narrowest defensible improvement
- Contingency 4 (Material Scope/Risk Change -> pause + user approval):
  - pause if the slice requires tokens, GitHub comments/checks/reviews, or CI mutation
- Contingency 5 (External Blocker -> unblock/rescope/park):
  - keep the improvement local and defer GitHub-facing automation

### Task 5: Task 3 Deeper Multi-Repo Behavior

- Objective:
  - broaden multi-repo behavior only when a concrete downstream workflow now needs more than docs/tool-surface reconciliation
- Inputs/Dependencies:
  - current group runtime and MCP/resource surfaces
  - evidence from prior stages about actual operator demand
- Primary Execution Path:
  - choose the smallest multi-repo runtime or workflow improvement with direct downstream value
  - avoid speculative unified-graph redesign
- Verification Criteria:
  - focused multi-repo tests pass
  - runtime/docs alignment holds
  - build passes
  - diff hygiene passes
- Checkpoint Outcome Chosen (1-5):
  - `1 (Success -> Next Task)`
- Gate Decision (Go / No-Go):
  - `Go`
- Retry Count:
  - `0`
- Probe Count:
  - `1`
- Rollback Complexity Note:
  - moderate; group behavior is real and cross-cutting, so changes must stay tightly scoped
- Contingency 1 (Success -> Next Task):
  - checkpoint the chosen operational improvement and proceed to Task 6
- Contingency 2 (Recoverable Failure -> RCA/Fix/Re-verify):
  - narrow to status/output ergonomics or resource alignment instead of broader runtime semantics
- Contingency 3 (Inconclusive -> Probe x2 then escalate):
  - confirm which downstream consumer truly needs more multi-repo behavior before editing source
- Contingency 4 (Material Scope/Risk Change -> pause + user approval):
  - pause if the work turns into unified cross-repo graph redesign
- Contingency 5 (External Blocker -> unblock/rescope/park):
  - retain docs/status improvements only and defer deeper runtime behavior

### Task 6: Task 7 Deeper OCaml Semantics

- Objective:
  - advance OCaml support by one meaningful bounded semantic step beyond experimental local V1
- Inputs/Dependencies:
  - current `.ml` / `.mli` support
  - current Query Depth V2 gains
  - existing experimental classification and OCaml tests
- Primary Execution Path:
  - choose one concrete semantic improvement
  - implement it with focused fixtures/tests
  - avoid bundling Dune, PPX, full module resolution, and production classification together
- Verification Criteria:
  - focused OCaml tests pass
  - adjacent provider/registry behavior remains stable
  - build passes
  - diff hygiene passes
- Checkpoint Outcome Chosen (1-5):
  - `1 (Success -> Next Task)`
- Gate Decision (Go / No-Go):
  - `Go`
- Retry Count:
  - `0`
- Probe Count:
  - `1`
- Rollback Complexity Note:
  - moderate to high; language semantics can spill into shared ingestion/resolution surfaces if not sharply bounded
- Contingency 1 (Success -> Next Task):
  - checkpoint the bounded semantic gain and treat the main end-to-end chain as complete
- Contingency 2 (Recoverable Failure -> RCA/Fix/Re-verify):
  - reduce to a smaller semantic improvement with clearer fixture coverage
- Contingency 3 (Inconclusive -> Probe x2 then escalate):
  - run a fixture-driven probe to identify the most valuable next semantic step
- Contingency 4 (Material Scope/Risk Change -> pause + user approval):
  - pause if the work requires dependency upgrades, Dune/PPX support, or broad resolver architecture
- Contingency 5 (External Blocker -> unblock/rescope/park):
  - retain current experimental boundary and park deeper semantics as later expansion work

## TEVV Gate

### Verification

- checks:
  - focused task-local tests for each selected stage
  - `npm run build`
  - `git diff --check`
  - adjacent tests where the touched surface crosses subsystem boundaries
- CI checks where available:
  - existing local test/build commands are the primary gate in this branch workflow
  - no new CI mutation is assumed by this plan
- expected pass conditions:
  - the selected stage’s behavior is covered by focused tests
  - build remains green
  - diff hygiene stays clean

### Validation

- behavior checks:
  - Task 2 produces the first real writable wiki workflow
  - Task 6 makes generated outputs easier to act on
  - Task 5 makes regression-forensics easier to trust and consume
  - Task 4 increases PR-oriented usefulness without pretending GitHub automation exists
  - Task 3 only deepens multi-repo where real downstream need exists
  - Task 7 adds one real OCaml semantic gain without false production claims
- acceptance criteria mapping:
  - each stage must deliver operator-visible value, not just internal helper churn

### Evaluation

- regression confidence:
  - strong for current deterministic report/CLI/test-heavy slices
  - weaker for still-deferred live workflow boundaries
- edge coverage confidence:
  - highest for existing local V1 primitives and downstream consumers
  - lowest for wiki mutation/provider shape, broader GitHub/CI workflow, and deeper OCaml semantics
- residual risk:
  - the main risk is drifting from “usable end-to-end workflow” back into isolated primitives or premature automation

## Risks and Assumptions

### Open Risks

- risk:
  - Task 2 may widen into provider/output policy work faster than expected
- impact:
  - the first stage could stall or drift into a red-lane boundary
- mitigation:
  - keep the first writable wiki slice local, reversible, and explicit about mutation policy

- risk:
  - Task 4 can be mistaken for permission to build GitHub writes
- impact:
  - unnecessary security and token-surface expansion
- mitigation:
  - preserve the local/report-first boundary and treat GitHub posting/checks as a separate future decision

- risk:
  - Task 3 and Task 7 can consume attention without improving the main operator workflow
- impact:
  - end-to-end value stalls while expansion work grows
- mitigation:
  - keep both later in the chain and open them only when earlier workflow hardening is complete

### Assumptions

- assumption:
  - the current long-horizon bundle remains the branch’s canonical operating truth
- how to validate:
  - keep the mirrored Ultraplan aligned with `plans.md`, `implement.md`, `documentation.md`, and `feature-map.md`

- assumption:
  - bigger vertical slices are now preferred over primitive-by-primitive top-level tasks
- how to validate:
  - each selected stage should deliver visible operator-facing capability, not merely helper scaffolding

- assumption:
  - the current task order remains the best path unless direct source evidence changes it
- how to validate:
  - re-check stage order after each checkpoint and only reorder with documented evidence

## User Checkpoints

- checkpoint reason:
  - exiting Ultraplan planning mode into implementation
- pending user decision:
  - explicit phrase `approve ultraplan`

- checkpoint reason:
  - any later stage that crosses into GitHub writes, provider execution, CI mutation, secrets/tokens, or major architecture expansion
- pending user decision:
  - explicit human-operator direction for that boundary

## Approval Status

- Planning Status: Approved and executing Task 1
- Quality Gate: Passed
- User Approval Phrase Received: Yes (`approve ultraplan`)
- Ready for Implementation: Yes
