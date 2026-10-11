---
name: gitnexus-refactoring
description: "Use when the user wants to rename, extract, split, move, or restructure code safely. Examples: \"Rename this function\", \"Extract this into a module\", \"Refactor this class\", \"Move this to a separate file\""
---

# Refactoring with GitNexus

## When to Use

- "Rename this function safely"
- "Extract this into a module"
- "Split this service"
- "Move this to a new file"
- Any task involving renaming, extracting, splitting, or restructuring code

## Bind the repository first

Refactoring writes to disk. `rename` with `dry_run: false` edits files in
whichever repository was resolved, so binding identity here is a safety gate,
not bookkeeping.

Call `list_repos {}` before the first tool call. With one indexed repository,
use the examples below as written. With more than one, pass `repo` on every
call: an omitted `repo` normally errors, but under an MCP policy with a
configured default it resolves to that default silently. If you cannot tell
which repository is meant, stop and ask. Never run `rename` with
`dry_run: false` until the preview in the same bound repository has been
reviewed — its returned `file_path` values show which checkout is about to be
written, so read them as a confirmation of identity.

`list_repos` is paginated, so page with `offset: pagination.nextOffset` until
`hasMore` is false before concluding a repository is absent.

`detect_changes` takes `worktree` when you are editing a linked worktree the
MCP server was not launched from; otherwise `git diff` runs in the wrong
checkout and reports nothing changed, which reads as a verified refactor.

## Workflow

```
0. list_repos {}                                  → Bind repo (and worktree)
1. impact({target: "X", direction: "upstream"})  → Map all dependents
2. query({search_query: "X"})                            → Find execution flows involving X
3. context({name: "X"})                           → See all incoming/outgoing refs
4. Plan update order: interfaces → implementations → callers → tests
```

> If "Index is stale" → run `node .gitnexus/run.cjs analyze` in terminal.
> Hot-tool `staleness` names which index answered (`branch`/`lastCommit`) and how fresh it is (`status`). Re-analyze only for `behind` or `diverged` — `current` is identity, `unknown` is unmeasurable.

## Checklists

### Rename Symbol

```
- [ ] list_repos {} — bind repo; explicit repo when >1 indexed, ask if ambiguous
- [ ] rename_preview({symbol_name: "oldName", new_name: "newName"}) — preview semantic edits
- [ ] Confirm the previewed file paths are in the bound repository/worktree
- [ ] Review exact graph-backed semantic spans, coverage, and limitations
- [ ] If satisfied: rename({..., dry_run: false}) — apply edits
- [ ] detect_changes() — verify only expected files changed
- [ ] Run tests for affected processes
```

### Extract Module

```
- [ ] list_repos {} — bind repo; explicit repo when >1 indexed, ask if ambiguous
- [ ] context({name: target}) — see all incoming/outgoing refs
- [ ] impact({target, direction: "upstream"}) — find all external callers
- [ ] Define new module interface
- [ ] Extract code, update imports
- [ ] detect_changes() — verify affected scope
- [ ] Run tests for affected processes
```

### Split Function/Service

```
- [ ] list_repos {} — bind repo; explicit repo when >1 indexed, ask if ambiguous
- [ ] context({name: target}) — understand all callees
- [ ] Group callees by responsibility
- [ ] impact({target, direction: "upstream"}) — map callers to update
- [ ] Create new functions/services
- [ ] Update callers
- [ ] detect_changes() — verify affected scope
- [ ] Run tests for affected processes
```

## Tools

**rename_preview** — read-only semantic rename preview:

```
rename_preview({symbol_name: "validateUser", new_name: "authenticateUser", repo: "my-app"})
→ 12 edits across 8 files
→ semantic_edits: 12, coverage: {name: "gitnexus-semantic", scope: "indexed-repository", limitations: [...]}
→ changes: [{file_path, edits: [{start, length, line, old_text, new_text, confidence: "semantic"}]}]
```

