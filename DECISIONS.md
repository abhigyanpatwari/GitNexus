# DECISIONS — Zig callable-value references (D1) + false-confidence epistemic (D2)

Unattended run, 2026-09-08. Branch `fix/zig-value-ref-edges`, forked from
`origin/main` @ `0d1aed94`.

Task: a Zig function referenced as a VALUE in a binding table is absent from the
graph, and `impact` reports that absence as `epistemic: "exact"`. Downstream
rejection: lightpanda-io/browser#3399.

---

## Baseline (measured, not quoted)

Local build reports **1.6.11** (expected: `package.json` on main says 1.6.11 and
the 1.6.12-rc.* tags are CI-published without a committed bump).

```
cd ~/code/GitNexus/gitnexus && $HOME/.local/share/mise/installs/node/26.8.1/bin/npm run build   # exit 0
rm -rf ~/code/browser/.gitnexus
cd ~/code/browser && node ~/code/GitNexus/gitnexus/dist/cli/index.js analyze --index-only --skip-agents-md --no-stats
```

Index: **30,222 nodes | 71,070 edges | 997 clusters | 1155 flows** (34.7 s).

| probe (`impact … -d upstream`) | impactedCount | direct | risk | epistemic |
| --- | --- | --- | --- | --- |
| `getNamespaceUri` @ `src/browser/webapi/Element.zig` | 5 | 2 | LOW | `exact` |
| `getTagNameLower` @ `src/browser/webapi/Element.zig` | 30 | 10 | HIGH | `exact` |

`context getNamespaceUri` baseline `incoming.calls`: exactly the two internal
callers, `Element.lookupNamespaceURIForElement` and
`Element.lookupPrefixForElement`. The `JsApi` binding at `Element.zig:2296`
(`pub const namespaceURI = bridge.accessor(Element.getNamespaceUri, null, .{});`)
is absent.

My baseline is **identical** to the indicative npm 1.6.12-rc.7 numbers quoted in
the brief (5/2/LOW/exact and 30/10/HIGH), so the two artifacts agree and the
success criteria carry over unchanged.

---

## Decisions

### D2 — false confidence (`epistemic: "exact"` over unmodelled value references)

**D2-1. Signal source: the GRAPH, not new index metadata.** The `value-ref` →
`USES` edge already carries `reason = 'scope-resolution: value-ref'`, and
`reason` is an existing column of `CodeRelation`. `computeEpistemicBoundary`
probes for inbound edges with that reason and hedges when it finds any.

*Rejected:* a new `RepoMeta` summary in the shape of `unresolvedReceiverMembers`
(a `summarize*` builder + a persisted field + a reader). That is the established
pattern, but it is the pattern for facts that leave NO trace in the graph — a
dropped receiver has no edge to find. A value reference is the opposite: the
reference is modelled, only the invocation through it is not. Reading a fact
that is already in the graph out of a side-channel would add an analyzer change,
a metadata field and a re-index requirement for no extra information.
Consequence: this probe needs no re-index and works on indexes written today.

**D2-2. Its own cause slot, `causes.callableValueReferences`.**
*Rejected:* folding the count into `causes.dispatchBoundary`. That slot is
documented as "implementations plus interface-level consumers"; a value referrer
is neither, and this file's own comments are emphatic that a consumer branching
on the numbers must not be misled about which cause dominates. The distinction
is also actionable: a dispatch boundary is irreducible, a callable value usually
is not (it becomes traceable once the provider models the store/load).
*Also rejected:* a note with no count (the `convexDispatch` precedent, which
sets `dispatch: 0`). That precedent exists because endpoint metadata *cannot*
count omitted symbols. Here the count is available and real, so publishing zero
would be inventing an absence.

**D2-3. Unit = distinct referrer SYMBOLS, capped at 50.** The question the count
serves is "how many places does this value escape from"; a table registering the
same callable twice is still one table. The `LIMIT 50` bounds the work on a
promiscuous target — the note only needs to justify "at least N".

**D2-4. Upstream only.** A reference INTO a symbol says nothing about what that
symbol reaches, so a `downstream` walk is not shortened by it. Same gate the
`convexDispatch` probe already uses.

**D2-5. Shared constant `VALUE_REF_EDGE_REASON`** in a new leaf module
`scope-resolution/value-ref-edges.ts`, imported by the writer
(`passes/property-dispatch.ts`) and the reader (`mcp/local/local-backend.ts`).
*Rejected:* re-typing the literal in the reader. The failure mode of drift is
SILENT — the query matches nothing and every answer goes back to claiming
certainty, which is the defect itself. *Rejected:* importing
`property-dispatch.ts` for the string, which would drag the scope-resolution
emit graph into the MCP backend.

**D2 verified** (read-side only, no re-index needed) against the baseline index:
`impact expectTrue -f src/browser/tests/testing.js -d upstream` — the one JS file
in the browser repo, whose functions ARE registered as object-literal values —
moved `exact` → `lower-bound`, `causes.callableValueReferences: 1`,
`impactedCount` unchanged at 0. `getTagNameLower` unchanged (`exact`).
Test: `test/integration/impact-callable-value-references.test.ts` (5 cases,
including three controls: an ordinary CALLS-only target, a non-value-ref `USES`
edge, and the downstream direction).

