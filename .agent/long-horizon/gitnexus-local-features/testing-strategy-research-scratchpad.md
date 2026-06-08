# Testing Strategy Research Scratchpad

Created: 2026-06-08

## Research Block

- Start: 2026-06-08T13:31:59+01:00
- End: 2026-06-08T13:42:54+01:00
- Elapsed: about 11 minutes
- Target duration: 10-20 minutes
- Purpose: research what kinds of tests GitNexus can use for the current local-features workstream, then translate the findings into a practical testing ladder.
- Scope: software testing methodology, TypeScript/Node test layers, CLI/MCP/API/runtime verification, generated artifact testing, and Codex non-interactive review as a supplementary quality gate.
- Out of scope: implementing new tests during this research pass, changing runtime behavior, or selecting a new feature packet.

## Initial Questions

1. What test layers are recommended by current/authoritative software testing methodology?
2. Which test types map cleanly onto GitNexus surfaces: pure core logic, CLI, MCP tools, server API, generated Playwright specs, Podman runtime, and docs/control artifacts?
3. What should be cheap and mandatory before checkpointing?
4. What should be optional/high-confidence before release or promoted runtime use?
5. Where can Codex non-interactive review fit without pretending it replaces executable tests?

## Running Notes

- 2026-06-08T13:31:59+01:00 - Started time-boxed research block.
- 2026-06-08T13:37:13+01:00 - Local inventory confirms GitNexus already has Vitest unit/integration scripts, coverage, parity, cross-platform checks, fixtures, golden tests, CLI/MCP dispatch tests, and generated API-smoke artifacts.
- 2026-06-08T13:40:29+01:00 - Local `vitest.config.ts` confirms three Vitest projects: `lbug-db` sequential native DB tests, default tests, and `cli-e2e` for skills e2e; coverage uses V8 and includes `src/**/*.ts` with explicit exclusions for CLI entry, server, and wiki LLM code.

## Sources Checked

