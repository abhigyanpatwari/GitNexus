# GitNexus Engineering Plan

> Task: Fix #2432 — `analyze` aborts with `Napi::Error` SIGABRT on triton-lang/triton: pathological C++ capture extraction triggers worker timeouts, then worker termination lands mid-native-call.
> Evidence verified at commit 737a8cdb; GitNexus index refreshed this session (`node .gitnexus/run.cjs analyze --index-only --pdg`, 230,253 nodes / 487,362 edges). Deepened same session: assumption A1 empirically refuted (see §5a/§12); §6-C redesigned accordingly. (Note: the MCP context resource still displays a stale banner after refresh — tools serve the refreshed data; PDG queries succeed. Cosmetic cache issue, recorded in §12.)

## 1. Objective

`gitnexus analyze` on triton (repro: `GITNEXUS_MAX_FILE_SIZE=5120 … analyze --worker-timeout 60`) must complete without SIGABRT. Two stacked defects, both fixed:

1. **Perf (trigger):** C++ scope-capture extraction is O(calls × args × treeSize) per file — `lib/Dialect/TritonInstrument/IR/FunctionBuilder.cpp` (194 KB, parses in 46 ms) burns **151 s** in the worker; `hip_prof_str.h` (`.h` → cpp provider) burns 116 s. Measured via `--cpu-prof` on the real dist worker `[verified]`.
2. **Crash (abort):** terminating a worker thread that is inside an N-API call — whether via pool shutdown, breaker trip, **or plain process exit** — makes the pending `Napi::Error` escape as an uncaught C++ exception → `std::terminate` → SIGABRT kills the whole CLI (workers are `worker_threads`, shared process). Reproduced 2/2 on origin/main, exit 134 `[verified]`; process-exit variant reproduced directly `[verified]` (§5a).

Acceptance criteria: triton repro completes (exit 0); `FunctionBuilder.cpp` extraction drops from ~151 s to sub-second; no worker-pool or cpp-resolver test regressions.

## 2. Current Behaviour

Per-file worker flow (`parse-worker.ts` `processFileGroup`): parse → `query.matches` → `extractParsedFile` → provider `emitScopeCaptures` (`emitCppScopeCaptures` for `.cpp`/`.h` — `c-cpp.ts:435` maps both) `[verified]`.

For every call-expression capture, `inferCppCallArgTypeClasses` (`cpp/captures.ts:929`, driven from `:325`) classifies each identifier argument via:

- `lookupDeclaredTypeClassForIdentifier` (`:1133`) — linear scan of the enclosing scope's children per identifier `[verified]`;
- `lookupFunctionParameterTypeClass` (`:1182`) + `findEnclosingFunctionParameter` (`:1200`) — walk up + param scan per identifier `[verified]`;
- **`isKnownEnumName` (`:1248`) — walks to the AST root and full-tree DFS for `enum_specifier`, per identifier argument** `[verified]`. CPU profile: 87.7 s of 149.9 s inside it; self-time dominated by tree-sitter N-API accessors (`child`/`childCount`/`type`/`unmarshalNode`) `[verified]`.

