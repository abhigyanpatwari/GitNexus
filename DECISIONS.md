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


### D1 — the missing edge (Zig emits `value-ref`)

**D1-1. Query rules only; no new capture machinery.** Three rules added to
`ZIG_SCOPE_QUERY`, tagging `@reference.name @reference.value-ref`. Everything
downstream already existed: `referenceKindFromAnchor` → `'value-ref'` →
`mapReferenceKindToEdgeType` → `USES`, resolved by the property-dispatch pass.
Zero changes to `captures.ts`, to `callable-flow-captures.ts`, to the schema, or
to any edge kind.

*Rejected:* extending `zigCallableCaptureOptions` / `synthesizeCallableFlowCaptures`
(the cell/site model). That machinery exists to trace a value to its INVOKE site
and emit CALLS — which is the explicit non-goal here, needs comptime evaluation,
and already reports its own all-or-nothing failure (`callable-value-flow:
candidate set exceeded the cap`). The task is to stop dropping the reference,
and a reference is exactly what `value-ref` is for.

**D1-2. The callee must be consumed by `function:`.** In tree-sitter-zig,
call arguments are DIRECT children of `call_expression` — there is no `arguments`
node (only builtins have one; verified against the grammar). A naive
`(call_expression (identifier) @x)` therefore also matches the callee of
`foo(bar)`, minting a USES edge that shadows the call's own CALLS edge. Binding
`function: (_)` consumes it. Pinned by a test
(`does not mint a value reference for the CALLEE of an ordinary call`).

**D1-3. Both the bare and the qualified argument shape.** The motivating line is
qualified (`bridge.accessor(Element.getNamespaceUri, …)`) and its sibling is bare
(`bridge.accessor(_tagName, …)`); the real table uses both. For the qualified
form `@reference.name` is the MEMBER and the object is captured as
`@reference.receiver`, because the member is the name the scope walk resolves.
*Trade-off accepted:* the property-dispatch pass ignores the receiver, so a
qualified reference resolves by tail name and could in principle bind a
same-named local callable. Measured on the real corpus this does not bite: all
3,169 emitted edges land on `Method` (3,146) or `Function` (23), and the
94 registrations in `Element.zig`'s `JsApi` read as the DOM Element API surface
one for one. *Rejected:* resolving through the receiver — that is the
receiver-bound-call path, a much larger change, and the callable gate already
carries the precision.

**D1-4. Rules are deliberately broad; the CALLABLE GATE is the filter.**
`js.Bridge(Element)` and `register(count)` match too. `findCallableBindingInScope`
keeps only Function/Method/Constructor, so they emit nothing — the same design
that stops TypeScript's `{ port: DEFAULT_PORT }` from registering anything
(tie-breaker 2: consistency with how TS/JS already emit `value-ref`).

**D1-5. No `@reference.property-key`.** Zig has no object-literal key to
dispatch through, so these register a reference and never synthesize CALLS.
`emitPropertyDispatchCalls` already skips the registration index when
`propertyKey` is undefined, and still emits the USES edge.

**D1-6. Fixture lives in the EXISTING `zig-idioms` corpus**, as
`src/webapi/Element.zig`, alongside the `AbortController`/`AbortSignal` JsApi
files already there. *Rejected:* a new `zig-callable-values/` fixture directory —
`bench/receiver-resolution` uses `test/fixtures/lang-resolution` as its `--check`
corpus, so every added fixture risks moving `countArm`. Measured after the fact:
it did not move (`[receiver-resolution] OK — shape states and call-drop counts
match baseline`), so no rebaseline was needed either way.

---

## Measured result — D1 + D2 together

Re-analyzed from scratch (`rm -rf ~/code/browser/.gitnexus`) with the same
command as the baseline.