| Source | Type | Relevant finding | GitNexus implication |
| --- | --- | --- | --- |
| Martin Fowler / Thoughtworks, Practical Test Pyramid: https://martinfowler.com/articles/practical-test-pyramid.html | Methodology | Use tests at different granularities; keep many fast low-level tests, fewer coarse tests, and very few full end-to-end tests. | Treat the pyramid as a cost/confidence guide, not a rigid percentage rule. For GitNexus, parser/core/report/formatter tests should be numerous; Podman/runtime/browser checks should be sparse and deliberate. |
| Google Testing Blog, Just Say No to More End-to-End Tests: https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html | Methodology / field guidance | Google suggests 70/20/10 as a first guess, but says the exact mix depends on the product. | Use "mostly small, some medium, few large" as the default, but tune for GitNexus's graph/index/runtime surfaces. |
| Google Testing Blog, Test Sizes: https://testing.googleblog.com/2010/12/test-sizes.html | Methodology / taxonomy | Small/Medium/Large can be defined by capabilities used: no network for small, localhost only for medium, external systems for large; isolation and parallelism matter. | Better local vocabulary than only unit/integration/e2e: small = pure/isolated, medium = temp filesystem/local DB/local server, large = Podman/GitHub/browser/external runtime. |
| Vitest snapshot docs: https://v4.vitest.dev/guide/learn/snapshots | Tool docs | Snapshot/golden-style tests compare generated output against stored expected output and fail on drift. | Good fit for deterministic reports: PR Impact Markdown/JSON, regression-forensics reports, generated Playwright specs, wiki dry-run output, and graph golden snapshots. |
| Vitest coverage docs: https://vitest.dev/guide/coverage.html | Tool docs | Vitest supports V8 and Istanbul coverage; V8 is the default and supports runtime collection without pre-instrumentation. | Existing `npm run test:coverage` is a useful periodic confidence gate, but not a replacement for targeted behavior tests. |
| Vitest mocking docs: https://vitest.dev/guide/mocking.html | Tool docs | Vitest provides mocks for internal/external services and warns to clear/restore mocks between tests. | Useful for provider boundaries, filesystem/time/process isolation, and CLI/MCP dispatch tests; avoid mock-heavy tests for graph behavior where fixture integration is more meaningful. |
| Playwright best practices: https://playwright.dev/docs/best-practices | Tool docs | Test user-visible behavior and avoid implementation details; isolate tests and avoid third-party dependencies. | Future UI or generated browser tests should verify observable routes/output, not internal implementation. |
| Playwright mock APIs: https://playwright.dev/docs/mock | Tool docs | Playwright can intercept and mock HTTP/API calls and replay HARs. | Good for generated E2E tests that need deterministic app state without external services. |
| Playwright API testing: https://playwright.dev/docs/api-testing | Tool docs | APIRequestContext can set up preconditions and verify postconditions through HTTP. | Useful if GitNexus web/server API smoke grows beyond current generated route specs. |
| Pact docs: https://docs.pact.io/ | Tool docs / contract testing | Contract tests verify that inter-application messages conform to a shared contract without deploying the world. | Useful later for MCP/server/API compatibility if GitNexus adds stable public surfaces or cross-service integration; probably not needed for the immediate local feature tranche. |
| fast-check docs: https://fast-check.dev/docs/introduction/ | Tool docs / property testing | Generates many inputs and shrinks failures to minimal repros. | Strong candidate for parsers, diff-hunk/range mapping, path normalization, command option parsing, and report verdict invariants. No dependency should be added unless a selected task justifies it. |
| Stryker mutation testing docs: https://stryker-mutator.io/docs/ | Tool docs / mutation testing | Mutation testing changes source and checks whether tests fail; surviving mutants indicate weak tests. | Useful as a later audit for critical pure logic like verdict rules and diff mapping, but likely too slow/noisy for every feature iteration. |
| Testing Library guiding principles: https://testing-library.com/docs/guiding-principles/ | Methodology / UI testing | Tests gain confidence when they resemble how software is used. | Applies to any future UI/web tests: prefer user-observable behavior over component internals. |
| OpenAI Codex non-interactive docs: https://developers.openai.com/codex/noninteractive | Codex workflow docs | `codex exec` is intended for scripts/CI, pipelines, machine-readable output, and explicit sandbox/approval settings. | Non-interactive Codex review is a supplementary review/eval gate, not a substitute for executable tests. |
| OpenAI Codex workflows docs: https://developers.openai.com/codex/workflows | Codex workflow docs | Local `/review` is recommended as a second set of eyes; fixes should be applied and review rerun. | Keep using structured review after executable tests, especially before checkpoint/commit. |
| OpenAI Codex security diff use case: https://developers.openai.com/codex/use-cases/scan-code-changes-for-security | Codex workflow docs | Security diff scans should stay read-only and produce evidence-based Markdown reports. | For sensitive GitNexus changes, use read-only Codex/security-style review as an added gate, with findings documented. |

## Local Repo Inventory

Commands run:

```powershell
Get-Content gitnexus\package.json
rg -n "test:unit|test:integration|test:coverage|test:parity|test:cross-platform|build" gitnexus\package.json
Get-ChildItem gitnexus\test -Directory
Get-ChildItem gitnexus\test -Recurse -Filter "*.test.ts" | Group-Object { $_.FullName.Split([IO.Path]::DirectorySeparatorChar)[-2] }
rg -n "UPDATE_GOLDEN|golden|toMatchSnapshot|expected" gitnexus\test\integration\pipeline-graph-golden.test.ts gitnexus\test\unit\pr-impact-report.test.ts gitnexus\test\unit\e2e-test-generation-api-smoke-renderer.test.ts
Get-Content gitnexus\vitest.config.ts
```

Observed current test/verification surfaces:

