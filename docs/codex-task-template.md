# Codex Task Template

## Objective

[One clear outcome]

## Repo Context

Use GitNexus MCP before editing.
Read:

- AGENTS.md
- CLAUDE.md if present
- relevant generated skills
- relevant module docs

## Required GitNexus Queries

Before editing, run:

- list repos
- context for target module/symbol
- impact analysis for target symbol/module
- query for related flows

## Allowed Files

[List exact files or folders]

## Forbidden Files

[List files/folders Codex must not touch]

## Constraints

- no unrelated cleanup
- no silent dependency changes
- no schema changes unless explicitly approved
- no auth changes unless explicitly approved
- no environment variable changes unless explicitly approved

## Implementation Steps

1. inspect current behavior
2. identify dependencies
3. make smallest safe change
4. add/update tests if appropriate
5. run checks
6. run GitNexus change impact analysis
7. report diff and risk

## Required Proof

- commands run
- tests passed/failed
- files changed
- impact/risk summary
- rollback plan

## Commit Message

type(scope): concise description
