# Skill File Synchronization — Master Document

> **Status:** Complete (all 6 phases implemented)
> **Branch:** `sync_skills_across_integration`
> **Replaces:** `docs/analysis-skill-sync-strategy.md`, `docs/skill-sync-analysis.md`

---

## Table of Contents

1. [Motivation](#motivation)
2. [Current State](#current-state)
3. [Observed Drift](#observed-drift)
4. [Strategy Analysis](#strategy-analysis)
5. [Recommended Approach](#recommended-approach)
6. [Test Plan (TDD)](#test-plan-tdd)
7. [Implementation Outline](#implementation-outline)
8. [Coverage Criteria](#coverage-criteria)
9. [PR Description](#pr-description)
10. [Changelog](#changelog)

---

## Motivation

GitNexus agent skills (markdown files teaching AI assistants GitNexus-specific workflows) exist in **4 locations** within the monorepo, all checked into git:

| Location | Count | Format | Extras | Purpose |
|----------|-------|--------|--------|---------|
| `gitnexus/skills/` | 7 | flat `{name}.md` | YAML frontmatter | Canonical source; shipped in the npm package |
| `.claude/skills/gitnexus/` | 7 | `{name}/SKILL.md` | YAML frontmatter | Project-local skills for developers working on GitNexus itself |
| `gitnexus-claude-plugin/skills/` | 7 | `{name}/SKILL.md` | `mcp.json` per skill (6 of 7) | Claude Code plugin package |
| `gitnexus-cursor-integration/skills/` | 5 | `{name}/SKILL.md` | — | Cursor editor integration (subset) |

**Total: 26 skill files representing 7 unique skills.**

Additionally, the runtime installer (`setup.ts`) has a hardcoded `SKILL_NAMES` array containing only 6 of 7 skills — `gitnexus-pr-review` is excluded, making it a fifth discrepancy vector.

### Why this matters

- A skill content fix applied to `gitnexus/skills/` does **not** propagate to any other location.
- Adding a new skill requires manually creating it in up to 4 locations with 2 different directory structures.
- The Cursor integration is missing 2 skills with no documented rationale.
- There is **no mechanism** — neither automated nor documented — to detect or prevent drift.
- Drift has already occurred (see [Observed Drift](#observed-drift)).

---

## Current State

### Verified parity matrix (this branch)

| Skill | source | .claude | plugin | cursor | `SKILL_NAMES` |
|-------|--------|---------|--------|--------|---------------|
| gitnexus-cli | ✅ | ✅ *(content diff¹)* | ✅ *(identical)* | ❌ missing | ✅ |
| gitnexus-debugging | ✅ | ✅ *(formatting²)* | ✅ *(identical)* | ✅ *(drift³)* | ✅ |
| gitnexus-exploring | ✅ | ✅ *(formatting²)* | ✅ *(identical)* | ✅ *(drift³)* | ✅ |
| gitnexus-guide | ✅ | ✅ *(formatting²)* | ✅ *(identical)* | ❌ missing | ✅ |
| gitnexus-impact-analysis | ✅ | ✅ *(formatting²)* | ✅ *(identical)* | ✅ *(drift³)* | ✅ |
| gitnexus-pr-review | ✅ | ✅ *(identical)* | ✅ *(identical)* | ✅ *(identical)* | ❌ **missing** |
| gitnexus-refactoring | ✅ | ✅ *(formatting²)* | ✅ *(identical)* | ✅ *(drift³)* | ✅ |

**Legend:**
1. ¹ Content diff: `.claude` copy omits the sentence about PostToolUse hooks in the `gitnexus-cli` skill.
2. ² Formatting: `.claude` copies have prettified Markdown table columns (padded with spaces). Content is semantically identical.
3. ³ Drift: Cursor copies have different (shorter) frontmatter descriptions and compact table formatting. Trailing blank lines removed.

### Companion files

The `gitnexus-claude-plugin/skills/` directories contain `mcp.json` companion files (6 of 7 skills — `gitnexus-pr-review` is the exception). All 6 `mcp.json` files are identical:

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

---

## Observed Drift

These are concrete examples of drift that has already occurred silently:

### 1. Cursor frontmatter descriptions

The Cursor copies have shorter, terser descriptions that differ from the canonical source:

```yaml
# Source (gitnexus/skills/gitnexus-debugging.md)
description: "Use when the user is debugging a bug, tracing an error, ..."

# Cursor (gitnexus-cursor-integration/skills/gitnexus-debugging/SKILL.md)
description: Trace bugs through call chains using knowledge graph
```

This applies to all 5 Cursor skills. The descriptions are not just truncated — they are independently rewritten.

### 2. `.claude/gitnexus-cli` content omission

The `.claude` copy of the CLI skill is missing a content sentence present in the source:

```diff
- **When to run:** First time in a project, after major code changes, or when
- `gitnexus://repo/{name}/context` reports the index is stale. In Claude Code,
- a PostToolUse hook runs `analyze` automatically after `git commit` and `git merge`,
- preserving embeddings if previously generated.
+ **When to run:** First time in a project, after major code changes, or when
+ `gitnexus://repo/{name}/context` reports the index is stale.
```

### 3. `.claude` table formatting differences

The `.claude` copies have prettified Markdown tables with column padding. This is cosmetic but means byte-level comparison fails, complicating any naive diff-based drift detection.

### 4. Cursor missing 2 of 7 skills

`gitnexus-cli` and `gitnexus-guide` are absent from the Cursor integration. There is no manifest, config, or documentation explaining whether this is intentional.

### 5. `SKILL_NAMES` hardcoded list missing `gitnexus-pr-review`

The runtime installer in `setup.ts` uses a hardcoded array of 6 skill names. `gitnexus-pr-review` is excluded, meaning it is never installed to user machines even though it exists in all 4 repository locations.

---

## Strategy Analysis

Four approaches were evaluated across two independent analysis sessions:

### Option A: Build-time sync script ✅ Recommended

A `scripts/sync-skills.ts` script reads from the canonical source (`gitnexus/skills/`) and generates derived copies.

| Dimension | Assessment |
|-----------|-----------|
| Can drift silently? | No (CI catches it) |
| Developer experience | Good — `npm run sync:skills` |
| Platform compatibility | Excellent (Node.js) |
| Complexity | Low–medium |
| Handles extras (mcp.json) | Yes — only overwrites `SKILL.md` |
| Handles subsets | Yes — via explicit allowlist per target |

### Option B: Symlinks ❌ Ruled out

| Dimension | Assessment |
|-----------|-----------|
| npm publish | **Breaks** — npm silently drops symlinked files ([npm/cli#6746](https://github.com/npm/cli/issues/6746)) |
| Windows | Requires Developer Mode |
| mcp.json companions | Cannot symlink a file into a directory that also needs non-symlinked files |

### Option C: CI drift-detection only ⚠️ Insufficient alone

Detects drift but does not help developers fix it. Manual copy from flat `.md` → directory-structured `SKILL.md` is error-prone. Viable only as a **complement** to Option A.

### Option D: Git pre-commit hook ⚠️ Bypassable

Good local DX but trivially bypassed with `--no-verify`. Must be paired with CI.

### Industry context

No widely-adopted npm package exists for syncing arbitrary content files within a monorepo. Teams (Babel, Next.js, Nx) roll their own build-time generators or avoid duplication entirely.

---

## Recommended Approach

**Option A + C: Sync script with CI enforcement.**

### Architecture

```
gitnexus/skills/*.md                 ← Single source of truth
        │
        ├─ sync-skills.ts reads ──→ .claude/skills/gitnexus/*/SKILL.md
        ├─ sync-skills.ts reads ──→ gitnexus-claude-plugin/skills/*/SKILL.md
        └─ sync-skills.ts reads ──→ gitnexus-cursor-integration/skills/*/SKILL.md
                                     (only allowlisted skills)
```

### Sync script responsibilities

1. Read all `gitnexus/skills/*.md` flat files as canonical source.
2. For each target, read a `skills.manifest.json` declaring which skills to include.
3. Write `{name}/SKILL.md` into each target directory.
4. **Only overwrite `SKILL.md`** — leave `mcp.json` and other companion files untouched.
5. Strip YAML frontmatter from derived copies (the frontmatter is consumed by `setup.ts` at runtime, not by the editor integrations).
6. Optionally prepend a generated header: `<!-- AUTO-GENERATED FROM gitnexus/skills/{name}.md — DO NOT EDIT -->`

### `skills.manifest.json` per target

```json
{
  "skills": ["gitnexus-exploring", "gitnexus-debugging", "gitnexus-impact-analysis",
             "gitnexus-refactoring", "gitnexus-pr-review", "gitnexus-guide", "gitnexus-cli"]
}
```

Cursor's manifest would list only its 5 skills (or all 7 — to be decided, but now **explicitly documented**).

### CI enforcement

A CI step runs `npm run sync:skills` then `git diff --exit-code`. If any derived file is out of sync, the PR fails.

### `SKILL_NAMES` in `setup.ts`

The hardcoded `SKILL_NAMES` array should be derived from the canonical source directory listing (or from a shared manifest) to prevent the `gitnexus-pr-review` omission from recurring.

---

## Test Plan (TDD)

Tests live in `gitnexus/test/unit/sync-skills.test.ts` using the existing vitest infrastructure. The sync script will be a pure function that takes config and returns a list of write operations — making it fully testable without filesystem side effects.

### Core function signature (design target)

```typescript
interface SyncTarget {
  name: string;
  dir: string;
  skills: string[];          // allowlist
  stripFrontmatter: boolean;
  generatedHeader: boolean;
}

interface SyncOperation {
  targetPath: string;
  content: string;
  action: 'write' | 'skip';  // skip if content already matches
}

function planSync(
  sourceDir: string,
  targets: SyncTarget[],
  readFile: (path: string) => Promise<string>,
): Promise<SyncOperation[]>;
```

### Test Cases

#### T1 — Source Discovery

| ID | Test Case | Expected |
|----|-----------|----------|
| T1.1 | All `.md` files in `sourceDir` are discovered | Returns operations for every skill × target combination |
| T1.2 | Non-`.md` files in source directory are ignored | `README.md`-like files with non-skill names excluded — or: only files matching `gitnexus-*.md` pattern |
| T1.3 | Empty source directory | Returns empty array, no errors |
| T1.4 | Source directory does not exist | Throws descriptive error |

#### T2 — Target Allowlist Filtering

| ID | Test Case | Expected |
|----|-----------|----------|
| T2.1 | Target with full allowlist receives all skills | Operations for all 7 skills |
| T2.2 | Target with subset allowlist receives only listed skills | Cursor target (5 skills) → exactly 5 operations |
| T2.3 | Allowlist references a skill not present in source | Throws or warns — skill `gitnexus-nonexistent` in allowlist but no source file |
| T2.4 | Empty allowlist | No operations for that target |
| T2.5 | Allowlist with duplicate entries | Deduplicates, produces one operation per skill |

#### T3 — Content Transformation

| ID | Test Case | Expected |
|----|-----------|----------|
| T3.1 | Frontmatter stripping removes YAML block | Input with `---\nname: ...\n---\n# Body` → output starts with `# Body` |
| T3.2 | Frontmatter stripping with no frontmatter | Content passes through unchanged |
| T3.3 | Frontmatter stripping preserves `---` inside content body | Only the leading YAML block is removed; `---` used as horizontal rules mid-document are kept |
| T3.4 | Generated header is prepended when configured | First line matches `<!-- AUTO-GENERATED FROM gitnexus/skills/{name}.md — DO NOT EDIT -->` |
| T3.5 | Generated header not added when disabled | Content starts with the skill body |
| T3.6 | Trailing whitespace is normalized | Consistent trailing newline (single `\n` at EOF) |

#### T4 — Path Generation

| ID | Test Case | Expected |
|----|-----------|----------|
| T4.1 | Flat source `{name}.md` produces `{target}/{name}/SKILL.md` | Path is `<targetDir>/gitnexus-debugging/SKILL.md` |
| T4.2 | Skill name is extracted from filename | `gitnexus-debugging.md` → directory name `gitnexus-debugging` |
| T4.3 | Multiple targets produce independent paths | Same skill, 3 targets → 3 distinct paths |

#### T5 — Idempotency and Skip Detection

| ID | Test Case | Expected |
|----|-----------|----------|
| T5.1 | Content already matches target | Operation has `action: 'skip'` |
| T5.2 | Content differs from target | Operation has `action: 'write'` |
| T5.3 | Target file does not exist yet | Operation has `action: 'write'` |
| T5.4 | Running sync twice produces zero writes on second run | All operations are `'skip'` |

#### T6 — Companion File Preservation

| ID | Test Case | Expected |
|----|-----------|----------|
| T6.1 | Existing `mcp.json` in target directory is not listed in operations | Sync operations only contain `SKILL.md` writes |
| T6.2 | Existing non-skill files in target directory are untouched | No delete or overwrite operations for `mcp.json`, `README.md`, etc. |

#### T7 — Error Handling

| ID | Test Case | Expected |
|----|-----------|----------|
| T7.1 | Source file is unreadable (permission error) | Throws with skill name and path in message |
| T7.2 | Target directory is read-only | Error propagated with clear context |
| T7.3 | Malformed YAML frontmatter (unclosed `---`) | Graceful handling — treat entire content as body, or throw with clear message |

#### T8 — Integration: Actual Repository State

| ID | Test Case | Expected |
|----|-----------|----------|
| T8.1 | Running `planSync` against real `gitnexus/skills/` directory | Returns expected number of operations per target |
| T8.2 | All 7 canonical skills are present in source | Verify by listing source directory |
| T8.3 | Skill names match expected set | Exact match against known list, catches accidental additions/removals |

#### T9 — `SKILL_NAMES` Parity

| ID | Test Case | Expected |
|----|-----------|----------|
| T9.1 | Runtime `SKILL_NAMES` matches canonical source directory | Every `.md` file in `gitnexus/skills/` has a corresponding entry; no extras, no missing |
| T9.2 | Detects the current `gitnexus-pr-review` omission | Fails when `SKILL_NAMES` is missing a skill present in source |

#### T10 — Manifest Validation

| ID | Test Case | Expected |
|----|-----------|----------|
| T10.1 | Valid manifest parses correctly | Skills array extracted |
| T10.2 | Manifest with unknown fields is accepted (forward-compat) | Extra fields ignored, no error |
| T10.3 | Manifest with missing `skills` field | Throws descriptive error |
| T10.4 | Manifest is not valid JSON | Throws with path in error message |

---

## Implementation Outline

### Phase 1: Reconcile drifted content (manual, one-time)
- Diff all 4 locations, decide canonical content for each skill.
- Update `gitnexus/skills/` with the best version of each.
- Ensure `gitnexus-pr-review` is added to `SKILL_NAMES` in `setup.ts`.

### Phase 2: Write tests (TDD — before implementation)
- Create `gitnexus/test/unit/sync-skills.test.ts`.
- Implement all test cases from T1–T10.
- Tests will fail initially (red phase).

### Phase 3: Build the sync script
- Create `gitnexus/scripts/sync-skills.ts` (or `scripts/sync-skills.ts` at repo root).
- Implement `planSync()` as a pure function.
- Add `executeSync()` wrapper for filesystem writes.
- Wire as `npm run sync:skills`.
- All tests pass (green phase).

### Phase 4: Add manifests
- Create `skills.manifest.json` in each target directory.
- All skills for `.claude` and `gitnexus-claude-plugin`.
- Explicit subset for `gitnexus-cursor-integration` (all 7, unless we decide otherwise).

### Phase 5: CI enforcement
- Add a CI step: `npm run sync:skills && git diff --exit-code`.
- Fails PRs that modify skills without running sync.

### Phase 6: Clean up
- Delete the two superseded analysis docs.
- Run sync to regenerate all derived copies.
- Verify `git diff` shows only expected changes (formatting normalization).

---

## Coverage Criteria

The change is considered **complete and valid** when:

- [ ] All test cases T1–T10 pass.
- [ ] `npm run sync:skills` generates all derived files from `gitnexus/skills/`.
- [ ] Running sync twice is idempotent (zero diff on second run).
- [ ] `mcp.json` companion files in `gitnexus-claude-plugin/skills/` are untouched.
- [ ] Each target has a `skills.manifest.json` with an explicit allowlist.
- [ ] `SKILL_NAMES` in `setup.ts` matches the canonical source directory listing.
- [ ] CI step catches intentional drift (tested by manually editing a derived file and verifying failure).
- [ ] No derived `SKILL.md` file differs from what the sync script would generate.
- [ ] The Cursor integration includes all 7 skills (or the exclusion of specific skills is documented in its manifest).
- [ ] This document's changelog reflects all completed steps.

---

## PR Description

```markdown
## chore: centralize skill definitions with build-time sync

### Problem

GitNexus agent skills exist as 26 files across 4 locations in the monorepo. There is
no mechanism to keep them in sync, and drift has already occurred:

- Cursor integration has different frontmatter descriptions from the canonical source
- `.claude/gitnexus-cli` is missing a content sentence present in the source
- `gitnexus-pr-review` is missing from the runtime installer's `SKILL_NAMES` array
- Cursor is missing 2 skills with no documented rationale

### Solution

- **Single source of truth:** `gitnexus/skills/*.md`
- **Build-time sync:** `scripts/sync-skills.ts` generates all derived copies
- **Per-target manifests:** `skills.manifest.json` in each integration directory
  declares which skills to include (making subsets explicit and reviewable)
- **CI enforcement:** sync + `git diff --exit-code` fails PRs with stale copies
- **Companion preservation:** sync only overwrites `SKILL.md` files, leaving
  `mcp.json` and other extras untouched

### Test coverage

- 10 test groups (T1–T10) covering source discovery, allowlist filtering, content
  transformation, path generation, idempotency, companion preservation, error
  handling, repository state validation, SKILL_NAMES parity, and manifest validation.

### Checklist

- [ ] All tests pass (`npm test`)
- [ ] `npm run sync:skills` is idempotent
- [ ] CI drift check integrated
- [ ] `SKILL_NAMES` updated to include all skills
```

---

## Changelog

| Date | Action | Details |
|------|--------|---------|
| 2026-03-07 | Document created | Consolidated from `analysis-skill-sync-strategy.md` and `skill-sync-analysis.md`. Verified current drift state against actual files. Designed test plan (T1–T10). |
| 2026-03-07 | Phase 1 complete | Reconciled all drifted content. `.claude/gitnexus-cli` PostToolUse sentence restored. `gitnexus-claude-plugin/gitnexus-cli` tables + content aligned. Cursor frontmatter descriptions restored to canonical for all 5 existing skills. Missing Cursor skills (`gitnexus-cli`, `gitnexus-guide`) added. All 28 derived files now byte-identical to `gitnexus/skills/` source. `SKILL_NAMES` in `setup.ts` updated to include `gitnexus-pr-review` (7 of 7). |
| 2026-03-07 | Phase 2 complete | Created `gitnexus/test/unit/sync-skills.test.ts` with 35 tests across 10 groups (T1–T10). Created `gitnexus/src/sync-skills.ts` stub exporting `planSync`, `SyncTarget`, and `SyncOperation` types. TDD red phase confirmed: 29 tests fail (awaiting implementation), 6 pass (repo-state assertions T8.2/T8.3, SKILL_NAMES parity T9.1/T9.2, invalid-input error tests T10.3/T10.4). All 839 existing unit tests remain green. |
| 2026-03-07 | Phase 3 complete | Implemented `planSync()` in `gitnexus/src/sync-skills.ts`. TDD green phase: all 35 sync-skills tests pass. Full unit suite green (874 tests). Implementation covers: source discovery (gitnexus-* pattern filtering), target allowlist filtering with deduplication, YAML frontmatter stripping, generated header prepend, trailing newline normalization, path generation (flat .md → {name}/SKILL.md), idempotency via content comparison (write/skip), input validation (null/undefined skills array, missing source skills), and graceful handling of malformed frontmatter. |
| 2026-03-07 | Phase 4 complete | Created `skills.manifest.json` in all 3 target directories (`.claude/skills/gitnexus/`, `gitnexus-claude-plugin/skills/`, `gitnexus-cursor-integration/skills/`) — all listing all 7 skills. Created executable sync script `gitnexus/scripts/sync-skills.ts` with manifest loading, `--dry-run` support, and filesystem write execution. Added `npm run sync:skills` and `npm run sync:skills:check` scripts. Ran sync to regenerate all 21 derived SKILL.md files with AUTO-GENERATED headers. Verified idempotency (second run = 0 writes). Companion `mcp.json` files untouched. |
| 2026-03-07 | Phase 5 complete | Added `skill-sync-check` job to `.github/workflows/ci.yml`. Runs `npm run sync:skills` then `git diff --exit-code` on all 3 target directories. PRs with stale derived SKILL.md files will fail CI. |
| 2026-03-07 | Phase 6 complete | Superseded analysis docs already removed in prior commit. Ran `npm run sync:skills` — all 21 files up-to-date, `git diff --exit-code` clean. Full unit suite green (874 tests, 38 files). All 6 phases complete. |

---

*This is a living document. Update the changelog as work progresses.*
