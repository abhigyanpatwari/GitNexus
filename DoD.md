# Definition of Done — GitNexus

Last reviewed: 2026-04-23 · Version: 2.0.0

This document defines the repo-wide completion bar for production-ready changes in GitNexus. It is the stable baseline. Implementation prompts, agent behavior, and review workflows may add task-specific checks, but they must never weaken this bar.

Use it together with:

- `AGENTS.md` — agent-facing rules of engagement
- `GUARDRAILS.md` — hard safety constraints
- `CONTRIBUTING.md` — contributor workflow
- `TESTING.md` — test strategy and coverage expectations
- `ARCHITECTURE.md` — pipeline boundaries, Call-Resolution DAG, LanguageProvider contract

## 1. Scope and Intent

A change is **Done** when it is correct, safely integrated, appropriately tested, operationally sound, and a net improvement to the codebase — not merely "the code compiles and a test passes."

This DoD applies to:

- CLI, MCP, and HTTP-bridge behavior in `gitnexus/`
- Browser UI in `gitnexus-web/`
- Shared contracts in `gitnexus-shared/`
- CI workflows, release pipelines, and repo-level docs

Out of scope: full agent personas, step-by-step implementation prompts, verbose review formatting rules, repo walkthroughs already covered elsewhere, temporary task-specific acceptance criteria. Those belong in prompts, PR templates, or other repo docs.

## 2. Core Definition of Done

Every change must satisfy **every relevant item** below. If an item does not apply, say so explicitly in the PR description.

### 2.1 Correctness and Completeness

- [ ] The requested behavior is implemented end-to-end in the **real runtime path** for the affected surface — no dead code, partial wiring, test-only shims, or "works in isolation but not in production" seams.
- [ ] Edge cases relevant to the changed surface are handled or explicitly documented as out of scope.
- [ ] Error handling is proportionate: inputs at system boundaries (user input, external APIs, filesystem, process spawn) are validated; internal, framework-guaranteed paths are trusted.
- [ ] The change produces the same result on re-run (idempotent where expected) and does not rely on accidental ordering.

### 2.2 Architecture and Placement

- [ ] The change is placed in the correct package and layer:
  - `gitnexus/` for CLI, MCP, HTTP bridge, ingestion, graph, and runtime logic
  - `gitnexus-web/` for browser UI (thin client — no WASM workers, all queries via HTTP API)
  - `gitnexus-shared/` for shared contracts, types, and constants
- [ ] Pipeline and architecture boundaries remain explicit. Shared ingestion code in `gitnexus/src/core/ingestion/` must not name languages — use `LanguageProvider` hooks (see `AGENTS.md` and `ARCHITECTURE.md` § Call-Resolution DAG).
- [ ] No hidden cross-phase coupling; no leaking of language-specific logic into shared infrastructure without a documented architectural reason.
- [ ] Runtime and graph behavior are consistent — the real source of truth is fixed at the source, not symptom-patched in a downstream layer.
- [ ] Direct imports from `gitnexus-shared` are used. No barrel re-exports introduced to paper over drift between packages.

### 2.3 Design and Readability

- [ ] The implementation is the **smallest correct solution** for the requirement. No speculative abstraction, unnecessary indirection, clever but hard-to-follow control flow, or unrelated cleanup.
- [ ] Naming, control flow, ownership, and extension points are clear enough that the next contributor can extend the code without archaeology.
- [ ] Comments are minimal and useful — they explain intent, invariants, contracts, or non-obvious constraints. No stale comments, placeholder comments, narrated code, commented-out code, or "what" comments where a good name would do.
- [ ] No copy-paste duplication created for convenience; no premature deduplication of three similar lines.

### 2.4 Contracts and Compatibility

- [ ] Existing contracts (types in `gitnexus-shared/`, CLI flags, MCP tools/resources, HTTP routes, graph node/edge shapes, persisted IDs) are preserved unless the task explicitly requires a contract change.
- [ ] Any contract change is intentional, explicit, and reflected in **every direct consumer** in the same change, with types aligned end-to-end.
- [ ] Persisted data changes (graph schema, IDs, embeddings) are backward-compatible or accompanied by a documented migration / reindex path.
- [ ] If user-visible behavior, public usage, CLI help, or README examples change, the relevant docs, examples, help text, or migration notes are updated in the same change.

