# Claude Structured Review - 2026-06-10

Generated: 2026-06-10

## Purpose

Capture a structured second-pass review of the new local-features work
before the Task 2 usage-hardening WIP is checkpointed: the uncommitted
`wiki-refresh --execute` slice and the committed explicit-range /
API-smoke tranche (`8640ab5b`, `5a8c4e1c`, `6a550c48`).

This review was performed by a Claude Code session with full filesystem
and test-execution access (unlike the prompt-only Codex review of
2026-06-08). Working notes are in
`feature-review-scratchpad-20260610.md`; this file is the structured
result.

## Scope

- Uncommitted WIP: `gitnexus/src/cli/wiki-refresh.ts`,
  `gitnexus/src/core/wiki/provider-readiness.ts`, CLI/i18n registration,
  and the three WIP test files.
- Committed: `impact-for-ranges` primitive and Markdown readout, the
  `/api/clusters` API-smoke renderer.
- Not re-reviewed: `2dde6886` analyze/vector fix (already unit-, build-,
  and runtime-verified per the 2026-06-09 handover).
- Verified supporting claims in source: `resolveLLMConfig()` never
  prompts or writes config; `runWikiAutoRefresh` skipped path stamps
  `durationMs: 0`.

## Verification Runs

| Run | Result |
| --- | --- |
| `npx vitest run test/unit/wiki-refresh-cli.test.ts test/unit/wiki-provider-readiness.test.ts test/unit/cli-index-help.test.ts test/unit/wiki-auto-refresh.test.ts` | Passed, 4 files, 32 tests |
| `npx vitest run test/unit/impact-for-ranges-cli.test.ts test/unit/impact-for-ranges-report.test.ts test/unit/calltool-dispatch.test.ts test/unit/e2e-test-generation-api-smoke-renderer.test.ts` | Passed, 4 files, 102 tests |

Two error-level log lines during the second run are expected
rename-test fixture noise (path-traversal block, missing `rg`).

## Overall Result

Overall correctness: `WIP slice is correct and ready to checkpoint;
committed tranche has one low-severity follow-up bug`.

Confidence: `0.9`

Boundary compliance: all reviewed slices respect the feature-map
boundaries — no provider execution without `--execute`, no config
writes anywhere (`config_writes_enabled` is a literal `false` in the
type), no GitHub/CI surface, deterministic outputs, honest caveats.

## Findings

| Priority | Finding | Location | Confidence |
| --- | --- | --- | --- |
| P1 | `impact_for_ranges` returns a misleading error and drops `unmatched_ranges` evidence when valid ranges match zero symbols. | `gitnexus/src/mcp/local/local-backend.ts` (`impactForRanges` -> `resolveDirectProcessImpact` empty-input guard) | `0.95` |
| P2 | Planning mode and `--execute` mode evaluate provider readiness differently (`mode: 'server'` vs `'cli'`), so the dry-run plan is not predictive of `--execute` for local CLI providers (claude/codex/cursor). | `gitnexus/src/cli/wiki-refresh.ts` (`planWikiProviderReadiness` call) | `0.9` |
| P3 | With `--execute` requested but execution skipped, `execution_boundary` still reports `provider_execution_enabled: true` / `output_mutation_enabled: true`; the `execution` block records the skip, so this is doc-clarity only. | `gitnexus/src/cli/wiki-refresh.ts::buildExecutionBoundary` | `0.85` |
| P4 | Markdown readout defaults a missing `change_type` to `modified`; `unknown` would be more honest if the field can ever be absent. Cosmetic; backend currently always sets it. | `gitnexus/src/core/pr-impact/impact-for-ranges-report.ts::summarizeRanges` | `0.7` |

### P1 - All-Unmatched Ranges Error Instead of Reporting Evidence

In `impactForRanges`, when caller-supplied ranges are valid but map to
zero graph symbols (comment-only or whitespace-only ranges), the
composed call passes an empty symbol array into
`resolveDirectProcessImpact`, which returns
`{ error: 'symbols array must contain at least one valid symbol object
with an id.' }`. The caller supplied ranges, not symbols, and the
legitimate `unmatched_ranges` evidence is silently dropped. No test
covers the all-unmatched case; the single dispatch test always has at
least one matched symbol.

Suggested fix:

- Guard `mapped.symbols.length === 0` in `impactForRanges` and return a
  normal `impact-for-ranges.v1alpha1` report with `matched_symbols: 0`,
  the `unmatched_ranges` evidence intact, and empty symbol/process
  arrays.
- Add a red/green test for the all-unmatched input.

This is a green-lane, single-method fix.

### P2 - Plan Output Not Predictive of `--execute` for Local CLI Providers

`wikiRefreshCommand` passes `mode: options.execute ? 'cli' : 'server'`
to `planWikiProviderReadiness`. For a user configured with a local CLI
provider, the default planning report says the provider is not ready
(refresh would be skipped) while `--execute` detects the local binary
and proceeds. Either planning mode should also use `'cli'` (the command
is a CLI), or the plan output should explain the divergence. This is a
report-contract decision and should be settled before the WIP slice is
checkpointed.

### P3 / P4

Cosmetic; see table. One documentation sentence (P3) and an optional
renderer default change (P4).

## Strengths Confirmed

- `runWikiAutoRefresh` re-evaluates all prerequisites before invoking
  the generator, so `--execute` degrades to `skipped` rather than
  mutating output on stale graph / missing meta / unready provider.
- Exit code 1 on non-`completed` execution makes `--execute`
  scriptable.
- The `resolveDirectProcessImpact` extraction is a faithful refactor:
  `impact_for_symbols` output shape and ordering are unchanged.
- Deterministic ordering throughout the explicit-range surfaces
  (input order for symbols; `matched_symbols desc, name, id` for
  processes).
- Markdown readout is a pure renderer over the JSON contract with no
  backend change, as the packet required.
- `/api/clusters` smoke renderer is pattern-consistent, fixture-backed,
  and stays within stable-shape assertions.

## Recommended Actions

1. Decide P2 (planning-mode provider readiness `'server'` vs `'cli'`)
   before committing the WIP — it changes the report contract.
2. Checkpoint the wiki-refresh `--execute` slice (source + tests + its
   docs) separately from unrelated long-horizon doc updates.
3. Open a small follow-up packet for P1 (guard + test).
4. Optional: P3 doc sentence and P4 renderer default.
