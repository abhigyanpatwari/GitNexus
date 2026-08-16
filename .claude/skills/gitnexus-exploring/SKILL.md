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

Step 1 discovers what is indexed; the calls after it must say which of those
they mean. With one indexed repository, use the examples below as written. With
more than one, pass `repo` explicitly on every call — an omitted `repo` errors,
or silently resolves to a configured default — and stop and ask if the intended
repository is ambiguous. See `references/repository-identity.md`.

## Workflow

```
1. list_repos {} or READ gitnexus://repos         → Discover indexed repos; bind one
2. READ gitnexus://repo/{name}/context             → Codebase overview, check staleness
3. query({search_query: "<what you want to understand>"[, repo: "<repo>"]})  → Find related execution flows
4. context({name: "<symbol>"[, repo: "<repo>"]})   → Deep dive on specific symbol
5. READ gitnexus://repo/{name}/process/{name}      → Trace full execution flow
```

> If step 2 says "Index is stale" → run `node .gitnexus/run.cjs analyze` in the bound checkout.

## Checklist

```
- [ ] list_repos {} — bind repo; explicit repo when total > 1, ask if ambiguous
- [ ] READ gitnexus://repo/{name}/context
- [ ] query for the concept you want to understand
- [ ] Review returned processes (execution flows)
- [ ] context on key symbols for callers/callees
- [ ] READ process resource for full execution traces
- [ ] Read source files for implementation details
- [ ] State the repository and index freshness alongside the explanation
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

```
1. list_repos {}                             → total: 1 (my-app) — bind it
   READ gitnexus://repo/my-app/context       → 918 symbols, 45 processes, index current
2. query({search_query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. context({name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
4. Read src/payments/processor.ts for implementation details
5. Answer, noting: Repository my-app, index current
```

Had step 1 returned two repositories, every call above would carry
`repo: "my-app"`.
