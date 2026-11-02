# Test Scenario Map — design

Date: 2026-10-23 · Status: design — Codex round 7 (fresh full review, `gpt-6-astra` xhigh): rework, 9 findings, all applied; blocker resolved with a semantic value-flow check (§5.3a). Approved 2026-10-23 ("we can proceed"). Phase 0 (§5.4a, pure-JS runner slice) built 2026-10-24: gates 1-4 pass on the pure-JS category. Phase 1 (§9, pure-JS report) built 2026-10-25 in `gitnexus/tools/scenario-map/`; its deviations from this design are applied in place and listed in §12 · Related: PR #3686 (advisory duplicate-test scan; Phase 0 tooling in `gitnexus/tools/mutation/`)

## 1. Intent

GitNexus has about 22,700 test cases (1,350 files) plus 42 benchmark directories. **Scope of this effort: the CLI package `gitnexus/`** (about 1,280 test files: `test/unit`, `test/integration`, `bench/`). `gitnexus-web/` is deferred. We want three things:

1. **No repeated scenarios.** Many tests may exercise the same code path, but each must exercise it in a _different scenario_. Two tests that run the same path, check the same thing, and differ only in data the code treats identically are one scenario written twice.
2. **Less clutter.** Repeated scenarios should be removed, and same-logic table rows folded into `it.each`, without losing any protection.
3. **High quality.** The tool should also surface tests that catch none of the evaluated faults and code that the evaluated tests do not protect.

The tool reports. It never deletes or edits tests. Nothing it emits is a removal decision: every removal needs strong evidence (§2), a human scenario review, and the removal check in a cleanup PR (§6).

## 2. Definitions

| Term                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Test identity**        | Test file, describe path, title, declaration location, and parameter-row index for `it.each`/`test.for` rows. Duplicate titles are disambiguated by declaration order. Stable across runs and shards.                                                                                                                                                                                                                                                                                                                                                      |
| **Mutant identity**      | Source revision + file + span + operator + replacement. Globally comparable across runs and shards (Stryker's per-run mutant IDs are not).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Execution provenance** | Per test (from the V8 hook, §5.2): the set of files it executed, including files excluded from mutation, `node_modules` entry points of native packages (tree-sitter, `@ladybugdb/core`, onnxruntime), and worker-spawn call sites. It covers what the canonical path cannot see. **Strong-eligible provenance** (the one predicate used everywhere): provenance is known, and contains no mutation-excluded file and no native-package entry point, and no worker spawn unless the worker code is inside a validated instrumented-worker envelope (§5.4). |
| **Canonical path**       | For verdicts: the set of mutant identities a test covers (Stryker `coveredBy`), including mutants executed by its suite's `beforeAll`. V8 block coverage (§5.2) is used **only to retrieve candidates**, never for a verdict.                                                                                                                                                                                                                                                                                                                              |
| **Checks**               | The shape of each `expect(subject).matcher(…)` with literals abstracted. Selector literals inside the subject (`getNodesByLabel(r, 'Function')`) stay exact. Expected values are not lost: they are part of the input facet (§5.3 rule 3). Snapshot assertions are compared by snapshot content hash. Supported assertion forms are listed in the implementation; anything else makes the test _unsupported_ for strong evidence.                                                                                                                          |
| **Context**              | Enclosing hooks, `vi.mock`/`vi.spyOn`/`vi.stubEnv`, env writes and wrapper-call arguments (reusing #3686's context closure). Must be exactly equal for any repeat or row verdict.                                                                                                                                                                                                                                                                                                                                                                          |
| **Input facet**          | A signature of what the test feeds the code (§5.3). It also keeps the concrete values it discarded, per position, for the value-flow check (§5.3a).                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Kill**                 | A mutant for which the test fails **by assertion failure**. Timeouts, runtime errors, crashes, hook/fixture failures and infrastructure failures are **not** kills; they make the comparison inconclusive.                                                                                                                                                                                                                                                                                                                                                 |
| **Kill set**             | The test's kills over the **evaluated mutant universe** of that run (`disableBail`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Scenario fingerprint (primary verdict since 2026-10-25)

Two tests are **duplicates** when they run the **same execution path** (identical V8 block sets) on the **same input data** (equal input facets and discarded values, every input resolved, the runtime trace clean) and check the **same expectation** (equal checks-and-context keys). This needs no mutation run. A pair with an unresolved input is at most a **possible duplicate**; other input values make a **table-row** candidate; the same path and input with other checks is **same scenario, different checks**. Rules: `gitnexus/tools/scenario-map/verdict/fingerprint.ts`; plan: `docs/plans/2026-10-25-1700-feat-scenario-fingerprint-plan.md`. The mutation verdicts below remain as optional evidence (§6: dispatch, or the `scenario-map` label on a pull request).

### Verdict categories

Precedence, highest first: **Inconclusive → Out of scope → Weak → Repeat (strong) → Repeat (weak) → Row → Review → Distinct.** Subsumed is a per-test property that is reported alongside these verdicts. A test with an empty kill set can never be part of a repeat.

| Verdict                                | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                           | Action                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Inconclusive**                       | Any of: a timeout, error or flaky result on a mutant relevant to the pair, or missing results, unless a kill witness already rules out a repeat (a mutant both tests ran cleanly, killed by assertion by exactly one; the pair then goes on to Row or Distinct); differing outcomes on rerun; an isolation check that disagrees (§5.4); unattributable path (concurrent tests)                                                                 | Rerun or investigate; no other verdict                                                       |
| **Out of scope**                       | Covers no evaluated mutant, or its test category has not passed runner validation (§5.4a)                                                                                                                                                                                                                                                                                                                                                      | Not judged                                                                                   |
| **Weak**                               | Covers evaluated mutants but **kills no evaluated mutants**                                                                                                                                                                                                                                                                                                                                                                                    | Strengthen or delete (human)                                                                 |
| **Repeat candidate (strong evidence)** | All of: exact canonical path; same checks; same context; same input facet; identical non-empty kill sets over one complete common mutant universe; kills are assertion failures and stable on rerun; the full isolation pass agrees (§5.4); row deletion is _symmetric_ or _not applicable_; value-flow check clean (§5.3a); no unsupported assertion or table construct; strong-eligible provenance for both tests; no unresolved facet input | Human scenario review; removal only through a cleanup PR with the removal check (§6)         |
| **Repeat candidate (weak evidence)**   | Path, checks, context, facet and kills match as above, but one disqualifier applies: provenance is not strong-eligible, an unresolved facet input, inconclusive row deletion, an unsupported construct, the full isolation pass was not run (§5.4), or a test is not oracle-validated (§5.4a). A value-flow veto never yields a repeat verdict; it yields Review                                                                               | Review queue only                                                                            |
| **Row**                                | Same canonical path, checks, context and facet, but kill sets differ or row deletion is _asymmetric_                                                                                                                                                                                                                                                                                                                                           | Fold into `it.each`; keep every row                                                          |
| **Review**                             | Same canonical path, checks, context and kill set, but a different input facet, **or** the same facet with a value-flow veto or unknown (§5.3a)                                                                                                                                                                                                                                                                                                | Human decides; mutation cannot tell them apart                                               |
| **Distinct**                           | Anything else                                                                                                                                                                                                                                                                                                                                                                                                                                  | Keep                                                                                         |
| _Subsumed_ (property)                  | Non-empty kill set strictly inside another test's, over the common universe                                                                                                                                                                                                                                                                                                                                                                    | Reported as "no unique protection among evaluated mutants"; never a removal suggestion alone |

Phase 1 adds two weak-evidence disqualifiers. Both can only demote: V8 block sets that are not identical (§5.2), and a hook-attributed mutant on the pair's path or kills (§5.4 kill validity). A residual body difference makes two equal facets unequal (§5.3), so such a pair with equal kills ends in Review, never in a repeat.

## 3. Goals, non-goals, anti-goals

**Goals**

- Report repeat candidates, rows, weak tests and evaluated coverage gaps for the whole `gitnexus/` suite. Unit tests first, then the integration suite (tree-sitter, resolver and LadybugDB tests) through the Vitest 5 runner on the repo itself (§5.4, §5.4a).
- Every verdict carries its evidence: canonical paths, checks, context, facet differences, kill-set differences, row-deletion outcome, exclusions, and inconclusive causes.
- Report precision per stage, with sample sizes and confidence intervals (§8), and never claim more than those numbers support.
- Re-runnable from the CLI and on a schedule in CI.

**Non-goals**

- Automatic deletion, rewriting or folding of tests.
- Per-PR execution of the expensive layers (coverage and mutation). PR-time stays the structural scanner from #3686.
- `gitnexus-web/` (deferred, maintainer decision 2026-10-23) and Python tests (`eval/`). This effort covers the **CLI package `gitnexus/`** only: CLI, MCP server and core, with their tests and benches.
- Proving semantic equivalence. Identical kill sets mean "no evaluated mutant tells these apart", not "equivalent under every bug".
- Whole-suite protection claims from candidate-limited runs.

**Anti-goals** (failure even if it technically works)

- Any verdict that calls two genuinely distinct scenarios the same with nothing flagging it. This is the error that destroys protection.
- Similarity scores (embeddings, text similarity, path similarity) presented as evidence for a verdict.
- A report so noisy that people stop reading it.

## 4. Evidence this design rests on

All measured on this repo on 2026-10-22/23. Scratch artifacts were in `/tmp/test-audit/`; the labeled sets are to be committed (§8).

**Limits of this evidence (read first).**

- One author produced all the labels and also tuned the rules on them.
- The holdouts were drawn from a filtered slice: "same path + checks, different data" groups over 47 coverage files.
- 23/23 on the one untouched holdout gives a two-sided 95% exact lower bound of about 85% for distinct-scenario recognition. It measures **facet discrimination only**, not end-to-end precision of repeat candidates.

§8 adds independent labels and prospective holdouts before any precision claim is made.

### 4.1 Audit

1,350 test files, 22,678 cases, 42 bench dirs. Hand-verified:

- about 160 removable cases (~0.7%)
- 22 redundant pipeline runs
- 3 bench scripts and 7 tripwire tests
- defects: a fail-open bench guard, 5 orphan bench gates, tests that test nothing

### 4.2 Tool bake-off

83 labeled duplicate pairs (48 found by manual audit) and 15 look-alikes.

| Tool               | Audit-found pairs caught                                    | Look-alikes wrongly flagged |
| ------------------ | ----------------------------------------------------------- | --------------------------- |
| #3686 scanner      | 39/48                                                       | 0/15                        |
| vitest-dedup 0.7.0 | 26/48 (skips 24 oversized files and 1,482 unresolved tests) | 0/15                        |
| jscpd 5.4.2        | 14/48                                                       | 5/15                        |

saidvsdid 0.1.0 (deletion guard) caught a skip, deletions and a weakened matcher, but missed a dropped `it.each` row.

### 4.3 Embeddings (rejected)

arctic-embed-xs over all 22,769 test bodies:

- Retrieval was perfect: every known pair was in the top 5.
- Discrimination failed: duplicates vs look-alikes scored AUC 0.69 on bodies and 0.48 with titles.
- 0 of 16 sampled high-similarity pairs were redundant.
- GitNexus test cases are not graph nodes, and the indexes carry no embeddings.

### 4.4 Path layer (V8 per-test block coverage)

- AUC 0.876 for duplicates vs look-alikes; 48/55 known duplicates share path, checks and data.
- Pipeline tests drift slightly between runs (0.997 similarity). That is why similarity is used only for retrieval, and verdicts require exact canonical paths, which costs some recall in the safe direction.
- Blind to native tree-sitter parsing, regex alternatives and lookup-table rows.

### 4.5 Input facet

- Tuned on 4 labeled sets of 30 pairs.
- On a fifth, untouched set: **23/23 distinct scenarios** recognised (95% lower bound about 85%) and 4/7 repeats/rows. Every miss was on the safe side.

### 4.6 Mutation layer (Stryker 10, per-test)

_Historical: these numbers come from the spike, which ran a temporary Vitest 4 copy harness. The design uses Vitest 5 only (§5.4a)._

- **Runtimes:**
  - `shared.ts` alone: 1,232 mutants in 26 s.
  - 166 self-contained unit files (2,980 tests): 55,878 mutants in 65 min on 12 workers, static mutants skipped.
  - 48 candidate files with static mutants: 12–14 min.
- **Blind spots found and handled:**
  - Static mutants are required: 26 of 84 "repeats" were table rows.
  - `as const` array entries are never mutated: the spike stripped them in its copy (§5.4 keeps this as a pre-step).
  - Object-literal keys are never mutated: added a row-deletion operator.
  - Per-test results must be grouped by path and checks first.
- **Result in the 48-file scope:** 57 pairs passed all layers.
  - 23 are verbatim copies.
  - Of the 34 non-identical pairs, 33 were judged genuine repeats by the same author. 1 is debatable and is counted as not genuine.
  - This is a single-author judgement, not an adjudicated precision figure.
- **Weak tests:** about 16 kill no evaluated mutants, e.g. the 2048-character guard tests, which pass without the guard.

## 5. Architecture

Four layers. Layers 0–2 run over every test in scope, and Layer 0 agreement is **not** required for any verdict (Layer 0 misses real repeats, e.g. pairs whose `afterEach` differs). Layer 3 runs on candidate groups produced by Layers 1–2. The value-flow check (§5.3a) runs on candidate pairs whose concrete values differ.

### 5.1 Layer 0 — structural scan (exists, PR-time)

`gitnexus/tools/test-dupes/test-dupes.ts` from #3686 checks:

- same body + same setup
- literal-assertion pins
- repeated fixture builds
- copied helpers
- orphan bench gates

It stays the per-PR advisory comment. Planned small fixes (the bot findings on #3686, renamed locals, `afterEach` relaxation) are tracked there.

### 5.2 Layer 1 — candidate retrieval (path + checks + context)

V8 per-test coverage hook from the spike: a Vitest setup file using `node:inspector/promises`, run with `--repeats 1` (keep the warm run). Attribution rules:

- Coverage between a test's `beforeEach` and `afterEach` belongs to the test.
- A root `beforeAll` discards module-load coverage.
- `beforeAll` work is attributed per suite level: the coverage taken at the first `beforeEach` of each nested suite belongs to that suite.
- Tests under `describe.concurrent`/`test.concurrent` cannot be attributed. Their provenance is _unknown_, so any pair involving them is **Inconclusive** (reason: path unattributable).

Retrieval:

- **Metric:** Jaccard similarity over block identities. Pairs at ≥ 0.99 become candidates, together with pairs with identical checks + context.
- **Not transitive:** candidate groups are connected components and are used only to schedule Layer 3, never as verdicts.
- **Block identity (Phase 1, demote only):** a pair whose V8 block sets are not identical caps at weak evidence. The 0.99 tolerance would otherwise hide one test that reaches extra mutant-free code.

### 5.3 Layer 2 — input facet

Computed statically per test. Each rule was added to fix a measured miss; removing any of them reintroduces that miss. An input the rules cannot resolve is recorded as _unresolved_ and blocks strong evidence.

1. **Inline source code** is detected by language (`SupportedLanguages.X`, grammar identifiers, file-name literals, test path) and parsed with GitNexus's `createParserForLanguage`. Its anonymised tree shape is hashed:
   - **Locally declared names become `ID`.** Only declaration nodes count, including for/range/enhanced-for/assignment targets and Go `type_spec`.
   - **External types and GitNexus builtin names stay**, even when a fixture stubs them.
   - **Leaf rules apply only to leaves.** Composites such as `qualified_identifier` and `compound_literal_expression` keep their structure.
   - **Literal values are dropped; literal kinds are kept.**
   - **Comment text is shaped** for inline inputs and ignored in fixture files.
2. **COBOL** gets a reserved-word profile.
3. **Data literals, including expected values,** map to their production table by best fit. Search order:
   1. tables on the executed path
   2. the import closure, up to 2 hops
   3. property columns

   Never pool these. A table is a string array, Set/Map keys, object keys, switch cases or a regex alternation. A literal in no table is reduced to a boundary-aware shape: `0`, `1`, `-1`, negatives and empty strings stay exact.

4. **Selector literals** in an `expect(...)` subject call stay exact.
5. **Object-literal keys** count as input.
6. **Literals and builder calls keep their source order,** as shapes plus called function names.
7. **Shared-fixture tests** resolve their literals, and word tokens inside them, against the describe's fixture. The facet takes:
   - the matched definition's shape
   - the shapes of the fixture types it references, with their bases
   - the declared types of the fields it uses

   Presence-only assertions use the declaration kind instead.

8. **Fixture files** named anywhere under `test/fixtures/` contribute their shape. Only synthetic paths fall back to extension tables.

**Phase 1 additions (demote only):**

- **Numeric literals** follow rule 3 too: `0`, `1`, `-1` and negatives stay exact.
- **±1 rule:** a numeric literal within ±1 of a production numeric constant stays exact. Stryker has no numeric-literal mutator, so a boundary value such as `LIMIT + 1` would otherwise collapse with an interior value. The constants come from the test's executed production files and its static import closure, because a constants-only module runs only during the discarded module load. Statically evaluable initialisers such as `2 * 1024` count.
- **Residual-difference guard:** for two instances with equal facets, the check diffs the instance bodies. Any differing node that is neither a facet part nor a recorded discarded value marks both instances unresolved and makes the two facets unequal. This catches pairs that differ only in an enum member, a regex, a boolean, `null` or an operator.

### 5.3a Value-flow check (semantic veto)

**Why:** the facet drops literal values (rules 1 and 3). Two tests can then share facet, path and kills while protecting different behaviour inside code mutation cannot see. Example: a wrapper around `Math.round` tested with `2.4 → 2` and `2.5 → 3`. Non-empty kills show some sensitivity, not sensitivity to the erased difference.

**Scope:** every candidate pair whose discarded values differ (§2 input facet). Phase 1 also runs step 4 on every facet-equal candidate pair, as a cheap backstop for differences the facet cannot see. The check can only send a pair to **Review**; it never promotes. It uses four sources, and all must come back clean:

1. **Test side (Babel).** Bind each differing value to where it enters production code: a call argument, a fixture field or a table key. A differing expected value follows the input that produces it. A value that cannot be bound is _unknown_.
2. **Types and resolution (TypeScript 7 checker).** Through `typescript/unstable/sync` on `gitnexus/tsconfig.test.json`, resolve each entry call through aliases (`getAliasedSymbol`) to its declaration and read the parameter and contextual types.
   - An `any`/`unknown`-typed or unresolved entry is _unknown_.
   - Literal-union or enum members are recorded for the reviewer.
   - Probe (2026-10-23, TypeScript 7.0.2): the 2,401-file project loads in about 9 s; `Math.round` resolves to `lib.es5.d.ts`. The API is unstable: pin the TypeScript version, and treat any API failure as _unknown_.
3. **Static value flow (GitNexus PDG).** From each entry parameter, follow the value inter-procedurally to its sinks, and classify each sink with the checker:
   - **repo code** (branch, comparison, arithmetic, call into a repo function): coverage and mutation see it. Clean only inside the pair's mutated production files (§5.4 mutate scope). Repo code outside them is _unknown_.
   - **supported table read** (§5.4 row deletion): row deletion tests it. Clean.
   - **pass-through** (stored, returned unchanged, compared for identity only): clean.
   - **opaque:** a call declared in `lib.*.d.ts`, `@types/node` or `node_modules`, or any regex use. Veto.
   - **unknown:** truncated flow, dynamic dispatch, or a file without a PDG layer. Veto (fail closed).
   - Classes apply in that order. Reads from supported tables and storage into built-in containers (`push`, `Map.set`, `Set.add`) are table reads and pass-through, even though they are declared in `lib.*.d.ts`. The flow continues from wherever the stored value is read back; if the PDG cannot follow it, it is _unknown_.
   - **Stitched walk (Phase 1, `gitnexus/tools/scenario-map/value-flow/pdg-walk.ts`).** GitNexus `pdg_query` flows are intra-procedural, so the check stitches the walk itself:
     - It reads each function's REACHING_DEF and `CALL_SUMMARY` edges through LocalBackend's `cypher` tool, scoped to the function's `BasicBlock:<file>:<fnLine>:` id prefix.
     - The TypeScript checker resolves each callee. The argument position in the production AST gives the parameter. `CALL_SUMMARY` covers return values.
     - A binding derived from the value (`const { ratio } = opts`, `x = v`) is walked under its own name. A store into a property or module state is _unknown_.
     - Any opaque or unknown use in a statement vetoes the whole statement.
     - A truncated per-function query, an ambiguous binding or the depth cap (4 functions, entry included) is _unknown_.
4. **Dynamic trace (Vitest 5).** One extra run of the pair with a setup file that wraps value-sensitive built-ins: `Math`, string transforms and comparisons, `RegExp` methods, number parsing and formatting, `JSON`, `Intl`, `Date`, sort comparators, plus every opaque sink step 3 found. Storage and table reads (`push`, `Map`/`Set` methods) are not wrapped. Each call from a production frame (`gitnexus/src`, `gitnexus-shared/src`) records its call site, its receiver (`this`), its arguments and a call count per site.
   - If the two tests reach the same call site with a different receiver or different arguments, the differing data reached opaque code. Veto. This also catches derived values (`x * 10`) and flows step 3 missed.
   - Asymmetric call sites, or asymmetric call counts at a site, veto too.
   - Phase 1 runs the trace for every facet-equal candidate pair, not only for value-differing ones (demote only).
   - The trace run is separate from mutation runs. If a test's outcome changes under tracing, the pair is Inconclusive.

**Lifting a veto:** only an explicit equivalence rule for that built-in (e.g. `Math.round` on two integers), each with its own test. The list starts empty; add a rule only when measured Review noise justifies it.

**Cost:** one checker load per run, PDG queries per value-differing candidate pair, and one traced run over the tests of every facet-equal candidate pair. Phase 1 runs value flow before the mutation shards, so the isolation pass (§5.4) is spent only on pairs that can still be strong.

### 5.4 Layer 3 — mutation evidence

**Configuration**

- Stryker `perTest`, `disableBail: true`, **static mutants included**.
- Runs **on the repo itself** (Stryker's sandbox copy of the checkout), through the Vitest 5 runner (§5.4a). There is no separate harness project.
  - Phase 0 runs Stryker in a **prepared copy** of `gitnexus/` outside the checkout. Its `node_modules` links to the checkout's. It leaves out `vendor/`, `prebuilds/` and `dist/`, which the pure-JS category never loads.
  - Phase 1: baselines, row deletion and the trace run (§5.3a) run on plain Vitest 5 under the mutation config, with a fresh Vitest instance per run. Row deletion cannot run through Stryker, because Stryker applies only its own mutators. It edits a throwaway copy of the prepared tree instead. This still honours Vitest 5 only.
- Mutate scope: the candidates' production closure **and** `gitnexus-shared/src`. `gitnexus-shared` resolves to its source via a Vitest alias in the Stryker-only config, so its tables are mutated.
  - Phase 1: the mutate scope of a candidate group is whole production files: every production file in either test's V8 provenance or static import closure, with no line ranges.
  - Phase 0 finding: Stryker cannot mutate files outside its working directory. The prepared copy therefore relocates `gitnexus-shared/src` inside the `gitnexus/` tree. The mutation config derives its aliases from the package `exports`, and a path map translates relocated paths back.
- **Type assertions** (Phase 0 finding, replaces the `as const`-only pre-step). Stryker's instrumenter skips every `TSAsExpression` subtree, not only `as const` tables (`gitnexus/src` alone has 317 `as const` nodes).
  - The prepared copy blanks every ` as <type>` in the mutated files with spaces of the same length, keeping newlines. Lines and columns do not move, so the span map is an identity.
  - The check is AST equality: the blanked file must parse to the original AST with every `TSAsExpression` unwrapped. "Still parses" is not enough: ASI, precedence and a parenthesised `(x) as T` can give a different tree.
  - `satisfies` and the non-null `!` are not skipped, and stay.
  - The edit is type-only, and Vitest does not typecheck. An upstream instrumenter option is the long-term fix.
- **`disableTypeChecks: false`.** Stryker's default prepends `// @ts-nocheck` to matching files, test files included. That shifts every test line by one and breaks test identities.

**Kill validity**

- Before mutating, the baseline must pass twice with identical test identities.
  - Phase 1: two plain Vitest 5 baselines (a fresh instance per run) and Stryker's dry run must agree. Otherwise the group is _inconclusive_.
- Only assertion failures count (§2). Stryker `Timeout`, runtime and compile errors are recorded per test, and make any pair they touch _inconclusive_.
  - A test file that fails to import under a static mutant reports no per-test result (`killed-outside-test:collection`). Every test of that file is recorded with that class, not as a missing result. When it holds for both tests of a pair, neither test ran, so the mutant cannot tell them apart and counts as a non-kill for both.
- **Full isolation pass**, required for strong evidence: rerun every mutant covered by either test (the pair's covered universe), both tests together and then each alone, comparing coverage and outcome class. Static mutants and mutants executed in `beforeAll` rerun in a fresh process with modules reset. Any disagreement makes the pair _inconclusive_. This catches order dependence and leaking mocks that hide a distinguishing mutant.
  - Phase 1: the pass selects tests through the runner's `testIds` scope key (§5.4a). Each pair gets one Stryker run with both tests, and each test one run alone, shared across pairs. Mutate is restricted to the pair's covered universe. `maxTestRunnerReuse` 1 gives every mutant a fresh process. Coverage and outcome class per test and mutant must agree across the main, together and alone runs.
  - Phase 1: the pass runs only for pairs that can still be strong after value flow, because value flow (§5.3a) runs before the mutation shards. A pair whose isolation does not fit the shard's time stays isolation not-run, which caps it at weak.
  - **Hook-stratum cap (Phase 1, demote only):** a pair whose path or kills touch a hook-attributed mutant caps at weak. The cap holds until a gate 3 scope with a non-empty hook stratum passes (§5.4a). Today that stratum is empty in all three scopes.
- A sampled isolation pass is allowed as a cheap screen, but a pair without the full pass caps at weak evidence.
- Two passing baselines show observed stability, not absence of flakiness. The report says so.

**Comparability and sharding**

- Shard by **candidate group**, so both members of every compared pair are evaluated in the same run against the same mutant universe.
- Pairs are compared only over their common evaluated universe, keyed by global mutant identity. A missing result is _unknown_, never a non-kill.
- Shards merge **raw test–mutant observations**: test identity, mutant identity, selected-test scope, coverage, outcome class, validity and universe membership.
- Weak, gaps and subsumption are **recomputed** from the merged observations. Computed verdicts and counts are never merged or summed: two groups can mutate the same file, so a mutant can survive one group and be killed by another.
- Two observations of the same test and mutant with different outcome classes make it _inconclusive_.
- **Subsumption** of A by B is claimed only if B was evaluated on **every** mutant in A's evaluated universe, whether in the same shard or in a merged result covering that universe. Otherwise subsumption is _unknown_.
- Every comparison records its universe identifier in the report.

**Row-deletion operator** (Stryker never mutates object keys)

- Applies to candidate pairs whose differing literals are both keys of one production object literal.
- Delete each key in turn and run the pair.
  - Phase 1: the operator splices one key's text out of a throwaway copy of the prepared tree and runs the pair on plain Vitest 5, a fresh instance per run. A reused instance serves cached transforms and would turn a no-op deletion into a false "neither fails". A control run comes first: both tests must pass, and the edited file must load.
- Outcomes:
  - **symmetric:** both tests fail, or neither does
  - **asymmetric:** exactly one fails, which means _row_
  - **not applicable:** no such table
  - **inconclusive:** errors or timeouts
- **Supported tables:** object literals with plain identifier or string keys, read through ordinary lookups (`table.key`, `table['key']`, `table[variable]`, `key in table`, `Object.keys/entries(table)`); and `new Set([...])`/`new Map([...])` built from literal entries, read through `has`/`get`. Deletion removes one key or one entry.
- **Unsupported tables:** any table that is built or changed at runtime (spreads, computed keys, `Object.assign`, assignments into it, getters, proxies, duplicate keys). These make the outcome _inconclusive_, which blocks strong evidence.

**Execution environment** _(maintainer decision 2026-10-23: Stryker runs on Vitest 5, the version `gitnexus/` uses, through a runner built in this effort)_

- Stryker runs on the repo checkout with its real `node_modules`, fixtures and config, so native packages, `test/fixtures/` and repo-relative paths behave as in normal test runs.
- Worker scripts are built (`node scripts/build.js`) before the run, with `GITNEXUS_WORKER_READY_TIMEOUT_MS=60000`.
- LadybugDB tests keep `lbug-db` sequential isolation **and** get a per-Stryker-process database and temp namespace, or are globally serialised across Stryker workers.
- **Runner validation** (§5.4a) replaces the harness fidelity checks.

- **Native code is never mutated.** Loading it is not the same as testing it.

**Worker threads**

- Parse workers load the built `dist/` script, not the instrumented sources.
- The builder makes workers load instrumented code, and proves it with **planted worker-side mutants as positive controls**: they must be killed by a test known to depend on them.
- Until that is proven, worker-only files are mutation _exclusions_.
- Strong evidence is enforced through **execution provenance**. V8 coverage cannot see inside native addons or other worker isolates, and module-load coverage is discarded, so a clean V8 run is **not** proof of no native or excluded execution. Two checks always apply together:
  1. **V8 provenance:** excluded files, native-package entry points or worker spawns seen at runtime cap the test at weak evidence.
     - **Excluded files (Phase 1):** any executed repo file under `gitnexus/` that is neither a test file (`test/**`, `*.case.ts`) nor mutated, such as `tools/` or `scripts/` code.
  2. **Static closure:** if the test's static import closure reaches any native package (tree-sitter included), any worker-spawning module, or **any mutation-excluded file**, the cap applies too. Excluded files' module initialisation runs during the discarded load phase, so V8 cannot vouch for it.
- **No other exceptions.**
  - Tests depending on tree-sitter, LadybugDB, onnxruntime or any other native package top out at **weak evidence**: review queue, never a strong repeat candidate.
  - Worker execution stays capped until instrumentation is proven by positive controls. A proven, validated instrumented-worker envelope removes **only** the worker-spawn disqualifier from strong-eligible provenance (§2); worker code then appears in the canonical path. The native-package, excluded-file and static-closure caps still apply.
  - Consequence: most parser, resolver and LadybugDB repeats will be weak-evidence candidates. That is intended; it is the price of the top anti-goal.
- Unknown or incomplete provenance always caps at weak evidence.
- Unexecuted worker mutants never count as survived.

**Integration cost**

- Unknown. Benchmark three cases before scheduling: one resolver file, one parser-worker-heavy file and one LadybugDB file. Record wall clock, CPU time, peak memory and timeout rate.
- Do not extrapolate linearly from the 12-worker numbers.

**Wording of per-test results**

- Use "kills no evaluated mutants" and "no unique protection among evaluated mutants".
- Gaps are "uncovered by selected tests" (`NoCoverage`) and "survived the selected tests" (`Survived`), counted per production file. `Survived` includes equivalent mutants.
- A whole-suite run with static mutants is an optional manual job.

### 5.4a Vitest 5 test runner for Stryker (Phase 0, critical path)

**Why:** `@stryker-mutator/vitest-runner` 10.0.0 supports Vitest ≤4. Under the repo's Vitest 5.0.5, the dry run succeeds but every mutant run executes **0 tests**, so nothing can be killed. Without a working runner there is no Layer 3.

**Root cause (Phase 0 diagnosis):** Vitest 5 matches `testNamePattern` against the full name joined with `' > '`. The runner builds space-joined names, so every test inside a `describe` is filtered out. Upstream merged the separator fix (StrykerJS PR #6214, 2026-10-23) but had not released it; `latest` was still 10.0.0.

**Built (Phase 0):** a new runner plugin, `vitest5`, written in TypeScript in `gitnexus/tools/mutation/runner/`. It is not a fork: the upstream fix covers only the separator, and the needs below change most of the upstream file. Versions: Vitest 5.0.5, Stryker 10.0.0, Node 22. The runner:

- selects tests by **Vitest task id**, one test specification per file, never by name pattern or related mode. It checks that the executed tests equal the requested ones, because a specification with only unknown ids silently skips every test.
- keeps the configured `forks` pool and starts fresh workers per run. It never forces threads.
- writes a **run manifest** from the dry run: test id to Vitest task id and location, and the expected test set per file. Only one Stryker process runs the dry run, so every runner process loads the manifest before its first mutant run.
- writes per-test failure classes to **sidecar files**, because Stryker's result type has no field for them.
- counts a hit in a suite's `beforeAll` as coverage for every test of that suite. Only load- and collection-time hits make a mutant static.
- refuses any Vitest outside `5.0.x`.

**Extended (Phase 1):**

- an optional `testIds` key in the driver scope, passed as the `vitest5.testIds` runner option. The dry run runs only the requested tests, checks the executed set against the request, and fails on an unknown id before any mutant run.
- per-test outcome classes from every sidecar attempt in `results.json` (`perTest`, `attemptsDisagree`).
- a per-mutant hook marker (`hookAttributedTests`): the tests a suite hook attributed the mutant to.

What upstream would need before the plugin can be dropped is listed in `gitnexus/tools/mutation/UPSTREAM.md`.

**Required behaviour:**

- per-test coverage (`perTest`), mutant activation per run, `disableBail`, static mutants (full re-run), hit limits and timeouts
- test filtering by test identity
- **per-test failure classification:** assertion failure vs runtime error vs hook failure vs timeout, so §2's kill definition can be enforced
- stable test identities including `it.each` rows

**Validation, before Layer 3 is trusted.** Validation is staged **per test category**: pure JS, native-backed, fixture-reading, LadybugDB, worker-backed. A category is out of scope until it passes all four gates.

1. **Execution-path fidelity and envelope.** For each category, compare a normal Vitest 5 run with the runner's unmutated Stryker run, including the prepared sources (blanked `as` assertions) and the `gitnexus-shared` alias. Both must agree on:
   - collected test identities
   - outcomes
   - effective configuration
   - resolved paths of production modules (inside the sandbox)

   Record the validated envelope (config, environment, pool, aliases). Anything outside it is out of scope.

   **Span map check:** for every mutant in the prepared copy, applying its replacement at the mapped span in the original source must give the same code, apart from the blanked `as` assertions.

   **Phase 0 result:** pass on the pure-JS category, 246 files and 4,541 tests, 0 differences. The runtime load check found `commander` loading `child_process` at runtime; the classifier now rejects tests that import it. The span map check passed on 1,510 mutants with 0 failures.

   **Phase 1 result:** after the runner extensions, gate 1 passes on 251 files and 4,667 tests, with 0 differences. The envelope was refreshed: the classifier now rejects `conformance-compare.test.ts` and `php-namespace-extraction.test.ts`, and accepts the three oracle unit tests.

2. **Runner conformance suite.** A small, committed fixture project pins expected per-test coverage and outcomes for:
   - static and module-load mutants
   - mutants executed in a suite's `beforeAll`
   - several killers of one mutant under `disableBail`
   - `it.each` row filtering by test identity
   - mutant activation and reset between runs
   - assertion vs hook vs runtime vs timeout failures

   A mutant run that unexpectedly executes zero tests invalidates that mutant's evidence. Worker-category controls must prove the workers ran the instrumented sandbox build.

   **Phase 0 result:** all 23 pinned cases hold in two profiles, about 4 min each: Stryker concurrency 2 with a fresh runner process per mutant, and concurrency 1 with unlimited runner reuse. Only this fixture exercises `beforeAll` hit attribution: the hook-hit populations of all three oracle scopes are empty.

   **Phase 1 result:** the fixture gains a `testIds` selection scope and hook-marker cases. All 26 pinned cases hold.

3. **Vitest 5 cross-check oracle.** It is built entirely on Vitest 5, independently of the new runner. Every category gets its own frozen cross-check scopes before it is promoted:
   - **Scopes (Phase 0):** the pure-JS category has three, because `shared.ts` alone exercises neither the blanking, the alias, `beforeAll` nor `it.each`:
     - `gitnexus/src/core/ingestion/type-extractors/shared.ts`: 1,232 mutants, 143 tests, no hooks.
     - `gitnexus-shared/src/lbug/schema-constants.ts` through `gitnexus/test/unit/schema.test.ts`: 72 mutants, all static, 42 tests. It covers the blanked `as const` tables, the alias and `it.each`.
     - `gitnexus/src/server/middleware.ts` through `gitnexus/test/unit/middleware-public-origin.test.ts`: 302 mutants, 31 tests, with a `beforeAll`. The hook runs no mutated code.
   - **Independence:** both oracle paths share only Stryker's instrumented sandbox. They never use the runner's test filtering, state, kill attribution or result conversion. Each run is a fresh process that installs one frozen mutant before any module import and starts clean, so nothing carries over between mutants. **Activation and execution are recorded separately:** the run must independently confirm that the intended mutant ID was installed (else it is invalid), and records whether the mutant executed. A correctly executed, passing test that never hits the mutant is a valid non-covering observation. A hit is required only where a control predicts coverage.
   - **Per-mutant status:** Stryker's built-in `command` runner, which works on Vitest 5 but cannot attribute kills to tests, gives failed vs passed for every mutant. The runner's per-mutant outcome must agree on every mutant.
     - Phase 0: one Stryker run cannot use two test runners, so the oracle runs **its own Stryker run** with the `command` runner and keeps its instrumented sandbox for the single-test launches. Runner and oracle share Stryker core (planning, instrumentation), the prepare step and the mutation config, and no runner code. The two runs' mutant inventories must be identical sets of global ids.
     - On `shared.ts`, the command run agreed with the runner on all 1,232 mutant classes, and on the assertion kill sets of all 379 assertion-killed mutants.
   - **Per-test kill sets:** each test in the scope runs alone with the mutant active, selected by `vitest run <file>:<line>` plus an escaped, anchored `-t "^<full name>$"`. A run must report exactly one executed test, with the intended identity; zero or several invalidate the observation. Tests that still cannot be told apart (identical expanded `it.each` titles, duplicate full titles) are listed as not oracle-validated, and their evidence caps at weak.
   - **Outcome classes:** keep Vitest's JSON failure details and classify each failure as assertion, hook, runtime, timeout or infrastructure. Compare the runner and the oracle class by class, so the §2 assertion-only kill rule is checked, not just pass/fail.
   - **Sample:** a seeded random 100 mutants, topped up so every stratum is present: static/module-load mutants, mutants executed in `beforeAll`, mutants with several killers, survivors and `it.each` tests. Zero differences in 100 random mutants bounds the difference rate at roughly 3% (95% upper bound). That is the claim, and it covers this category only.
     - Phase 0: strata are counted across the three scopes combined. Within one scope, a stratum is required only when the scope's tests contain the construct and its population is not empty. Empty populations are recorded, never required.
   - **Cost (Phase 0 benchmark):** one single-test launch takes about 3.3 s wall and 1.8 s CPU at concurrency 4, about 0.87 s of throughput.
     - The sample is about 120 mutants (100 random plus top-ups) times the scope's tests: 17,160 launches for `shared.ts`, 3,024 for `schema-constants.ts` (all 72 mutants), 3,720 for `middleware.ts`. Each scope adds one command-runner pass.
     - Projected on 4 vCPU: 6.18 h at best (5.52 h launches, 0.41 h command-runner passes, 0.25 h setup). That exceeds the 6 h job limit.
     - So CI shards the freeze by scope: about 4.3 h for `shared.ts`, 44 min for `schema-constants.ts`, 56 min for `middleware.ts`. Comparing a runner run with the frozen manifests costs one Stryker run per scope.
     - Gate 3 stays on demand (`workflow_dispatch`); it does not run on pull requests.
   - **Freezing:** the oracle's source revision, configuration, operator set, test identities and global mutant identities are frozen with it.
     - Phase 0 records content hashes instead of a revision, since hashes survive squash merges and shallow checkouts: the scope's import closure, the Vitest configs and the prepare tool, plus the Stryker and Vitest versions and the Node major version. Any mismatch fails with "re-freeze required".
   - **Acceptance:** every supported observation must agree. The only allowed differences are an enumerated list of meaning-preserving representation normalisations. Phase 0 allows exactly four: every timeout row is one class, NoCoverage and survived are one class (the raw status stays in the report), title escaping, and path separators. Any execution, attribution or failure-class difference blocks validation **even when its cause is known**: fix it, or exclude the affected tests or category from the validated envelope.
   - **Not covered by the oracle:** it shares Stryker's instrumentation, so it cannot vouch for instrumentation or the blanking span map. Gate 1 checks the span map separately.
   - The spike's Vitest 4 results are history only, not an oracle.
   - **Phase 0 result:** gate 3 passes on all three scopes (seed `u7-gate3-1`, frozen 2026-10-24 in `gitnexus/test/fixtures/mutation-oracle/`): every mutant class agrees (`shared.ts` 1,232, `schema-constants.ts` 72, `middleware.ts` 302; NoCoverage read as survived for 621, timeouts 5), and every sampled per-test observation agrees (14,300 + 3,024 + 3,131 = 20,455 over 273 sampled mutants), with 0 differences and 0 invalid launches. Inventories match (tests and global mutant ids). Strata across the scopes: static, multi-killer, survived, no-coverage and each-row met; hook-hit population empty. The freezes took 2 h 55 min, 1 h 25 min and 1 h 36 min locally at launch concurrency 8, 3 and 3.
   - **Re-freeze (Phase 1, 2026-10-24):** merging `main` changed the import closure of the `schema-constants.ts` scope (`template-arguments.ts`), so gate 3 reported "re-freeze required". The manifest was re-frozen with seed `u7-gate3-2`: 72 sampled mutants, 3,024 valid observations, 0 invalid. Gate 3 passes on all three scopes again (1,232, 72 and 302 mutants), with 0 differences. The runner extensions changed no gate 3 hashed input, so they caused no re-freeze.

4. **Positive controls and determinism.** Per category, a fixed list of planted mutants must be killed by the tests that depend on them and must survive under tests that don't touch them. Two runs must give identical kill sets.

   **Phase 0 result:** pass. Nine controls, three per oracle scope, picked from each run's own mutants by global id; three sit in relocated `gitnexus-shared` `as const` tables. The `shared.ts` scope uses lines 729-904 (199 mutants) to bound the run time. Profile A runs at Stryker concurrency 1 with unlimited runner reuse, profile B at concurrency 3 with a fresh runner process per mutant. Every control held in every run, and A and B gave 0 differences in outcome classes and kill sets. About 81 min locally.

   **Phase 1 result:** after the runner extensions, gate 4 passes with 0 failures.

**Maintenance:**

- Pin the Vitest minor version that the runner supports. Done: the runner refuses anything outside `5.0.x`, and Stryker is pinned exactly.
- A CI check runs the conformance suite and the Vitest 5 cross-check oracle whenever Vitest, Stryker or the local runner changes, so an upgrade or edit cannot silently break kill evidence.
  - Phase 0: `.github/workflows/mutation-runner-validation.yml` runs the conformance suite on pull requests that touch the tooling, its fixtures, `gitnexus/package.json`, the lockfile or `gitnexus/vitest.config.ts`. The oracle, gates 1 and 4 and the benchmark run on manual dispatch, because the oracle takes hours. The workflow is advisory.
- Offer the patch upstream to `stryker-mutator/stryker-js`. Drop the local copy only once the upstream runner passes the same four gates.
  - Phase 0: upstream already merged the root-cause fix (#6214), so no PR was opened. The residual deltas are listed in `gitnexus/tools/mutation/UPSTREAM.md`.

### 5.5 Noise control and decisions

- **Tracking issue:** strong repeat candidates, weak tests and the per-file gap summary. Weak-evidence repeats, Review pairs and Inconclusive items live in the artifact report.
- **A human "keep"** is recorded with `// dupe-ok: <reason>`, as in Layer 0. Fold and remove decisions are recorded by the PRs that make them.
- **Two identities.** Execution identity is revision-pinned (§2) and kept as provenance. **Report continuity** uses stable anchors instead, so unrelated edits do not resurface findings:
  - a test anchor: file, describe path, title, row index and a body fingerprint, without the declaration line. A moved test is matched by body fingerprint; an unmatched test is new.
  - a mutant fingerprint: file, operator, replacement and the normalised enclosing code, without revision or span.
- **Week over week:** the report shows items that are new, **or whose evidence hash changed**, keyed by the continuity anchors. The hash uses fingerprints, not revisions or line positions, and covers:
  - canonical path and provenance
  - checks and context
  - facet
  - kills and universe identifier
  - row-deletion outcome
  - validity status and runner-validation status
  - exclusions
  - the computed verdict, its deciding rule or disqualifiers, and the verdict-engine version (so a rule change resurfaces every pair it reclassifies)

### 5.6 Verdict engine

Applies §2 with its precedence. Emits evidence for each pair and each test, including which rule or disqualifier decided the verdict. A pair has exactly one verdict.

## 6. Where it runs

| Surface       | Layers                                                   | Trigger                  | Output                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR            | 0                                                        | every PR                 | Sticky CI comment (exists)                                                                                                                                                                      |
| Scheduled job | 0–2 and the scenario fingerprint on `gitnexus/test/unit` and `gitnexus/test/integration` (Layer 1 in 4 CI slices) | weekly (mutation `none`) | Artifact (JSON + markdown); one tracking issue updated in place                                                                                                                                 |
| Manual run    | as scheduled, plus 3 at the chosen mutation scope        | workflow dispatch        | As the scheduled job; mutation `possible-duplicates` or `all` adds kill sets, weak tests and gaps                                                                                               |
| Labelled PR   | as scheduled but diff-scoped (pairs with a changed test file), plus 3 over the possible duplicates | `scenario-map` label     | Artifact and job summary; no issue, no baseline                                                                                                                                                 |
| Local CLI     | any                                                      | developer                | Same report                                                                                                                                                                                     |
| Cleanup PR    | 3 on the touched tests and their partners                | cleanup PR author        | **Removal check:** mutation run over the pair's common universe, before and after the removal. The remaining suite's kill set must be unchanged, and there must be no new inconclusive results. |

## 7. Constraints

- **Vitest version.** The repo uses Vitest 5. The stock Stryker runner supports only Vitest ≤4, so this effort builds the Vitest 5 runner (§5.4a). It is the critical path: Layer 3, and every strong verdict, waits for it.
  - **Vitest 5 only**, the version pinned in `gitnexus/package.json`. No Vitest 4 anywhere: no harness, no oracle, no `--legacy-peer-deps`.
  - The runner refuses anything outside Vitest `5.0.x`. A Vitest, Stryker or Node upgrade needs the four §5.4a gates again before its results count.
- **TypeScript 7:** the stable JS API is not ready, and Stryker's tsconfig preprocessor crashes, so point `tsconfigFile` at a non-existent file. Set `disableTypeChecks: false` (§5.4). The value-flow check uses the shipped unstable API (`typescript/unstable/sync`), pinned to the repo's TypeScript version and fail-closed (§5.3a).
- **Native code and fixtures** work as in normal test runs, because Stryker runs on the repo. The spike reached only pure-JS tests (170/894 unit files) through its copy harness, so integration-scale cost is still unmeasured (§5.4). Phase 0 validated the pure-JS category only: 246 unit files, chosen by a static classifier and checked by gate 1's runtime load check. Phase 1 refreshed that envelope to 251 files (§5.4a gate 1).
- **Compute:**
  - Shard by candidate group (§5.4), and merge raw test–mutant observations by global identity (§5.4).
  - Must fit `ubuntu-latest` (4 vCPU, 6 h) through sharding. Size the job from the §5.4 benchmarks, not by extrapolating.
  - The gate 3 oracle's full pure-JS sample does not fit one job (6.18 h projected on 4 vCPU), so its freeze is sharded by scope (§5.4a).
- **Measured budgets** (12 workers, unit scope):
  - about 65 min per 55k mutants without static mutants
  - 12–14 min per 30k-mutant candidate pass with them
  - about 54 min of coverage for 47 integration-heavy files
- **Measured Phase 0 times** (Vitest 5 runner; a loaded 24-CPU WSL2 machine, checkout on a 9p mount; CI will differ):
  - `shared.ts`, 1,232 mutants with static mutants: 5 min 12 s at Stryker concurrency 4; the oracle's command-runner pass 18 min
  - gate 1 over the pure-JS category: 2 min 39 s
  - gate 2: about 4 min per profile
  - gate 4: about 81 min for both profiles
- **Measured Phase 1 costs** (local runs; CI will differ):
  - Layer 1: 4,667 tests in about 2 min (1 min 55 s)
  - Layer 2: checks for 4,600 instances in 2.9 s; input facets for 4,667 instances in about 33 s
  - Layer 3 main run: about 1.5 min fixed per group, plus about 13 min per MB of mutated code, at Stryker concurrency 2. The cost does not grow with the group's tests.
  - isolation pass: about 130 s fixed per run, plus about 5.5 s per mutant (fresh process per mutant)
  - row deletion: about 48 s per batch, plus 2.5–5 s per pair run
  - whole-repo `analyze --pdg` for value flow: 6 min 49 s wall, 8.4 GB peak RSS
  - trace run: 1.19× pooled overhead on 40 eligible files, with no outcome change
  - controls fixture end to end: 16 of 16 pairs match, 28 min
  - predicted CI run: 9 shards at Stryker concurrency 4, 1,658–1,829 min in total, largest shard 196–253 min (budget 300 min), 0 groups over budget
- **Caching:** key results on everything that changes them:
  - test and production file contents
  - fixtures read
  - the evaluated mutant universe identifier
  - the Vitest, Stryker and runner versions, and the operator set
  - the dependency lockfile
  - the source revision
  - relevant env vars and runtime: Node version, OS, `GITNEXUS_*` settings
  - the Stryker and Vitest config used for the run
- **Determinism:** stable report ordering. Any sampling (reruns, spot audits) uses a recorded seed.

## 8. Validation

**Labeled data**

- Commit the raw evidence of the 150 labeled pairs (5 sets) and the 20-pair mutation-scope set, frozen at commit `caacc3bac`:
  - both test bodies
  - describe paths
  - fixture snippets and production table excerpts
  - kill sets, for the mutation set
- Signatures are **re-derived** from this raw evidence in CI, so extraction regressions are caught. A full re-derivation at the pinned commit is a manual job.
- Rejected tools are not re-scored.

**Independent adjudication**

- Before any precision claim, a human who did not tune the rules relabels at least the four tuning sets, and all disagreements are resolved.
- Report agreement (Cohen's κ).
- **Strong-repeat precision** is measured on a seeded random sample of strong candidates from each scheduled run class (unit, integration): 50 per class, or all of them if fewer. Each is independently labeled by a human who did not tune the rules. The denominator is the sample size.

**Prospective holdouts**

- **Grouping:** holdouts are split by fixture and candidate group, so related pairs always land in the same set and cannot leak tuning information.
- **Size:** each fresh holdout has at least 30 distinct pairs and 30 repeat pairs. 30/30 gives a two-sided 95% lower bound of about 88%; 50/50 gives about 93%. These are bounds, not claims of near-zero risk.
- **Adversarial set:** pairs built to differ only where the facet or mutation layer is weakest. All must end in Review or Distinct:
  - opaque built-ins: `Math.round` on `2.4`/`2.5`, `parseInt` radix, `toFixed`, `localeCompare`, Unicode `normalize`, `Date` boundaries
  - regex alternatives
  - Unicode
  - numeric boundaries
  - ordering
  - native-parsed input
  - worker-only code
  - positive controls that must stay eligible: repo-only arithmetic (`add(1, 2)` vs `add(5, 5)`), membership in a supported `Set` table
- **Integration set:** pairs drawn once the runner reaches integration tests.

**Metrics per stage**, each with sample size and 95% CI:

- facet discrimination
- strong-repeat precision, adjudicated
- row/review split
- weak-test claim validity, audited as two separate questions:
  - is the scoped mutation claim true? Reruns confirm no evaluated mutant is killed, and the share of likely-equivalent mutants is recorded.
  - assertion quality, judged by a human. Meaningful assertions can kill no evaluated mutant, so this is reported separately.

**Gates for changing facet or verdict rules**

- Distinct recognition on a **fresh** untouched holdout stays at 100%. Each holdout gates one change and then retires into the tuning pool. The next gate draws a new holdout.
- **Paired precision check:** old and new rules run on the same fresh sample. Any false strong repeat that the new rule introduces blocks the change. The precision difference is reported with its 95% CI.
- Every new rule cites a newly labeled miss and is re-scored on a fresh holdout.

**Spot audit:** each scheduled report includes 10 strong repeat candidates, selected with a recorded seed, for human verification.

## 9. Rollout

Each category becomes eligible for Layer 3 only after it passes the §5.4a gates.

0. **Vitest 5 runner, pure-JS vertical slice (§5.4a):**
   - diagnose and patch
   - the `as const` pre-step with span mapping and its span map check, and the `gitnexus-shared` alias
   - commit the conformance suite and the `shared.ts` cross-check oracle
   - validate the **pure-JS** category only
   - benchmark the oracle's fresh-process cost
   - write the residual deltas against upstream in `gitnexus/tools/mutation/UPSTREAM.md` (upstream merged the root-cause fix, StrykerJS #6214; no PR is opened in Phase 0)
1. **Pure-JS unit tests:** Layers 1–3, the value-flow check, the kill-validity protocol, the report and the scheduled job.
   - **Built 2026-10-25:** `gitnexus/tools/scenario-map/`, the `npm run test:scenario-map` CLI and `.github/workflows/test-scenario-map.yml`. The plan is `docs/plans/2026-10-24-0902-feat-test-scenario-map-phase1-plan.md`.
   - The controls fixture (`gitnexus/test/fixtures/mutation-scenario-map/`) matches all 16 expected verdicts and rules.
   - The first full run ran on PR #3686 through a temporary label-gated trigger (run 40183982111, 2026-10-25): complete, 9 of 9 shards, about 4 h. 4,632 eligible tests, 2,327 evaluated, 6,264 candidate pairs. All 11 strong repeat candidates call `extractElementTypeFromString` with the same input and expectation, in two files or under different titles.
   - Verdict engine 1 left 4,532 pairs Inconclusive (`kills-unknown` 3,141, `non-assertion-outcome` 1,391): any unknown or runtime-class mutant decided the pair, even when the kill sets already differed. Engine 2 adds the kill witness. Re-merged from the same artifacts, Inconclusive falls to 1,469 (Distinct 1,053 to 3,952, Row 46 to 165, Weak 117 to 162). Every pair engine 1 decided keeps its verdict, rule and details, and the repeat candidates are unchanged.
   - The remaining Inconclusive pairs have no witness: `kills-unknown` 977 (`missing-result` alone 675, all same-file pairs; timeouts alone 245), `non-assertion-outcome` 345, `member-inconclusive` 147. Every `missing-result` came from a static mutant whose test file failed to import (no per-test rows), not from a timeout; 966 of the 1,020 run-timeout mutants had a test past Vitest's 30 s testTimeout. Engine 3 records the import failure (§5.4). Its run (40208819019, complete, same 6,264 pairs) left 833 pairs Inconclusive (`non-assertion-outcome` 382, `kills-unknown` 302, of which 266 are timeouts, `member-inconclusive` 149). The 596 pairs import failures alone had blocked now reach the repeat stage: 595 are `csv-escaping.test.ts` table rows the trace vetoes to Review, because the arguments differ. Strong repeat candidates rose from 11 to 13. Both new ones were weak repeats that now had isolation, and both repeat a call with the same input and expectation. A timeout retry was tried and dropped: re-running the six timed-out mutants of one group locally resolved none (loop mutants that hang every time), and 214 of the 244 timeout-only pairs time out in both tests. Those pairs stay Inconclusive: a Stryker timer timeout marks every covered test, and a hung test can starve the next one, so a timeout of both tests does not show that the mutant cannot tell them apart. 2,305 eligible tests have no candidate partner, so they are never mutation-run; their Weak status is not evaluated.
   - Scenario fingerprint (2026-10-25), measured locally (shared 24-core WSL2 host, concurrency 4, `nice -n 19`): the fingerprint-only run over all 4,632 eligible tests took 8.2 min (plan 5.4, of which Layer 1 3.0; trace 2.6; merge under a second; 2 GB peak RSS), against about 4 h and 30 runner-hours for the full mutation run. It names 26 duplicates, exactly the 26 pairs the evidence above predicts (the 13 strong repeats and the 13 mutation could not decide), 109 possible duplicates (all with an unresolved input) in 17 groups, 945 table rows and 5,184 distinct pairs. The controls fixture matches all 16 fingerprint expectations and all 16 mutation expectations. The deep run over the possible duplicates (the `scenario-map` label on PR #3686, run 40268120818) took 5 min 42 s on CI: plan 2.1, value flow 1.0, one shard of 5 groups, 25 tests and 844 mutants in 1.3, merge 0.5. Of the 109 possible duplicates, mutation settles 35 of the 38 it can reach: 31 are Row (the `embedding-recovery` table rows: kills differ), 1 Distinct, 3 weak-evidence repeats; 3 stay Inconclusive. The other 71 test `tools/mutation/` code, which is outside the mutation scope (Out of scope). That run's merge found no shard result: with one shard, `download-artifact` unpacks the only matching artifact into the path itself, and the placement step looked for a subdirectory; the merge above is a local re-merge of its artifacts, and the step now handles both layouts.
2. **Rest of the unit suite:**
   - a frozen cross-check scope, then validation, for the **native-backed** and **fixture-reading** categories
   - LadybugDB namespaces, then validation of the **LadybugDB** category
3. **Integration:**
   1. Benchmark the three cases (§5.4).
   2. Prove worker instrumentation and validate the **worker-backed** category.
   3. Shortlist by candidate group and shard.

## 10. Decided

- Embeddings, vitest-dedup in CI and jscpd are out (measured, §4).
- PR-time stays Layer 0. The expensive layers run on a schedule or on demand.
- Strong evidence requires all of §2's conditions, including mutation evidence. Facet agreement alone is never enough, and nothing is removed without human review plus the removal check.
- Similarity of any kind is retrieval only.
- The canonical path for verdicts is mutant-granular `coveredBy`; V8 block coverage is for retrieval.
- Mutation runs on the repo itself on Vitest 5, through a Stryker runner built in this effort. Vitest 4 is not used anywhere, including validation.
- Scope: the `gitnexus/` CLI package. `gitnexus-web/` is deferred.
- The unit suite comes first.
- Data that differs but collapses to one facet is judged by semantic tooling: Babel, the TypeScript 7 checker, GitNexus PDG and a Vitest 5 trace run (§5.3a). It can only veto a repeat.

## 11. Left to the builder

- Package layout and language: TypeScript under `gitnexus/scripts/` or a separate tool directory.
- Report format details and tracking-issue formatting.
- Where the Vitest 5 runner lives (an in-repo tooling package, or a pinned fork) until upstream ships support. Also the cache implementation (cache keys are fixed in §7).
- The list of supported assertion forms, as long as it is documented and anything else is reported as unsupported.
- The exact list of wrapped built-ins in the trace run (§5.3a), as long as storage and table reads stay unwrapped and the list is documented.

Phase 1 choices: the tool lives in `gitnexus/tools/scenario-map/`. The supported matcher list and the wrapped built-ins list are documented in `TESTING.md` and in the headers of `facet/checks.ts` and `value-flow/builtins.ts`. There is no result cache yet: the report records the §7 cache-key inputs as run provenance.

## 12. Decisions log

Maintainer (2026-10-26):

- **Fingerprint scope:** the fingerprint covers every unit and integration test of `gitnexus/`; mutation stays on the validated pure-JS category. Layer 1 runs in CI slices (fingerprint plan E5, E6, E7).

Maintainer (2026-10-25):

- **Duplicate definition:** a duplicate is the same execution path, the same input data and the same expectation (the scenario fingerprint, §2). It is the primary verdict; mutation kill sets are optional evidence.
- **Where it runs:** weekly fingerprint only; mutation on manual dispatch; a pull request gets the deep run (fingerprint plus mutation over the possible duplicates) when the `scenario-map` label is added, not automatically.
- **Cost:** optimise the deep run as far as possible and measure locally, not on CI.

Maintainer (2026-10-23):

- **Tests outside mutation reach:** bring native-backed, fixture-reading and integration tests into mutation scope (§5.4), rather than adding an unconfirmed verdict or waiting. Delivered through the Vitest 5 runner on the repo itself, not a harness.
- **Vitest 5 only (2026-10-23):** use Vitest 5, as `gitnexus/` does, for the runner and its validation oracle. Vitest 4 is gone from the design.
- **CLI focus (2026-10-23):** this effort covers `gitnexus/` only. `gitnexus-web/` is deferred.
- **Semantic value flow (2026-10-23):** for data that collapses to one facet, use whatever gives real semantic information (Babel, TypeScript itself, the Vitest engine) rather than a blanket rule (§5.3a).
- **Vitest 5 runner (2026-10-23):** build a Stryker test runner for Vitest 5 as part of this effort, and run mutation on the repo itself. This supersedes the earlier inference of a Vitest 4 harness: no harness, no `--legacy-peer-deps`, no cross-version fidelity checks.

Independent review (Codex, 2026-10-23, round 1 verdict "rework"). All 11 findings were applied:

1. The repeat verdict is split into strong and weak evidence, and is never "confirmed" without a human.
2. Kill-validity protocol: assertion-only kills, reruns, isolation checks, Inconclusive.
3. Global mutant and test identities; comparisons only over a common universe; sharding by candidate group.
4. Similarity is used for retrieval only; the canonical path is decided; attribution rules are specified.
5. Explicit context equality, snapshot handling, supported assertion forms, row-deletion outcomes.
6. Evidence limits and per-stage metrics with confidence intervals; independent adjudication; prospective holdouts.
7. Differential Vitest 4/5 fidelity checks and resolution-path verification _(superseded: Vitest 5 only; fidelity is now checked per category in §5.4a)_.
8. Worker positive controls; out-of-reach code caps a test at weak evidence.
9. LadybugDB namespaces; three-case benchmark before scheduling.
10. Scoped wording for weak tests and gaps; verdict precedence; empty kill sets never form a repeat.
11. Raw-evidence re-derivation, complete cache keys, evidence-hash resurfacing, seeded audits.

Codex round 2 (2026-10-23, "rework": 5 resolved, 6 partially resolved, 4 new). Applied:

- Execution provenance enforces the exclusion cap (blocker).
- Supported table reads are defined for row deletion.
- Strong-repeat evaluation sample and holdout retirement.
- Fault-positive controls and the supported harness envelope.
- Full cache and evidence-hash inputs.
- Concurrent tests go to Inconclusive.
- Cross-shard subsumption eligibility.
- Weak-test validation split into a mutation-claim audit and an assertion-quality review.
- The Vitest 4 decision is marked pending _(superseded: Vitest 5 only, decided)_.

Codex round 3 (2026-10-23): 8 of 10 open items resolved, no new problems. Applied:

- Provenance completeness: the static-closure check always applies alongside V8, and other natives and workers stay capped.
- The resurfacing hash includes the verdict, deciding rules and verdict-engine version.

Codex round 4 (2026-10-23): **approve with changes**, both applied:

- The tree-sitter exception is removed as unsound: lossy shapes cannot vouch for native lexer and parser execution, and it contradicted §2. Native-dependent tests cap at weak evidence.
- The static-closure check also covers mutation-excluded files, since their module initialisation is invisible to V8.

Codex round 5 (2026-10-23), reviewing the Vitest 5 runner revision: **approve with changes**, all applied:

- per-category execution-path fidelity and envelope checks
- a runner conformance suite (coverage attribution, zero-test runs, failure classes, worker build)
- a frozen, mapped regression oracle with a blocking acceptance rule _(now the Vitest 5 cross-check oracle)_
- CI on runner changes
- rollout prerequisites reconciled: categories are validated in stages, and the `as const` pre-step and shared alias move to Phase 1

Codex round 6 (2026-10-23), reviewing the Vitest-5-only oracle and the CLI scope: **approve with changes**, all applied to gate 3:

- oracle independence from the runner's execution adapter; activation before import, proven per run
- exact test selection (`file:line` plus anchored `-t`, exactly one executed test); indistinguishable titles are not oracle-validated and cap at weak
- outcome classes compared, not just pass/fail; unexplained differences can never be accepted
- stratified sample on top of the random 100; the roughly 3% bound stated as the claim
- cost estimate, with a benchmark and CI budget before the check becomes mandatory
- CLI scope change: consistent; `gitnexus-shared/src` stays in scope as a CLI test dependency

Codex round 7 (2026-10-23, fresh full review, `gpt-6-astra` xhigh): **rework**, 1 blocker, 6 major, 2 minor. All applied:

1. Blocker, lossy facets: the value-flow check (§5.3a) vetoes pairs whose differing data reaches opaque code or flows unknown; the facet keeps the discarded values.
2. Full isolation pass over the pair's covered universe for strong evidence; sampled isolation caps at weak.
3. Oracle activation is confirmed separately from execution; non-covering runs are valid.
4. Known-cause defects block oracle acceptance; only enumerated normalisations pass.
5. Phase 0 is a pure-JS vertical slice with its prerequisites; per-category cross-check scopes; a separate span map check.
6. Shards merge raw observations; weak, gaps and subsumption are recomputed.
7. Holdouts are grouped by fixture and candidate group, with sizes and a paired precision check.
8. One strong-eligible provenance predicate; a validated worker envelope lifts only the worker disqualifier.
9. Report continuity anchors are separate from revision-pinned execution identity.

Settled by the author (reviewable):

- **Deletion guard:** tracked separately.
- **Report home:** artifact plus one tracking issue.
- §5 layer flow, §5.5 noise control, §7 sharding, §8 frozen labels.

Phase 1 implementation (2026-10-24/25, `docs/plans/2026-10-24-0902-feat-test-scenario-map-phase1-plan.md`). Deviations from this design, all applied in place above:

1. **Stitched value-flow walk (§5.3a step 3).** GitNexus `pdg_query` flows are intra-procedural. The check reads per-function REACHING_DEF and `CALL_SUMMARY` edges through LocalBackend's `cypher` tool. The TypeScript checker resolves callees, and AST argument positions map to parameters. Truncation, ambiguity and the depth cap of 4 are unknown. Repo code is clean only inside the pair's mutated files. Any opaque or unknown use in a statement vetoes it.
2. **Trace (§5.3a step 4).** It records receivers as well as arguments. It runs for every facet-equal candidate pair. Asymmetric call sites or call counts veto.
3. **Plain Vitest 5 outside Stryker (§5.4).** Baselines and row deletion run on plain Vitest 5 with a fresh instance per run. Row deletion cannot run through Stryker, because Stryker applies only its own mutators. It edits a throwaway copy of the prepared tree.
4. **Isolation pass (§5.4).** It selects tests through the runner's new `testIds` scope key and gives every mutant a fresh process. It runs only for pairs that can still be strong after value flow.
5. **Demote-only additions:**
   - non-identical V8 block sets cap a pair at weak (§5.2);
   - numeric literals keep `0`, `1`, `-1` and negatives exact (§5.3 rule 3);
   - the ±1 numeric-constant rule, with constants from executed files and the static import closure and folded initialisers (§5.3);
   - the residual-difference guard: a body difference the facet misses makes the facets unequal, so a pair with equal kills ends in Review (§5.3);
   - excluded files: any executed repo file under `gitnexus/` that is neither a test nor mutated caps the test at weak (§5.4);
   - the hook-stratum cap (§5.4);
   - the trace on every facet-equal pair (§5.3a).
6. **Runner extensions (§5.4a).** `testIds` selection, per-test classes from every attempt and a per-mutant hook marker. Gates 1–4 pass after them, with no oracle re-freeze caused by them.
7. **Schema-constants re-freeze (§5.4a gate 3).** Merging `main` changed the scope's import closure. The manifest was re-frozen with seed `u7-gate3-2`, and gate 3 passes on all three scopes.
8. **CI topology (§6, §7).** Value flow runs before the mutation shards, not in parallel with them. The shard plan is rebuilt after value flow, so it counts isolation only for the pairs value flow leaves able to be strong. A group whose isolation does not fit still runs its main run and row deletion; its pairs get isolation not-run (weak cap). A group that executes no production file is not run, and its pairs are Out of scope.
