---
title: Claude Skill Discovery Paths - Plan
type: fix
date: 2026-07-11
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Claude Skill Discovery Paths - Plan

## Goal Capsule

- **Objective:** Make every Claude Code skill written by `gitnexus analyze` discoverable from the project skill root while preserving skip flags, repeat-run stability, and unrelated user skills.
- **Authority:** GitHub issue #2433 and Claude Code's documented project-skill layout are the behavioral contract; repository guardrails and existing CLI conventions govern implementation.
- **Execution profile:** Standard, test-first bug fix in `gitnexus/`; no dependency, schema, or public MCP changes.
- **Stop conditions:** Stop if the fix requires deleting unrecognized user-owned skill directories, changes `--skip-skills` semantics, or impact analysis reports HIGH/CRITICAL risk without maintainer approval.
- **Tail ownership:** LFG owns simplification, review, commits, PR creation, and CI follow-through after the implementation units pass verification.

---

## Product Contract

### Summary

Install standard and repo-generated Claude Code skills as direct children of `.claude/skills/`, update all generated references and CLI messages to those paths, and migrate known legacy GitNexus outputs without touching unrelated project skills.

### Problem Frame

`gitnexus analyze` currently writes standard skills below `.claude/skills/gitnexus/` and community skills below `.claude/skills/generated/`.
Claude Code treats `.claude/skills/<skill-name>/SKILL.md` as the project-skill shape; nested `.claude/skills/` directories elsewhere in a monorepo are separate discovery roots, not grouping directories inside a skill root.
The current installer therefore reports success and writes managed instructions that point to files, but the skills are not registered for invocation.

### Requirements

**Standard skills**

- R1. Each bundled `gitnexus-*` standard skill is written to `.claude/skills/<skill-name>/SKILL.md`.
- R2. Generated AGENTS.md and CLAUDE.md routing rows reference the same direct standard-skill paths.

**Community skills**

- R3. Each `--skills` community skill is written directly below `.claude/skills/` with a GitNexus-owned name that cannot collide with the six standard skills or ordinary unprefixed project skills.
- R4. Community skill frontmatter, returned metadata, console output, and generated routing rows use one consistent discoverable name and path.

**Migration and compatibility**

- R5. A repeat analyze removes or replaces only legacy directories GitNexus can identify as its own output and preserves unrelated `.claude/skills/` entries.
- R6. `--skip-skills` continues to suppress only the six standard skills, while `--skills` community generation remains independent; `--index-only` continues to suppress all context-file injection.
- R7. CLI help and localized help text describe the corrected paths without changing flag behavior.
- R8. This repository's checked-in copies of the six standard skills and its managed AGENTS.md/CLAUDE.md routing rows use the corrected direct layout when the fix lands.

### Acceptance Examples

- AE1. Given a clean repository, a normal analyze creates `.claude/skills/gitnexus-exploring/SKILL.md`, does not create `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`, and emits the direct path in AGENTS.md and CLAUDE.md.
- AE2. Given `analyze --skills`, each generated community skill has a direct, namespaced directory below `.claude/skills/`, and the context-file table points to that exact file.
- AE3. Given existing unrelated project skills plus legacy GitNexus grouping directories, rerunning analyze preserves the unrelated skills, produces the direct GitNexus skills, and leaves no managed reference pointing at a legacy grouped path.
- AE4. Given `--skip-skills`, no standard `gitnexus-*` skill is installed or referenced, while generated community skill behavior remains available when `--skills` is also requested.

### Success Criteria

- All standard and generated skill files use Claude Code's documented direct-child layout.
- Generated context, return messages, help text, and tests contain no active references to `.claude/skills/gitnexus/` or `.claude/skills/generated/`.
- The canonical repository no longer ships the six standard skills or managed routing rows in the broken grouped layout.
- Repeated runs are deterministic and do not delete unrelated user skills.

### Scope Boundaries

