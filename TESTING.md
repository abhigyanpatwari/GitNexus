# Testing — GitNexus

How we structure tests and which commands to run locally and in CI.

## Packages

| Package        | Path            | Runner     | Notes                      |
| -------------- | --------------- | ---------- | -------------------------- |
| CLI + MCP core | `gitnexus/`     | Vitest     | Primary test surface in CI |
| Web UI         | `gitnexus-web/` | Vitest     | Unit/component tests       |
| Web UI E2E     | `gitnexus-web/` | Playwright | Run when changing UI flows |

## Test lanes

### `gitnexus/` commands

From `gitnexus/`:

| Command                       | What it runs                                       | When to use                           |
| ----------------------------- | -------------------------------------------------- | ------------------------------------- |
| `npm test`                    | Full suite (all 3 vitest projects)                 | Before opening a PR                   |
| `npm run typecheck:tests`     | TypeScript checks for source, tests, and helpers   | Before opening a PR                   |
| `npm run test:unit`           | Unit tests only (`test/unit/`)                     | Tight development loop                |
| `npm run test:integration`    | Integration tests (`test/integration/`)            | After changing pipelines, DB, workers |
| `npm run test:coverage`       | Full suite + v8 coverage with thresholds           | Checking coverage impact              |
| `npm run test:parity`         | Scope-resolution parity for all migrated languages | After changing resolver or scope code |
| `npm run test:cross-platform` | Platform-sensitive subset only                     | Debugging a Windows/macOS issue       |
| `npm run test:watch`          | Vitest in watch mode                               | Active development                    |
| `npm run test:dupes`          | Duplicate-test scan of lines changed vs `main`     | Before adding tests or benchmarks     |

Vitest transpiles TypeScript without checking types. Run `npm run typecheck:tests`
in `gitnexus/` to check test code and helpers against the production types. This
uses `tsc --noEmit -p tsconfig.test.json`; parser input files under `test/fixtures/`
are excluded because they are sample source code, not part of the test program.

### `gitnexus-web/` commands

From `gitnexus-web/`:

| Command                 | What it runs                  | When to use                                                         |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `npm test`              | Unit/component tests (vitest) | After changing web code                                             |
| `npm run test:coverage` | Unit tests + coverage         | Checking coverage impact                                            |
| `npm run test:e2e`      | Playwright browser tests      | After changing UI flows (requires `gitnexus serve` + `npm run dev`) |

### Before opening a PR

```bash
# gitnexus-shared/dist must exist first. `npm install` / `npm run build` in
# gitnexus/ compiles it via parent `lib/tsc.js` (do not npm ci gitnexus-shared).
cd gitnexus && npx tsc --noEmit && npm run typecheck:tests && npm test
cd ../gitnexus-web && npx tsc -b --noEmit && npm test
```

## Pre-commit hook

A husky pre-commit hook (`.husky/pre-commit`) runs automatically on every `git commit`:

1. **Formatting** — `lint-staged` runs prettier on staged files
2. **`gitnexus-web/` files staged** → `tsc -b --noEmit`
3. **`gitnexus/` files staged** → `tsc --noEmit`

Tests do **not** run in the pre-commit hook — they run in CI (`ci-tests.yml`) only.

Skip with `git commit --no-verify` (use sparingly).

## Vitest projects

`gitnexus/vitest.config.ts` defines three projects for safety isolation:

| Project   | Files                                              | Parallelism | Purpose                                             |
| --------- | -------------------------------------------------- | ----------- | --------------------------------------------------- |
| `lbug-db` | Native LadybugDB integration tests (explicit list) | Sequential  | Prevents file-lock conflicts from native mmap addon |
| `cli-e2e` | `skills-e2e.test.ts`                               | Sequential  | CLI process spawning requires serial execution      |
| `default` | Everything else                                    | Parallel    | Fast execution for pure logic and parser tests      |

When adding a new test that uses native LadybugDB (`@ladybugdb/core`), add it to the `lbug-db` project's explicit include list and the `default` project's exclude list.

## Test categories

- **Unit** — Pure logic, parsers, graph/query helpers; fast; no network.
- **Integration** — Real combinations (filesystem, MCP wiring, larger pipelines) as already organized under `gitnexus/test/integration`.
- **Resolver / parity** — Language-specific call-resolution tests in `test/integration/resolvers/`.
- **E2E (web)** — Critical user paths only; prefer `data-testid` attributes for stable selectors. Tests run against real backend (`gitnexus serve`) and Vite dev server.

## Scope-resolution tests

