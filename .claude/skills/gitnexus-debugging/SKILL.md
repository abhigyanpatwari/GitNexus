---
name: gitnexus-debugging
description: "Use when the user is debugging a bug, tracing an error, or asking why something fails. Examples: \"Why is X failing?\", \"Where does this error come from?\", \"Trace this bug\""
---

# Debugging with GitNexus

## When to Use

- "Why is this function failing?"
- "Trace where this error comes from"
- "Who calls this method?"
- "This endpoint returns 500"
- Investigating bugs, errors, or unexpected behavior

## Bind the repository first

A root cause traced in the wrong repository is a wrong root cause.

Bind once using a confirmed registry name/path or configured MCP default. Call
`list_repos {}` if the target is not yet known; reuse that binding across calls. With one indexed repository,
use the examples below as written. With more than one, pass `repo` on every
call: an omitted `repo` normally errors, but under an MCP policy with a
configured default it resolves to that default silently. If you cannot tell
which repository is meant, stop and ask. This matters most for `cypher`, whose
statement carries no in-band hint of which database it ran against.

`list_repos` is paginated, so page with `offset: pagination.nextOffset` until
`hasMore` is false before concluding a repository is absent.

A stale index describes the code from before your bug, so refresh before
trusting a trace, and state the repository and index freshness with the
diagnosis.

## Workflow

```
0. Bind the repo once (list_repos only if not already known)
1. If the suspect is unknown, query for the error/symptom with small result limits
2. context({name: "<suspect>"})                    → See callers/callees/processes
3. Read a process resource only if its trace resolves an open question
4. cypher({statement: "MATCH path..."})                 → Custom traces if needed
```

> If "Index is stale" → run `node .gitnexus/run.cjs analyze` in terminal.
> Hot-tool `staleness` names which index answered (`branch`/`lastCommit`) and how fresh it is (`status`). Re-analyze only for `behind` or `diverged` — `current` is identity, `unknown` is unmeasurable.

## Checklist

```
- [ ] Once per session: bind repo; explicit repo when >1 indexed, ask if ambiguous
- [ ] Understand the symptom (error message, unexpected behavior)
- [ ] query for error text or related code
- [ ] Identify the suspect function from returned processes
- [ ] context to see callers and callees
- [ ] Trace execution flow via process resource if applicable
- [ ] cypher for custom call chain traces if needed
- [ ] Read source files to confirm root cause
- [ ] State the repository and index freshness with the diagnosis
```

## Keep investigations focused

Start with a known symbol's `context`, or a small `query` (`limit: 3`,
`max_symbols: 3`, `include_content: false`, `chain_depth: 0`) to discover one.
When the server advertises these single-repository filters, request only the
needed evidence:

```text
context({uid: "<suspect id>", repo: "my-app", include_content: true,
         response_sections: ["outgoing"], relationTypes: ["CALLS"]})
trace({from_uid: "<suspect id>", to_uid: "<failure id>", repo: "my-app"})
```

`symbol` and completeness/staleness diagnostics remain in a filtered context.
`relationTypes` filters the returned incoming/outgoing categories only; it does
not expand their existing bounded window or filter an explicitly requested chain.
For callback registration, include `USES`; for imports or inheritance, request
those relation types or omit the filter. Omitted references are not absent
references. Broaden when the hypothesis needs it, and preserve UNKNOWN/partial
warnings. Confirm source and tests before claiming a root cause. A useful 2–3
call investigation is a goal, not a reason to skip verification or pre-edit impact.

## Debugging Patterns

| Symptom              | GitNexus Approach                                          |
| -------------------- | ---------------------------------------------------------- |
| Error message        | `query` for error text → `context` on throw sites |
| Wrong return value   | `context` on the function → trace callees for data flow    |
| Intermittent failure | `context` → look for external calls, async deps            |
| Performance issue    | `context` → find symbols with many callers (hot paths)     |
| Recent regression    | `detect_changes` to see what your changes affect — pass `worktree` for a linked worktree |
| "How does A reach B?" | `trace` between the two symbols — shortest call chain in one call |

## Tools

**query** — find code related to error:

```
query({search_query: "payment validation error", repo: "my-app"})
→ Processes: CheckoutFlow, ErrorHandling
→ Symbols: validatePayment, handlePaymentError, PaymentException
```

**context** — full context for a suspect:

```
context({name: "validatePayment", repo: "my-app"})
→ Incoming calls: processCheckout, webhookHandler
→ Outgoing calls: verifyCard, fetchRates (external API!)
→ Processes: CheckoutFlow (step 3/7)
```

**cypher** — custom call chain traces. Pass `repo` alongside the statement; the
Cypher text itself names no repository, so the result is unattributable without
it:

```cypher
MATCH path = (a)-[:CodeRelation {type: 'CALLS'}*1..2]->(b:Function {name: "validatePayment"})
RETURN [n IN nodes(path) | n.name] AS chain
```

**trace** — shortest call chain between two symbols ("how does A reach B?"), one call instead of chaining `context` hops:

```
trace({ from: "processCheckout", to: "fetchRates", repo: "my-app" })
→ status: ok, hopCount: 3
→ hops: processCheckout → validatePayment → verifyCard → fetchRates
→ edges: CALLS (1.0), CALLS (0.95), CALLS (1.0)
```

When no path exists, `trace` reports the furthest reachable node — exactly where the chain breaks (dynamic dispatch, reflection, or an external boundary).

## Example: "Payment endpoint returns 500 intermittently"

```
0. list_repos {}
   → total: 2 (my-app, billing-api) — bind my-app explicitly on every call

1. query({search_query: "payment error handling", repo: "my-app"})
   → Processes: CheckoutFlow, ErrorHandling
   → Symbols: validatePayment, handlePaymentError

2. context({name: "validatePayment", repo: "my-app"})
   → Outgoing calls: verifyCard, fetchRates (external API!)

3. READ gitnexus://repo/my-app/process/CheckoutFlow
   → Step 3: validatePayment → calls fetchRates (external)

4. Root cause: fetchRates calls external API without proper timeout
   Repository: my-app  Index: current
```

With a single indexed repository, step 0 returns `total: 1` and the `repo`
argument drops out of every call above.
