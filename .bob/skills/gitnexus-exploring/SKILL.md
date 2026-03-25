---
name: gitnexus-exploring
description: Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: "How does X work?", "What calls this function?", "Show me the auth flow"
---

# GitNexus Exploring Workflow

Use this skill when exploring code architecture, understanding execution flows, or investigating unfamiliar parts of the codebase.

## When to Use

- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Workflow

1. **READ gitnexus://repos** → Discover indexed repos
2. **READ gitnexus://repo/{name}/context** → Codebase overview, check staleness
3. **gitnexus_query({query: "<what you want to understand>"})** → Find related execution flows
4. **gitnexus_context({name: "<symbol>"})** → Dive on specific symbol
5. **READ gitnexus://repo/{name}/process/{name}** → Trace full execution flow

If step 2 says "Index is stale" → run `npx gitnexus analyze` in terminal.

## Checklist

- [ ] READ repos resource to discover available repositories
- [ ] READ context resource for codebase overview
- [ ] Use query tool to find execution flows related to concept
- [ ] Use context tool for 360-degree view of key symbols
- [ ] READ process resource for full execution traces
- [ ] Read source files for implementation details

## Resources

| Resource | What you get |
|----------|--------------|
| `gitnexus://repo/{name}/context` | Stats, staleness warning (~150 tokens) |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores (~300 tokens) |
| `gitnexus://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens) |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens) |

## Tools

**gitnexus_query** — find execution flows related to a concept:

```
gitnexus_query({query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**gitnexus_context** — 360-degree symbol view — categorized refs, processes it participates in:

```
gitnexus_context({name: "validateUser"})
→ Callers, callees, imports, process participation
→ Categorized incoming/outgoing references