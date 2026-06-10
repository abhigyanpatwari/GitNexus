# Feature Review Scratchpad - 2026-06-10

Reviewer: Claude Code session, 2026-06-10.
Status: COMPLETE

## Scope

Review of new feature work on `local/gitnexus-local-features`:

1. **Uncommitted WIP** — Task 2 wiki-refresh usage-hardening
   (`wiki-refresh.ts` +191 lines, `provider-readiness.ts` +22, CLI/i18n
   registration, 3 test files, ~155 new test lines).
2. **Committed tranche** (since `2a38a6db`) — Task 4 explicit-range
   primitives (`symbols-for-ranges`, `impact-for-symbols`,
   `impact-for-ranges` + markdown), Task 6 API clusters smoke renderer,
   and the `2dde6886` analyze/vector fix.

Method: read diffs, check against the stated boundaries in
`feature-map.md` (planning-only execution boundary, no provider
execution, no secrets), run focused tests, record findings here as work
proceeds.

## Work Log

- [x] Survey WIP diff (13 files, +797/-48; source WIP is wiki-refresh
      `--execute` slice + i18n/help registration)
- [x] Review wiki-refresh CLI WIP in detail
- [x] Review provider-readiness changes
- [x] Review WIP tests
- [x] Check `resolveLLMConfig` no-prompt claim
- [x] Run focused WIP test suite — 4 files, 32 tests, all passed
- [x] Review committed tranche commits (`8640ab5b`, `5a8c4e1c`,
      `6a550c48`; `2dde6886` already runtime-verified per handover)
- [x] Run committed-tranche focused tests — 4 files, 102 tests, all
      passed
- [x] Final summary + verdicts

## Findings

### WIP: Task 2 wiki-refresh `--execute` (uncommitted)

**Design summary.** `gitnexus wiki-refresh --execute` flips the report's
`execution_boundary` from `planning-only` to `explicit-cli-execution`,
calls `runWikiAutoRefresh` (which re-evaluates prerequisites before
invoking the generator), and adds an `execution` summary block
(`not-requested | completed | failed | skipped`) to both JSON and
Markdown output. `config_writes_enabled` stays hard-`false` in both
modes. Non-`completed` execution sets `process.exitCode = 1`.

**Good:**

- G1. The boundary object is honest in both modes; the type keeps
  `config_writes_enabled: false` as a literal `false`, so config writes
  cannot be silently enabled later without a type change.
- G2. `runWikiAutoRefresh` re-runs the prerequisite plan internally, so
  `--execute` with a stale graph / missing meta / unready provider
  degrades to `skipped` rather than mutating output.
- G3. Exit code 1 on `skipped`/`failed` makes the command scriptable.
- G4. Tests cover the execute path end-to-end with a faithful
  `actualPlan()` simulation of the real planner gates, including
  boundary fields and `recommended_command` suppression.
- G5. CLI-mode provider readiness (`mode: 'cli'`) only widens readiness
  for local CLI providers (cursor/claude/codex) via binary detection;
  server mode behavior is unchanged. Both branches tested.

**Findings (to verify or fix):**

- F1 (consistency, minor). Planning mode passes `mode: 'server'` to
  `planWikiProviderReadiness`, execute mode passes `mode: 'cli'`. For a
  user with `provider: codex/claude/cursor`, the *plan* says provider
  not ready (skip) while `--execute` would proceed. The dry-run report
  is therefore not predictive of `--execute` for local CLI providers.
  Suggest planning mode also use `'cli'` (the command IS a CLI), or the
  plan output should explain the divergence.
- F2 (to verify). `--execute` help text promises "without prompting or
  writing config" — need to confirm `resolveLLMConfig()` never prompts
  and never writes config when invoked non-interactively.
- F3 (truth-claim, cosmetic). When `--execute` is requested but
  execution is `skipped`, `execution_boundary` still reports
  `provider_execution_enabled: true` / `output_mutation_enabled: true`
  with empty `required_human_decisions`. The `execution` block does
  record the skip, so it is not misleading overall, but the boundary
  describes intent rather than outcome — worth one doc sentence.
- F4 (cosmetic). `buildExecutionSummary` skipped-branch reads
  `result.durationMs` — confirm the skipped path of `runWikiAutoRefresh`
  actually stamps `durationMs` (else field is silently absent; fine but
  the test fixture stamps `durationMs: 0`, masking it).

**F2/F4 resolution (verified in source):**

- F2 RESOLVED — `resolveLLMConfig()` (`llm-client.ts:51`) only reads
  env vars (`GITNEXUS_API_KEY`, `OPENAI_API_KEY`,
  `GITNEXUS_LLM_BASE_URL`, etc.) and saved config. No prompting, no
  config writes. The `--execute` help-text claim is accurate.
- F4 RESOLVED — `runWikiAutoRefresh` skipped path returns
  `{ ...plan, durationMs: 0 }` (`auto-refresh.ts:170`). Field is always
  present.