### 2.5 Security

- [ ] No new injection surfaces (command, path, SQL/Cypher-style, prompt) introduced on paths that consume untrusted input.
- [ ] No secrets, tokens, or credentials committed to the repo, to logs, or to error messages.
- [ ] Filesystem access honors the repo-scope and indexed-repo boundaries documented in `AGENTS.md` and `GUARDRAILS.md`.
- [ ] Third-party dependencies added or bumped are justified, from reputable sources, and do not regress the supply-chain posture.

### 2.6 Performance and Resource Use

- [ ] No repeated avoidable work, unnecessary scans, unnecessary round-trips, unbounded caches, or obvious hot-path regressions.
- [ ] Tree-sitter buffer sizing follows the adaptive 512KB–32MB convention (`getTreeSitterBufferSize`) — do not hard-code new buffer sizes.
- [ ] Memory and handle lifecycles are explicit: database handles (LadybugDB) close cleanly, no dangling process watchers, no leaked tree-sitter parsers.
- [ ] Long-running or large-graph paths remain bounded or are measurably streamed; degradation on large real repos is considered, not assumed benign.

### 2.7 Tests

- [ ] Tests cover the **real changed path** — they would fail if behavior, wiring, or contracts were broken, not only if a mock were misconfigured.
- [ ] Integration tests hit a real database where the production path does; do not introduce mocks that hide migration or schema drift.
- [ ] Assertions are meaningful. Use `toBe` / `toEqual` for exact expectations; avoid `toBeGreaterThanOrEqual` and other bounds-only assertions that mask regressions.
- [ ] Fixtures are realistic enough for the risk of the change — a one-file fixture is not sufficient for a pipeline-wide behavior change.
- [ ] New tests are deterministic and do not depend on network, clock, or host-specific paths without explicit isolation.

### 2.8 Observability and Operability

- [ ] Errors surfaced to users or callers are actionable: they name what failed, what input was involved (without leaking secrets), and how to recover where possible.
- [ ] Logging is proportionate — no noisy debug logs left in hot paths, no silent catches that swallow diagnostics.
- [ ] CLI exit codes and MCP tool responses are correct for each outcome (success, user error, internal error).
- [ ] Progress reporting (`PipelineProgress` and similar shared contracts) remains accurate after the change.

### 2.9 Reversibility and Risk

- [ ] The change has a clear rollback story: revert is safe, or migration is accompanied by a documented rollback / reindex procedure.
- [ ] Residual risks, compatibility impacts, and operational concerns are either resolved or **clearly stated** in the PR description.
- [ ] Destructive or hard-to-reverse operations (graph rebuild, schema change, `git` state manipulation) are opt-in or guarded.

## 3. Agent-Assisted Workflow Guardrails

When the change is produced with or reviewed by an AI agent, the following additional gates apply:

- [ ] **Scope match.** The final diff matches the intended symbols, files, and processes — no speculative refactors, unrelated formatting churn, or collateral edits outside the task scope.
- [ ] **Evidence-based edits.** Claims about repo state are verified against the current code, not trusted from memory or stale documentation.
- [ ] **Impact analysis.** Where GitNexus graph tooling is available and relevant, impact of non-trivial symbol, contract, or runtime-path changes is checked **before** editing.
- [ ] **Embeddings preserved.** If an indexed repo already has embeddings and re-analysis is required, embeddings are preserved — not accidentally dropped by a destructive reindex.
- [ ] **No false-done.** "Done" is claimed only after the Validation Baseline below has been run or any gap is explicitly named. Green tests on an unrelated path do not constitute validation.
- [ ] **Five-axis self-review** before handing off: correctness, readability, architecture, security, performance.

## 4. Validation Baseline

Run the commands relevant to the touched area. If something cannot be run in the current environment, state it explicitly in the handoff.

### 4.1 Build ordering

- [ ] `gitnexus-shared/` dist is built before consuming packages are typechecked or tested (CI uses the `setup-gitnexus` action for this — local runs must match).

### 4.2 If `gitnexus/` changed

- [ ] `cd gitnexus && npx tsc --noEmit`
- [ ] `cd gitnexus && npm test`
- [ ] `cd gitnexus && npx prettier --check .` for files in the diff (pre-commit runs the affected-tests subset; do not expand scope)