Every language resolves calls and inheritance through the scope-resolution pipeline — the legacy call-resolution DAG and the per-language `REGISTRY_PRIMARY_<LANG>` flag were removed in RING4-1 (#942). Each language's resolver test lives at `test/integration/resolvers/<slug>.test.ts` and runs once, on the single scope-resolution path, as part of the normal `tests` job (`vitest test/**/*.test.ts`).

Adding a language: register its `ScopeResolver` in `scope-resolution/pipeline/registry.ts` (`SCOPE_RESOLVERS`) and add the resolver test file — no workflow or config edit needed.

## Cross-platform testing

Windows and macOS CI runs only the platform-sensitive test subset (~50 files out of 373). The full suite runs on Ubuntu.

The subset is defined in `gitnexus/scripts/cross-platform-tests.ts` and includes:

- **Platform-specific logic** — tests with `process.platform` guards, path.sep behavior, EPERM/EBUSY error classification
- **Native LadybugDB** — all `lbug-*` integration tests (N-API addon with known platform-varying behavior)
- **Process spawning / CLI** — tests using real `child_process.spawn`, shell quoting, CLI invocations
- **Worker threads** — tests spawning real `worker_threads`
- **Native addon loading** — tree-sitter grammar loading smoke tests
- **Filesystem behavior** — CRLF handling, directory walking, symlinks

When adding a platform-sensitive test, add it to the appropriate section in `scripts/cross-platform-tests.ts`.

### Automatic shard balancing

CI uses `vitest-shard-balancer` to distribute test files by measured duration.
Timing history lives in GitHub Actions storage; adding a test does not require
editing a weight table. Windows, macOS, and Ubuntu coverage each have their own
profile because native startup and coverage costs differ.

The `shard-plan` job restores history once and uploads `shard-timing-input`.
Every shard and report merge downloads that same snapshot. Retries reuse it,
so a newly published history cannot change the partition halfway through a run.
If the snapshot cannot be restored, the retry fails. If it was never uploaded,
deleted, or expired, trigger a fresh workflow run with a new commit; rerunning
the old run must not replace its timing input.
With no usable history, the sequencer spreads sequential/native work using
generic estimates; new files in an established profile use the package's median.

The merge reporter includes setup, collection, and test execution costs and
smooths new measurements with previous ones. It rejects missing, duplicate, or
unexpected modules and unsuccessful runs, and retains prior costs for skipped
modules. Native blobs are merged on their originating OS. Only main-branch push
runs that pass the execution audit publish the updated history to the Actions
cache. Cache expiry affects balance, not test discovery or completeness.

For a local reproduction, download the run's `shard-timing-input` artifact into
`gitnexus/.vitest/timings/` and set `GITNEXUS_SHARD_PROFILE` to `windows-latest`,
`macos-latest`, or `coverage` (the default). Then use the same `--shard=i/n`
argument with `npm run test:cross-platform -- --shard=i/n` or `npm test -- --shard=i/n`.
Keep `.vitest/` untracked. Bump the workflow's timing-cache schema key when a
runner/measurement change makes the stored profiles incompatible.

### Confirming no tests are orphaned

Every test file matches one of the three vitest projects. To verify:

```bash
cd gitnexus
npx vitest list 2>/dev/null | wc -l  # should match total test count
```

To check the cross-platform list is up to date, run `npm run test:cross-platform` — it fails fast if any listed file is missing.

## CI integration

GitHub Actions (`.github/workflows/ci.yml`) orchestrate:

| Workflow              | Jobs                                                              | Purpose                                                               |
| --------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ci-quality.yml`      | format, lint, typecheck, typecheck-web, workflow-convention       | Code quality gates                                                    |
| `ci-tests.yml`        | ubuntu/coverage, cross-platform (Win/Mac), packaged-install-smoke | Full suite + coverage on Ubuntu; platform-sensitive subset on Win/Mac |
| `ci-scope-parity.yml` | discover, parity                                                  | Scope-resolution parity for all migrated languages                    |
| `ci-e2e.yml`          | e2e (chromium)                                                    | Playwright E2E, gated on `gitnexus-web/**` changes                    |

The `CI Gate` job in `ci.yml` requires the quality and test workflows to pass.
The browser E2E workflow must pass or be skipped because no web files changed.

Branch protection also requires six platform check names from the former
three-shard matrix. These names remain as aggregate gates: all native shards
and the `every test executed` audit must succeed before any of them passes.
Failed, cancelled, skipped, or missing dependency results fail these gates.
The actual native tests run in the current Windows/macOS shard matrix.

The `typecheck` job runs both the production compiler check and
`npm run typecheck:tests`. A type error in either check fails the job and the CI gate.

### Complete execution, including platform and benchmark tests

The required `every test executed` job reconciles execution receipts from Ubuntu
coverage, every Windows/macOS shard, the serial benchmark run, and the real Python
workflow preflight. It requires a recorded pass for every collected test. A skip
on Linux is satisfied only by a pass of that exact test in another required job.
Test identities include the file, suite/title and source location; ambiguous
parameterized cases must have unique titles. Missing receipts, missing test files,
unhandled runner errors, failed hooks, failed assertions, and tests with no pass
all fail the gate. Web tests are checked separately with the same rules.

The locked pytest suite and Linux/Windows containment jobs also upload JUnit
receipts. The same gate checks every Python test file was collected and every
case passed in at least one job, while preserving failures from any job. The
Linux containment job supplies Bubblewrap, the pinned CLI, and built Vitest
dependencies for tests that cannot run in the basic Python job. Python results
are included in the combined PR report.

The PR report shows the reconciled result as **Unverified**. Zero means every test
has execution evidence; individual OS logs still show tests that require another
OS as skipped. Failed executions remain failures even if another job passes.

### Duplicate-test scan (advisory)

The `Duplicate test scan` job in `ci.yml` runs `npm run test:dupes` on the lines a PR
changes, and the PR report lists what it finds under **Possible duplicate tests**. It
never fails a build. It reports:

| Kind                 | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `same-test`          | Same body and same setup as an existing test                                |
| `assertions-pinned`  | Every assertion is a literal `fn(...)` → matcher another test already makes |
| `same-fixture-setup` | A `before*` hook builds a fixture another describe already builds           |
| `copied-helper`      | A top-level helper identical to one in another file or `test/helpers`       |
| `orphan-bench-gate`  | A bench script with `--check` that no workflow or npm script runs           |

"Same setup" includes enclosing hooks, describe-level statements, wrapper arguments,
loop heads, `each` tables, referenced file-local declarations and resolved imports, so
identical bodies that run against different fixtures are not reported. Mark an
intentional repeat with `// dupe-ok: <reason>` on the reported line or the line above.
Locally, `npm run test:dupes` compares against `origin/main`; pass `--base <ref>` to
change that, or `--all` to scan every test. Python tests are not scanned.

`npm run test:benchmarks` discovers all tests gated by `GITNEXUS_BENCH` and runs
them serially. Keep timing measurements out of parallel coverage workers. The
`eval-tests` job installs the locked Python dependencies and runs the workflow
preflight Vitest tests as well as pytest; those tests must exercise real Python
validation, never a stubbed success.

## Mutation testing tooling

`gitnexus/tools/mutation/` holds a Stryker test runner for Vitest 5 (`vitest5`) and the tools
that validate it. The runner supports Vitest `5.0.x` only and refuses any other version. Its
validated scope is the pure-JS category: 251 unit test files (4,667 tests) that load no native
code, workers or child processes and read no fixtures. The gates stay out of the main suite
(only the tools' unit tests in `test/unit/mutation/` run there), and nothing ships in the npm
package.

Every run works in a prepared copy outside the checkout (`--out`/`--work` must lie outside it).
The copy blanks each `as` type assertion in the mutated files with spaces of equal length,
because Stryker never mutates code under one, and relocates `gitnexus-shared/src` into the
package. From `gitnexus/` (each tool documents its options in its file header):

| Command                                | What it does                                                          |
| -------------------------------------- | --------------------------------------------------------------------- |
| `npm run test:mutation:run`            | One Stryker run over a scope file with the `vitest5` runner           |
| `npm run test:mutation:classify`       | Lists the pure-JS unit test files                                     |
| `npm run test:mutation:fidelity`       | Gate 1: the unmutated run matches plain Vitest; records the envelope  |
| `npm run test:mutation:conformance`    | Gate 2: pinned outcomes of the conformance fixture project            |
| `npm run test:mutation:oracle`         | Gate 3: compares runner runs with the frozen oracle manifests         |
| `npm run test:mutation:oracle:freeze`  | Freezes (or re-freezes) one oracle manifest                           |
| `npm run test:mutation:oracle:command` | The oracle's own Stryker run, with Stryker's `command` runner         |
| `npm run test:mutation:controls`       | Gate 4: planted positive controls and determinism across two profiles |
| `npm run test:mutation:bench`          | Oracle cost benchmark                                                 |
| `npm run test:mutation:prepare`        | Builds a prepared copy on its own                                     |

Frozen artifacts live in `gitnexus/test/fixtures/`: `mutation-conformance/` (the gate 2
fixture project and `expected.json`), `mutation-oracle/` (the gate 1 envelope and one gate 3
manifest per oracle scope: `shared`, `schema-constants`, `middleware`) and
`mutation-controls/planted.json` (gate 4).

Re-freeze a manifest when gate 3 reports "re-freeze required", that is after a change to a
scope's tests or their imports, the Vitest configs, the prepare tool, or the Stryker, Vitest or
Node major version. Use the `refreeze` command recorded in the manifest, with a new seed.
Re-select the controls when gate 4 reports "re-select required". After a Vitest, Stryker or Node
upgrade, re-run all four gates. Refresh `expected.json` from the conformance `observed.json`
only for an intended change.

`.github/workflows/mutation-runner-validation.yml` runs gate 2 on PRs that touch the tooling,
its fixtures, `gitnexus/package.json`, the lockfile or `gitnexus/vitest.config.ts`. A manual
dispatch also runs gates 1, 3 and 4 and the benchmark, or re-freezes oracle manifests sharded
by scope and uploads them for a maintainer to commit. The workflow is advisory.

### Test Scenario Map

`gitnexus/tools/scenario-map/` builds a report on the eligible pure-JS tests: tests that repeat
a scenario, tests that kill no evaluated mutant, and per-file gaps. It runs Layers 0–3 of the
design (`docs/plans/2026-10-23-test-scenario-map-design.md`) on the `vitest5` runner. It only
reports. It never edits, deletes or folds a test.

From `gitnexus/`, run `npm run test:scenario-map -- <stage> --work <dir>`. The work directory
must lie outside the checkout. Every stage reads and writes JSON there, so a local `all` run and
CI produce the same report. `value-flow`, `all` and `controls` need a built `dist/`
(`npm run build`). The CLI header (`tools/scenario-map/scenario-map.ts`) documents every flag
and file.

| Stage        | What it does                                                         | Writes (under `--work`)                                                                    |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `plan`       | Eligibility, Layers 0–2, the run manifest, candidates, shard plan    | `plan.json`, `scenario-run-manifest.json`, `layer0.json`, `layer2.json`, `coverage/`       |
| `value-flow` | PDG index, static value-flow check, trace run, final shard plan      | `value-flow.json`                                                                          |
| `shards`     | Prints the final shard count (the CI matrix size)                    | Nothing                                                                                    |
| `shard`      | `--index <i> --of <n>`: Layer 3 runs, row deletion, isolation pass   | `observations/`, `batches/`, `isolation/`, `row-deletion-shard-<i>.json`, `shard-<i>.json` |
| `merge`      | Merges every result, computes verdicts, compares with `--baseline`   | `scenario-map-report.json`, `scenario-map-report.md`, `issue-body.md`                      |
| `all`        | `plan` (one shard), `value-flow`, `shard` 0 of 1 and `merge`         | All of the above                                                                           |
| `controls`   | `all` over the controls fixture, then compares every expected result | All of the above                                                                           |

Exit code 0 means complete results. Exit code 1 means the stage finished with incomplete results,
or a controls verdict differs. Exit code 2 is a usage or setup error.

The controls fixture is `gitnexus/test/fixtures/mutation-scenario-map/`: one pair per
`*.case.ts` file (16 pairs). It holds the pure-JS adversarial pairs of design §8, an
order-dependent pair, an object-key row and positive controls. `expected.json` was written from
the design before any pipeline run. Never regenerate it from observed output: a mismatch is a
finding. The fixture has its own Vitest config and tsconfig, and no repo project collects it.
The `scenario-map-controls` job in `.github/workflows/mutation-runner-validation.yml` runs
`controls` on the same PRs as gate 2.

**Supported matchers** (`SUPPORTED_MATCHERS` in `tools/scenario-map/facet/checks.ts`), after
`expect(…)` or `expect.soft(…)` and an optional `.not`, `.resolves` or `.rejects`:
`toBe`, `toEqual`, `toStrictEqual`, `toMatchObject`, `toBeTruthy`, `toBeFalsy`, `toBeNull`,
`toBeUndefined`, `toBeDefined`, `toBeNaN`, `toBeNullable`, `toBeTypeOf`, `toBeInstanceOf`,
`toBeGreaterThan`, `toBeGreaterThanOrEqual`, `toBeLessThan`, `toBeLessThanOrEqual`,
`toBeCloseTo`, `toBeOneOf`, `toContain`, `toContainEqual`, `toHaveLength`, `toHaveProperty`,
`toMatch`, `toThrow`, `toThrowError`, `toHaveBeenCalled`, `toHaveBeenCalledOnce`,
`toHaveBeenCalledTimes`, `toHaveBeenCalledWith`, `toHaveBeenCalledExactlyOnceWith`,
`toHaveBeenLastCalledWith`, `toHaveBeenNthCalledWith`, `toHaveBeenCalledBefore`,
`toHaveBeenCalledAfter`, `toBeCalled`, `toBeCalledTimes`, `toBeCalledWith`, `toHaveReturned`,
`toHaveReturnedTimes`, `toHaveReturnedWith`, `toHaveLastReturnedWith`, `toHaveNthReturnedWith`,
`toReturn`, `toReturnTimes`, `toReturnWith`, `toHaveResolved`, `toHaveResolvedTimes`,
`toHaveResolvedWith`, `toHaveLastResolvedWith`, `toHaveNthResolvedWith`, and the snapshot
matchers `toMatchSnapshot`, `toMatchInlineSnapshot`, `toMatchFileSnapshot`,
`toThrowErrorMatchingSnapshot`, `toThrowErrorMatchingInlineSnapshot`. `expect.assertions(n)` and
`expect.hasAssertions()` count as checks. Any other form is unsupported and blocks strong
evidence: `assert.*`, chai-style chains, custom matchers, `toSatisfy`, and an `expect` inside a
loop, a conditional, a catch clause, a nested function or a helper.

**Wrapped built-ins** of the trace run (`BASE_WRAP_LIST` in
`tools/scenario-map/value-flow/builtins.ts`), by group:

- `math`: every `Math` function except `random`.
- `string`: `String.prototype` `toUpperCase`, `toLowerCase`, `toLocaleUpperCase`,
  `toLocaleLowerCase`, `normalize`, `localeCompare`, `trim`, `trimStart`, `trimEnd`, `padStart`,
  `padEnd`, `slice`, `substring`, `substr`, `replace`, `replaceAll`, `split`, `at`, `charAt`,
  `charCodeAt`, `codePointAt`, `startsWith`, `endsWith`, `includes`, `indexOf`, `lastIndexOf`,
  `repeat`.
- `regexp`: `RegExp.prototype.test` and `exec`; `String.prototype.match`, `matchAll` and
  `search`.
- `number`: `parseInt`, `parseFloat`, the `Number` constructor, and `Number.prototype.toFixed`,
  `toPrecision`, `toExponential`, `toString`, `toLocaleString`.
- `json`: `JSON.parse`, `JSON.stringify`.
- `intl`: the `Intl` constructors `Collator`, `DateTimeFormat`, `NumberFormat`, `PluralRules`,
  `RelativeTimeFormat`, `ListFormat`, `Segmenter`, `DisplayNames`; `Collator.prototype.compare`,
  `DateTimeFormat.prototype.format` and `NumberFormat.prototype.format`; and the methods
  `formatToParts`, `formatRange`, `formatRangeToParts`, `select`, `selectRange`, `segment` and
  `of`.
- `date`: the `Date` constructor, `Date.UTC`, `Date.parse`, every `Date.prototype` getter and
  setter, and its formatters.
- `sort`: `Array.prototype.sort` and `toSorted`, recorded with the receiver and the comparator.

The trace also wraps the opaque callees that the static value-flow check finds. Storage and
table reads stay unwrapped: array `push` and `unshift`, and every method of `Map`, `Set`,
`WeakMap` and `WeakSet`.

`.github/workflows/test-scenario-map.yml` runs the pipeline every Monday and on manual dispatch
(inputs `seed` and `shards`). Its jobs are `plan`, `value-flow`, `shards`, a `shard` matrix,
`merge` and `upsert-issue`. Every job is advisory (`continue-on-error`). Only a complete run from
the default branch uploads the `scenario-map-baseline` artifact and replaces the body of the
tracking issue (label `test-scenario-map`), unless the issue already records a newer run. A
partial run adds a comment and leaves the body alone. The workflow never closes the issue.

Mark a human keep with `// dupe-ok: <reason>` on either test of a pair, on the test call's line
or the line above. The report then lists the pair as kept, with its evidence.

## Regression testing

Re-run the full relevant suite when:

- Prompt or agent-behavior documentation changes (if tests encode behavior)
- Model or embedding-related code paths change
- Graph schema, query contracts, or MCP tool shapes change
- Dependencies with parsing or runtime impact upgrade

## User acceptance / beta (optional)

For staged releases or UI betas: deploy to a staging environment, collect structured feedback, watch errors and latency, then iterate before a wider release.
