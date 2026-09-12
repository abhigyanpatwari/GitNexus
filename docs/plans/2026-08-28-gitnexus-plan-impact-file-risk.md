# GitNexus Engineering Plan

> Task: Fix #3075 — File `impact` risk is not comparable to Function/Method risk.
> Evidence verified at commit `6bff33d14cbfe1e7b4f04bca51507e9f64ef579c` (`feat/kotlin-const-resolver`); GitNexus index 129 commits behind, refresh skipped: full-repo `--index-only --pdg` rebuild is impractical this session. Scorer and schema claims are `[verified]` from source; live inversion numbers are `[graph]` on the stale index.

## 1. Objective

Make File vs symbol `impact.risk` honest for consumers: either they can tell the scales differ, or they can compare on a shared two-axis score. Do **not** DEFINES-bridge processes/modules onto File targets (issue reporter sampled 8/10 one-importer files jumping to HIGH/CRITICAL). Do **not** retune Function HIGH/CRITICAL thresholds (agent warn-before-edit).

Acceptance:

- A File with a wider blast radius than a Function in the same file no longer looks “safer” when a consumer only reads `risk`, **or** the result states that `risk` is not comparable across kinds and offers `riskSharedAxes` for comparison.
- File targets still cannot trip HIGH/CRITICAL via `processes_affected` / `modules_affected` unless those axes become real in the index (they are not today).
- Existing Function/Method labels under the current four-axis ladder stay the same for the same inputs.
- MCP `riskNote` remains UNKNOWN-only (`tools.ts` contract).

## 2. Current Behaviour

Callgraph `impact` ends in `LocalBackend._runImpactBFS` (`gitnexus/src/mcp/local/local-backend.ts`). After BFS it enriches impacted ids with `STEP_IN_PROCESS` and `MEMBER_OF`, then scores:

```7720:7738:gitnexus/src/mcp/local/local-backend.ts
    } else if (
      directCount >= 30 ||
      processCount >= 5 ||
      moduleCount >= 5 ||
      impacted.length >= 200
    ) {
      risk = 'CRITICAL';
    } else if (
      directCount >= 15 ||
      processCount >= 3 ||
      moduleCount >= 3 ||
      impacted.length >= 100
    ) {
      risk = 'HIGH';
    } else if (directCount >= 5 || impacted.length >= 30) {
      risk = 'MEDIUM';
    } else {
      risk = 'LOW';
    }
```

Empty upstream → `UNKNOWN` + `riskNote`. Downstream empty stays LOW. `skipEnrichment` (ambiguous probes) already scores on direct+total only. PDG mode forces `risk: UNKNOWN` (`composeUnifiedPdgImpactResult`) — out of scope.

File BFS walk is mostly File←IMPORTS File. Enrichment queries those File ids. Processes are CALLS traces (`process-processor.ts`); communities admit only Function/Class/Method/Interface (`isCommunitySymbol` in `community-processor.ts:412-416`). File is not in that set. `enrichCandidateLabels` UNION also **omits File**, so File `target.type` is often `""`; detect File via `id` prefix `File:`.

Web Graph RAG (`gitnexus-web/src/core/llm/tools.ts` ~1331–1346) duplicates the same ladder.

## 3. Relevant Architecture

| Layer | Role |
|---|---|
| Index | File never sources `STEP_IN_PROCESS` / `MEMBER_OF` by construction |
| MCP `_runImpactBFS` | Blast radius + four-axis `risk` |
| Ambiguous probes | `skipEnrichment` → 2-axis `risk` already |
| `mergeRisk` | Group overlay; monotone in crossings; does not know target kind |
| CLI `formatImpactResult` | Prints counts; **does not print `risk`** on the resolved callgraph path; JSON `impactCommand` still ships `risk` |
| `ai-context.ts` / `tools.ts` | Agent contract: warn on HIGH/CRITICAL; `riskNote` UNKNOWN-only |
| Web LLM `impact` | Same formula, prose `RISK:` line |