| | baseline | after | delta |
| --- | --- | --- | --- |
| index | 30,222 nodes / 71,070 edges | 30,222 nodes / 74,229 edges | **+3,159 edges, 0 nodes** |
| `getNamespaceUri` impactedCount | 5 | 7 | +2 |
| `getNamespaceUri` direct | 2 | 3 | +1 |
| `getNamespaceUri` risk | LOW | LOW | — |
| `getNamespaceUri` **epistemic** | **`exact`** | **`lower-bound`** | the fix |
| `getTagNameLower` impactedCount | 30 | 31 | +1 (explained below) |
| `getTagNameLower` direct / risk / epistemic | 10 / HIGH / `exact` | 10 / HIGH / `exact` | unchanged |

**The +3,159 edges are fully accounted for.** Per-type counts in the new index:
`USES` = 3,169 and value-ref edges = 3,169 — i.e. every USES edge in this repo is
a value reference. The baseline had 10 (all from the single `.js` file,
`src/browser/tests/testing.js`), which still has exactly 10. `CALLS` (25,649),
`ACCESSES`, `IMPORTS`, `HAS_METHOD`, `DEFINES`, … did not move. The change is
purely additive and confined to `USES`.

**`getTagNameLower` +1, explained.** The single added entry is at depth 2:
`USES Struct:src/browser/webapi/Element.zig:JsApi`. `JsApi` registers 94
accessors, three of which (`Element.getLocalName`, `Element._prefix`,
`Element.getTagNameDump`) are depth-1 callers of `getTagNameLower`. So the
binding table genuinely does sit two hops upstream of it, and one node is the
correct amount to add. `direct` (10), `risk` (HIGH) and `epistemic` (`exact`)
are all unchanged — and `exact` is the meaningful half of the control: the hedge
is targeted at symbols with an INBOUND value reference, not sprayed over
everything the change touches. `getTagNameLower` is registered nowhere, so it
keeps its certainty. I am recording the +1 rather than calling the control
"unchanged", because it is a real new fact of exactly the kind D1 exists to
record.

## Gates

- `npm run build` — clean; `tsc --noEmit -p tsconfig.json` — clean.
  (`tsconfig.test.json` has ~1,194 pre-existing errors across the fixture tree
  and test helpers on `origin/main`; none are in the files this branch touches,
  and no npm script or CI job runs it.)
- Bench `--check` gates, all PASS with **no baseline edited**: `scope-capture`
  (15 languages), `receiver-resolution`, `zig-cross-file-resolution`,
  `scope-emission`, `python-scope`, `callable-value-flow`, `import-target`,
  `emit-persistence`, `finalize-reexport`, `cpp-qualified-ns`,
  `parse-dispatch-rounds`, `spring-config-bindings`.
- `npx vitest run` (full suite): **20,552 passed / 10 failed / 78 skipped**
  (20,640 tests, 1,005 files, ~17 min).

  All 10 failures are **pre-existing on `origin/main` and machine-specific**.
  Verified, not assumed: I stashed the branch, checked out `0d1aed94`
  (`origin/main`), rebuilt, and re-ran the six affected files — the **same 10
  tests fail, identically**. They are:

  | file | tests | cause |
  | --- | --- | --- |
  | `analyzer-identity` | 4 | macOS realpath `/var` vs `/private/var` |
  | `analyzer-identity-in-process-guards` | 2 | EACCES cases, #3092 |
  | `hooks-e2e` | 2 | "prefers pnpm dlx" — local `pnpm` shim is 1.40.0, below the ≥10.2 gate |
  | `evidence-provenance-helper` | 1 | golden digest |
  | `review-agent-workflow` | 1 | pinned-install retry helper |

  None is in a file or dependency cone this branch touches.
- Targeted re-run of every suite that exercises `value-ref`, after the final
  build: `resolvers/zig`, `impact-callable-value-references`,
  `resolvers/typescript-value-refs`, `resolvers/value-ref-locality`,
  `resolvers/cpp`, `resolvers/typescript` — **734 / 734 passed**.

## Nothing marked UNRESOLVED or BLOCKED

Every fork above was decided and recorded. No gate failed three times; no gate
needed a baseline edit.
