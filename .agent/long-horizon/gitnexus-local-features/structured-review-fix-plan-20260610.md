# Structured Review Fix Plan - 2026-06-10

## Summary

Implement the review fixes from `claude-structured-review-20260610.md` as one small hardening packet, keeping the current dirty Task 2 WIP separate from unrelated planning/runtime notes.

Confirmed findings:

- **P1 is made out**: `impact_for_ranges` errors on valid all-unmatched ranges and drops `unmatched_ranges`.
- **P2 is made out**: `wiki-refresh` dry-run uses server provider readiness while `--execute` uses CLI readiness, making the plan non-predictive for local CLI providers.
- **P3 is partly made out**: execution boundary wording is clear enough in JSON but potentially misleading in Markdown/report language.
- **P4 is partly made out**: renderer fallback should prefer `unknown` over inventing `modified`.

## Key Fixes

### P2: Make `wiki-refresh` Planning Predictive

- In `gitnexus/src/cli/wiki-refresh.ts`, call `planWikiProviderReadiness` with `mode: 'cli'` for the CLI command in both planning and execute modes.
- Leave server/API provider readiness behavior unchanged; server routes should still use server readiness.
- Update `wiki-refresh-cli` tests so a local CLI provider can be reported ready in planning mode when the CLI binary is available.
- Keep config writes disabled and do not add prompts, secrets, saved config mutation, or provider execution in dry-run mode.

### P1: Preserve All-Unmatched Range Evidence

- In `impactForRanges`, after `mapRangesToSymbols`, add a guard for `mapped.symbols.length === 0`.
- Return a normal `impact-for-ranges.v1alpha1` report with:
  - `input_ranges`
  - `matched_symbols: 0`
  - `unmatched_ranges`
  - empty `symbols`, `unmapped_symbols`, `unknown_symbols`, and `affected_processes`
  - existing caveats
- Add a red/green test in `calltool-dispatch.test.ts` for valid ranges that match zero symbols.

### P3: Clarity Polish

- Do not change JSON field names.
- Update Markdown wording so execution boundary means "enabled by requested mode," while the `execution` block remains the source of truth for whether execution actually happened.
- Add or adjust one assertion in `wiki-refresh-cli.test.ts` if Markdown wording changes.

### P4: Renderer Hygiene

- In `impact-for-ranges-report.ts`, change the missing `change_type` fallback from `modified` to `unknown`.
- Add or update a renderer test proving omitted `change_type` renders as `unknown`.

## Test Plan

Focused tests:

```powershell
npx vitest run test/unit/wiki-refresh-cli.test.ts test/unit/wiki-provider-readiness.test.ts test/unit/cli-index-help.test.ts test/unit/wiki-auto-refresh.test.ts
npx vitest run test/unit/calltool-dispatch.test.ts test/unit/impact-for-ranges-report.test.ts test/unit/impact-for-ranges-cli.test.ts
```

Broader checks:

```powershell
npm run build
git diff --check
```

Review checks:

- Confirm P1 no longer returns `symbols array must contain...` for valid all-unmatched ranges.
- Confirm `wiki-refresh` dry-run and `--execute` use the same CLI provider-readiness basis.
- Confirm no server/API provider-readiness behavior was changed.
- Confirm no config writes, provider prompts, secrets, GitHub/CI writes, or runtime route changes were introduced.

## Checkpoint Plan

Commit grouping should be one source/test commit for the review fixes:

```text
fix: harden wiki-refresh readiness and range impact edge cases
```

Keep unrelated docs/runtime handover notes separate unless the user explicitly asks for a docs checkpoint.

After commit, update long-horizon status docs with:

- P1/P2 fixed
- P3/P4 addressed as polish
- tests/build/diff-check results
- next selected task or checkpoint status

## Assumptions

- The preferred P2 resolution is to make CLI dry-run predictive of CLI execution, not to preserve server-readiness semantics in the CLI report.
- `impact-for-ranges.v1alpha1` may return a successful report with zero matched symbols; zero impact is evidence, not an error.
- P3/P4 can be included because they are low-risk and adjacent to the same report surfaces.
- No MCP route promotion, Podman runtime mutation, GitHub automation, CI mutation, or provider/token behavior is part of this fix packet.
