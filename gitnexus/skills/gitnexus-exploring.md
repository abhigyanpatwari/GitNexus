---
name: gitnexus-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this function?\", \"Show me the auth flow\""
---

# Exploring Codebases with GitNexus

## When to Use

- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Bind the repository first

Bind once per session using a confirmed registry name/path or configured MCP
default; reuse it. Call `list_repos {}` when the target is not yet known, not before
every question. Never guess the registry name from the checkout directory. With
one indexed repository, use the examples below as written. With more than one, pass `repo` on every call: an omitted `repo` normally errors,
but under an MCP policy with a configured default it resolves to that default
silently. If you cannot tell which repository is meant, stop and ask. Report
the bound repository and index freshness alongside your explanation.

`list_repos` is paginated, so page with `offset: pagination.nextOffset` until
`hasMore` is false before concluding a repository is absent.

## Workflow

```
1. Bind the repository once; use hot-tool staleness on subsequent calls
2. If no symbol is known: query({search_query: "<concept>", limit: 3, max_symbols: 3})
3. context({uid: "<returned id>"})                → Inspect the selected symbol
4. Read a process resource only when its full trace answers an unresolved question
```

> If the index is stale → run `node .gitnexus/run.cjs analyze` in terminal.
> Hot-tool `staleness` names which index answered (`branch`/`lastCommit`) and how fresh it is (`status`). Re-analyze only for `behind` or `diverged` — `current` is identity, `unknown` is unmeasurable.

## Ask for only the evidence needed

Use options advertised by the connected server. `response_sections` and context
`relationTypes` are opt-in views for a single repository, not `@group` routing.
On an older server, use the existing limits and content/chain options instead.
Use filters when unwanted sections are bulky; their omission metadata can make
an already-small response slightly larger.
Aim for 2–3 focused calls after repository binding; stop when the question is
answered, but expand if evidence or a required safety check is still missing.

```text
query({search_query: "payment retry", repo: "my-app", limit: 3, max_symbols: 3,
       include_content: false, chain_depth: 0,
       response_sections: ["process_symbols", "definitions"]})
context({uid: "<id from query>", repo: "my-app", include_content: true,
         response_sections: ["incoming", "outgoing"], relationTypes: ["CALLS"]})
// Before editing, assess impact using the normal traversal and risk calculation:
impact({target: "<same id>", repo: "my-app", direction: "upstream", summaryOnly: true})
```

If the symbol is already known, start with `context`; use `uid`, or `name` plus
`file_path`/`kind`, to avoid ambiguous results. To answer only “who calls it?”,
request `response_sections: ["incoming"]`, `relationTypes: ["CALLS"]` and leave
`include_content` false. Keep `processes` in a query when the question is about
flows, rather than requesting a symbols-only view.

Do not request source and multi-hop chains for every search hit. Fetch source
for the selected symbol only; for a large class/file, prefer `read_file` with
a small 0-based `startLine`/`endLine` window (subtract 1 from graph line numbers),
or `maxLines` for a whole-file read, if that tool is available. Use
`trace` for a known A→B path instead of repeatedly expanding `context`.

Filters retain requested sections/categories and hide the others; they do not prove other references
are absent or make the existing bounded search exhaustive. Read `response_filter`,
`warning`, `partial`, `truncated`, `epistemic` and `staleness`. Remove filters when
broader evidence is needed. `maxTokens` is a last-resort byte cutoff that can cut
JSON: narrow the request rather than treating a cut response as complete. Never
use a filtered caller view to waive the required impact check or an UNKNOWN risk.

## Checklist

```
- [ ] Once per session: bind repo; explicit repo when >1 indexed, ask if ambiguous
- [ ] Check hot-tool staleness; read the overview only if needed
- [ ] Query for the concept only if the relevant symbol is not already known
- [ ] Review returned symbols; include processes when execution flow matters
- [ ] context on selected symbols; request only relevant sections/relations
- [ ] Read a process resource only if its full trace is needed
- [ ] Read targeted source only when implementation details are needed
- [ ] State the repository and index freshness with the explanation
```

## Resources

| Resource                                | What you get                                            |
| --------------------------------------- | ------------------------------------------------------- |
| `gitnexus://repo/{name}/context`        | Stats, staleness warning (~150 tokens)                  |
| `gitnexus://repo/{name}/clusters`       | All functional areas with cohesion scores (~300 tokens) |
| `gitnexus://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens)              |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens)              |

## Tools

**query** — find execution flows related to a concept:

```
query({search_query: "payment processing", repo: "my-app"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**context** — 360-degree view of a symbol:

```
context({name: "validateUser", repo: "my-app"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

`repo` is required once more than one repository is indexed, and may be omitted
with a single one.

## Example: "How does payment processing work?"

With `my-app` already bound and the index current:

```text
1. query({search_query: "payment processing", repo: "my-app", limit: 3, max_symbols: 3})
   → CheckoutFlow and RefundFlow, with symbol IDs and locations
2. context({uid: "<processPayment id>", repo: "my-app", include_content: true,
            response_sections: ["outgoing", "processes"]})
   → Selected source, callees, process participation and completeness diagnostics
3. Answer from that evidence; read one process resource only if its trace is still needed
```

Report the repository and index freshness with the explanation. If `my-app`
had not yet been bound, discover it once with `list_repos` first.