Modules: Local (MCP), Cli (format/docs), Group (`mergeRisk`), gitnexus-web LLM tools. Shared package `gitnexus-shared` is already a dependency of both CLI and web.

## 4. GitNexus Findings

- Primary: `_runImpactBFS` — d=1 `[graph]` `impact(target:_runImpactBFS, maxDepth:1, includeTests:true)`: `_impactImpl`, `impactByUid`. Production chain `[verified]`: `impact` → `_impactImpl` → `_runImpactBFS`; `impactByUid` skips per-symbol process lists but **not** aggregation (`skipPerSymbolEnrichment` only).
- `LocalBackend.impact` d=1 `[graph]` `context`: `callTool`.
- Duplicate scorer `[verified]` grep: `gitnexus-web/src/core/llm/tools.ts`.
- `mergeRisk` `[verified]` callers in `src/`: only `runGroupImpact` (`cross-impact.ts:907`). Graph d=1 listed a test File (`impact-pdg-shape.test.ts`) and missed `runGroupImpact` — trust source.
- Schema `[verified]`: `isCommunitySymbol` excludes File; `schema.ts` documents MEMBER_OF as Function/Class/Method/Interface only.
- Live inversion `[graph]` stale index, `impact summaryOnly` on GitNexus:

| target | kind | impacted | direct | processes | modules | risk |
|---|---|---|---|---|---|---|
| `lbug-config.ts` | File | 54 | 12 | 0 | 0 | MEDIUM |
| `openLbugConnection` | Function | 16 | 9 | 3 | 2 | HIGH |
| `local-backend.ts` | File | 12 | 10 | 0 | 0 | MEDIUM |
| `refreshRepos` | Method | 50 | 5 | 4 | 7 | CRITICAL |

- Clusters/processes resources `[graph]`: Local/Cli/Group sit in the impact path; process traces are function-stepped, not File-stepped.
- Related tests `[verified]`: `test/unit/impact-pagination.test.ts` (CRITICAL from `direct=400`); `test/integration/impact-zero-caller-risk.test.ts` (`withTestLbugDB` seed — pattern to extend); `test/unit/eval-formatters.test.ts` (`formatImpactResult`); group `mergeRisk` tests.

## 5. Statement-Level PDG Findings

PDG unavailable (`pdg_query` on `_runImpactBFS`: “no PDG layer”). Recommend `node .gitnexus/run.cjs analyze --index-only --pdg` before any future statement-slice work. Control flow of the scorer is a straight if/else after enrichment; no hidden guards. `skipEnrichment` is the only branch that structurally zeros process/module counts besides File ids.

## 6. Proposed Changes

### 6.1 Extract `scoreImpactRisk` — `gitnexus-shared/src/impact-risk.ts` (new)

- **Responsibility:** Pure function: `{ direction, directCount, processCount, moduleCount, impactedCount, unusedAxes }` → `{ risk, riskSharedAxes, riskScale }`.
- **Behaviour:** Existing UNKNOWN/CRITICAL/HIGH/MEDIUM/LOW thresholds unchanged when `unusedAxes` is empty. `riskSharedAxes` always scores as if `processCount=0` and `moduleCount=0` (UNKNOWN rule still applies). `riskScale.comparableAcrossKinds` is false iff `unusedAxes` is non-empty. `riskScale.unusedAxes` lists `{ axis, reason }`.
- **Constraints:** Zero deps. Export from `gitnexus-shared/src/index.ts`. Do not put MCP types here.
- **File detection:** caller passes unused axes; helper does not parse UIDs.

### 6.2 Wire MCP — `_runImpactBFS` in `local-backend.ts`

- After computing `processCount`/`moduleCount`, set `unusedAxes`:
  - target `id` starts with `File:` **or** `symType === 'File'` → processes + modules, reason `file-nodes-have-no-process-or-community-membership`;
  - `skipEnrichment` → same axes, reason `enrichment-skipped` (ambiguous probes).
