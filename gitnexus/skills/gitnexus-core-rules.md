# GitNexus — Core Rules (All Projects)

**Source:** AGENTS.md (canonical)

Last reviewed: 2026-03-25

## Non-negotiables (MUST follow)

- **NEVER edit a function/class/method without running `gitnexus_impact` first.**
- **NEVER rename symbols with find-and-replace** — use `gitnexus_rename`.
- **NEVER commit without running `gitnexus_detect_changes()`.**
- **NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.**
- **NEVER run `npx gitnexus analyze` without `--embeddings`** if `.gitnexus/meta.json` shows stored embeddings.

## Multi-Repository Support

- **ALWAYS start with repo discovery:** `READ gitnexus://repos` to check if multiple repos are indexed
- **If multiple repos exist:** Add `repo: "name"` parameter to ALL GitNexus tool calls
- **Resource URIs:** Use actual repo names from discovery, not `{repoName}` placeholders
- **Single repo:** The `repo` parameter is optional and can be omitted

### Repo Discovery Pattern

1. `READ gitnexus://repos` → Get list of indexed repositories
2. If count > 1: Identify target repo, add `repo: "name"` to all subsequent calls
3. If count = 1: Proceed without `repo` parameter (optional)

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `READ gitnexus://repos` — discover indexed repos (if multiple)
2. `gitnexus_query({query: "<error or symptom>", repo: "name"})` — find execution flows related to the issue
3. `gitnexus_context({name: "<suspect function>", repo: "name"})` — see all callers, callees, and process participation
4. `READ gitnexus://repo/{name}/process/{processName}` — trace the full execution flow step by step (use actual repo name)
5. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main", repo: "name"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true, repo: "name"})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target", repo: "name"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream", repo: "name"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all", repo: "name"})` to verify only expected files changed.
- **Note:** Add `repo: "name"` parameter if multiple repos are indexed.

## Tools Quick Reference

| Tool | When to use | Single Repo | Multiple Repos |
|------|-------------|-------------|----------------|
| `list_repos` | Discover indexed repos | `list_repos()` | `list_repos()` |
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` | `gitnexus_query({query: "auth validation", repo: "myapp"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` | `gitnexus_context({name: "validateUser", repo: "myapp"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` | `gitnexus_impact({target: "X", direction: "upstream", repo: "myapp"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` | `gitnexus_detect_changes({scope: "staged", repo: "myapp"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true, repo: "myapp"})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` | `gitnexus_cypher({query: "MATCH ...", repo: "myapp"})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings).