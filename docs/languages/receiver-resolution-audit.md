# Receiver Resolution Measurement Audit

Measured on 2026-10-23. Production sources are pinned to `c35806d2447dda6642448948e53c7c1ac8c3482a`;
this change updates the benchmark, tests and documentation, not the resolver.

The original 167-cell snapshot and count arm reproduced exactly after a fresh
build. That did not establish correctness: its classifier accepted any same-named
callee. Independent full-target checks found one false positive, and reviewing
all 72 original N/A entries found executable cases hidden among the exclusions.

## Results

The expanded matrix has **110 executed cases**: 93 reach their exact expected
declaration, 14 expose gaps, and three intentionally untyped controls remain
unresolved. The other **58 entries are N/A declarations**, not successful runtime
tests. No active shape corpus reported GRAMMAR-UNAVAILABLE.

| Language                                   | Exact target | Visible gap | Invisible gap | Wrong target | N/A |
| ------------------------------------------ | ------------ | ----------- | ------------- | ------------ | --- |
| [c](c-ingestion-gaps.md)                   | 0            | 0           | 0             | 0            | 10  |
| [cobol](cobol-ingestion-gaps.md)           | 0            | 0           | 0             | 0            | 10  |
| [cpp](cpp-ingestion-gaps.md)               | 7            | 2           | 0             | 0            | 3   |
| [csharp](csharp-ingestion-gaps.md)         | 8            | 1           | 0             | 0            | 1   |
| [dart](dart-ingestion-gaps.md)             | 5            | 2           | 1             | 1            | 1   |
| [go](go-ingestion-gaps.md)                 | 6            | 0           | 0             | 0            | 4   |
| [java](java-ingestion-gaps.md)             | 4            | 1           | 0             | 0            | 5   |
| [javascript](javascript-ingestion-gaps.md) | 5            | 2           | 0             | 0            | 4   |
| [kotlin](kotlin-ingestion-gaps.md)         | 9            | 0           | 0             | 0            | 1   |
| [php](php-ingestion-gaps.md)               | 6            | 2           | 0             | 0            | 4   |
| [python](python-ingestion-gaps.md)         | 6            | 0           | 0             | 0            | 4   |
| [ruby](ruby-ingestion-gaps.md)             | 3            | 3           | 0             | 0            | 5   |
| [rust](rust-ingestion-gaps.md)             | 8            | 0           | 0             | 0            | 2   |
| [swift](swift-ingestion-gaps.md)           | 7            | 1           | 0             | 0            | 2   |
| [typescript](typescript-ingestion-gaps.md) | 10           | 0           | 0             | 0            | 1   |
| [vue](vue-ingestion-gaps.md)               | 9            | 1           | 0             | 0            | 1   |

The visible-gap counts include the three deliberate controls: JavaScript and
Ruby `untypedChain`, and PHP `arrowCallChain`. They must remain unresolved.
Zig and Objective-C still lack shape-arm rows; their dedicated suites were run
separately. C and COBOL's all-N/A rows do not measure their ordinary call paths;
their focused integration suites were also run.

The count arm is unchanged: **138 call drops, 168 total drops, 30 reads, no writes**.
Its origin breakdown is 57 in-program, 49 unknown, 30 external and two unclassified.
These diagnostic totals are not an actionable bug count.

## Corrected classifications

| Case                  | Previous | Fresh result                            | Interpretation                                                                                                                                                 |
| --------------------- | -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C++ plainChain        | N/A      | RESOLVES                                | The old entry delegated to pointerArrowChain/valueDotChain. A canonical plain-chain fixture now also reaches User.save; there was no plain/deep contradiction. |
| C++ awaitParen        | N/A      | VISIBLE-GAP                             | A valid C++20 awaiter declares User await_resume(), but the terminal call does not resolve. The minimal probe passes `g++ -std=c++20 -fsyntax-only main.cpp`.  |
| PHP fieldReceiverCall | N/A      | RESOLVES                                | A real `$this->repo->save()` fixture replaces the alias to arrowPropertyPath.                                                                                  |
| Rust awaitParen       | N/A      | RESOLVES                                | `(svc.get_user_async().await).save()` reaches User.save.                                                                                                       |
| Dart awaitParen       | RESOLVES | WRONG-TARGET                            | Future<User> requires User.save, but the emitted edge reaches Address.save. Matching only `save` concealed the error.                                          |
| Dart explicitTypeArgs | N/A      | VISIBLE-GAP                             | A generic method with a concrete User return still loses `svc.getTyped<User>().save()`.                                                                        |
| Vue script shapes     | All N/A  | Nine RESOLVES, one VISIBLE-GAP, one N/A | A real typed SFC exposes working chains and an indexed-receiver gap. The new fourHopChain cell matches the TypeScript control.                                 |

Dart explicitly supports type arguments on generic method invocations; inference
was not a valid N/A reason. See the [Dart reference](https://dart.dev/language/type-system#type-argument-inference).
Rust await expressions are documented in the [Rust reference](https://doc.rust-lang.org/reference/expressions/await-expr.html).

These changes reclassify 15 existing cells and add Vue's four-hop cell. The
remaining original classifications are unchanged. The harness now records full
expected and actual node IDs, rejects extra wrong targets, and matches receiver
drops to call sites in the generated main file. A property-read drop or a drop in
a support file can no longer make a missing call look observable.

## Additional probes and tests

- **Ruby sibling parameters:** using `svc` for both the typed and untyped functions
  reproduces an incorrect User.save edge from the untyped function in both
  declaration orders. This independently confirms RUBY-01; the normal shape corpus
  uses distinct parameter names to avoid contaminating its measurements.
- **Classifier regression tests:** five assertions failed against the previous
  classifier. All seven tests pass after the change, including wrong-owner edges,
  mixed correct/incorrect targets, untyped controls and unrelated drop records.
- **Five language suites:** 225 unique tests passed across C coverage, COBOL scope,
  Vue scope, Zig and Objective-C provider tests; the runner also reported one skip.
  The Objective-C persisted query/context and incremental-versus-force test timed
  out at 180 seconds in the combined run, then passed in isolation. The retry's ten
  name-filtered skips are not additional coverage.
- **Build, production/test typechecks and focused lint:** passed. The benchmark
  source and its unit test parse and format cleanly. No full-suite or performance
  claim is made from these focused checks.

## Reproduce

Run from `gitnexus/` with the checkout's own freshly built workers and shared
package. This audit used Node 22.23.3 on Linux x64, TypeScript 7.0.2, Vitest 5.0.4
and LadybugDB 0.21.1. All measured optional grammars loaded.

```sh
npm run build
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
GITNEXUS_WORKER_POOL_SIZE=2 GITNEXUS_WORKER_READY_TIMEOUT_MS=60000 \
  node --import tsx bench/receiver-resolution/measure.mjs --check
npm test -- test/unit/receiver-resolution-measurement.test.ts --maxWorkers=1
GITNEXUS_WORKER_POOL_SIZE=2 GITNEXUS_WORKER_READY_TIMEOUT_MS=60000 \
  npx vitest run test/integration/resolvers/c-coverage.test.ts \
  test/integration/resolvers/cobol-scope.test.ts \
  test/integration/resolvers/vue-scope.test.ts \
  test/integration/resolvers/zig.test.ts \
  test/integration/objective-c-provider.test.ts --maxWorkers=2
```

A direct startup probe took about 20 seconds on this filesystem. The first run
hit the default five-second worker deadline before measuring any language; the
60-second setting above changes only that local deadline. An initial diagnostic
runner also inherited an invalid `--input-type` worker flag; rerunning from an
ordinary `.mjs` file removed that runner error. Neither failed attempt is counted
as language evidence. Each shape uses a fresh temporary directory, and the
worktree's parse caches were cleared before the original run.

The full JSON evidence command is the same harness with
`--shapes --corpus test/fixtures/lang-resolution`; it includes each expression,
expected target, actual targets, state and N/A reason. Compare its count projection
with the baseline before making any intentional update.

## Evidence identities

- Production source: `c35806d2447dda6642448948e53c7c1ac8c3482a` (no production changes in this audit).
- `measure.mjs` SHA-256: `73367935b50116a03d79342006569001a4265318ea351ca5793a4338f44d0785`.
- `baseline.json` SHA-256: `8416509491c9b684a2440bb46395295e2031fd60512c9806b3fd1b542948e71c`.

The benchmark preserves known gaps so future fixes cause an explicit baseline
change. This audit does not implement Dart ownership, indexed receiver typing,
C++ awaiter typing, Ruby scope isolation or the remaining historical backlog.