- Replace inline ladder with `scoreImpactRisk`.
- Spread `riskScale` and `riskSharedAxes` on the result next to `risk`. Do **not** set `riskNote` for File.
- Ambiguous candidate summaries: forward the new fields (probes already skip enrichment).
- `target.type` for File: if still `""`, prefer `'File'` when `id` starts with `File:` (display-only; helps CLI).

### 6.3 Web duplicate — `gitnexus-web/src/core/llm/tools.ts`

- Import `scoreImpactRisk` from `gitnexus-shared`. Print `RISK:` from `risk`; if `!comparableAcrossKinds`, one extra line: not comparable to Function risk; shared-axes label is `riskSharedAxes`.

### 6.4 Agent/MCP contract copy

- `gitnexus/src/mcp/tools.ts` impact description: document `riskScale` / `riskSharedAxes`; keep `riskNote` UNKNOWN-only; say File `risk` is not comparable to symbol `risk`.
- `gitnexus/src/cli/ai-context.ts`: HIGH/CRITICAL warning still applies; add: do not rank a File `MEDIUM` below a contained Function `HIGH` without `riskSharedAxes`.
- `formatImpactResult`: on resolved callgraph results with `risk`, print `Risk: {risk}` and, when incomparable, `Shared-axes risk: {riskSharedAxes} (File/process axes unused)`.

### 6.5 Explicitly not changing

- DEFINES-bridge, community/process indexers, `mergeRisk` formula, PDG `UNKNOWN`, `detectChanges` `risk_level`, Function thresholds.

## 7. Implementation Sequence

1. Add `gitnexus-shared` helper + unit table (issue-shaped inputs + UNKNOWN + skipEnrichment). Shared package tests if present; otherwise `gitnexus/test/unit/impact-risk.test.ts` importing the helper.
2. Switch `_runImpactBFS` + candidate probe payload. Tree still coherent: old `risk` values identical for Function fixtures.
3. Integration seed in `impact-zero-caller-risk.test.ts` **or** new `impact-file-risk-scale.test.ts`: File with ≥5 File IMPORTS (MEDIUM on direct) vs Function with 3 process-member callers (HIGH); assert File `riskScale.comparableAcrossKinds === false`, Function true, File `riskSharedAxes === risk`, Function `riskSharedAxes` is LOW/MEDIUM while `risk` is HIGH.
4. CLI formatter + `eval-formatters.test.ts`.
5. `tools.ts` + `ai-context.ts` wording.
6. Web import + a unit assertion on the printed RISK block if a test already covers that tool.
7. `npx tsc --noEmit` in `gitnexus/` and `gitnexus-web/`; `cd gitnexus && npm run test:unit -- test/unit/impact-risk.test.ts test/unit/eval-formatters.test.ts`; integration file from step 3.

## 8. Test Strategy

| File | Scenarios |
|---|---|
| `gitnexus/test/unit/impact-risk.test.ts` (new) | Issue table: File(25,13,0,0)→MEDIUM; Function(15,2,4,2)→HIGH; shared-axes File MEDIUM vs Function LOW; empty upstream UNKNOWN; downstream empty LOW; skipEnrichment unused axes; CRITICAL via direct≥30 still works with unused process axes |
| `gitnexus/test/integration/impact-file-risk-scale.test.ts` (new) | `withTestLbugDB` seed: `File:src/crypto.ts` ← 13 File IMPORTS, no File STEP_IN_PROCESS; `getEncryptionKey` with 2 CALLS from functions that have STEP_IN_PROCESS to 4 distinct Process nodes — reproduce inversion; assert new fields |
| `gitnexus/test/integration/impact-zero-caller-risk.test.ts` | Unchanged UNKNOWN/`riskNote`; candidates may grow `riskScale` — assert still present only when UNKNOWN for `riskNote` |
| `gitnexus/test/unit/impact-pagination.test.ts` | Hub CRITICAL unchanged |
| `gitnexus/test/unit/eval-formatters.test.ts` | Resolved result prints Risk + shared-axes line for File-shaped `riskScale` |
| Web | Only if an existing Graph RAG impact test snapshots `RISK:` |