- **In scope:** project-local Claude Code skill installation performed by `analyze`, repo-generated community skills, managed context paths, the repository's checked-in copies of the six standard skills, CLI/help copy, migration of known legacy outputs, and regression coverage.
- **Out of scope:** global `gitnexus setup` targets, plugin skill layouts, changing the six bundled skill bodies, or changing Claude Code itself.
- **Deferred to follow-up work:** relocating this repository's three extra hand-maintained nested `.claude/skills/gitnexus/` skills that are not installed by `analyze`; those are workspace configuration rather than the issue's six standard installer outputs.

### Sources

- GitHub issue #2433: `https://github.com/abhigyanpatwari/GitNexus/issues/2433`
- Claude Code skills documentation: `https://code.claude.com/docs/en/slash-commands`
- Related path-contract regressions: GitHub issues #1098 and #1381.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Treat `.claude/skills/` as the installation root and make each skill directory its direct child. This matches the official project-skill contract and avoids relying on recursive discovery that Claude Code does not document.
- KTD2. Keep the six standard names unchanged because they are already `gitnexus-*` namespaced. This preserves their intended invocation names while correcting only the filesystem layout.
- KTD3. Reserve a separate GitNexus-owned prefix for generated community skill names before writing them flat. This prevents a community such as `Cli` from overwriting `gitnexus-cli` and prevents common labels such as `auth` from replacing user skills.
- KTD4. Replace grouped-directory cleanup with ownership-bounded cleanup. Remove known standard legacy children and generated legacy output, or direct generated directories carrying the reserved prefix, but never recursively clear `.claude/skills/` itself.
- KTD5. Keep generation and documentation derived from the same `GeneratedSkillInfo.name` value so disk paths, frontmatter names, managed routing rows, and repeat-run cleanup cannot drift.

### Assumptions

- Issue #2433's request to check community skills includes fixing them in this PR rather than filing a separate follow-up.
- Legacy `.claude/skills/generated/` is GitNexus-owned because current code already deletes and recreates it on every `--skills` run; unknown siblings under `.claude/skills/` remain user-owned.
- Standard legacy cleanup is limited to the six bundled names under `.claude/skills/gitnexus/`; unknown children in that grouping directory are preserved.
- The exact generated-skill prefix may be refined during implementation, but it must be stable, GitNexus-owned, direct-child compatible, and non-conflicting with standard skill names.

### Existing Patterns to Follow

- `gitnexus/src/cli/setup.ts` installs globally scoped Claude skills directly under the target skill root and provides a path-contract precedent.
- `gitnexus/src/cli/ai-context.ts` already centralizes standard skill definitions, context table generation, skip semantics, and best-effort filesystem handling.
- `gitnexus/src/cli/skill-gen.ts` already owns community-name normalization, deterministic collision suffixes, output cleanup, frontmatter rendering, and returned path metadata.
- `gitnexus/test/unit/ai-context.test.ts` uses temporary repositories to prove file layout and skip-mode behavior.
- `gitnexus/test/unit/skill-gen.test.ts` and `gitnexus/test/integration/skills-e2e.test.ts` cover generated skill metadata, file contents, idempotency, and end-to-end context references.

### System-Wide Impact

The change affects the user-visible filesystem contract of `gitnexus analyze`, generated AGENTS.md/CLAUDE.md content, CLI help output, and the invocation names of previously inert community skills.
It does not alter indexing, graph storage, MCP APIs, global setup targets, or runtime analysis behavior.

### Risks and Mitigations

- **Accidental user-skill deletion:** Scope cleanup to known standard names, the prior generated output directory, and the new reserved prefix; add preservation tests with unrelated directories.
- **Standard/community collision:** Use distinct namespaces and assert representative `Cli`/common-label cases.
- **Path drift across surfaces:** Derive context rows from returned generated names and assert exact disk-to-doc parity.
- **Skip-mode regression:** Retain focused tests for normal, `--skip-skills`, `--skills`, and `--index-only` combinations.

---

## Implementation Units

### U1. Flatten standard skill installation and managed references

- **Goal:** Install the six bundled skills as direct project skills and migrate only their known legacy copies.
- **Requirements:** R1, R2, R5, R6; AE1, AE3, AE4.
- **Dependencies:** None.
- **Files:** `gitnexus/src/cli/ai-context.ts`, `gitnexus/test/unit/ai-context.test.ts`.
- **Approach:** Change the standard install root and routing-table templates together; preserve `skipSkills` behavior and result reporting; add bounded cleanup for the six known legacy child directories while preserving unknown siblings and unrelated direct skills.
- **Execution note:** Start with failing temporary-repository assertions for the direct path, absence of the legacy path, preservation of unrelated skills, and repeated-run behavior.
- **Patterns to follow:** Existing `installSkills`, `generateGitNexusContent`, and temporary-directory tests in `ai-context.test.ts`.
- **Test scenarios:**
  - Covers AE1. A default run writes all six direct skill files and emits the same direct paths in both context files.
  - Covers AE3. A run with an unrelated direct skill and an unknown legacy-group child preserves both while replacing known legacy standard children.
  - Covers AE4. `skipSkills` writes no standard direct skill, emits no standard routing row, and reports the corrected skipped location.
  - A second default run produces the same six skills without duplicate directories or context rows.
- **Verification:** Focused AI-context tests prove the filesystem, managed-document, migration, and skip contracts.

### U2. Flatten and namespace generated community skills

- **Goal:** Make `--skills` outputs discoverable without colliding with standard or user-authored skills.
- **Requirements:** R3, R4, R5, R6; AE2, AE3, AE4.
- **Dependencies:** U1 establishes the shared direct-root convention.
- **Files:** `gitnexus/src/cli/skill-gen.ts`, `gitnexus/test/unit/skill-gen.test.ts`, `gitnexus/test/integration/skills-e2e.test.ts`, `gitnexus/test/unit/analyze-no-stats-bridge.test.ts`, `gitnexus/test/unit/analyze-gitnexusrc.test.ts`.
- **Approach:** Generate reserved, deterministic community names; write each directory directly under `.claude/skills/`; clean only legacy generated output and stale directories in the reserved namespace; return and render the direct path consistently; update mocked path fixtures that model the output contract.
- **Execution note:** Characterize existing name normalization and idempotency first, then add red tests for a community label that would collide with a standard or common user skill.
- **Patterns to follow:** `toKebabName`, `renderSkillMarkdown`, and existing repeat-run tests.
- **Test scenarios:**
  - Covers AE2. A representative community produces a direct namespaced directory whose basename equals frontmatter `name` and returned metadata `name`.
  - A `Cli` community does not overwrite the standard `gitnexus-cli` skill.
  - A pre-existing unrelated `.claude/skills/auth/SKILL.md` survives generation of an Auth community.
  - Covers AE3. A repeat run removes stale GitNexus-generated community directories and the legacy `generated/` output while preserving unrelated direct skills.
  - The end-to-end `analyze --skills` fixture finds generated files at direct paths and context tables point to those exact paths on first and second runs.
- **Verification:** Unit and integration tests prove collision resistance, ownership-bounded cleanup, path/frontmatter parity, and deterministic regeneration.

### U3. Align CLI help and path-contract assertions

