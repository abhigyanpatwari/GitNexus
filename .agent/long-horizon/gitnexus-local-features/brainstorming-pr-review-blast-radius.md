# Brainstorming - GitNexus PR Review / Blast Radius

## Purpose

This note captures a general brainstorming frame for building a GitNexus-native equivalent of BlastRadius.

It is not an implementation approval, source-change plan, or final product specification. It exists to preserve the idea shape, naming, references, and staged product direction before the feature is particularized into a Codex Goal and implementation plan.

## Working Nomenclature

Preferred feature label:

- **GitNexus PR Review / Blast Radius**

Possible product-style names:

- **GitNexus PR Impact Review**
- **GitNexus Blast Radius Review**
- **GitNexus PR Impact Intelligence**
- **GitNexus Merge Risk Report**

Recommended internal naming:

- Feature name: `PR Review / Blast Radius`
- CLI concept: prefer `pr-impact`; keep `pr-review` only as an older/alternative wording because `pr-swarm-review/` and the `gitnexus-pr-review` skill already use "review"
- Report concept: `GitNexus PR Impact Report`
- Long-horizon task label: `Task 2 - PR Review / Blast Radius`
- Codex Goal label: `Goal 2 - PR Review / Blast Radius`

## Core Idea

Build a GitNexus-native equivalent of BlastRadius, but anchor it in GitNexus's existing graph engine instead of recreating a one-off PR analyzer.

BlastRadius-style products answer:

> What downstream code, tests, routes, services, or business flows might break if this PR merges?

For GitNexus, the strongest version should be graph-first:

1. Identify changed symbols from a local diff or, later, a PR diff.
2. Map those symbols to affected processes, routes, API consumers, callers, and graph neighborhoods.
3. Produce a deterministic Markdown/JSON report.
4. Later, optionally add model summaries, GitHub PR comments, UI reports, graph visualizations, or generated test stubs.

V1 should be understood as a deterministic diff-to-graph impact pipeline:

```text
diff ranges -> symbols -> impact -> report
```

That means `symbols-for-ranges` and `impact-for-symbols` are not merely later polish. They are the load-bearing core behavior of V1, even if the first implementation exposes them only as internal helpers before deciding whether they become stable CLI/MCP primitives.

## References

Codex workflow references:

- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex use cases](https://developers.openai.com/codex/use-cases)
- [Follow a goal](https://developers.openai.com/codex/use-cases/follow-goals)
- [Codex workflows](https://developers.openai.com/codex/workflows)
- [Codex SDK](https://developers.openai.com/codex/sdk)

BlastRadius references:

- [BlastRadius lablab page](https://lablab.ai/ai-hackathons/ibm-bob-hackathon/ghost-commiter/blastradius-pr-impact-analysis)
- [tazwaryayyyy/BlastRadius](https://github.com/tazwaryayyyy/BlastRadius)
- [GitHub blast-radius topic](https://github.com/topics/blast-radius)
- [GitHub blastradius repository search](https://github.com/search?q=blastradius&type=repositories)

Local GitNexus research references:

- `enterprise-feature-intended-functions-scratchpad.md`
- `plans.md`
- `documentation.md`
- `pr-swarm-review/`
- `C:\Users\steve\.agents\skills\gitnexus-pr-review\SKILL.md`

## Codex Workflow Brainstorm

Use Codex Goals for feature-level objectives.

Use `codex exec` later for bounded sub-agent jobs such as:

- research a narrow PR-review design question
- review the report schema
- generate a structured risk summary from command output
- run a non-interactive code review over the feature diff
- produce JSON output with `--output-schema`

Use the Codex SDK only if we later want a custom orchestrator that starts or resumes Codex threads programmatically.

Near-term default:

- Keep the main feature work in the current long-horizon bundle.
- Use one feature branch: `local/gitnexus-local-features`.
- Work one feature at a time.
- Use `codex exec` as a helper/sub-agent route, not as an unbounded autonomous implementer.

## Practical V1 Direction

Recommended v1:

**Local Diff First, No LLM**

Why:

- lower risk
- no GitHub token needed
- no Actions workflow security problem
- no generated-test quality problem
- directly uses existing GitNexus primitives
- easier to test with fixtures and mocked backend calls

V1 should produce:

- changed symbols
- affected processes
- impact depth/risk
- API-impact section where available
- missing/unknown test coverage notes
- final recommendation
- explicit note that no GitHub posting/check automation occurred

Candidate local command shape:

```powershell
gitnexus pr-impact --base-ref main --repo gitnexus-local-features --format markdown
gitnexus pr-impact --scope compare --base-ref main --repo gitnexus-local-features --format json
```

Older/alternative command wording:

```powershell
gitnexus pr-review ...
```

`pr-review` should remain only an alias or historical alternative if used at all, because "review" already names the manual/swarm review assets.

## Tight V1 Spec Notes

### V1 Core Primitive Shape

GitNexus PR Impact V1 should be built around two conceptual primitives:

- `symbols-for-ranges`: map file path + side + line range to graph symbols.
- `impact-for-symbols`: map graph symbols to bounded callers, affected graph neighborhoods, process participation, route/API evidence, and risk signals.

The first implementation may keep these as internal helpers used by `pr-impact`. Public CLI/MCP exposure should be a later API decision, not a prerequisite for the first report.

### V1 Input Boundary

V1 input should be local-diff first:

- local repo index
- local working tree or compare diff
- base ref for compare mode
- no GitHub PR URL
- no GitHub token
- no PR comments/checks

GitHub PR URL ingestion should later become another diff source feeding the same engine, not a redesign of the report logic.

### V1 JSON Contract

The V1 JSON report should be explicitly experimental but versioned from day one:

- include `schema_version`
- do not claim public API stability yet
- keep output deterministic for fixture tests
- evolve the schema freely until a real downstream consumer exists

### Test-Signal Approximation

V1 should not claim true coverage unless a real coverage graph exists.

Use a conservative graph-derived signal:

- `has_test_reference = true` when a test-file node has a `CALLS` or `IMPORTS` path to the affected symbol.
- otherwise report `unknown_or_unreferenced`.

Do not call this "uncovered" in V1. "No known test reference" is useful; "uncovered" implies proof the graph may not have.

### Optional Report Sections

Only render graph-evidence sections when the graph actually has evidence:

- affected processes: render only when process nodes or process participation are present
- affected routes/API impact: render only when route/API evidence exists
- test references: render only when the approximation has evidence to report

Avoid empty authoritative-looking scaffolding. If evidence is unavailable, use a compact caveat rather than a blank section.

### Diff-Mapping Cases

V1 must define behavior for the common hard cases:

- Changed ranges with no symbol match:
  - report as unmatched ranges
  - treat as file-level impact candidates
  - do not silently drop them

- New symbols not present in the base graph:
  - report as new/unmapped symbols
  - do not claim inbound callers from the base graph
  - allow impact to be empty without treating it as safe

- Deleted symbols:
  - resolve against the base graph where possible
  - surface inbound callers loudly
  - treat deleted symbol + inbound callers as a high-risk signal

### Traversal Defaults

V1 traversal should be bounded and explainable:

- default hop cap: `5`
- cycle guard required
- report depth in output
- distinguish direct callers from transitive callers

The report should make a 1-hop caller look different from a 5-hop transitive dependency.

### Deterministic Verdict Rules

V1 recommendation must come from transparent rules, not a vibe.

Initial verdict table:

| Verdict | Deterministic triggers |
| --- | --- |
| `BLOCK` | Deleted symbol with inbound callers; critical API mismatch; critical/high direct impact with no known test reference |
| `NEEDS_DISCUSSION` | High fan-in; multi-process impact; unmatched high-risk ranges; route/API impact without clear tests |
| `PROCEED` | Low/medium bounded impact with no deletion/API mismatch signals |
| `UNKNOWN` | Stale or ambiguous graph; failed diff mapping; insufficient graph evidence |

These rules can be conservative. They should be visible in the report or easy to trace from the report data.

### V1 Acceptance Criterion

The natural definition of done for a deterministic report is fixture-backed golden output.

V1 should include:

- a checked-in fixture diff
- expected golden Markdown report
- expected golden JSON report
- tests covering schema versioning, verdict rules, deleted symbols, unmatched ranges, optional sections, and traversal bounds

This protects the report and schema from silent drift.

## LLM Layer Brainstorm

The LLM should not be the blast-radius engine.

GitNexus should compute graph facts first:

- changed symbols
- affected processes
- affected routes
- callers and depth
- API consumers and shape mismatches
- risk signals

If added later, an LLM layer should only narrate or prioritize verified facts.

Possible staged model:

1. **No LLM in v1**
   - Deterministic Markdown/JSON report only.
   - Fast, local, reproducible, and testable.

2. **LLM summary in v2**
   - Model explains verified graph facts.
   - No generated tests.
   - No invented edges.

3. **LLM remediation in v3**
   - Suggest test stubs for high-risk, under-tested paths.
   - Requires test-framework detection and execution validation.

## Later Product Layers

Possible v2:

- LLM summary over verified graph facts only.
- More explicit test coverage analysis.
- Stable JSON schema for downstream consumers.
- Possible MCP tool surface if the CLI report proves useful.

Possible v3:

- GitHub PR URL ingestion.
- Persistent shareable report.
- PR comment/check integration.
- Generated test stubs.
- Visual graph view.
- Codex non-interactive helper workflows for review/report synthesis.

Possible v4:

- GitHub Actions workflow.
- Fork-safe security model.
- Split trusted/untrusted workflow design.
- Report posting with least-privilege token permissions.
- Optional Codex SDK orchestration for larger enterprise workflows.

## Claude Analysis Addendum - Codex Fit For V2 / V3

Source:

- User-provided Claude analysis in `C:\Users\steve\.codex\attachments\912c30db-61c1-467c-aed4-076119f2af9c\pasted-text.txt`

Claude's analysis is useful because it maps Codex's non-interactive mode, SDK, and GitHub Action surfaces onto the staged GitNexus PR Review / Blast Radius roadmap.

### Codex Surfaces

Claude identifies three Codex automation shapes:

- `codex exec`
  - Runs Codex non-interactively from scripts or CI.
  - Defaults to a read-only sandbox.
  - Supports `--output-schema` for schema-constrained final output.
  - Supports `--json` for JSONL event streams.
  - Supports `codex exec resume --last` for two-stage pipelines.
  - Supports prompt-plus-stdin piping, such as piping GitNexus report output into Codex for explanation.

- Codex SDK
  - TypeScript: `@openai/codex-sdk`.
  - Python: `openai-codex`.
  - Starts/resumes Codex threads programmatically.
  - Can run multiple turns against the same thread.
  - Can change sandbox level per turn, for example read-only analysis, then workspace-write remediation, then read-only review.

- Codex GitHub Action
  - Provides a CI wrapper around Codex automation.
  - Fits later GitHub PR comment/check workflows.
  - Should be treated as security-sensitive because workflows may involve repository-controlled code and privileged tokens.

### Decision Codex Sharpens

Claude's most important point is that v2 and v3 should not be conflated:

- v2 is explanation.
- v3 is remediation.

Those are different jobs and should use different levels of agent power.

### v2 - Explain The Report

For v2, Claude argues that Codex's full agentic abilities are usually unnecessary.

The desired behavior is:

- take deterministic GitNexus impact JSON
- produce a human review narrative
- do not invent graph edges
- do not roam the repository
- preserve stable output fields

Recommended v2 shape:

- provider-agnostic summary layer where possible
- schema-constrained output
- input limited to the GitNexus report JSON
- no file writes
- no test generation
- no GitHub posting

Codex can still be used optionally for v2 if it is run in a strict read-only mode with only the report piped in as context, but it should not be the default design assumption.

### v3 - Generate And Validate Tests

Claude argues that v3 is where Codex becomes genuinely useful.

BlastRadius-style tools generate test stubs and stop. Codex can do more:

1. Analyze the verified risk/test gap.
2. Write a test stub.
3. Run the relevant test suite.
4. Inspect failures.
5. Iterate until the test is valid or the run reaches a stop condition.

This makes v3 a validated remediation loop rather than a one-shot generated suggestion.

Recommended v3 shape:

- optional Codex-backed remediation backend
- sandbox starts read-only for analysis
- sandbox switches to workspace-write only for the approved test-write turn
- Codex uses GitNexus facts as ground truth
- Codex runs the relevant tests and reports evidence
- generated tests are not considered useful unless they execute or fail with a clear blocker

### MCP Grounding Principle

Claude's strongest architectural point:

> Feed Codex the GitNexus graph; do not let Codex re-derive the graph.

Practical meaning:

- GitNexus remains the authority for changed symbols, impact paths, API impact, and process participation.
- Codex should query GitNexus MCP/CLI outputs or consume a GitNexus-generated report.
- Codex should not infer call structure from raw source as the authoritative blast-radius engine.
- Codex is an executor/reviewer/remediator, not the graph source of truth.

This preserves the principle:

> The model may explain verified graph facts, but it must not invent graph edges.

### Coupling Warning

Claude explicitly warns not to couple GitNexus core to OpenAI or Codex.

Recommended design direction:

- Keep GitNexus model-agnostic.
- Define a pluggable `explainer` or `remediator` concept later if needed.
- Treat Codex as one optional backend for remediation.
- Keep v2 summaries provider-agnostic where possible.
- Use Codex-specific logic only where its read/write/run loop materially helps.

### Streaming And CI

Claude notes that Codex event streams and GitHub Action workflows can eventually resemble BlastRadius's live stage events and PR comments.

Planning interpretation:

- `codex exec --json` could later feed a live progress UI.
- stdin piping could later produce a PR comment body.
- GitHub Action integration belongs to a later token-bearing automation tier.
- None of this belongs in v1.

### Claude-Informed Phase Ladder

Claude's analysis supports this refined ladder:

1. **v1 - deterministic GitNexus PR Impact report**
   - no LLM
   - no Codex dependency
   - no GitHub posting
   - local Markdown/JSON over the diff-to-graph impact pipeline
   - core behavior is `diff ranges -> symbols -> impact -> report`

2. **v2 - schema-constrained explanation**
   - summarize verified GitNexus report facts
   - provider-agnostic by default
   - Codex optional, read-only, report-only

3. **v3 - Codex-backed remediation**
   - optional test-stub generation
   - uses Codex only for the write/run/repair loop
   - grounded in GitNexus MCP/CLI facts
   - validates generated tests by execution

4. **v4 - GitHub automation / UI**
   - PR comments
   - checks/statuses
   - streaming progress
   - shareable reports
   - fork-safe security model required

### Planning Consequence

This does not replace the existing v1 plan.

It strengthens it:

- v1 should remain deterministic and local.
- v2 should be summary-only and tightly fact-bound.
- v3 is the first place Codex should be seriously considered.
- v4 is the first place GitHub posting and token-bearing workflows should be considered.

## Important Boundary

For GitNexus, "BlastRadius equivalent" should first mean:

> A graph-backed PR impact report that tells reviewers what a change may break before merge.

It should not initially mean:

> A hosted PR bot with external API, GitHub comments, generated tests, persistent web UI, and token-bearing automation.

## Open Questions

- Naming decision for V1: prefer `pr-impact`; reserve `pr-review` for manual/swarm review contexts or a compatibility alias.
- Schema decision for V1: JSON is experimental but must include `schema_version` from day one.
- Primitive decision for V1: `symbols-for-ranges` and `impact-for-symbols` are core conceptual primitives, even if implemented internally before public exposure.
- Coverage decision for V1: use `has_test_reference` / `unknown_or_unreferenced` as a graph-derived approximation, not true coverage.
- At what point, if any, should GitHub PR URL ingestion become part of this feature rather than a separate integration feature?

## Current Bias

Use this staged approach unless later research or `MAIN` approval changes the direction:

1. Local deterministic `pr-impact` report over range-to-symbol and symbol-to-impact graph primitives.
2. Optional model summary over verified facts.
3. Public/stable exposure of lower-level diff-to-graph primitives if the internal V1 helpers prove useful.
4. GitHub PR URL ingestion.
5. GitHub comment/check automation.
6. Generated remediation/test stubs.