| Surface | Current support |
| --- | --- |
| Build/type/transpile | `npm run build` via `node scripts/build.js`. |
| Unit tests | `npm run test:unit`, many `gitnexus/test/unit/*.test.ts` files. |
| Integration tests | `npm run test:integration`, 75 direct integration files plus nested language/resolver suites. |
| Full Vitest suite | `npm test` -> `vitest run`, with project partitioning in `vitest.config.ts`. |
| Coverage | `npm run test:coverage`, V8 provider, existing low ratchet thresholds. |
| Parity/cross-platform | `npm run test:parity`, `npm run test:cross-platform`. |
| Native DB/LadybugDB tests | Dedicated `lbug-db` Vitest project with sequential file execution. |
| CLI/e2e-ish tests | `cli-e2e`, help tests, command tests, direct CLI tool tests, skills e2e. |
| MCP contract/dispatch tests | `calltool-dispatch`, `tool-direct-cli`, local backend integration tests. |
| Parser/graph/language tests | Capture tests, resolver tests, pipeline tests, grammar validation, import/scope tests. |
| Golden/snapshot-style tests | Pipeline graph golden, language capture goldens, PR Impact report golden, generated API-smoke golden specs. |
| Generated artifact tests | E2E API smoke renderer tests compare generated Playwright spec text to committed fixture output. |
| Runtime/Podman smoke | Not a normal Vitest layer; should remain explicit operator/runtime verification when route behavior changes. |
| Non-interactive Codex review | Already usable locally after Codanna auth/server recovery; produces structured review evidence. |

## Test Type Taxonomy For GitNexus

Use the following vocabulary for this workstream.

| Type | What it proves | Best for | Cost | Example command/surface |
| --- | --- | --- | --- | --- |
| Static/build hygiene | Code compiles and packaging/transpile pipeline is not broken. | Any source edit. | Low/medium. | `npm run build`; `git diff --check` for whitespace/docs. |
| Small pure unit tests | A function/module behaves correctly without filesystem, DB, network, Podman, or external process dependence. | Diff parsing, symbol/range mapping, report verdicts, option normalization, renderers, formatters. | Low. | `npm test -- --run test/unit/<file>.test.ts`. |
| Sociable unit tests | A small local collaboration works with real adjacent helpers but still avoids heavyweight runtime. | CLI formatters plus i18n, report builders plus fixtures, parser helpers plus AST fixtures. | Low/medium. | Focused Vitest unit files. |
| Medium fixture integration tests | A feature works against temp repos, fixtures, local filesystem, local DB/index, or local server only. | Analyzer/index behavior, graph snapshots, route/API shape, language parsing, local backend. | Medium. | `npm run test:integration` or a focused integration file. |
| CLI command tests | User-facing CLI flags, help, stdout/stderr, exit behavior, route names, and dry-run/status behavior. | `wiki refresh`, `detect-changes`, `pr-impact`, `analyze`, route guidance. | Low/medium. | CLI unit tests or `dist/cli/index.js` subprocess tests after build. |
| MCP contract/dispatch tests | Tool schema, call routing, JSON shape, and CLI/MCP parity. | Any MCP tool or local backend behavior. | Low/medium. | `calltool-dispatch`, `tool-direct-cli`, local backend tests. |
| Deterministic report/golden tests | Text/JSON/generated output does not drift silently. | PR Impact reports, regression-forensics reports, wiki dry-run summaries, generated E2E specs, graph snapshots. | Low/medium. | Compare exact Markdown/JSON/spec text to fixtures. |
| Property/fuzz tests | Invariants hold across many generated inputs and shrunk edge cases. | Diff hunks, path normalization, option parsing, range merging, verdict monotonicity. | Medium; new dependency if using fast-check. | Future `fast-check` tests if approved. |
| Mutation tests | Tests are strong enough to fail when source logic is intentionally perturbed. | Critical pure logic after it stabilizes. | High. | Future Stryker experiment; not a default gate. |
| Browser/UI tests | Observable web UI behavior works from the user's perspective. | Future GitNexus web UI flows. | Medium/high. | Playwright, with mocked local APIs when possible. |
| API smoke tests | HTTP routes respond with expected shape/status, often using local request context. | `/api/info`, server readiness, generated API smoke specs. | Medium. | Playwright APIRequestContext or local HTTP tests. |
| Runtime/Podman smoke tests | Container route, mounted repo path, internal llama.cpp/embedding sidecar, and runtime index behavior are healthy. | Podman-first route changes, embeddings, server route changes. | High/manual. | `gitnexus-podman list`, `gitnexus-podman analyze /workspace/<repo> --embeddings`, container health checks. |
| Cross-platform/parity tests | Windows/Linux/path/process behavior remains aligned. | Path handling, shell/process spawning, file locks, generated commands. | Medium/high. | `npm run test:cross-platform`, `npm run test:parity`. |
| Non-interactive Codex review/eval | A separate agent reviews risks, missed cases, and regression gaps over a diff. | Checkpoint review, security-sensitive changes, large tranches. | Medium and token-costly. | `codex exec --sandbox read-only` with structured review prompt/output artifact. |
| Manual exploratory review | Human/agent inspection for product fit, confusing behavior, missing docs, and UX of reports. | Reports, generated docs/wiki, CLI help, local workflow docs. | Variable. | Markdown review note plus source references. |