- **Goal:** Remove stale user-facing descriptions of grouped skill directories and lock the corrected contract into CLI coverage.
- **Requirements:** R7 and the active-reference portion of R2/R4.
- **Dependencies:** U1 and U2 determine the final standard and generated naming conventions.
- **Files:** `gitnexus/src/cli/index.ts`, `gitnexus/src/cli/i18n/zh-CN.ts`, `gitnexus/test/unit/skip-git-cli.test.ts`, `gitnexus/test/unit/ai-context.test.ts`, `gitnexus/test/integration/skills-e2e.test.ts`.
- **Approach:** Update English and Chinese help copy and strengthen existing help/context assertions so legacy grouped paths fail tests if reintroduced.
- **Patterns to follow:** Existing Commander option descriptions, `help.option.analyze.*` translation keys, and `skip-git-cli.test.ts` help assertions.
- **Test scenarios:**
  - `gitnexus analyze --help` names the direct standard location and the reserved direct community naming convention.
  - Generated AGENTS.md and CLAUDE.md contain no active `.claude/skills/gitnexus/` or `.claude/skills/generated/` routing entries.
  - Chinese help retains the same flag semantics while naming corrected locations.
- **Verification:** Focused CLI/help tests and repository search confirm stale active path copy is gone from changed runtime and test surfaces.

### U4. Align the repository's checked-in standard skills

- **Goal:** Ensure the canonical GitNexus checkout demonstrates the same discoverable layout the corrected analyzer produces.
- **Requirements:** R8 and the repository-facing portion of R2.
- **Dependencies:** U1 establishes the standard direct paths.
- **Files:** `.claude/skills/gitnexus-exploring/SKILL.md`, `.claude/skills/gitnexus-debugging/SKILL.md`, `.claude/skills/gitnexus-impact-analysis/SKILL.md`, `.claude/skills/gitnexus-refactoring/SKILL.md`, `.claude/skills/gitnexus-guide/SKILL.md`, `.claude/skills/gitnexus-cli/SKILL.md`, `AGENTS.md`, `CLAUDE.md`.
- **Approach:** Relocate exactly the six analyzer-installed standard skill directories from the grouped path to direct children and update only their managed routing rows; preserve the extra hand-maintained nested skills unchanged.
- **Patterns to follow:** The direct paths produced by U1 and the existing GitNexus-managed block markers in AGENTS.md and CLAUDE.md.
- **Test scenarios:** Test expectation: none -- this unit relocates checked-in skill assets without changing their bodies; repository search and the focused path-contract tests cover their discoverability contract.
- **Verification:** Each of the six direct files exists with unchanged content, the six legacy grouped copies are absent, the three extra nested skill directories remain, and both managed tables point to the direct files.

---

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Focused standard installer | `cd gitnexus && npx vitest run test/unit/ai-context.test.ts` | Direct standard paths, managed rows, migration safety, skip flags |
| Focused community generator | `cd gitnexus && npx vitest run test/unit/skill-gen.test.ts` | Namespacing, collision handling, cleanup, metadata/frontmatter parity |
| CLI help | `cd gitnexus && npx vitest run test/unit/skip-git-cli.test.ts` | User-facing flag path contract |
| Community end to end | `cd gitnexus && npx vitest run test/integration/skills-e2e.test.ts` | Real analyze output and repeat-run references across fixtures |
| CLI/Core regression | `cd gitnexus && npm test` | Full package behavior |
| Type safety | `cd gitnexus && npx tsc --noEmit` | TypeScript contract integrity |
| Change scope | GitNexus `detect_changes` before each commit | Only expected CLI skill-generation symbols and flows are affected |

---

## Definition of Done

- U1-U3 requirements and test scenarios pass.
- U4's checked-in relocation and managed-row verification pass.
- Standard and community skills are direct children of `.claude/skills/` and discoverable by documented Claude Code rules.
- No runtime or generated-document surface points to the two legacy grouping layouts.
- Unrelated user-authored skills and unknown legacy-group children are preserved by regression tests.
- `--skip-skills`, `--skills`, and `--index-only` retain their documented independence.
- Full `gitnexus` tests and typecheck pass, or any environment-only exception is documented with focused proof.
- GitNexus change detection reports only the expected CLI generation and test scope.
- Abandoned experimental code and temporary artifacts from implementation are absent from the final diff.
