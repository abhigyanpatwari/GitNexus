# Tyler AI Change Control

Use these rules for future AI coding work in GitNexus-indexed repos.

## Before Editing

- Read the repo's `AGENTS.md`.
- Read `CLAUDE.md` if present.
- Read relevant generated skills under `.claude/skills/` when they exist.
- Query GitNexus context for the target module, symbol, route, or workflow.
- Use GitNexus query to find related flows before assuming the local file is the whole story.

## Required Impact Analysis

Run GitNexus impact analysis before changing:

- auth
- database or persistence
- routing
- billing
- shared types
- public APIs
- generated contracts
- functions, classes, methods, or modules with known callers

Warn explicitly when GitNexus reports HIGH or CRITICAL risk. Do not proceed with HIGH or CRITICAL changes without human approval.

## Scope Control

Every task must list:

- objective
- allowed files or folders
- forbidden files or folders
- expected tests or checks
- rollback notes

Do not mix broad refactors with feature work. Do not include unrelated cleanup. Do not change dependency files unless the task explicitly allows dependency changes.

## Forbidden Without Explicit Approval

- schema changes
- auth changes
- billing changes
- environment variable changes
- production config changes
- broad renames
- generated-code rewrites
- destructive Git operations

For renames in GitNexus-indexed projects, use the GitNexus rename workflow with a dry run first. Do not use blind find-and-replace.

## During Implementation

- Make the smallest safe change.
- Prefer existing project patterns and helpers.
- Keep edits inside the allowed files.
- Add or update tests when behavior changes.
- Do not expose secrets or inspect real `.env` values.

## After Changes

Run the agreed checks from the task. When GitNexus is available, run `detect_changes` before commit to confirm the affected symbols and processes match the intended scope.

Minimum final proof:

- files changed
- commands run
- tests/checks passed
- tests/checks failed
- GitNexus impact or change summary
- residual risk
- rollback plan

## Rollback Notes

Every task should include a simple rollback path, such as:

- revert the specific commit
- restore the changed files from main
- remove the added config block
- rerun `gitnexus analyze` after rollback if the repo was re-indexed
