# Tyler Repo Intelligence Workflow

Use this workflow when applying GitNexus as the context layer for another app repo.

1. Open the target app repo.
2. Install the repo's dependencies using its lockfile and docs.
3. Run:

   ```bash
   npx gitnexus analyze --skills --skip-embeddings
   ```

4. Check status:

   ```bash
   npx gitnexus status
   ```

5. Ask Codex to read:

   - `AGENTS.md`
   - `CLAUDE.md` if present
   - relevant generated skills
   - relevant module docs

6. Ask Codex to query GitNexus before editing:

   - list repos
   - context for target module or symbol
   - query for related flows
   - impact analysis for target symbol, route, or module

7. Define the task with exact allowed files and forbidden files.
8. Make a small scoped change.
9. Run the repo's tests and checks.
10. Run GitNexus change detection if available.
11. Summarize risk before commit.
12. Commit only after checks and risk summary are acceptable.

## Good Codex Prompt Shape

```text
Use GitNexus MCP before editing.
Objective: [one clear outcome]
Allowed files: [exact files/folders]
Forbidden files: [exact files/folders]
Before editing: list repos, inspect context for [symbol/module], query related flows, run impact on [target].
After editing: run [checks], run detect_changes, summarize risk and rollback.
```

## Operating Notes

- Keep one GitNexus MCP server configured globally for Codex.
- Re-index after meaningful code changes.
- If MCP warns that an index is stale, run `npx gitnexus analyze`.
- If multiple repos are indexed, pass the explicit `repo` argument to GitNexus tools.
- Avoid embeddings for first-pass setup unless semantic search quality is required.