Commands (exist in `gitnexus/package.json`): `npm run test:unit`, `npm test` (full vitest), `npx tsc --noEmit`. Web: `npm test`, `npx tsc -b --noEmit`. Integration needs `pretest:integration` / `npm run test:integration` (runs `scripts/build.js`).

## 9. Risk and Impact Analysis

Direct dependents of `_runImpactBFS` `[graph]`: `_impactImpl`, `impactByUid`. `_impactImpl` is the only d=1 of `impact` besides the method’s own class. Any JSON consumer of `impact` (MCP, CLI `output(result)`, group local leg) sees additive fields — compatible if they ignore unknowns.

- **HIGH workflow:** Function HIGH/CRITICAL unchanged. File still cannot reach HIGH via processes; a File with `direct≥15` or `total≥100` still can. Agents that compare File MEDIUM vs Function HIGH must start using `riskSharedAxes` or `riskScale`.
- **Ambiguous `maxRisk`:** probes skip enrichment, so File vs Function candidates are already 2-axis there — inversion is weaker on that path.
- **Group `mergeRisk`:** still compares incomparable File local `risk` to crossing count. Do not retune this PR; if a group File target is common, follow-up.
- **Web:** browser bundle picks up `gitnexus-shared` export — confirm `gitnexus-shared` build/exports include the new file.
- **Performance:** none (pure arithmetic after existing enrichment).
- **Ladybug empty labels:** File detection must not rely on `symType` alone.

## 10. Files Expected to Change

