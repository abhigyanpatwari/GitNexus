# Repository and worktree identity

This file is the shared identity contract for the per-repository GitNexus
skills. `gitnexus-exploring`, `gitnexus-debugging`, `gitnexus-impact-analysis`
and `gitnexus-refactoring` carry byte-identical copies so each skill works
without relying on another skill's install.

Two independent questions must be answered before any graph or diff result can
be trusted, and a wrong answer to either produces a well-formed report about
code you were not asking about:

- **`repo` — which indexed project.** Every graph tool (`query`, `context`,
  `impact`, `trace`, `rename`, `cypher`, `explain`, `pdg_query`) runs against
  exactly one registered repository's database. Registered repositories are
  independent stores, so the failure is never leakage between them; it is
  selecting the wrong one.
- **`worktree` — which checkout of that project.** Diff-based tools
  (`detect_changes`) shell out to `git diff` and need a working directory.
  Linked worktrees share one object store but hold different files and
  different uncommitted changes.

## Preflight

Run once per task, before the first tool call:

1. Call `list_repos {}` and read `total`.
2. If `total` is 1, use that repository; the `repo` argument may be omitted and
   examples stay as written.
3. If `total` is greater than 1, resolve the intended repository and pass
   `repo` explicitly on **every** subsequent call. Do not infer it from the
   current working directory, and do not let the server pick: an omitted `repo`
   normally errors, but under an MCP policy with a configured default it
   resolves silently to that default.
4. If the intended repository cannot be resolved, stop and ask. An ambiguous
   identity is not a detail to settle later — every result below it inherits
   the ambiguity.
5. If the target repository is absent from `list_repos`, it is not indexed.
   Index it rather than querying a neighbour that happens to share symbol
   names.

`list_repos` is paginated (`limit` default 50, max 200). Page with
`offset: pagination.nextOffset` until `hasMore` is false before concluding a
repository is absent; `total` is the true count regardless of page size.

## Worktree

The server auto-detects a linked worktree only when it was launched from inside
that worktree. When the server runs from the canonical root and your changes
are in a linked worktree, pass `worktree: "<absolute path>"` to
`detect_changes` explicitly.

Omitting it runs `git diff` in the wrong checkout, which reports zero changed
symbols. That zero is indistinguishable in shape from a genuine clean result
and reads as a passed check. Confirm the checkout you are editing is the
checkout that was diffed before treating any empty change set as evidence.

## Index freshness

Identity includes *when*. A correctly bound repository whose index predates the
code answers about the old code. Check the staleness signal — `query`,
`context`, `impact` and `cypher` attach a `staleness` field with
`commitsBehind` when the index is behind HEAD — and refresh with
`node .gitnexus/run.cjs analyze --index-only` in the target checkout before
trusting results. If `.gitnexus/run.cjs` is missing, fall back to the installed
`gitnexus` CLI, then `npx gitnexus`.

## Echo before claiming

State the bound identity before reporting conclusions:

```
Repository: <name> (<path>)   Worktree: <path>   Index: <commit>, <n> behind HEAD
```

Where the identity is partly unresolved, say which part and do not describe the
result as a complete graph-backed answer. This mirrors the provenance rule in
`gitnexus-review`: the graph and the diff must describe the same code, and a
reader must be able to tell from the output whether they did.

## Scope

Bind identity for any task that reads or writes a specific repository. Skip it
only for questions about GitNexus itself that touch no repository data. When
one task legitimately spans two repositories, bind each explicitly and label
which repository each result came from; never blend results from different
repositories into a single undifferentiated list.
