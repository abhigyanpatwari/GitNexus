# GitNexus Engineering Plan

> Task: Fix all 28 findings from the six-lens review of PR #2522 (callable reference flows, #2437), one commit per finding.
> Evidence verified at commit 1b0dfa86b1f3ca547b3ac9f590c27082dc491a31; GitNexus index fresh (indexed this session at that commit, `--pdg` layer present).

## 1. Objective

Land every finding of the 2026-07-17 six-lens review of PR #2522 as an ordered
series of atomic commits on `fix/2437-provider-hook-impact`, each with its
regression test where behavior changes, ending with CI-green bench baselines.

## 2. Current Behaviour

PR #2522 adds callable-value-flow: per-language capture options feed a shared
AST synthesizer (`gitnexus/src/core/ingestion/utils/callable-flow-captures.ts`)
whose facts persist on `ParsedFile.callableFlowSites` (validated in
`gitnexus/src/storage/parsedfile-store.ts`, SCHEMA_BUMP 17) and drive a bounded
inclusion solver (`.../scope-resolution/passes/callable-value-flow.ts`) plus a
property-dispatch pass, wired in `.../scope-resolution/pipeline/run.ts`. The
review found the kernel sound but 6 HIGH / 12 MEDIUM / ~10 LOW defects in
upgrade paths, per-language captures, storage bounds, and docs/claims.

## 3. Relevant Architecture

Shared ingestion code must stay language-neutral (AGENTS.md): language
specifics enter via `ScopeResolver`/provider options only. Two persisted
artifact families exist: the parse/ParsedFile caches (keyed on `SCHEMA_BUMP`,
`gitnexus/src/storage/parse-cache.ts`) and the graph DB (incremental writeback
gated by `INCREMENTAL_SCHEMA_VERSION`, `gitnexus/src/storage/repo-manager.ts:359`;
write set = changed files only, `gitnexus/src/core/run-analyze.ts:1447`).
Bench fingerprints (`gitnexus/bench/scope-capture/baselines.json`,
`gitnexus/bench/python-scope/baseline-fingerprint.txt`) hash capture output
per language and gate CI.

## 4. GitNexus Findings

All from this session's review (tools named per claim):

- `detect_changes {scope: compare, base_ref: dc993a6d}`: 311 changed symbols,
  48 flows, risk critical. [graph]
- `impact {mapReferenceKindToEdgeType, upstream}`: CRITICAL; d=1 outside diff
  `emitReceiverBoundCalls` — source-verified unaffected (filters call/read/write). [verified]
- `impact {resolveReferenceSites|emitReferencesViaLookup|emitPropertyDispatchCalls, upstream}`:
  HIGH; all d=1 dependents inside the diff (`run.ts`/`phase.ts`). [graph]
- `impact {loadParsedFilesForPaths, upstream}`: LOW, 4 direct. [graph]
- `explain` on changed storage/kernel files: zero taint findings. [graph]
- Six lens agents source-verified every finding below at exact `path:line`;
  capture findings were confirmed by executing the extractors on failing
  shapes (empirical). [verified]

## 5. Statement-Level PDG Findings

PDG layer present; review used `pdg_query {controls}` on
`parsedfile-store.ts` (118 CDG edges) to confirm guard structure. No further
slices needed: every fix site is anchored by the review at statement level.
Constraint that matters for sequencing: solver seeding at
`callable-value-flow.ts:409-445` gates on `constrainedBindings` built at
`:185-189`; fixes to seeding must preserve the formal-shadowing suppression
(formals must not adopt same-named globals). [verified]

## 6. Proposed Changes

One commit per finding, exact responsibilities in §7. Design decisions fixed
here (synthesized direction, smallest change that meets the finding):

- **F16 dead surface**: drop `ownerQualifiedName` (field, capture parsing,
  validation, solver branch) rather than build a producer — YAGNI; re-add
  with a real producer if C++ qualified member declarators ever need it.
- **F17 dead knobs**: drop `'callable-object'` from `CallableFlowPassingMode`
  and drop `extractCallArguments`; keep `CallableFlowInvocationKind`'s
  `'callable-object'` (live).