### 4.3 If `gitnexus-web/` changed

- [ ] `cd gitnexus-web && npx tsc -b --noEmit`
- [ ] `cd gitnexus-web && npm test`
- [ ] `cd gitnexus-web && npm run test:e2e` when browser flows or user-facing UI behavior changed

### 4.4 If `gitnexus-shared/` changed

- [ ] Shared package builds cleanly (`npm run build` in `gitnexus-shared/`)
- [ ] Dependent packages still typecheck and test after the shared change — verify both CLI and web consumers together

### 4.5 If CI workflows or release pipelines changed

- [ ] The workflow passes a dry-run or triggered run before merge; concurrency (`cancel-in-progress`) and the `setup-gitnexus` action remain wired correctly.
- [ ] `CHANGELOG.md` is **not** edited here — it is owned by the release process.

## 5. Review Gates

A reviewer (human or agent) should be able to answer **yes** to each of the following before approving:

1. **Correctness** — Does the change do what it claims on the real runtime path?
2. **Readability** — Will the next contributor understand this in six months without asking?
3. **Architecture** — Is it in the right package, layer, and phase? Are boundaries respected?
4. **Security** — No new injection, leak, or trust-boundary violation?
5. **Performance** — No obvious regression on realistic inputs?
6. **Tests** — Would a regression in the changed behavior fail loudly?
7. **Scope** — Does the diff match the intended change, with no unrelated churn?

## 6. "Not Done" Signals

A change is **not** Done if any of the following is true, even if CI is green:

- The runtime path is not actually exercised by the tests.
- A contract drifted between `gitnexus/`, `gitnexus-web/`, and `gitnexus-shared/` and only one side was updated.
- A language-specific concern leaked into shared ingestion code.
- The diff contains unrelated reformatting, refactors, or cleanup beyond the stated task.
- Logs, comments, or TODOs were added as placeholders for work not done.
- The change depends on a manual step that is not documented.
- `CHANGELOG.md` was edited during PR work.
- Pre-commit, prettier, or typecheck was bypassed without explicit justification.

## 7. Task-Specific DoD Template

Use this in implementation and review prompts. Keep it short and tailor it to the actual change:

```md
# Definition of Done for this implementation

- [ ] Runtime wiring is complete for the affected path.
- [ ] Requested behavior is correct and relevant contracts are preserved or explicitly updated.
- [ ] The design stays scoped, readable, and proportionate to the task.
- [ ] Tests prove the changed behavior and catch broken wiring.
- [ ] Required validation for touched packages has been run, or any gap is explicitly noted.
- [ ] Repo boundaries, security, performance, and operational safety are respected.
- [ ] The diff contains only the intended change — no unrelated churn.
```

## 8. How to Use This File in Claude Review

Reference this file as the repo-wide completion bar. Add a task-specific review instruction such as:

```md
Review this change against `DoD.md` and the repo docs (`AGENTS.md`, `GUARDRAILS.md`,
`CONTRIBUTING.md`, `TESTING.md`, `ARCHITECTURE.md`). Treat `DoD.md` as the minimum
bar for production readiness. Flag anything that is partially wired, contract-unsafe,
under-tested, architecturally misplaced, scope-creeping, or harder to maintain than
necessary. Apply the five-axis review gate: correctness, readability, architecture,
security, performance.
```

## 9. Evolution

This DoD is living. Revisit it when:

- A class of incident slips past it (add a gate).
- A gate becomes consistently ceremonial without catching issues (remove or merge it).
- The architecture evolves in a way that changes what "done" means (update placement, validation, or contracts sections).

Track material updates in the changelog below. Keep the file tight — if it grows past a single read-in-one-sitting, something has drifted into the wrong place.

## Changelog

| Date       | Version | Change                                                                                                                                                        |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-23 | 2.0.0   | Restructured into numbered sections; added Security, Observability, Reversibility, Agent-Assisted Guardrails, Review Gates, Not-Done Signals; expanded validation baseline (shared-first build, prettier, CI workflow checks). |
| 2026-04-13 | 1.0.0   | Initial repo-wide Definition of Done.                                                                                                                         |