Rename uses the indexed graph and GitNexus's own semantic layer. Language
providers resolve current source through scopes and bindings; no compiler or
language service is loaded. Unsupported syntax, ambiguous bindings, stale
declarations, and incomplete occurrence coverage fail closed. Coverage describes
indexed files accepted by the selected provider, including supported embedded sources,
and excludes unindexed files and external consumers. All registered source-language
providers supply rename rules. Declaration and override families require complete
semantic evidence. Dynamic or computed references block a rename when the provider
cannot resolve them or exclude them from the selected family. Provider-specific
limits, including class renames requiring a file move, remain explicit in results.
There is no regex fallback: legacy `graph_edits` and `text_search_edits` are zero.
Comments, strings, and unrelated same-spelled symbols are not replacements.

`rename` remains available with `dry_run: true` (default) or explicit
`dry_run: false`. Both use the same planner. Results use `result_version: 2`;
`total_edits` counts occurrences, not matching lines. Exact replacements are shown in `new_text`. Separate preview and apply calls recompute the plan.
Check `planning_status`, `application_status`, and `applied`. A completed apply
has `status: "success"`, `application_status: "applied"`, and `applied: true`.
A successful preview has not written files. Neither tool accepts `branch`:
they inspect the current checkout.

Recover from a blocked or incomplete rename before applying again:

| Result | Next step |
| --- | --- |
| `stale_graph` | Re-analyze the bound repository, then run `rename_preview` again. |
| `source_changed` | Run a fresh `rename_preview` against the current source and review it. |
| `unsupported_*` | Stop automated rename and inspect the reported limitation. Use a language-aware manual refactor if needed. |
| Ambiguous target | Inspect the returned candidates or `context`, then preview with the chosen `symbol_uid`. |
| `application_status: "partial"` or `"failed"` | Inspect landed `changes`, their counts, and `failed_files`. Reconcile the current files, re-index, and review a fresh preview; never blindly retry the apply call. |

Run the project validation suite after applying.

**impact** — map all dependents first:

```
impact({target: "validateUser", repo: "my-app", direction: "upstream"})
→ d=1: loginHandler, apiMiddleware, testUtils
→ Affected Processes: LoginFlow, TokenRefresh
```

**detect_changes** — verify your changes after refactoring:

```
detect_changes({scope: "all"})
→ Changed: 8 files, 12 symbols
→ Affected processes: LoginFlow, TokenRefresh
→ Risk: MEDIUM
```

`partial: true` (a graph query failed) or `truncated: true` (the changed-symbol
listing was capped) means the result is short of the truth: a short or empty
list is not proof that only the expected files changed. Re-run it rather than
treat the refactor as verified.

A wrong-worktree zero carries neither flag and is indistinguishable from a
clean verification, so confirm the diffed checkout is the one you edited.

**cypher** — custom reference queries:

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "validateUser"})
RETURN caller.name, caller.filePath ORDER BY caller.filePath
```

## Risk Rules

| Risk Factor         | Mitigation                                |
| ------------------- | ----------------------------------------- |
| Many callers (>5)   | Use rename for automated updates |
| Cross-area refs     | Use detect_changes after to verify scope  |
| String/dynamic refs | query to find them               |
| External/public API | Version and deprecate properly            |
| Same name in another indexed repo | Bind `repo`; verify previewed paths before applying |

## Example: Rename `validateUser` to `authenticateUser`

```
0. list_repos {}
   → total: 2 (my-app, billing-api) — both define validateUser, so bind explicitly

1. rename_preview({symbol_name: "validateUser", new_name: "authenticateUser", repo: "my-app"})
   → 12 semantic occurrences in the indexed repository's supported provider scope
   → Files: validator.ts, login.ts, middleware.ts...

2. Review semantic spans and provider coverage; inspect dynamic references separately

3. rename({symbol_name: "validateUser", new_name: "authenticateUser", repo: "my-app", dry_run: false})
   → Applied 12 edits across 8 files

4. detect_changes({scope: "all", repo: "my-app"})
   → Affected: LoginFlow, TokenRefresh
   → Risk: MEDIUM — run tests for these flows
   Repository: my-app (/abs/path/my-app)  Worktree: same  Index: current
```

With a single indexed repository, step 0 returns `total: 1` and the `repo`
argument drops out of every call above.