## Recommended Test Ladders

### 1. Small source slice

Use for focused local code changes in one feature.

1. Red test first for the intended behavior.
2. Focused unit/sociable unit test for the edited module.
3. Any direct CLI/MCP/golden test if the behavior is exposed there.
4. `npm run build`.
5. `git diff --check`.

### 2. CLI or MCP surface change

Use when flags, tool schemas, stdout/stderr, JSON shape, or command names change.

1. Focused tests for parser/core behavior.
2. CLI help/output tests.
3. MCP dispatch/schema tests.
4. Golden Markdown/JSON tests if output is deterministic.
5. `npm run build`.
6. `git diff --check`.

### 3. Graph/index/parser/language change

Use when analysis output, tree-sitter queries, symbol extraction, import resolution, or graph edges change.

1. Small parser/query tests for the new syntax edge.
2. Fixture integration test over a temp/minimal repo.
3. Golden/capture test where feasible.
4. Nearby resolver/language integration tests.
5. `npm run build`.
6. Consider `npm run test:integration` if the edited path is shared.

### 4. Report/generator change

Use for PR Impact, regression-forensics, E2E generation, wiki dry-run, and deterministic docs artifacts.

1. Pure report builder tests.
2. Golden Markdown/JSON/spec comparison.
3. CLI/MCP smoke if the report is exposed publicly.
4. Manual rendered/readability review of generated Markdown.
5. `npm run build`.
6. `git diff --check`.

### 5. Server/API route change

Use for `/api/info` or future server routes.

1. Unit tests for route data assembly.
2. Local server/API smoke test against localhost or direct Express handler where available.
3. Generated API-smoke spec/golden test if output generation is involved.
4. `npm run build`.
5. Runtime smoke only if server wiring changed.

### 6. Runtime/Podman/embedding route change

Use only when workstation/runtime route behavior changes.

1. Confirm route intent in docs first: `gitnexus` host/npm vs `gitnexus-podman` container.
2. Build or targeted source tests if source changed.
3. Podman health/port/env checks.
4. `gitnexus-podman list`.
5. `gitnexus-podman status /workspace/<repo>`.
6. Small `gitnexus-podman analyze /workspace/<repo>` smoke; use `--embeddings` only when embedding behavior is in scope.
7. Document command output in the long-horizon status ledger.

### 7. Pre-checkpoint or pre-commit tranche

Use after multiple slices have accumulated.