| File | Symbols | Reason |
|---|---|---|
| `gitnexus-shared/src/impact-risk.ts` | `scoreImpactRisk` | New shared scorer |
| `gitnexus-shared/src/index.ts` | exports | Public helper |
| `gitnexus/src/mcp/local/local-backend.ts` | `_runImpactBFS`, ambiguous candidate map | Wire scorer + File unused axes |
| `gitnexus/src/mcp/tools.ts` | `impact` description | Contract |
| `gitnexus/src/cli/ai-context.ts` | generated Always Do | Agent warning |
| `gitnexus/src/cli/eval-server.ts` | `formatImpactResult` | Print scale |
| `gitnexus-web/src/core/llm/tools.ts` | web `impact` | Same formula |
| `gitnexus/test/unit/impact-risk.test.ts` | — | Table tests |
| `gitnexus/test/integration/impact-file-risk-scale.test.ts` | — | Seeded inversion |
| `gitnexus/test/unit/eval-formatters.test.ts` | `formatImpactResult` | Formatter |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Fix #3075: File impact.risk is a 2-axis score silently labelled on a 4-axis scale. Extract scoreImpactRisk; mark File/skipEnrichment axes unused; add riskScale + riskSharedAxes; do not DEFINES-bridge or retune Function thresholds."
  acceptance_criteria:
    - "File vs Function comparison is either labelled incomparable (riskScale) or done via riskSharedAxes"
    - "Function/Method risk for identical four-axis inputs unchanged"
    - "riskNote still UNKNOWN-only"
    - "Integration seed reproduces crypto.ts-style inversion and asserts the new fields"
  primary_symbols:
    - symbol: "_runImpactBFS"
      file: "gitnexus/src/mcp/local/local-backend.ts"
      lines: "6991-7888"
      role: "BFS + enrichment + inline risk ladder (replace ladder only)"
    - symbol: "scoreImpactRisk"
      file: "gitnexus-shared/src/impact-risk.ts"
      lines: "new"
      role: "Pure scorer + shared-axes + riskScale"
    - symbol: "formatImpactResult"
      file: "gitnexus/src/cli/eval-server.ts"
      lines: "305-641"
      role: "Human/LLM text surface for impact JSON"
  related_symbols:
    - symbol: "_impactImpl"
      relationship: "CALLS"
      relevance: "Resolves target, PDG vs callgraph, ambiguous skipEnrichment probes"
    - symbol: "impactByUid"
      relationship: "CALLS"
      relevance: "Group fan-out; keep skipPerSymbolEnrichment; still run aggregation"
    - symbol: "mergeRisk"
      relationship: "consumes risk string"
      relevance: "Do not change this PR"
    - symbol: "isCommunitySymbol"
      relationship: "index gate"
      relevance: "Why File modules_affected is always 0"
    - symbol: "composeUnifiedPdgImpactResult"
      relationship: "separate path"
      relevance: "PDG risk stays UNKNOWN"
  execution_path:
    - "impact / callTool → _impactImpl (resolve symbol, File id prefix File:)"
    - "_runImpactBFS: IMPORTS-heavy walk for File; CALLS walk for Function"
    - "Enrich STEP_IN_PROCESS / MEMBER_OF on impacted ids (empty for File ids)"
    - "scoreImpactRisk with unusedAxes for File or skipEnrichment"
    - "JSON to MCP/CLI; formatImpactResult for eval text; web LLM tools parallel path"
  pdg_constraints:
    - description: "No PDG layer on the planning index; scorer is post-enrichment arithmetic"
      affected_statements: []
      implementation_consequence: "Do not wait on PDG; do not change pdg impact risk"
  architectural_patterns:
    - pattern: "Additive optional JSON fields on impact (riskNote, epistemic, partial)"
      example_location: "gitnexus/src/mcp/local/local-backend.ts _runImpactBFS base object ~7754"
      usage_guidance: "Add riskScale/riskSharedAxes the same way; never overload riskNote"
    - pattern: "withTestLbugDB CREATE seed for impact contract"
      example_location: "gitnexus/test/integration/impact-zero-caller-risk.test.ts"
      usage_guidance: "Seed File IMPORTS + Function CALLS + Process membership separately"
  files_to_modify:
    - file: "gitnexus-shared/src/impact-risk.ts"
      symbols: ["scoreImpactRisk"]
      intended_change: "new pure scorer"
    - file: "gitnexus-shared/src/index.ts"
      symbols: []
      intended_change: "re-export"
    - file: "gitnexus/src/mcp/local/local-backend.ts"
      symbols: ["_runImpactBFS"]
      intended_change: "unusedAxes + helper; File type display"
    - file: "gitnexus/src/mcp/tools.ts"
      symbols: []
      intended_change: "document fields"
    - file: "gitnexus/src/cli/ai-context.ts"
      symbols: []
      intended_change: "agent comparability note"
    - file: "gitnexus/src/cli/eval-server.ts"
      symbols: ["formatImpactResult"]
      intended_change: "print risk + shared-axes when incomparable"
    - file: "gitnexus-web/src/core/llm/tools.ts"
      symbols: []
      intended_change: "import helper; extra prose line"
  tests:
    - file: "gitnexus/test/unit/impact-risk.test.ts"
      scenarios:
        - "File(25,13,0,0)+unused process/module → risk MEDIUM, comparableAcrossKinds false, riskSharedAxes MEDIUM"
        - "Function(15,2,4,2) → HIGH, riskSharedAxes LOW (direct 2, total 15)"
        - "upstream impactedCount 0 → UNKNOWN both fields"
        - "direct 400 → CRITICAL even with unused process axes"
    - file: "gitnexus/test/integration/impact-file-risk-scale.test.ts"
      scenarios:
        - "Seed File crypto.ts with 13 File importers vs getEncryptionKey with process-rich callers → inversion on risk, File incomparable, Function comparable"
    - file: "gitnexus/test/unit/eval-formatters.test.ts"
      scenarios:
        - "formatImpactResult includes Shared-axes risk when riskScale.comparableAcrossKinds is false"
  verification_commands:
    - "cd gitnexus && npx tsc --noEmit"
    - "cd gitnexus && npm run test:unit -- test/unit/impact-risk.test.ts test/unit/eval-formatters.test.ts test/unit/impact-pagination.test.ts"
    - "cd gitnexus && npm run test:integration -- test/integration/impact-file-risk-scale.test.ts test/integration/impact-zero-caller-risk.test.ts"
    - "cd gitnexus-web && npx tsc -b --noEmit"
  risks:
    - "Consumers that only read risk still see the inversion unless they adopt riskScale/riskSharedAxes — that is the chosen (explicit-scale) fix"
    - "File type often empty; must key unusedAxes off File: id prefix"
    - "gitnexus-shared export must reach the web bundle"
  assumptions:
    - "WHAT: File nodes never gain STEP_IN_PROCESS/MEMBER_OF without an indexer change. HOW: keep isCommunitySymbol and process traces as-is; tests seed File with zero such edges"
    - "WHAT: Additive JSON fields are backward compatible. HOW: existing tests that exact-match the full impact object may need to allow extra keys — grep expect(res).toEqual on impact results before landing"
    - "WHAT: HEAD 6bff33d is the pin; scorer line numbers ~7720. HOW: re-read the ladder if that hunk moved"
  open_questions:
    - "Whether GroupImpactResult should copy riskScale from local File targets (deferred unless tests already snapshot the full group object)"
  avoid:
    - "Do not DEFINES-bridge File→symbol processes/modules"
    - "Do not lower Function process/module HIGH/CRITICAL thresholds"
    - "Do not reuse riskNote for File incomparability"
    - "Do not change PDG impact risk or detectChanges risk_level"
    - "Do not treat labels(n)[0] or empty target.type as proof the node is not a File"
    - "Do not repeat full repository discovery"