Crash path: idle-timeout/give-up paths all pass `'retire'` → `retireWorkerAfterTimeout` (`worker-pool.ts:1188`) defers terminate until the worker posts `sub-batch-done`/`result`/`error` (the #1848 fix) `[verified]`. But:

- `parse-impl.ts:1123-1125` `finally { await workerPool?.terminate() }` → pool `terminate` (`worker-pool.ts:2025` awaits) → `terminateTrackedWorkers` (`:971-980`) — terminates every live AND retired worker unconditionally `[verified]`.
- `tripBreaker` (`:1303`) fire-and-forgets the same (`void terminateTrackedWorkers`, `:1312`) on breaker trip — including live workers that may be mid-native-parse `[verified]`.
- These are the ONLY two callers `[verified]` (grep; matches the graph's d=1).
- **Existing test `worker-pool-timeout-retire.test.ts:97` asserts the crash-causing contract**: a never-safe retired mock worker gets `terminateCalls === 1` after `pool.terminate()` (`:114-118`); `:155` asserts the same for breaker trips `[verified]`. Both flip intentionally under this fix.
- Run evidence: process died 12 s after the last retire log with no error-path output; the 2-file mini corpus (retired workers finish before shutdown) exits 0 `[verified]`.

## 3. Relevant Architecture

- Shared ingestion pipeline is language-agnostic (AGENTS.md): the fix stays inside the cpp language module (`languages/cpp/captures.ts`) and the generic worker pool; no `LanguageProvider` interface change.
- Precedent for exactly this bug class: Go scope-capture re-walk fix (#1848/#1915), Python (#1918), C++ ADL once-built index (#1990) — `languages/c/captures.ts:39-42` documents the pattern `[verified]`.
- The C provider has its own thin `emitCScopeCaptures` (164 lines, no arg-type-class inference) — not affected `[verified]`.
- Workers cluster (76 symbols, 65% cohesion) is self-contained; depth-3 upstream impact of the shutdown change stays entirely inside it `[graph]`.
- `parse-worker.ts:1362-1369` documents the group-catch trap: a throw escaping per-file processing makes the language-group catch drop every remaining file — any new bail path must be caught per-file, never thrown outward `[verified]`.

## 4. GitNexus Findings

- `impact {target: emitCppScopeCaptures, direction: upstream, maxDepth: 2}` → 0 dependents, LOW `[graph]`. **Graph/source discrepancy:** the real consumer is the provider-hook indirection (`c-cpp.ts:495 emitScopeCaptures: emitCppScopeCaptures` → `scope-extractor-bridge.ts:41 extractParsedFile`) which the call graph doesn't model. Source wins; internal signature changes are still safe (all hot functions are file-private).
- `impact {target: terminateTrackedWorkers, direction: upstream}` at depth 2 → d=1: `tripBreaker`, `terminate`; deepened at `maxDepth: 3, summaryOnly` → 13 symbols total (d1:2, d2:7, d3:4), risk LOW, all in the Workers module. Key output: `"direct": 2` — both d=1 dependents modified deliberately in §6-C and source-confirmed `[verified]`.
- Related tests located and read: `test/unit/worker-pool-timeout-retire.test.ts` (mock `TimeoutThenHealthyWorker` harness with `terminateCalls`/`unrefCalls` counters and a `delayed-safe-return` mode — supports the new scenarios without factory changes `[verified]`), `test/integration/resolvers/cpp.test.ts` + `c.test.ts` (golden equivalence gate), `test/integration/cpp-adl-benchmark.test.ts` (GITNEXUS_BENCH-gated; template for the new benchmark) `[verified]`.

## 5. Statement-Level PDG Findings

- `pdg_query {mode: controls, target: isKnownEnumName}` (28 edges): the DFS body (`:1253-1262`) is control-dependent only on the trivial `typeName === ''` guard (`:1249`, guard:true) and its own loop conditions — **no memoization or early-exit gate exists**; the full-tree walk runs unconditionally on every call `[graph]`, consistent with source `[verified]`.
- `pdg_query {mode: controls, target: terminateTrackedWorkers}` → 0 edges: straight-line, unconditional termination of both worker lists `[graph]`. The crash fix is precisely "add the missing control dependency" (safe-point gate).
- Performance-mode scan: the hot loop's N-API fan-out (`cur.child(i)` per node per DFS per identifier) is the marshalling hotspot (`unmarshalNode` 15.5 s incl.) `[verified via profile]`.
- Ordering constraint: `lookupDeclaredTypeClassForIdentifier` returns the **first** matching `declaration` in scope-child order, with no position filtering relative to the identifier — the replacement index must preserve first-declaration-wins and must NOT introduce use-before-decl filtering `[verified]`.

## 5a. Deepen finding — A1 refuted empirically

Driver test (`exit-with-busy-worker.mjs`, kept in scratchpad): main thread `process.exit(0)` five seconds into the real dist worker's extraction of `FunctionBuilder.cpp`, worker `unref()`d → **process aborts: `terminate called after throwing an instance of 'Napi::Error'`, exit 134** `[verified]`. Node tears down worker environments on process exit through the same terminate path. Consequence: "skip terminating unsafe workers and let the process exit" merely relocates the abort. The shutdown design must instead guarantee workers reach a JS safe point in bounded time before the process exits — this promotes the previously-deferred cooperative extraction deadline into scope (§6-D).

## 6. Proposed Changes

**A. Perf root-cause — per-file lookup index in `gitnexus/src/core/ingestion/languages/cpp/captures.ts`.**
Introduce a lazily-built, per-invocation index object created at the top of `emitCppScopeCaptures` and threaded through `inferCppCallArgTypes` / `inferCppCallArgTypeClasses` → the lookup helpers (all file-private; no exported API change):

- `enumNames: Set<string>` — built by ONE root DFS on first `isKnownEnumName` query (lazy: files with no identifier args pay nothing). `isKnownEnumName` becomes a Set lookup. Behavior-identical: current code matches any `enum_specifier` name anywhere in the translation unit.
- `scopeDecls: Map<number /* scope.id */, Map<string, {typeNode, nameChild, stmt}>>` — per-scope declaration map built on first lookup in that scope by one pass over `scope` children, first-declaration-wins (skip existing keys). Replaces the per-identifier linear scans in `lookupDeclaredTypeClassForIdentifier` / `lookupDeclaredTypeForIdentifier` (`:1090-1131`).
- `fnParams: Map<number /* function node.id */, Map<string, param>>` — same treatment for `findEnclosingFunctionParameter`.

Complexity: O(treeSize + identifiers) per file. Expected: 151 s → sub-second (parse itself is 46 ms). `classifyCppParameterType` / `normalizeCppTypeText` stay per-hit (cheap; memoizing them changes nothing observable).

**B. New benchmark test — `gitnexus/test/integration/cpp-captures-typeclass-benchmark.test.ts`** modeled exactly on `cpp-adl-benchmark.test.ts` (`describe.skipIf(!GITNEXUS_BENCH)`): synthetic C++ file scaling call-sites × enums, asserts sub-quadratic scaling of the capture-emit phase.

**C. Crash fix — safe-point-gated shutdown with bounded drain, `gitnexus/src/core/ingestion/workers/worker-pool.ts`.** (Redesigned after §5a.)

- **C1 (gate):** extend `RetiredWorkerRecord` with `safeToTerminate`, set exactly where `terminateWhenBackInJs` fires today (`onRetiredMessage` for `sub-batch-done`/`result`/`error`, and `messageerror`). `terminateTrackedWorkers` terminates retired records only when safe; unsafe records keep their armed at-safe-point terminate listener.
- **C2 (bounded drain):** pool `terminate()` awaits unsafe retired records' safe-point terminate up to a cap (`GITNEXUS_WORKER_SHUTDOWN_DRAIN_MS`, default ≈ 30 s — comfortably above D's per-file deadline so the drain converges for the known class). On cap expiry: log a clear diagnostic naming the wedged worker + in-flight file and proceed (residual abort risk at process exit remains for truly-wedged native code, now rare and diagnosed). The breaker path (`tripBreaker:1312`) stays fire-and-forget — it must never block the dispatch rejection; its unsafe records drain when the pipeline's `finally` runs pool `terminate()`.
- **C3 (breaker-path live workers):** on breaker trip, live workers in `busySlots` (`:1154` `[verified]`) are routed through `retireWorkerAfterTimeout` instead of direct `terminate()` — same mid-native abort risk, same cure. Idle live workers terminate directly (parked in the JS event loop; safe). The normal post-parse `terminate()` still direct-terminates live workers — all idle by construction (jobs drained).

**D. Cooperative extraction deadline (promoted from deferred Q2 by §5a) — `cpp/captures.ts`.**
Bound per-file wall time inside `emitCppScopeCaptures`'s match loop: check `Date.now()` against a soft budget (`GITNEXUS_CPP_CAPTURE_BUDGET_MS`, default ≈ 20 s; post-A one iteration is microseconds, so check granularity of every N=64 matches is ample). On breach: **return** partial captures accumulated so far + `reportWarning` naming the file — never throw (the group-catch trap, §3). This guarantees cpp extraction returns to JS in bounded time, which is what makes C2's drain converge and process exit safe. Generic all-language budget remains a deferred follow-up (§12).

## 7. Implementation Sequence

1. **cpp captures index (A).** Build the index type + lazy constructors; convert `isKnownEnumName`, `lookupDeclaredType{Class}ForIdentifier`, `lookupFunctionParameterType{Class}`, `findEnclosingFunctionParameter`; thread from `emitCppScopeCaptures`. Gate: `npx vitest run test/integration/resolvers/cpp.test.ts test/integration/resolvers/c.test.ts` passes unchanged.
2. **Benchmark (B).** Add the GITNEXUS_BENCH-gated benchmark; record before/after in the PR body (before: 151 s / 116 s from this plan).
3. **Extraction deadline (D).** Budget check + partial-return + warning; unit test with a tiny budget forcing the bail (assert warning emitted, remaining files in group still processed).
4. **Worker-pool shutdown safety (C1–C3).** Gate + drain + breaker routing. Update `worker-pool-timeout-retire.test.ts:97` and `:155` (both currently assert the buggy contract) and add: (i) `pool.terminate()` with a never-safe retired worker + tiny drain cap → resolves after cap, `terminateCalls === 0`, diagnostic logged; (ii) retired worker signals safe during drain → terminated, `terminate()` resolves promptly; (iii) breaker trip with busy live worker → retired, not direct-terminated.
5. **End-to-end validation.** Rebuild (`npm run build`); re-run the triton repro → exits 0, `FunctionBuilder.cpp` indexed (not quarantined); mini 2-file corpus completes in seconds; re-run the §5a exit-with-busy-worker driver against the built worker with D's budget lowered → clean exit.

Steps 1–2 alone de-trigger #2432; 3–4 close the abort class. Each step leaves the tree green.

## 8. Test Strategy

- **Update:** `worker-pool-timeout-retire.test.ts:97` + `:155` — expectations flip to the new contract (unsafe ⇒ not terminated at shutdown; terminated at safe point). The mock harness supports this as-is `[verified]`.
- **Add:** benchmark (§6-B); three shutdown cases (§7-4); deadline-bail unit test (§7-3).
- **Regression:** resolver goldens `cpp.test.ts`/`c.test.ts` unchanged (equivalence gate); full `npm run test:unit`; `npm run test:integration` (carries its build via `pretest:integration`).
- **Edge cases:** file with enums but no calls (lazy index never built); duplicate declaration in one scope (first-wins preserved); use-before-decl in scope (still resolved — no position filter); anonymous enums (name-less `enum_specifier` excluded, same as today); breaker trip with mixed busy/idle live workers; drain cap = 0 (immediate proceed); deadline breach mid-file (partial captures kept, group continues).
- **Failure paths:** shutdown never hangs (drain is capped); deadline bail is a warning, never a group-dropping throw (§3 trap).
- **Verification commands (verified to exist):** `npm run build`, `npm run test:unit`, `npm run test:integration`, `GITNEXUS_BENCH=1 npx vitest run test/integration/cpp-captures-typeclass-benchmark.test.ts` — all from `gitnexus/`.

## 9. Risk and Impact Analysis

- **d=1 dependents of `terminateTrackedWorkers`** — `tripBreaker` (`:1312`), `terminate` (`:2025`): both modified deliberately; no other callers `[verified]`. Depth-3 radius stays pool-internal (13 symbols, Workers module) `[graph]`.
- **Behavioral-equivalence risk (A):** first-declaration-wins + position-free matching must be preserved (§5). Mitigation: resolver goldens + explicit edge cases.
- **Node identity:** key maps by `SyntaxNode.id` (stable within a tree); wrapper object identity is NOT usable (wrappers are recreated per access — a `WeakMap` would silently fail).
- **Drain-cap tuning (C2 vs D):** drain cap must exceed D's budget or the drain can expire while a worker is legitimately finishing its bailed file — defaults 30 s vs 20 s encode that; both env-tunable, relation asserted in a unit test comment.
- **Residual abort window:** a worker wedged in native code longer than the drain cap still aborts at process exit — now requires non-cpp pathological input (D bounds cpp) and is logged with the culprit file before it can happen. Accepted; full elimination needs child-process workers (out of scope, §12).
- **`emitCppScopeCaptures` consumers:** provider hook only; signature unchanged (D's budget read from env inside the module) — zero external surface.
- **Deadline false positives (D):** 20 s default is ~3 orders of magnitude above post-A extraction cost of the worst observed file; breach ⇒ degraded coverage for that file (warning), never a failed run.
- **Coverage change:** triton's `FunctionBuilder.cpp` was previously quarantined; post-fix it indexes — strictly an improvement.
- **Concurrency:** the new index and deadline state are function-scoped per invocation (per file, per worker thread) — no shared state, no `clearCaches()` interaction.

## 10. Files Expected to Change

| File | Symbols | Reason |
|---|---|---|
| `gitnexus/src/core/ingestion/languages/cpp/captures.ts` | `emitCppScopeCaptures`, `inferCppCallArgTypes`, `inferCppCallArgTypeClasses`, `lookupDeclaredType{Class}ForIdentifier`, `lookupFunctionParameterType{Class}`, `findEnclosingFunctionParameter`, `isKnownEnumName` (+ index type, + deadline) | A: O(n²)→O(n) index; D: bounded extraction |
| `gitnexus/src/core/ingestion/workers/worker-pool.ts` | `RetiredWorkerRecord`, `retireWorkerAfterTimeout`, `terminateTrackedWorkers`, `terminate`, `tripBreaker` | C1–C3: safe-point gate + bounded drain + breaker routing |
| `gitnexus/test/unit/worker-pool-timeout-retire.test.ts` | `:97`, `:155` + 3 new cases | New shutdown contract |
| `gitnexus/test/integration/cpp-captures-typeclass-benchmark.test.ts` | new | Scaling regression gate |
| `gitnexus/test/unit/` (new file) | cpp capture deadline-bail | D coverage |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: >
    Fix #2432 (SIGABRT on triton analyze): (A) replace per-identifier full-tree/
    per-scope AST re-walks in cpp capture extraction with a lazily-built per-file
    index; (C) gate worker terminate on a JS-safe-point flag with a bounded
    shutdown drain and breaker-path retire routing; (D) bound cpp capture
    extraction wall-time per file (partial-return + warning, never throw).
  acceptance_criteria:
    - "Triton repro (avoid[4] artifacts) exits 0, no Napi::Error abort"
    - "FunctionBuilder.cpp capture extraction sub-second (was 151s)"
    - "resolvers/cpp.test.ts + worker-pool suites green"
    - "exit-with-busy-worker driver (avoid[4]) exits cleanly against built worker"
  primary_symbols:
    - { symbol: isKnownEnumName, file: gitnexus/src/core/ingestion/languages/cpp/captures.ts, lines: "1248-1265", role: "full-tree DFS per identifier — replace with per-file enum-name Set" }
    - { symbol: lookupDeclaredTypeClassForIdentifier, file: gitnexus/src/core/ingestion/languages/cpp/captures.ts, lines: "1133-1172", role: "per-identifier scope scan — replace with per-scope decl map; preserve first-wins, position-free" }
    - { symbol: lookupFunctionParameterTypeClass, file: gitnexus/src/core/ingestion/languages/cpp/captures.ts, lines: "1182-1224", role: "per-identifier param walk — memoize per function node.id" }
    - { symbol: inferCppCallArgTypeClasses, file: gitnexus/src/core/ingestion/languages/cpp/captures.ts, lines: "929-1010", role: "per-call driver — threads the index down; call sites at 311/325" }
    - { symbol: emitCppScopeCaptures, file: gitnexus/src/core/ingestion/languages/cpp/captures.ts, lines: "15-", role: "per-file entry — owns index lifetime + D deadline checks in its match loop" }
    - { symbol: terminateTrackedWorkers, file: gitnexus/src/core/ingestion/workers/worker-pool.ts, lines: "971-980", role: "add safeToTerminate gate (C1); callers: tripBreaker :1312 (void), terminate :2025 (await) — the only two" }
    - { symbol: retireWorkerAfterTimeout, file: gitnexus/src/core/ingestion/workers/worker-pool.ts, lines: "1188-1245", role: "set safeToTerminate where terminateWhenBackInJs fires; unref already at :1240" }
    - { symbol: tripBreaker, file: gitnexus/src/core/ingestion/workers/worker-pool.ts, lines: "1303-1315", role: "C3: retire busySlots members instead of direct terminate; stays fire-and-forget" }
    - { symbol: "pool terminate", file: gitnexus/src/core/ingestion/workers/worker-pool.ts, lines: "~2010-2027", role: "C2: bounded drain of unsafe records before/instead of force terminate" }
  related_symbols:
    - { symbol: extractParsedFile, relationship: "CALLS emitScopeCaptures via provider hook", relevance: "graph-invisible consumer; signature unchanged" }
    - { symbol: "parse-impl.ts:1124 finally", relationship: CALLS, relevance: "the shutdown trigger; C2 drain runs under this await" }
    - { symbol: "c-cpp.ts:435 extensions", relationship: config, relevance: ".h routes to cpp provider — hip_prof_str.h covered by A+D" }
    - { symbol: busySlots, relationship: "state read by C3", relevance: "worker-pool.ts:1154; add/delete sites verified at :1631/:1646/:1676/:1687/:1720/:1814" }
  execution_path:
    - "worker: parse file → query.matches → extractParsedFile → emitCppScopeCaptures"
    - "per call capture: inferCppCallArgTypeClasses → per identifier: scope scan + full-tree enum DFS (hot)"
    - "worker exceeds idle timeout → retire (no terminate) → parse ends → parse-impl finally → pool.terminate → terminateTrackedWorkers → terminate mid-N-API → SIGABRT"
    - "ALSO: process exit with native-busy unref'd worker → same abort (verified) — why C2+D exist"
  pdg_constraints:
    - description: "isKnownEnumName full-tree DFS gated only by typeName!=='' (guard, line 1249); no memo gate exists"
      affected_statements: ["gitnexus/src/core/ingestion/languages/cpp/captures.ts:1253-1262"]
      implementation_consequence: "Set lookup is behavior-identical; keep the empty/'unknown' early-out"
    - description: "terminateTrackedWorkers is straight-line (0 CDG edges) — terminates unconditionally"
      affected_statements: ["gitnexus/src/core/ingestion/workers/worker-pool.ts:975-977"]
      implementation_consequence: "add safeToTerminate control dependency; drain bounded, never unbounded await"
    - description: "lookupDeclaredTypeClassForIdentifier: first-declaration-wins, position-free scope match"
      affected_statements: ["gitnexus/src/core/ingestion/languages/cpp/captures.ts:1148-1170"]
      implementation_consequence: "build per-scope map in child order, skip existing keys, no use-before-decl filtering"
  architectural_patterns:
    - { pattern: "once-built per-file index over repeated AST walks", example_location: "gitnexus/src/core/ingestion/languages/c/captures.ts:39-42 (comment citing go #1848 / python #1918); ADL index #1990", usage_guidance: "thread an index object; key node maps by SyntaxNode.id, never object identity" }
    - { pattern: "GITNEXUS_BENCH-gated scaling benchmark", example_location: "gitnexus/test/integration/cpp-adl-benchmark.test.ts", usage_guidance: "copy harness shape incl. skipIf + table output" }
    - { pattern: "mock-Worker retire harness", example_location: "gitnexus/test/unit/worker-pool-timeout-retire.test.ts:12-64", usage_guidance: "TimeoutThenHealthyWorker: terminateCalls/unrefCalls counters + 'delayed-safe-return' mode cover all new cases; no factory change needed" }
    - { pattern: "per-file bail must not throw", example_location: "gitnexus/src/core/ingestion/workers/parse-worker.ts:1362-1369 (CFG isolation comment)", usage_guidance: "D returns partial captures + reportWarning; a throw drops the whole language group" }
  files_to_modify:
    - { file: gitnexus/src/core/ingestion/languages/cpp/captures.ts, symbols: [see primary], intended_change: "A index + D deadline" }
    - { file: gitnexus/src/core/ingestion/workers/worker-pool.ts, symbols: [see primary], intended_change: "C1 gate, C2 drain, C3 breaker routing" }
    - { file: gitnexus/test/unit/worker-pool-timeout-retire.test.ts, symbols: [], intended_change: "flip :97/:155 + 3 new cases" }
    - { file: gitnexus/test/integration/cpp-captures-typeclass-benchmark.test.ts, symbols: [], intended_change: "new benchmark" }
  tests:
    - file: gitnexus/test/unit/worker-pool-timeout-retire.test.ts
      scenarios:
        - "never-safe retired worker + tiny drain cap → pool.terminate() resolves after cap, terminateCalls === 0, diagnostic logged"
        - "retired worker signals safe during drain → terminated, terminate() resolves promptly"
        - "breaker trip with busy live worker → routed through retire, not direct terminate"
        - "UPDATED :97/:155 — unsafe workers not terminated at shutdown (was: terminated)"
    - file: gitnexus/test/integration/cpp-captures-typeclass-benchmark.test.ts
      scenarios: ["N call-sites × M enums synthetic file → capture emit scales sub-quadratically"]
    - file: "gitnexus/test/unit/ (new: cpp capture deadline test)"
      scenarios: ["GITNEXUS_CPP_CAPTURE_BUDGET_MS=1 on a many-call file → partial captures returned, warning emitted, no throw"]
    - file: gitnexus/test/integration/resolvers/cpp.test.ts
      scenarios: ["existing golden behavior unchanged (equivalence gate — run, don't modify)"]
  verification_commands:
    - "cd gitnexus && npm run build"
    - "cd gitnexus && npm run test:unit"
    - "cd gitnexus && npm run test:integration"
    - "cd gitnexus && GITNEXUS_BENCH=1 npx vitest run test/integration/cpp-captures-typeclass-benchmark.test.ts"
  risks:
    - "equivalence break in decl ordering (first-wins) → resolver goldens catch"
    - "drain cap must exceed D budget (30s > 20s) or drains expire on legitimately-bailing workers"
    - "SyntaxNode object identity is NOT stable — key by node.id"
    - "residual abort: non-cpp native wedge longer than drain cap still aborts at exit — logged, accepted (child-process workers out of scope)"
  assumptions:
    - "D's env-read (GITNEXUS_CPP_CAPTURE_BUDGET_MS) is visible in worker threads — CHECK: workers inherit process.env by default; confirm no env filtering in spawnWorker (worker-pool.ts:909-925 sets only workerData/resourceLimits — none seen)"
  open_questions:
    - "Q2 (narrowed): generic all-language extraction budget — deferred follow-up issue after cpp-only D lands"
  avoid:
    - "Do not repeat full repository discovery — symbols and line ranges verified at 737a8cdb"
    - "Do not change LanguageProvider or emitScopeCaptures signatures — provider hook consumers are graph-invisible"
    - "Do not add position/use-before-decl filtering to scope lookups — changes resolution behavior"
    - "Repro artifacts in scratchpad: repro-2432-wt (worktree), triton/, mini-2432/, repro-run{1,2}.log, profiles/CPU.*.cpuprofile, profile-worker.mjs, prof-top.mjs, exit-with-busy-worker.mjs — reuse for §7-5, do not re-derive"
    - "Do not let a D bail throw out of emitCppScopeCaptures — the language-group catch drops all remaining files (parse-worker.ts:1362-1369)"
    - "Do not edit CHANGELOG (release-time owned)"
```

## 12. Assumptions and Open Questions

- **A1 — RESOLVED (refuted):** process exit with a native-busy unref'd worker DOES abort (§5a, empirical). Design consequence absorbed into §6-C2/§6-D.
- **A2 — RESOLVED:** mock harness supports all new shutdown cases without factory changes (test file read in full).
- **A3 (new, minor):** worker threads see `process.env` for D's budget knob — spawn options set only `workerData`/`resourceLimits`, so default env inheritance applies; executor re-verifies in one line.
- **Q2 (narrowed):** generic per-language extraction budget — file as follow-up issue once cpp-only D proves the shape.
- **Deferred:** `lookupDeclaredTypeForIdentifier` (`:1090`) gets the same index for consistency (cheap, in A) though not hot (0.4 s incl.).
- **Graph/source discrepancies recorded:** (i) provider-hook edges invisible to `impact`; (ii) MCP `context` resource staleness banner not refreshed after `--index-only --pdg` while tools serve fresh data — both worth separate GitNexus issues, not this fix.

## 13. Definition of Done

1. `GITNEXUS_HOME=<fresh> GITNEXUS_LBUG_EXTENSION_INSTALL=never GITNEXUS_MAX_FILE_SIZE=5120 node gitnexus/dist/cli/index.js analyze --worker-timeout 60` on triton-lang/triton exits 0 with no `Napi::Error`/SIGABRT, and `lib/Dialect/TritonInstrument/IR/FunctionBuilder.cpp` appears in the index (not quarantined).
2. Mini 2-file corpus (FunctionBuilder.cpp + hip_prof_str.h) analyzes in seconds (was 318.9 s).
3. The §5a exit-with-busy-worker driver, run against the rebuilt worker, exits cleanly.
4. Updated + new worker-pool unit tests green (including flipped `:97`/`:155` contract); resolver goldens (`cpp.test.ts`, `c.test.ts`) green unchanged; `npm run test:unit` and `npm run test:integration` green in `gitnexus/`.
5. Benchmark demonstrates sub-quadratic capture-emit scaling behind `GITNEXUS_BENCH=1`; deadline-bail test proves partial-return-not-throw.
6. No `LanguageProvider`/public API signature changes; no CHANGELOG edits.
