# Testing — GitNexus

How we structure tests and which commands to run locally and in CI.

## Packages

| Package        | Path           | Runner   | Notes                          |
| -------------- | -------------- | -------- | ------------------------------ |
| CLI + MCP core | `gitnexus/`    | Vitest   | Primary test surface in CI     |
| Web UI         | `gitnexus-web/`| Vitest   | Unit/component tests           |
| Web UI E2E     | `gitnexus-web/`| Playwright | Run when changing UI flows   |

## Test lanes

### `gitnexus/` commands

From `gitnexus/`:

| Command                  | What it runs                                         | When to use                     |
| ------------------------ | ---------------------------------------------------- | ------------------------------- |
| `npm test`               | Full suite (all 3 vitest projects)                   | Before opening a PR             |
| `npm run test:unit`      | Unit tests only (`test/unit/`)                       | Tight development loop          |
| `npm run test:integration` | Integration tests (`test/integration/`)            | After changing pipelines, DB, workers |
| `npm run test:coverage`  | Full suite + v8 coverage with thresholds             | Checking coverage impact        |
| `npm run test:parity`    | Scope-resolution parity for all migrated languages   | After changing resolver or scope code |
| `npm run test:cross-platform` | Platform-sensitive subset only                  | Debugging a Windows/macOS issue |
| `npm run test:watch`     | Vitest in watch mode                                 | Active development              |

### `gitnexus-web/` commands

From `gitnexus-web/`:

| Command               | What it runs                      | When to use                    |
| ---------------------- | --------------------------------- | ------------------------------ |
| `npm test`             | Unit/component tests (vitest)     | After changing web code        |
| `npm run test:coverage`| Unit tests + coverage             | Checking coverage impact       |
| `npm run test:e2e`     | Playwright browser tests          | After changing UI flows (requires `gitnexus serve` + `npm run dev`) |

### Before opening a PR

```bash
cd gitnexus && npx tsc --noEmit && npm test
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

| Project    | Files                         | Parallelism | Purpose                                       |
| ---------- | ----------------------------- | ----------- | ---------------------------------------------- |
| `lbug-db`  | Native LadybugDB integration tests (explicit list) | Sequential  | Prevents file-lock conflicts from native mmap addon |
| `cli-e2e`  | `skills-e2e.test.ts`          | Sequential  | CLI process spawning requires serial execution |
| `default`  | Everything else               | Parallel    | Fast execution for pure logic and parser tests |

When adding a new test that uses native LadybugDB (`@ladybugdb/core`), add it to the `lbug-db` project's explicit include list and the `default` project's exclude list.

## Test categories

- **Unit** — Pure logic, parsers, graph/query helpers; fast; no network.
- **Integration** — Real combinations (filesystem, MCP wiring, larger pipelines) as already organized under `gitnexus/test/integration`.
- **Resolver / parity** — Language-specific call-resolution tests in `test/integration/resolvers/`.
- **E2E (web)** — Critical user paths only; prefer `data-testid` attributes for stable selectors. Tests run against real backend (`gitnexus serve`) and Vite dev server.

## Scope-resolution parity

Migrated languages (listed in `MIGRATED_LANGUAGES` in `src/core/ingestion/registry-primary-flag.ts`) are tested in both legacy and registry-primary modes on every PR.

For each migrated language, CI runs the resolver test file twice:
1. `REGISTRY_PRIMARY_<LANG>=0` — legacy DAG path
2. `REGISTRY_PRIMARY_<LANG>=1` — registry-primary path

Both must pass. Known legacy gaps are listed in `LEGACY_RESOLVER_PARITY_EXPECTED_FAILURES` in `test/integration/resolvers/helpers.ts` and are automatically skipped in legacy mode.

Adding a language to `MIGRATED_LANGUAGES` automatically enrolls it in parity — no workflow or config edit needed. The test file must exist at `test/integration/resolvers/<slug>.test.ts`.

Run parity locally: `cd gitnexus && npm run test:parity`

Run for a single language: `cd gitnexus && npx tsx scripts/run-parity.ts --language python`

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

### Confirming no tests are orphaned

Every test file matches one of the three vitest projects. To verify:

```bash
cd gitnexus
npx vitest list 2>/dev/null | wc -l  # should match total test count
```

To check the cross-platform list is up to date, run `npm run test:cross-platform` — it fails fast if any listed file is missing.

## CI integration

GitHub Actions (`.github/workflows/ci.yml`) orchestrate:

| Workflow              | Jobs                           | Purpose                                         |
| --------------------- | ------------------------------ | ------------------------------------------------ |
| `ci-quality.yml`      | format, lint, typecheck, typecheck-web, workflow-convention | Code quality gates |
| `ci-tests.yml`        | ubuntu/coverage, cross-platform (Win/Mac), packaged-install-smoke | Full suite + coverage on Ubuntu; platform-sensitive subset on Win/Mac |
| `ci-scope-parity.yml` | discover, parity               | Scope-resolution parity for all migrated languages |
| `ci-e2e.yml`          | e2e (chromium)                 | Playwright E2E, gated on `gitnexus-web/**` changes |

The `CI Gate` job in `ci.yml` is the single required check for branch protection. It requires quality, tests, e2e, and scope-parity to all pass.

## Regression testing

Re-run the full relevant suite when:

- Prompt or agent-behavior documentation changes (if tests encode behavior)
- Model or embedding-related code paths change
- Graph schema, query contracts, or MCP tool shapes change
- Dependencies with parsing or runtime impact upgrade

## User acceptance / beta (optional)

For staged releases or UI betas: deploy to a staging environment, collect structured feedback, watch errors and latency, then iterate before a wider release.