- **F15 Java**: drop `get`/`test` from `callableProtocolMethods` (heaviest
  false-fact sources); keep `run/apply/accept/call`.
- **F3 Ruby**: bare receiver-less paren-less identifier RHS is a call in
  Ruby — only treat explicit reference forms (`method(:x)`, `&:x`, lambda,
  proc, block-pass) or provably-local-variable reads as callable sources.
- **F7 storage**: validator rejects per-site (not per-file), logs at debug
  with a counter; emit side clamps to the same shared constants and drops
  empty-string `parameterTypes` entries.
- **F28 bench**: single final refresh of both fingerprint sets after all
  capture-affecting fixes; verify scaling budgets in the same run.

## 7. Implementation Sequence

Each step = one conventional commit; tree coherent after every step.
Regression tests land inside their fix commit. Order: storage blockers →
kernel → shared util → C++ → language options → COBOL → docs/comments →
test infra → bench finale.

1. **fix(storage): bump INCREMENTAL_SCHEMA_VERSION 6→7** —
   `repo-manager.ts:359`. New edge semantics must invalidate incremental
   writeback (review HIGH; #2494 class). Check for tests pinning `6`.
2. **fix(storage): per-site callable-flow validation + emit-side clamps** —
   `parsedfile-store.ts:262-271,288-421` reject offending *site* only, add
   debug log + counter; share caps (name 4096, index 1024) with emit;
   `callable-flow-captures.ts` / `cpp/captures.ts:617-619` drop `''`
   parameter-type entries at emit. Test: extractor-realistic malformed-C++
   payload loads with the bad site dropped, file retained.
3. **fix(scope-resolution): seed declaration defs into constrained cells** —
   `callable-value-flow.ts:185-189,409-445,1029-1033`: when a constrained
   operand's binding resolves to a callable def, seed it (union semantics).
   Test: `function greet(){}; greet = unresolvable; greet()` keeps CALLS→greet.
4. **fix(scope-resolution): budget-bailout honesty** —
   `callable-value-flow.ts:654-688`: include forfeited deferred-site count in
   the warning; fix the false "ordinary graph emission remains untouched"
   comment.
5. **feat(scope-resolution): surface skipped property-dispatch keys** —
   `property-dispatch.ts:101-107` keep bounded dropped-key names;
   `run.ts:415-439,868-880` add `propertyDispatchSkippedKeys` to
   `RunScopeResolutionStats`, names in the warn payload (matches PR-body claim).
6. **refactor(scope-resolution): drop ownerQualifiedName surface** —
   `gitnexus-shared/src/scope-resolution/callable-flow-site.ts`,
   `scope-extractor.ts:1251-1252`, `parsedfile-store.ts:316`,
   `callable-value-flow.ts:1203-1205`, extractor unit test at
   `scope-extractor.test.ts:654`.
7. **refactor(scope-resolution): drop dead capture knobs** —
   `'callable-object'` passing mode (`scope-extractor.ts:1394-1403`, shared
   type), `extractCallArguments` (`callable-flow-captures.ts:67,757`).
8. **fix(ingestion): subscript destinations use the argument field** —
   `callable-flow-captures.ts:982-987`: `tbl[i] = h` must not seed `i`;
   invoke callee for `tbl[i]()` must not be `i`. Test: fp-array C sample.
9. **fix(ingestion): file-scope callable bindings visible across functions** —
   `callable-flow-captures.ts:341-368,585-586,689`: `isVisibleValueBinding`
   also consults `signatureByNameAndRegion` declarations. Test: C fp assigned
   in `init()`, called in `run()` → CALLS edge (review H1 shape).
10. **fix(ingestion): C variadic detection uses variadic_parameter** —
    `c/captures.ts:180-183`. Test: `int (*emit)(const char*, ...)` signature
    carries the variadic sentinel.
11. **fix(ingestion): C field-pointer calls emit invoke facts** —
    `callable-flow-captures.ts:666-686`: member-call path emits an invoke for
    languages without protocol methods when the member cell has stores
    (ops-vtable). Test: `o->run = handler; o->run(1)` → CALLS→handler.
12. **fix(cpp): disambiguate ->* ERROR recovery by token order** —
    `cpp/captures.ts:68-83`. Test: `(obj->*ptr)()` with short names resolves
    (the name-luck shape from review H2).
13. **fix(cpp): static member functions are not file-local** —
    `cpp/scope-resolver.ts:294-296` + `markFileLocal` producers
    (`cpp/captures.ts:277-283`): skip class-owned defs. Test: header-declared
    `static` member joins its .cpp definition.
14. **fix(cpp): parameterPassingMode examines outermost declarator only** —
    `cpp/captures.ts:55-60`. Test: `void reg(void (*cb)(int& out))` → `cb`
    is `value`, not `reference`.
15. **fix(ruby): bare identifier RHS is not a callable reference** —
    `ruby/captures.ts:40-46` (+ existing `extractCallableReference`). Test:
    `action = process; dispatch(action)` emits NO CALLS→process; `method(:x)`
    still works.
16. **fix(go): pair multi-value := positionally** — `go/captures.ts:18-25`
    add Go `extractAssignment` splitting `expression_list`s per index. Test:
    `a, b := f, g` → seeds a→f, b→g.
17. **fix(java): narrow callableProtocolMethods** — `java/captures.ts:43`
    drop `get`/`test`. Test: `map.get("x")` emits no invoke fact;
    `supplier.get()`… removed too — assert `Runnable.run`/`Function.apply`
    still resolve.
18. **fix(rust): scoped_identifier must resolve to a callable** —
    `rust/captures.ts:25`: gate seeds on the target resolving to a
    function/method def. Test: `let x = Shape::Square` emits no seed fact
    (or seed resolves to nothing and stays inert by contract — assert no edge).
19. **fix(php): remove dead optional_parameter literal** —
    `php/captures.ts:61`.
20. **fix(cobol): fixed-format procedure-pointer detection** —
    `cobol-preprocessor.ts:609-620` add `PROCEDURE-POINTER`/`FUNCTION-POINTER`
    to the USAGE alternation; `cobol/captures.ts:63-73` scan `cleaned` lines.
    Test: sequence-numbered fixed-format fixture produces seed/invoke facts.
21. **fix(cobol): skip comment lines in SET scans** —
    `cobol/captures.ts:326-360`: skip col-7 `*`/`/` and `*>` lines. Test:
    commented `SET … TO ENTRY` produces no seed.
22. **docs(architecture): document callable-flow-only mode** —
    `ARCHITECTURE.md` § Callable-value flow.
23. **docs(scope-resolution): fix wrong/stale contract comments** —
    `gitnexus-shared/src/scope-resolution/reference-site.ts:41-43`
    (value-ref resolution mechanism), stale `--pdg`-only comments at
    `graph-bridge/edges.ts:26-27`, `passes/free-call-fallback.ts:~93`,
    `passes/receiver-bound-calls.ts:165`.
24. **test(ingestion): direct unit tests for synthesizeCallableFlowCaptures** —
    new `test/unit/scope-resolution/callable-flow-captures.test.ts` covering
    the option surface (assignment forms, member paths, params, subscripts).
25. **test(resolvers): deepen shallow language coverage** — add cross-file +
    decoy/shadow scenarios for the single-scenario languages (Java, Kotlin,
    Go, C#, Rust, Swift, Dart, JS, COBOL incl. `SET x TO y` copy branch) in
    `callable-value-flow.test.ts`; add non-pdg calleeId-filter over-capture
    assertion in `pdg-callee-id-capture.test.ts`.
26. **test(infra): extend the #1920 literal gate to capture options** —
    `test/helpers/literal-collectors.ts`: collect node-type literals from
    `*_CALLABLE_CAPTURE_OPTIONS` object-literal Sets and custom-walker args.
    (PHP `optional_parameter` would have been caught; step 19 removes it first
    so the gate lands green.)
27. **test(storage): replace as-unknown-as casts with typed corrupt-entry
    helper** — `parsedfile-store.test.ts:109-164`.
28. **chore(bench): refresh capture fingerprints after capture fixes** —
    run both `--check` scripts, commit regenerated
    `bench/python-scope/baseline-fingerprint.txt` and
    `bench/scope-capture/baselines.json`; record scaling ratios in the commit
    message. Fixes the stale-Python finding and absorbs steps 8–21 drift.

Step notes / risks inline: steps 8, 9, 11 change shared-util behavior for all
16 languages — run the full resolver integration suite after each; step 11 is
the largest design delta (new invoke emission path) — keep it store-gated
(only when the member cell has callable stores) to avoid Java-style noise.

## 8. Test Strategy

- Every behavioral fix carries its regression test in the same commit,
  asserting edge type + reason + target (repo standard; no if-branching in
  vitest, `toMatchObject` style).
- Suites: `test/integration/resolvers/callable-value-flow.test.ts` (per-language),
  `test/integration/resolvers/typescript-value-refs.test.ts` (untouched),
  `test/unit/scope-resolution/callable-value-flow-worklist.test.ts` (solver),
  `test/unit/parsedfile-store.test.ts` (storage), new files per steps 24/26.
- Verification commands (verified to exist):
  `cd gitnexus && npx vitest run <files>` per step;
  `npx tsc --noEmit` in `gitnexus-shared` (build first: `npm run build`) and `gitnexus`;
  `node --import tsx bench/python-scope/measure.mjs --check` and
  `node --import tsx bench/scope-capture/measure.mjs --check` (step 28);
  final: full targeted suite + both bench checks + both typechecks.

## 9. Risk and Impact Analysis

- `repo-manager.ts` `INCREMENTAL_SCHEMA_VERSION` (step 1): forces one-time
  full DB write for existing indexes — intended; parse cache already
  cold-invalidates via SCHEMA_BUMP 17 in this PR.
- Shared-util steps (8, 9, 11) have 16-language blast radius [graph:
  detect_changes]; mitigated by full resolver-suite runs per step and the
  step-28 fingerprint re-verification.
- Solver seeding change (step 3) must not reintroduce formal shadowing
  [verified: suppression rationale at `callable-value-flow.ts:185-189`];
  worklist unit suite guards termination.
- Removing surface (steps 6, 7) is JSON-compatible: validators ignore unknown
  keys; caches at SCHEMA_BUMP 17 written by pre-fix builds remain loadable.
  No additional bump needed [inferred — re-verify validator behavior in step 6].
- d=1 accounting: every impact d=1 dependent from the review is inside the
  diff except `emitReceiverBoundCalls` (verified unaffected); step edits stay
  within already-analyzed files, with per-step `impact` re-checks at
  execution per gitnexus-work discipline.

## 10. Files Expected to Change

| File | Symbols | Reason |
|---|---|---|
| gitnexus/src/storage/repo-manager.ts | INCREMENTAL_SCHEMA_VERSION | step 1 |
| gitnexus/src/storage/parsedfile-store.ts | isValidCallableFlowSite*, loadParsedFilesForPaths | steps 2, 6 |
| gitnexus/src/core/ingestion/scope-resolution/passes/callable-value-flow.ts | seeding, budget bailout, owner branch | steps 3, 4, 6 |
| gitnexus/src/core/ingestion/scope-resolution/passes/property-dispatch.ts | skippedKeys | step 5 |
| gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts | RunScopeResolutionStats, warn | step 5 |
| gitnexus-shared/src/scope-resolution/callable-flow-site.ts | ownerQualifiedName, passing mode | steps 6, 7 |
| gitnexus/src/core/ingestion/scope-extractor.ts | pass6 parsers | steps 6, 7 |
| gitnexus/src/core/ingestion/utils/callable-flow-captures.ts | terminalIdentifier, isVisibleValueBinding, emitCallFacts, options | steps 7–11 |
| gitnexus/src/core/ingestion/languages/c/captures.ts | variadic, options | step 10 |
| gitnexus/src/core/ingestion/languages/cpp/captures.ts, cpp/scope-resolver.ts | memberPointerParts, passing mode, markFileLocal | steps 2, 12–14 |
| gitnexus/src/core/ingestion/languages/{ruby,go,java,rust,php}/captures.ts | options | steps 15–19 |
| gitnexus/src/core/ingestion/languages/cobol/captures.ts, gitnexus/src/core/ingestion/cobol/cobol-preprocessor.ts | procedurePointers, SET scans | steps 20, 21 |
| ARCHITECTURE.md; reference-site.ts; graph-bridge/edges.ts; passes/free-call-fallback.ts; passes/receiver-bound-calls.ts | comments/docs | steps 22, 23 |
| gitnexus/test/** (per §8) | new/updated tests | steps 2–21, 24–27 |
| gitnexus/test/helpers/literal-collectors.ts | Mode-2 collectors | step 26 |
| gitnexus/bench/python-scope/baseline-fingerprint.txt; gitnexus/bench/scope-capture/baselines.json | fingerprints | step 28 |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Fix all 28 findings of the 2026-07-17 six-lens review of PR #2522 as one commit per finding on fix/2437-provider-hook-impact, ending with a single bench-fingerprint refresh."
  acceptance_criteria:
    - "Each finding has a dedicated conventional commit; behavioral fixes include a regression test asserting edge type + reason + target"
    - "INCREMENTAL_SCHEMA_VERSION = 7"
    - "Both bench --check scripts pass at branch tip with scaling ratios in budget"
    - "tsc --noEmit clean in gitnexus-shared and gitnexus; no any/as-any added"
    - "Full targeted resolver/storage/worklist suites green at tip"
  primary_symbols:
    - {symbol: emitCallableValueFlow, file: gitnexus/src/core/ingestion/scope-resolution/passes/callable-value-flow.ts, lines: "141-720", role: solver owner of deferred sites"}
    - {symbol: synthesizeCallableFlowCaptures, file: gitnexus/src/core/ingestion/utils/callable-flow-captures.ts, lines: "1-1134", role: shared capture synthesizer}
    - {symbol: loadParsedFilesForPaths, file: gitnexus/src/storage/parsedfile-store.ts, lines: "229-421", role: warm-cache validator}
    - {symbol: runScopeResolution, file: gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts, lines: "443-1330", role: pass wiring + stats}
    - {symbol: emitPropertyDispatchCalls, file: gitnexus/src/core/ingestion/scope-resolution/passes/property-dispatch.ts, lines: "60-138", role: value-ref USES + dispatch CALLS}
  related_symbols:
    - {symbol: emitReceiverBoundCalls, relationship: CALLS-consumer of mapReferenceKindToEdgeType, relevance: "verified unaffected; do not touch"}
    - {symbol: INCREMENTAL_SCHEMA_VERSION, relationship: gate for incremental DB writeback, relevance: step 1}
    - {symbol: collectDeferredIndirectSites, relationship: defines solver-owned sites, relevance: steps 3-4}
  execution_path:
    - "captures (per-language options) → synthesizeCallableFlowCaptures → pass6CollectCallableFlows → ParsedFile.callableFlowSites → parsedfile-store (persist/validate) → run.ts wiring → property-dispatch → callable-value-flow solver → CALLS/USES edges"
  pdg_constraints:
    - description: "Constrained-binding suppression exists so formals never adopt same-named globals"
      affected_statements: ["gitnexus/src/core/ingestion/scope-resolution/passes/callable-value-flow.ts:185", "gitnexus/src/core/ingestion/scope-resolution/passes/callable-value-flow.ts:1029"]
      implementation_consequence: "Step 3 seeds only via resolved callable defs of the operand's own binding; formal cells stay suppressed"
  architectural_patterns:
    - {pattern: "language specifics via provider options, never named in shared code", example_location: "gitnexus/src/core/ingestion/languages/cpp/captures.ts (CPP_CALLABLE_CAPTURE_OPTIONS)", usage_guidance: "all language fixes go in the language's captures.ts/options, not the shared util"}
    - {pattern: "edge assertions pin reason+type+target", example_location: "gitnexus/test/integration/resolvers/typescript-value-refs.test.ts", usage_guidance: "copy this discipline for every regression test"}
  files_to_modify: []   # see §10 table (authoritative)
  tests:
    - {file: gitnexus/test/integration/resolvers/callable-value-flow.test.ts, scenarios: ["C fp assigned in init(), called in run() → CALLS edge", "C ops-vtable o->run(1) → CALLS→handler", "C++ (obj->*ptr)() short names → CALLS", "C++ static member header/impl join", "Ruby action = process → NO CALLS→process", "Go a,b := f,g → both seeds", "Java map.get → no invoke fact", "Rust Shape::Square → no edge", "COBOL fixed-format seed/invoke", "COBOL commented SET → no seed", "COBOL SET x TO y copy branch", "cross-file + decoy scenarios for 9 shallow languages"]}
    - {file: gitnexus/test/unit/parsedfile-store.test.ts, scenarios: ["malformed-C++-shaped site dropped per-site, file retained, counter logged", "typed corrupt-entry helper replaces casts"]}
    - {file: gitnexus/test/unit/scope-resolution/callable-flow-captures.test.ts, scenarios: ["direct synthesizer unit coverage: assignments, member paths, subscripts, params, variadic"]}
    - {file: gitnexus/test/unit/pdg-callee-id-capture.test.ts, scenarios: ["non-pdg filter does NOT capture non-argument call sites"]}
  verification_commands:
    - "cd /workspace/.worktrees/pr-2522/gitnexus-shared && npm run build"
    - "cd /workspace/.worktrees/pr-2522/gitnexus && npx tsc --noEmit"
    - "cd /workspace/.worktrees/pr-2522/gitnexus && npx vitest run test/integration/resolvers/callable-value-flow.test.ts test/integration/resolvers/typescript-value-refs.test.ts test/unit/scope-resolution/callable-value-flow-worklist.test.ts test/unit/parsedfile-store.test.ts test/unit/scope-resolution/scope-extractor.test.ts"
    - "cd /workspace/.worktrees/pr-2522/gitnexus && node --import tsx bench/python-scope/measure.mjs --check"
    - "cd /workspace/.worktrees/pr-2522/gitnexus && node --import tsx bench/scope-capture/measure.mjs --check"
  risks:
    - "Steps 8/9/11 change shared-util output for all 16 languages — full resolver suite after each; fingerprints refresh only at step 28"
    - "Step 11 (C member invoke) is the largest new behavior — gate on member cells that have callable stores to avoid Java-style noise"
    - "Step 1 forces one-time full DB rewrite for existing indexes (intended)"
  assumptions:
    - "Removing optional persisted fields (steps 6/7) needs no SCHEMA_BUMP because validators ignore unknown keys — verify by loading a step-5-era cache fixture in step 6's test"
    - "No repo test pins INCREMENTAL_SCHEMA_VERSION = 6 — grep before step 1"
    - "bench scope-capture baselines will drift for ruby/go/java/rust/php/c/cpp/cobol after steps 8-21 — regenerate at 28, confirm ratios < 1.5"
  open_questions:
    - "Step 11: if store-gated member invokes still noise up Java/C#, restrict emission to languages without callableProtocolMethods (C-family) — decide at implementation with a capture probe"
  avoid:
    - "Do not repeat full repository discovery — the review evidence is the ledger"
    - "Do not touch CHANGELOG.md (release-time only)"
    - "Do not weaken existing assertions or use it.skip/describe.skip"
    - "Do not introduce any/as-any (including tests)"
    - "Do not name languages in shared ingestion code"
    - "Do not edit gitnexus-shared/dist by hand; rebuild via npm run build"
    - "Do not refresh bench fingerprints before step 28"
```

## 12. Assumptions and Open Questions

Condensed into the pack above (assumptions / open_questions). Explicitly
deferred (out of scope, review LOW notes with no action required): skipping
`formal` fact emission for functions with no callable-typed parameters
(covered by step 2's shared caps; optimization only), per-receiver
property-dispatch narrowing (§12 of the #2437 plan), relaxing the solver's
qualified-name fallback guard.

## 13. Definition of Done

- 28 commits on `fix/2437-provider-hook-impact`, one per finding, conventional
  messages referencing the finding.
- All acceptance_criteria in §11 met; both bench checks and both typechecks
  green at tip; targeted suites green.
- `detect_changes {scope: staged}` run before every commit; upstream `impact`
  run for every edited symbol; HIGH/CRITICAL surfaced.
- Knowledge-graph refresh (`node .gitnexus/run.cjs analyze --index-only --pdg`)
  after the final commit.
