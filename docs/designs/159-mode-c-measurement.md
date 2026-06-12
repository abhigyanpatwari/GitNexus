---
name: 159-mode-c-measurement
type: feature
risk: low
impacted: [c3_scripts]
status: proposed
date: 2026-06-11
branch: main-afk @ b83ddb1
base: "#159 P0–P3 (PRs #165/#168) + call-site/heritage slice (PR #170, merged b83ddb1)"
implements: "#159 Mode C measurement campaign — the unmet P3 exit criterion (verify --lsp pre/post on real repos) + PR #170 index-shape delta; gates the 0.70→0.90 confidence promotion (backlog item ③)"
---

# #159 Mode C measurement campaign — heuristic-precision data + PR #170 index-shape delta

> Companion to the plan `docs/plans/159-mode-c-measurement.md`. AI agents read this `.md`; no separate `.likec4`/`.html` for this slice (pure-additive tooling, no production topology change). All file:line cites verified against trunk `main-afk @ b83ddb1` by a 3-scout pass + arch audit (12+ factual claims spot-verified; 2 blocking inconsistencies found and folded in).

## Problem & Approach

**Problem.** The LSP machinery is fully shipped (Mode C `verify --lsp` + `lsp doctor` in PR #165; Mode B in #165; Mode A CALLS in #168; call-site identity + heritage in #170), but the P3 exit criterion was never executed: *run `verify --lsp` pre/post on a real repo — precision↑, no recall regression, false-confident rate*. Without this data, the 0.70→0.90 confidence promotion (backlog ③) has no evidential basis. Separately, PR #170's deliberate baseline change reshaped GitNexus's own index (edges 11,709→22,269 +90%; flows 266→167; clusters 465→474) — unquantified side effects that feed the same promotion decision and the pre-GA load-test follow-up.

**Approach.** A measurement campaign, not a feature: a committed harness (`gitnexus/scripts/measure-mode-c.ts`) that runs a two-leg matrix per repo — Leg A: default `analyze` (heuristic baseline index) → programmatic `runModeCVerify`; Leg B: same heuristic baseline index, same-seed `runModeCVerify` with `LspClient` (LSP-at-verify wiring). **Both legs verify against the SAME heuristic-only index**; the only leg-level difference is the verifier wiring (LspClient + `mapLocationToNodeId` + `executeParameterized` are wired in for the `lsp` leg). The harness runs `analyze` at most once per repo (when `.gitnexus` is absent on entry). The `lsp` leg therefore measures LSP availability at verify-time on a heuristic index — a *narrower* claim than "LSP-augmented index pre/post". Distinct LSP-augmented indexing is filed as a follow-up WI; the campaign's central claim is **LSP-at-verify delta on the heuristic index**, not pre/post index shape. A companion script (`scripts/flow-fate.ts`) quantifies the #170 delta by re-deriving the pre-#170 index at `438600e` and classifying flow fates. Everything reuses shipped machinery; zero production symbols change. Results land as a #159 comment with a promotion *recommendation* (the promotion itself is a non-goal).

## KeyDecisions

| # | Decision | Why |
|---|---|---|
| KD-1 | Programmatic `runModeCVerify` invocation from the harness — NOT parsing `verify` CLI text, NOT adding `--json`/`--seed` CLI flags | `VerifyReport` JSON directly + explicit `seed`/`sampleSize`/`hardCap` (`mode-c-verifier.ts:123-153`); zero production changes. CLI flags = scope creep, filed as follow-up if the campaign recurs |
| KD-2 | Repo set: GitNexus + hono + zod, SHAs pinned at execution; `npm install` in each; substitution rule (fastify/excalidraw) on analyze/probe failure | Mid-size, type-clean OSS TS; node_modules needed or external-tier refusals spike (workspace probe + definitions into deps) |
| KD-3 | Two-leg matrix per repo: SHARED heuristic-only index. Leg A (`baseline`) runs `runModeCVerify` against the heuristic index with the production seam wiring. Leg B (`lsp`) runs `runModeCVerify` against the SAME heuristic index, but with the full `LspClient` + `mapLocationToNodeId` + `executeParameterized` wiring (LSP-at-verify). The harness runs `analyze` at most once per repo (when `.gitnexus` is absent on entry); both legs reuse the resulting index. The `lsp` leg therefore measures the verifier's ability to *cross-check* heuristic edges against live LSP — NOT a distinct LSP-augmented index. The `leg` label lives on the artifact envelope (`artifact.leg`); it is NOT injected into the verifier's `RunModeCVerifyOpts` (zero `src/` edits). | The verifier re-verifies ALL CALLS edges regardless of `source` (`mode-c-verifier.ts:244-263`) → the comparison is mechanically valid. Distinct indexes (true pre/post LSP-augmented) are filed as a follow-up WI; the campaign's narrower claim is "LSP-at-verify delta on the heuristic index" — sufficient to gate the 0.70→0.90 confidence promotion because the per-edge verdict (match / false-confident / refused) is what the consumer cares about. |
| KD-4 | Sample 1000 (GitNexus) / 500 (external); seed `campaign-159`; determinism re-assert by double-run byte-compare | Serial LSP ≈ 100–200ms/req → 2–4 min/leg; CI ≈ ±2% at fc≈5%; verifier determinism already pinned (`mode-c-report-stability.test.ts`) — the re-run guards orchestration-level nondeterminism |
| KD-5 | Report BOTH fc-rates: reported (`falseConfident/n`) AND conditional (`falseConfident/(matches+falseConfident)`) + refusal rate as its own column | Refusals dilute the reported rate (`mode-c-verifier.ts:588-604`); multi-location ⇒ refusal is by-design conservative — without the conditional rate the data flatters the heuristic |
| KD-6 | #170 delta re-derived at `438600e` (scratch clone + analyze), never from memory snapshots; flow fate matched by `(entryPointId, terminalId)`, never label; entry-point hypothesis decomposed, not single-cause | Entry-point selection is a continuous score (`calculateEntryPointScore` > 0, `process-processor.ts:266-311`), and flow count is also driven by the `maxProcesses*2` trace cap + endpoint dedup (`:108`) — a "gate pass count" would measure the wrong quantity |
| KD-7 | Committed harness + gitignored raw artifacts; tables only in the #159 comment | Repeatable for the post-promotion re-run; raw reports are bulky and machine-local |
| KD-8 | Harness graph reads go through `executeParameterized` ONLY — never `initLbug`/`executeQuery` | `assertNoGraphWriteImports` (`mode-c-verifier.ts:727-764`) forbids those tokens; the harness must pass the same no-write invariant the verifier enforces on itself (audit blocking-fix #1) |
| KD-9 | Harness assembles the full `RunModeCVerifyOpts` mirroring `src/cli/verify.ts` — `{repoId, client, probe, mapLocationToNodeId, executeParameterized, seed, sampleSize, hardCap}` | `runModeCVerify` requires the client/probe/mapper deps; "just call it with a seed" was the audit's blocking-fix #2 |

## Contracts

- **`measureModeC(opts)`** (new, `scripts/measure-mode-c.ts`): `{ repoPath, legs: ('baseline'|'lsp')[], sampleSize, seed, outDir, exec?, verify?, stat?, runCypher?, sha?, loadMeta?, getStoragePaths?, serverVersion?, lspServerPath?, now? }` → one JSON artifact per (repo, leg) + a markdown summary. All I/O deps are injectable seams (QE). `now` and `lspServerPath` are optional determinism / production-verify seams; the test suite injects stubs.
- **Artifact schema** (per repo, leg): `{ repo, sha, leg, analyzeWallMs, dbSizeBytes, meta: {files,nodes,edges,communities,processes}, edgeCountsBySource, edgeCountsByReason, funnel?: {candidates, cap, skipped}, report: VerifyReport, underSampled: boolean, analyzeRanFirst: boolean }`. `underSampled = report.sampledCap < sampleSize`.
- **`VerifyReport` / `VerifyMetrics`** (existing, read-only consumption): `{perTier, overall: {precision, recall, falseConfidentRate, matches, falseConfident, recallMisses, refusals, recallGains, n}, sampleSize, serverVersion, lspUnavailable?, reason?, sampledCap?}` (`mode-c-verifier.ts:72-116`).
- **Metric definitions (KD-5):** precision = matches/(matches+falseConfident) · reported fc-rate = falseConfident/n · conditional fc-rate = falseConfident/(matches+falseConfident) · recall proxy = matches/(matches+falseConfident+recallMisses) · **no-recall-regression** = `noRecallRegression(baseline, lsp)` pure function — `lsp.recallMisses <= baseline.recallMisses` AND `lsp.resolvedCalls >= baseline.resolvedCalls` where `resolvedCalls = matches + falseConfident + recallGains`. When `baseline.recallMisses === 0` the `missesOk` clause is trivially true; the verdict attaches a `lowBaselinePower:true` flag so a downstream consumer can spot a regression check that ran with no signal on the misses side. The function is exported from `scripts/measure-mode-c.ts` and emits a `recall-regression.md` artifact in the CLI output directory (one row per repo, one verdict column). AC-2 is mechanically satisfied when the file is present and parseable.
- **`classifyFlowFates(before: ProcessNode[], after: ProcessNode[]): FateReport`** (new, pure, `scripts/flow-fate.ts`): match key `(entryPointId, terminalId)`; fates `{stable | label-changed | removed | added}`; emits `entryPointCandidatesBefore/After` (score>0 count). DB-reading orchestration is separate from the pure function.
- **Source-distribution query** (read-only): `MATCH ()-[r:CodeRelation]->() RETURN r.source AS bucket, COUNT(r) AS count GROUP BY r.source` via `executeParameterized` (schema: `schema.ts:533-546`; `EdgeSource` union `graph/types.ts:192`). The query is relationship-agnostic — it covers ALL `CodeRelation` rows (CALLS, IMPORTS, IMPLEMENTS, EXTENDS, HAS_METHOD, …) so the artifact's `edgeCountsBySource` / `edgeCountsByReason` maps reflect the full graph, not just CALLS. The KPI consumer's analysis (which edge types LSP is helping or hurting) is driven by the full distribution.
- **Halt contract:** `discoverServers` → no binary ⇒ exit non-zero with `lsp doctor`-equivalent diagnostics; NO artifact written (zeros are never data).
- **Typecheck contract:** `tsconfig.scripts.json` (new) extends the root config and includes `scripts/**`; `npm run typecheck:scripts` gates WI-V (scripts/ is outside the root tsconfig rootDir).

## Invariants

- **I-1** Zero `src/` edits; the only non-`scripts/` touches are `tsconfig.scripts.json` (new) + one `package.json` npm-script line (declared build config).
- **I-2** Harness and flow-fate sources pass `assertNoGraphWriteImports` (reused exported helper) — graph access is `executeParameterized`-only; the `analyze` subprocess does all writing.
- **I-3** Per-repo strictly sequential open → read → close (LadybugDB lock discipline); never two repos' connections concurrently.
- **I-4** Same (index, seed, sampleSize) double-run ⇒ byte-identical artifact files (AC-5; extends the verifier-level determinism pin to the orchestration layer).
- **I-5** An under-sampled run (`sampledCap < sampleSize`, e.g. LSP crash-degradation) is flagged `underSampled:true` and excluded from headline tables — partial metrics are never silently published.
- **I-6** Published rates always appear as the (reported, conditional, refusal) triple — no single-rate cherry-picking. The headline summary table's only rate columns are reported fc-rate, conditional fc-rate, and refusal rate. `precision` and `recall` are available on the full `VerifyReport` (in the per-leg JSON artifact) but are NEVER rendered as headline columns — a reader skimming the table sees only the KD-5 triple. The `recall-regression.md` artifact (AC-2) uses resolved-calls and recall-misses counts (not rates) to surface the regression verdict.
- **I-7** Pre-#170 numbers in the results derive exclusively from the `438600e` re-analysis, with memory-snapshot values shown only as a sanity cross-check.
- **I-8** The campaign emits a promotion *recommendation*; no confidence constant changes in this slice.

## Flows

#### Sequence: measurement matrix — per repo {#sd-campaign-tobe}

```mermaid
sequenceDiagram
    participant H as measure-mode-c.ts (harness)
    participant A as gitnexus analyze (subprocess)
    participant DB as LadybugDB (.gitnexus/lbug)
    participant V as runModeCVerify
    participant L as LspClient (tsserver)
    H->>H: discoverServers()
    alt no typescript-language-server
        H->>H: print doctor diagnostics, exit non-zero (NO artifact)
    else binary found
        H->>A: leg A: analyze <repo> (no --lsp, when .gitnexus absent)
        A->>DB: write heuristic index
        H->>DB: executeParameterized — meta/source/reason counts
        Note over H,V: Leg A uses the heuristic index. lspServerPath is resolved by main(); both legs use the same LspClient during verification; only artifact.leg differs. The harness does NOT inject meta into RunModeCVerifyOpts (zero src/ edits).
        H->>V: leg A: runModeCVerify({...realVerifyOpts (leg-agnostic)})
        loop sampled edges (stratified, seeded)
            V->>L: textDocument/definition(sourceLine) [when LSP available]
            L-->>V: Location | null
        end
        V-->>H: VerifyReport (leg A)
        H->>A: leg B: analyze <repo> --lsp (when leg's flag differs from leg A's)
        A->>DB: write LSP-augmented index
        H->>DB: executeParameterized — meta/source/reason counts
        H->>V: leg B: runModeCVerify({...same realVerifyOpts (leg-agnostic)})
        loop sampled edges (same seed/sample, new index)
            V->>L: textDocument/definition(sourceLine) [same LspClient]
            L-->>V: Location | null
        end
        V-->>H: VerifyReport (leg B)
        alt report.sampledCap < sampleSize
            H->>H: artifact.underSampled = true (excluded from headline tables)
        else complete sample
            H->>H: write artifacts + markdown summary rows
        end
    end
```

## EdgeCases

- **Repo without `.gitnexus`:** harness runs `analyze` first, records `analyzeRanFirst:true`.
- **LSP server crash mid-verify:** LspClient restart budget exhausts → degraded nulls → `sampledCap` under-runs → I-5 flags the run; harness retries once before declaring the leg invalid.
- **Legacy index without `source` column rows:** `edgeCountsBySource:{}` recorded without throwing.
- **External repo fails analyze or workspace probe:** substitution per KD-2 (fastify/excalidraw), logged in the results — never silently partial.
- **Same-label distinct flows:** matched by `(entryPointId, terminalId)` → independent fates (label is display-only, heuristic).
- **`438600e` checkout unavailable on another machine:** flow-fate smoke self-compares one dir (all `stable`); the SHA dependency is documented in `--help`.
- **Leg populations differ (Leg B has corrected/recall edges):** indexes are per-leg, so populations can legitimately differ (the LSP-augmented index can add/remove edges). Stratified tiers + same seed + funnel stats + `noRecallRegression` check keep the comparison interpretable; deltas are reported per-tier, never as one global number. The `noRecallRegression(baseline, lsp)` helper mechanically surfaces this: `lsp.recallMisses <= baseline.recallMisses` AND `lsp.resolvedCalls >= baseline.resolvedCalls` (resolvedCalls = matches + falseConfident + recallGains), otherwise the regression is flagged in `recall-regression.md`.
- **Mode A delta ceiling:** only ≤2000 candidates are touched per run (`DEFAULT_CANDIDATE_CAP`, `mode-a-reconciler.ts:249-250, 365-367`) — deltas interpreted per-candidate, not per-graph.
- **Environment-level LSP unavailability (all-excluded outcome):** When `typescript-language-server` is present but incompatible with the Node version (e.g., Node v23.11.0 vs tsserver v5.1.3), the workspace probe returns `ready:false` for all repos. The verifier short-circuits with `lspUnavailable:true` and `sampledCap:0` → every leg is `underSampled:true` per I-5. This is an environment constraint, not a harness bug; the halt contract is still honored (no artifact published as headline data). Documented in `wi3-manifest.md` §"All-excluded outcome — root cause". The Excluded section distinguishes three reasons: (a) `harness-error:<message>` — the harness itself rejected (e.g. `analyze` subprocess non-zero exit, `loadMeta` threw on a corrupt `meta.json`); (b) `lsp-unavailable:<reason>` — the LSP probe returned `ready:false` and the verifier short-circuited with `lspUnavailable:true`; (c) `under-sampled` — the verifier completed but `sampledCap < sampleSize` (caller-runnable cap, e.g. an empty bucket). The three reasons are mutually exclusive in the renderer; the most specific wins.
- **Per-leg analyze flag (NOT shipped — filed as follow-up WI):** The shipped harness reuses the SAME heuristic-only index for both legs. Per-leg `analyze --lsp` (i.e. a distinct LSP-augmented index for the `lsp` leg) is not implemented in this slice. The `lsp` leg therefore varies the verifier wiring only — not the underlying index. The headline claim of this campaign is **LSP-at-verify delta on the heuristic index**; a future follow-up may re-introduce per-leg analyze to extend the claim to "LSP-augmented index pre/post" (the stronger claim). Tests pin this narrower behavior (DT-7-3 asserts the single `analyze` call has no `--lsp` flag).

## BlastRadius

- **d1 (new files only):** `gitnexus/scripts/measure-mode-c.ts` · `gitnexus/scripts/flow-fate.ts` · `gitnexus/tsconfig.scripts.json` · `gitnexus/test/unit/scripts/{measure-mode-c,flow-fate,scripts-no-write-invariant}.test.ts` · `gitnexus/package.json` (+1 npm script).
- **d2 (read-only consumers — should-test via WI-V):** `runModeCVerify` + `RunModeCVerifyOpts` assembly · `executeParameterized` pool adapter · `loadMeta`/`getStoragePaths` · `discoverServers` · `assertNoGraphWriteImports`.
- **d3 (campaign-time only, no code dependency):** external clones (hono, zod) + `438600e` scratch clone — all in gitignored scratch.
- **Confirmed non-impact:** all `src/` production symbols (zero edits) · vitest `lbug-db` project include[] (script tests run in `default`) · `gitnexus-web/` · existing test files.
- **Untouchable:** `mode-c-report-stability.test.ts` determinism pins · mode-a-golden B1 source guards · PR #156 heritage tests.