```

## 12. Assumptions and Open Questions

**Assumptions**

- Indexer will not start attaching File→Process/Community in this change (`isCommunitySymbol` stays). `[verified]` source; `[assumed]` future indexers.
- Ignoring unknown JSON keys is safe for MCP clients; any `toEqual` goldens in-repo must be updated. `[assumed]` — grep during implement.
- Stale-index inversion (`lbug-config.ts` vs `openLbugConnection`) is illustrative; the integration seed is the regression lock. `[graph]` vs `[verified]` seed.

**Open questions**

- Group `mergeRisk` + File local risk: copy `riskScale` onto `GroupImpactResult`? Default **no** unless a test breaks.
- Class/Interface STEP_IN_PROCESS sparsity: out of scope (#3075 is File).
- Printing `risk` on CLI formatted output is new (JSON already has it). Keep the extra lines short.

**Deferred**

- Recalibrated File-only HIGH thresholds.
- Indexing File community membership.
- DEFINES-bridge after a threshold RFC.
- Related #2975 (docs vs scorer wording) except as touched by `tools.ts`.

## 13. Definition of Done

- [ ] `scoreImpactRisk` is the only callgraph ladder in MCP and web.
- [ ] File (and skipEnrichment) results include `riskScale.comparableAcrossKinds === false` and `riskSharedAxes`.
- [ ] Function four-axis HIGH/CRITICAL cases in unit tests still pass with the same labels.
- [ ] Integration seed proves wider File blast + lower `risk` than a contained Function, and `riskSharedAxes` orders them without pretending processes existed on the File.
- [ ] `riskNote` still absent unless `risk === 'UNKNOWN'`.
- [ ] `tools.ts` + `ai-context.ts` state that File `risk` is not comparable to symbol `risk`.
- [ ] `cd gitnexus && npx tsc --noEmit` and the named unit/integration commands pass; web typecheck passes.