1. Focused suites for every touched feature slice.
2. `npm run build`.
3. `git diff --check`.
4. Review dirty tree by slice with `git status --short --branch`, `git diff --name-status`, `git diff --stat`.
5. Non-interactive Codex review with read-only sandbox and saved Markdown/JSON output.
6. Fix findings with TDD if any.
7. Rerun focused verification plus build/diff check.
8. Update `documentation.md`.

### 8. Release-level or high-confidence sweep

Use before promoting a larger branch or after risky shared-module edits.

1. `npm test`.
2. `npm run test:integration`.
3. `npm run test:coverage`.
4. `npm run test:parity`.
5. `npm run test:cross-platform`.
6. Runtime/Podman smoke if runtime route was touched.
7. Manual review of generated docs/reports.

## Feature-Specific Testing Guidance

| Feature area | Minimum useful tests | Higher-confidence tests |
| --- | --- | --- |
| Auto-reindexing | Status/dry-run unit tests, stale-state detection tests, CLI/MCP output tests. | Temp-repo integration, Podman route smoke, watch/worker tests only if a watcher is actually implemented. |
| Auto-updating Code Wiki | Readiness/provider-boundary tests, dry-run report tests, generated output golden tests. | Manual rendered Markdown review, rollback/write-policy tests, provider execution tests only after explicit red-lane decision. |
| PR Impact / blast radius | Diff hunk parser tests, range-to-symbol tests, deletion/unmatched range tests, verdict tests, Markdown/JSON golden tests. | MCP/CLI parity, temp-repo diff integration, non-interactive Codex review over fixture reports. |
| Auto regression forensics | Evidence model unit tests, report builder golden tests, fixture incident inputs. | Eval harness integration, CI artifact parsing fixtures, mutation/property tests for ranking/verdict invariants. |
| E2E test generation | Route/API evidence to generated spec tests, exact golden generated files, no-secret/no-external URL policy tests. | Playwright API tests against a local server fixture, manual review of generated spec ergonomics. |
| Multi-repo improvements | Registry/group graph tests, cross-repo query fixture tests, conflict/name/path tests. | Multi-temp-repo integration, MCP resource contract tests, parity/cross-platform. |
| OCaml support | Tree-sitter query validation, parser loading tests, minimal symbol/import/type/call capture fixtures. | Golden capture tests, graph pipeline integration, resolver/import semantics tests. |

## Current Recommendation

Adopt a "small/medium/large plus evidence gate" model:

- Small tests are mandatory for almost every source change.
- Medium fixture integration tests are mandatory when behavior crosses parser, graph, CLI, MCP, filesystem, local DB, or generated-output boundaries.
- Large runtime/Podman/browser/GitHub tests are not default; run them when the selected task touches those boundaries.
- Golden tests should be first-class for deterministic reports and generated files.
- Non-interactive Codex review is a review/eval layer after executable verification, not a substitute for tests.
- Coverage is useful as a periodic health signal, but weak on its own; mutation/property testing should be considered later for critical pure logic, not forced into the current tranche.

## Open Questions

1. Should we add a formal `test:changed` or `test:feature` script later, or keep using focused `vitest --run` commands per task?
2. Should generated report tests use exact goldens everywhere, or combine exact JSON schema checks with more tolerant Markdown assertions for readability?
3. Do we want a future property-testing dependency such as `fast-check`, or should we write table-driven edge-case tests first?
4. Should non-interactive Codex review output become a standardized artifact name after every checkpoint?
5. What threshold should trigger a full `npm test` or `npm run test:integration` sweep during overnight/autonomous work?

## Working Conclusion

For the current local-features workstream, the strongest testing route is not a single suite. It is a ladder:

1. TDD with focused small tests.
2. Add medium fixture/CLI/MCP/golden tests at the first boundary crossing.
3. Build and diff hygiene for every source tranche.
4. Runtime/Podman/browser/GitHub checks only when that boundary is touched.
5. Non-interactive Codex review as a documented second-opinion gate before checkpointing.

This keeps tests fast enough for autonomous iteration while still giving strong evidence at the actual GitNexus risk surfaces.