**WIP test run:** `wiki-refresh-cli`, `wiki-provider-readiness`,
`cli-index-help`, `wiki-auto-refresh` — 4 files, 32 tests, all passed
(2026-06-10, vitest 4.1.7, ~20s).

### Committed: Task 4 `impact-for-ranges` primitive (`8640ab5b`)

**Design summary.** Extracts `resolveDirectProcessImpact()` as a shared
helper from `impactForSymbols`, then composes
`mapRangesToSymbols -> resolveDirectProcessImpact` into a new
`impact_for_ranges` tool returning `impact-for-ranges.v1alpha1` with
matched/unmatched range evidence, per-symbol `change_types`, direct
process membership, deterministic ordering, and explicit caveats
(no caller traversal, no risk scoring, no API/test signal).

**Good:**

- G6. The shared-helper refactor is faithful — `impact_for_symbols`
  output shape is unchanged (same summary fields, same sort rules).
- G7. Deterministic ordering everywhere (input order for symbols;
  `matched_symbols desc, name, id` for processes) — golden-testable.
- G8. Caveats honestly exclude semantics the surface does not compute,
  matching the coexistence/parity decision to keep `pr-impact` as the
  richer lane.

**Findings:**

- F5 (real bug, low severity). All-unmatched ranges return a misleading
  error. In `impactForRanges`, when valid ranges map to zero symbols,
  `resolveDirectProcessImpact(repo, [])` is called and returns
  `{ error: 'symbols array must contain at least one valid symbol
  object with an id.' }` — the caller supplied *ranges*, not symbols,
  and the legitimate `unmatched_ranges` evidence is dropped instead of
  reported. Comment-only / whitespace-only range sets hit this. There
  is no test for the all-unmatched case (the single dispatch test has
  >=1 matched symbol). Suggested fix: guard
  `mapped.symbols.length === 0` in `impactForRanges` and return a
  normal report with `matched_symbols: 0` and the `unmatched_ranges`
  evidence intact, plus a red/green test.

### Committed: `impact-for-ranges` Markdown readout (`5a8c4e1c`)

- Pure renderer over the JSON contract (`impact-for-ranges-report.ts`,
  new file, no backend change) — readout-only as the packet required.
- Deterministic table rendering; ranges summarized as
  `path:start-end (change side)`. No issues found.
- Minor note: `summarizeRanges` defaults missing `change_type` to
  `modified` in the readout — a display-side assumption the JSON
  contract does not make. Harmless today (backend always sets it), but
  `unknown` would be more honest than `modified` if it can be absent.

### Committed: Task 6 `/api/clusters` API-smoke renderer (`6a550c48`)

- Small, pattern-consistent extension of `api-smoke-renderer.ts` with a
  golden generated spec fixture and focused tests. Stable-shape
  assertions only (`{ clusters: [] }`), per the lane boundary. No
  issues found.

### Committed: analyze/vector fix (`2dde6886`)

- Not re-reviewed in depth: already unit-, build-, and
  runtime-verified per the 2026-06-09 handover (force analyze without
  `free(): invalid pointer`; 32035 embeddings; `vectorStatus:
  vector-index` in the local-features Podman image).

**Committed-tranche test run:** `impact-for-ranges-cli`,
`impact-for-ranges-report`, `calltool-dispatch`,
`e2e-test-generation-api-smoke-renderer` — 4 files, 102 tests, all
passed (2026-06-10). Two error-level log lines during the run are
expected rename-test fixture noise (path-traversal block, missing rg).

## Summary and Verdicts

| Slice | Verdict | Blocking issues |
| --- | --- | --- |
| WIP: wiki-refresh `--execute` | **Ready to commit** after deciding F1 | None blocking; F1 is a consistency choice, F3 is doc-only |
| `impact-for-ranges` primitive | **Solid; one follow-up bug** | F5 — all-unmatched ranges error instead of reporting evidence |
| Markdown readout | **Clean** | None (cosmetic `modified` default) |
| `/api/clusters` smoke renderer | **Clean** | None |
| Analyze/vector fix | **Verified previously** | None |

Boundary compliance: all reviewed slices respect the feature-map
boundaries — no provider execution without `--execute`, no config
writes anywhere, no GitHub/CI surface, deterministic outputs, honest
caveats. The `--execute` slice is exactly the "Task 2 wiki
usage-hardening" step the feature map names as the selected next slice.

Recommended actions, in order:

1. Decide F1 (planning-mode provider readiness: `'server'` vs `'cli'`)
   before committing the WIP — it changes the report contract.
2. Commit the wiki-refresh `--execute` slice (with its docs) as its own
   checkpoint, separate from long-horizon doc updates, per the
   handover's slice rule.
3. Open a small follow-up packet for F5 (guard + test); it is a
   green-lane, single-method fix.
4. Optional cosmetic: `unknown` instead of `modified` default in
   `summarizeRanges`; one doc sentence for F3.
