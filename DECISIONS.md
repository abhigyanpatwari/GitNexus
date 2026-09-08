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

Measured against a clean index of `lightpanda-io/browser` (the repo #3399 was
filed from), built from this checkout:

```
cd <gitnexus>/gitnexus && npm run build            # exit 0
rm -rf <browser>/.gitnexus                         # cold index: see D1-note below
cd <browser> && node <gitnexus>/gitnexus/dist/cli/index.js \
  analyze --index-only --skip-agents-md --no-stats
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

**D2-3. Unit = distinct referrer SYMBOLS.** The question the count serves is
"how many places does this value escape from"; a table registering the same
callable twice is still one table. *Originally decided with a `LIMIT 50` to
bound the work; **superseded by R1-5**, which replaced it with
`COUNT(DISTINCT other.id)` after the review pointed out that a capped row count
published a ceiling under a name documented as a symbol count. The current code
has no cap.*

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
*Trade-off originally accepted:* the property-dispatch pass ignored the receiver,
so a qualified reference resolved by tail name and could in principle bind a
same-named local callable. Measured on the real corpus at the time this did not
appear to bite: all 3,169 emitted edges landed on `Method` (3,146) or `Function`
(23), and the 94 registrations in `Element.zig`'s `JsApi` read as the DOM
Element API surface one for one. *Rejected at the time:* resolving through the
receiver.

***Superseded by R1-2 and R2-2.*** The trade-off was wrong: the bot's
counter-example reproduced, so the pass now resolves a qualified site through its
written owner — a class-like container (R1-2) or a module handle (R2-2) — and
declines rather than falling back to the lexical walk. The receiver is no longer
ignored, and the corpus census that justified the original decision is recorded
under R1-2 as the measurement of what declining costs.

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

Re-analyzed from scratch (`rm -rf <browser>/.gitnexus`) with the same
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

---

## Review round 1 — `gitnexus-check` bot on PR #3219

Five findings. I reproduced each against the code before deciding; four were
valid and are fixed, one was valid and is fixed differently than proposed.

**R1-1 (valid, fixed) — a failed probe read as "no boundary".**
`callableValueReferenceBoundaries` did `.catch(() => [])`, so a query that could
not run produced count 0 and no note, and `epistemicFrom` could then publish
`exact`. That is the exact failure this feature exists to remove, and this
file's own `loadMeta` comment states the rule: "a probe failing must never read
as certainty". Now: `.catch(() => null)`, and `null` emits a boundary note
("could not be run") with count 0. Three outcomes, three answers — cannot run →
hedge; measured zero → no hedge; followed → no hedge.
Test: `hedges — never reports exact — when the probe itself cannot run`, which
injects a rejection into that one query (keyed on the bound `$reason` param) and
leaves every other query on the real database.

**R1-2 (valid, REPRODUCED, fixed) — qualified references resolved by tail name.**
The bot claimed `Element.getNamespaceUri` could bind a lexically nearer
same-named callable. I built the fixture and it reproduced exactly:

    const Element = @This();
    pub fn getThing(...)             // Method:src/main.zig:main.getThing#0
    pub const JsApi = struct {
        fn getThing(...)             // Method:src/main.zig:JsApi.getThing#0
        pub const thing = bridge.accessor(Element.getThing, null, .{});
    };

→ `USES JsApi → Method:src/main.zig:JsApi.getThing#0`. A **wrong** edge, which
is worse than the missing edge this PR set out to fix.

Fixed in the language-neutral pass: `resolveValueRefTarget` in
`property-dispatch.ts` resolves a site with an explicit receiver through
`findClassBindingInScope` → `findOwnedMember` (the machinery
`receiver-bound-calls` already uses), gated on `CALL_TARGET_TYPES` because
`findOwnedMember` also answers with fields. A bare site keeps the lexical walk,
which is what an unqualified name means.

*Rejected: falling back to the lexical walk when the receiver does not resolve.*
It would have kept ~370 more edges, but it reinstates the wrong-edge case
exactly where the evidence is weakest. Declining costs a reference; falling back
mints a confident edge to the wrong function, and a reference that is now
missing is reported as `lower-bound` rather than as certainty.

Measured cost of that choice on the real corpus: value-ref edges
**3,169 → 2,799** (−370, −12%). Verified those 370 were tail-name coincidences,
not real registrations:
- all 94 `Element.zig` `JsApi` registrations survive;
- the cross-container case resolves and is correctly attributed —
  `IntersectionObserverEntry.JsApi → IntersectionObserverEntry.getTarget#0`, not
  the enclosing `IntersectionObserver`;
- source-level census of the corpus: 2,010 qualified `bridge.*` registrations,
  1,812 self-owner + 198 cross-container, and the sampled cross-container ones
  all resolve.
- both acceptance probes are unchanged by the fix: `getNamespaceUri` 7 / 3 /
  LOW / `lower-bound`, `getTagNameLower` 31 / 10 / HIGH / `exact`.

*Known limitation, deliberately not fixed:* when a `@This()` alias's NAME
differs from its container's (`const Element = @This();` inside `main.zig`), the
receiver does not resolve and the reference is declined. The provider has
`rewriteZigThisAlias` for exactly this, but it is applied to TYPE nodes and
extending it to reference receivers would change existing CALL-site behaviour —
out of scope here. Lightpanda's convention (`const Foo = @This();` in `Foo.zig`)
makes the names coincide, which is why the corpus is unaffected. The safe
behaviour is pinned by
`declines a qualified reference whose receiver cannot be resolved`.

**R1-3 (valid, fixed as proposed) — the test did not assert the caller count.**
Its own comment promised the count would not move; only the epistemic envelope
was asserted. Added `expect(result.impactedCount).toBe(2)` — the bot's proposed
value, confirmed by running it.

**R1-4 (valid, fixed) — not every value reference is an unmodelled invocation.**
`emitPropertyDispatchCalls` sweep 2 synthesizes CALLS (reason
`property-dispatch`) for member calls through a registered property key. Where
that happened the walk did NOT provably miss the caller, so hedging is noise
over an answer that was computed — and a signal that fires on every JS/TS hook
table stops carrying information. A second probe now excludes targets with an
inbound `property-dispatch` CALLS edge. Zig never sets a property key, so the
motivating case is untouched.
*Accepted residual, documented in the code:* the exclusion is symbol-level, not
per-edge — the graph does not record which registration produced which
synthesized call — so a target with a mix of followed and unfollowed
registrations is not hedged. That is the one place this errs toward confidence;
the alternative errs on every hook table in every JS codebase.

**R1-5 (valid, fixed) — `LIMIT 50` silently understated the count.**
`rows.length` over a capped row set published a ceiling as if it were the
documented symbol count. Replaced with `COUNT(DISTINCT other.id)` — bounded work
without a bounded answer, the shape `countByType` in the same file already uses.
The cap is gone rather than merely disclosed.

`tools.ts` cause documentation updated for all three new behaviours (exact
count, dispatch-modelled zero, probe-failure zero-with-note).

### Gates after review round 1

- Full `vitest run`: **20,634 passed / 10 failed / 20,644 total** — the SAME 10
  pre-existing failures verified against `origin/main` earlier, no new ones.
- One earlier run showed an 11th failure (`fts-extension-e2e` #2841). That was
  self-inflicted: I ran the browser `analyze` and cypher queries CONCURRENTLY
  with the suite. Run alone that test passes and two *network-dependent*
  self-heal tests fail instead; a clean full run with nothing else touching the
  machine reproduces exactly the 10. Recorded because it is the trap the
  machine notes already describe for `cli-e2e` / `analyze-index-lock-concurrency`.
- Bench `--check` re-run after the receiver fix: `scope-capture` (15 languages),
  `receiver-resolution`, `zig-cross-file-resolution`, `callable-value-flow`,
  `scope-emission`, `python-scope` — all PASS, no baseline edited.

---

## Review round 2 — PR #3219 tri-engine digest

Four inline items (one P1, two P2, one P3), plus a documented residual. Each was
reproduced against the worktree before deciding.

**R2-1 (valid, fixed) — the new captures could stay INERT on a warm parse cache.**
The headline finding, and the one that mattered: `ZIG_SCOPE_QUERY` now emits
`@reference.value-ref`, which changes `ParsedFile.referenceSites` — a PARSE-TIME
fact. `SCHEMA_BUMP` was left at 93, so a repo indexed before this change and
re-analyzed after it replays the old, empty site list for every unchanged `.zig`
file, `--force` included (shards are content-addressed). No USES edge, a real
measured zero at the probe, and `impact` back to `epistemic: "exact"` — #3399
un-fixed on exactly the incremental path most users are on, with every cold-run
test green. D1-1's claim of "zero changes to … the schema" conflated the graph
schema with the cache schema; only the first was true.

Bumped 93 → **98**, not 94: #3190 claims 94 and #3179 claims 94 through 97 in one
PR. `incremental-parse-cache.test.ts` re-pinned to 98 with 93–97 added to the
taken list. **Re-check against `origin/main` and open PRs immediately before
merging** — the ledger in that test records two PRs that each did this check once
and still collided.

**R2-2 (valid, REPRODUCED, fixed) — a qualified value-ref through a MODULE was
declined with no hedge.** R1-2 resolves a written receiver through
`findClassBindingInScope`, which requires `isClassLike`. A namespace-only
`@import` handle is not class-like:

    const dom_utils = @import("dom_utils.zig");   // no `@This()` in that file
    pub const comparator = bridge.accessor(dom_utils.compare, null, .{});

resolved to nothing. That is not the conservative half of R1-2's trade-off: a
declined site emits NO edge, so the boundary probe measures a real zero and
`impact` on `compare` reports `exact`. Silence, not a hedge — and the pass
comment claiming otherwise was wrong on this path (fixed).

`resolveValueRefTarget` now tries the second kind of owner a qualified name can
have. `findNamespaceValueRefTarget` reads the file's `namespace` import edges for
the handle and the target module's own `origin: 'local'` module-scope bindings
for the member — the same channel `receiver-bound-calls` Case 1 already trusts
for `dom_utils.compare()`. The three guards are Case 1's, for Case 1's reasons:
`isNamespaceNameShadowed` (a local declaration shadowing the handle suppresses
it), `origin === 'local'` only (a name the target merely imported is not
published as its own — the `namespaceExportsIncludeImportedNames` hub opt-in is a
provider decision this language-neutral pass does not make), and two distinct
defs under one name resolve nothing.

*Rejected:* the alternative the review offered — persisting hedgeable evidence
for declined sites so `impact` cannot stay `exact`. It needs a new metadata
channel and a re-index (the thing D2-1 was written to avoid) to publish a hedge
in the one case where the answer is actually knowable. Resolving the reference is
both cheaper and strictly more informative.

Fixture: `src/webapi/dom_utils.zig` (namespace-only) plus three cases in
`Element.zig` — the module-qualified registration, a non-callable module member
(`dom_utils.DEFAULT_NS`, the callable gate applies to module owners too), and a
`u8` parameter shadowing the handle. All three pinned in
`resolvers/zig.test.ts`; the shadow case was verified to FAIL with the guard
disabled, so it is not passing for an unrelated reason.

*Still declined, deliberately:* a receiver this index knows under no name at all
— the `@This()`-alias case R1-2 already recorded, and owners outside the
workspace. There the alternative is not a hedge either, it is a confident edge to
a lexically-nearer function the source did not name.

**R2-3 (valid, fixed as proposed) — the new suite was in neither vitest list.**
`impact-callable-value-references.test.ts` uses `withTestLbugDB(poolAdapter: true)`,
so TESTING.md puts it in the `lbug-db` project's include list and the `default`
project's exclude list. It was in neither, so `default`'s `test/**/*.test.ts`
also collected it into the parallel pool — the mmap file-lock flake class that
project exists to serialize. Added next to its `impact-epistemic-lower-bound`
sibling in both arrays.

**R2-4 (valid, fixed) — this file was stale against HEAD and embedded host paths.**
D2-3 still described the `LIMIT 50` that R1-5 removed and D1-3 still described the
receiver-blind resolution that R1-2 replaced; both now carry explicit *superseded
by* pointers rather than reading as current decisions. The three `~/code/...` and
mise-node paths in the baseline block are replaced with `<gitnexus>` / `<browser>`
placeholders (CONTRIBUTING.md: no machine-specific paths).

**Residual, re-affirmed not re-litigated — mixed followed/unfollowed
registrations.** R1-4's exclusion is symbol-level: any inbound `property-dispatch`
CALLS edge zeroes the note. A target with both a followed registration and an
unfollowed escape is therefore not hedged. Two engines rated this P1-to-P3; the
reasoning in R1-4 stands unchanged, and the alternative still fires on every
JS/TS hook table in every codebase. It is a JS/TS shape, not the Zig case this PR
exists for. Documented in the code at the exclusion site.

### Gates after review round 2

- `tsc --noEmit -p tsconfig.json` — clean. `npm run build` — clean.
- `resolvers/zig.test.ts` — 98 passed / 1 skipped, including the three new
  module-owner cases.

---

## Review round 3 — `gitnexus-check` bot on PR #3219 (head `cf53bbaa`)

Three findings: one Error, one Warning, one Nit. Each reproduced against the
code before deciding; two were valid, one is correct about the mechanism but
unreachable in the current rule set.

**R3-1 (valid, REPRODUCED, fixed) — a CLASS receiver could resolve through a
shadowing value binding.** R1-2 resolves a written receiver with
`findClassBindingInScope`, which is a class-ONLY walk: `walkScopeChain` filters
by `isClassLike`, so it steps over a nearer binding that is a value and keeps
climbing — and past the scope chain entirely, into a qualified-name fallback
that answers with the unique workspace definition of the name. So:

    // Ticker.zig  — a file-struct `Element.zig` never imports
    const Ticker = @This();
    pub fn fire(self: *Ticker) u8 { … }

    // Element.zig
    pub fn shadowsAContainerName(Ticker: u8) u8 {
        register(Ticker.fire);      // ← USES → Ticker.zig's `fire`
    }

emitted a confident edge to a function from a file this one neither declares nor
imports. That is precisely the wrong-edge failure R1-2 exists to prevent,
arriving through the class channel instead of the lexical one. Reproduced with
the fixture above before any fix; the test fails without the guard.

Fixed with `isOwnerNameShadowedBySomethingElse` in `scope/walkers.ts` — a
sibling of `isNamespaceNameShadowed` with one extra clause. The plain namespace
guard could NOT be reused: a container is often its own local declaration
(`fn make() { const Local = struct {…}; register(Local.go); }`), and reading that
binding as its own shadow suppresses exactly the resolutions the path exists to
make. So a scope that binds the name answers immediately, and the answer is "not
shadowed" only when one of that scope's own bindings IS the def just resolved.
Both halves are pinned, and both were verified to fail when the guard is
weakened: the parameter case fails with no guard, the local-container case fails
with the plain `isNamespaceNameShadowed`.

**R3-2 (mechanism correct, not reachable today; fragility fixed instead) — the
dispatch exclusion could suppress an unfollowed registration.** The bot is right
about the code: sweep 2 synthesizes CALLS only for a registration whose site
carried a `propertyKey`, so an unkeyed registration can never be followed, while
the exclusion zeroes the note on ANY inbound `property-dispatch` CALLS edge.

It is not reachable in the current rule set, and the reason is measured rather
than assumed: `@reference.value-ref` is emitted by exactly three languages —
JavaScript (2 rules), TypeScript (2), Zig (3) — and every JS/TS rule also
captures `@reference.property-key` (both are object-literal shapes) while no Zig
rule does (Zig has no object-literal key). So a dispatchable registration is
always a JS/TS one, an undispatchable registration is always a Zig one, and the
two cannot meet on one symbol.

*Rejected:* splitting the edge `reason` into dispatchable / undispatchable now.
It is the precise fix, but it is a graph-content change that churns whichever
side keeps the old literal — the Zig, TypeScript and probe suites all pin
`'scope-resolution: value-ref'` by hand as a drift canary — and it buys nothing
against a case no rule can produce.

*What was actually wrong* is that the exclusion's soundness rested on a
coincidence recorded nowhere, in files that no one reading `local-backend.ts`
would open. Fixed at both ends: the exclusion site now states the invariant, the
three facts it rests on, and the two options for when it breaks; and
`test/unit/scope-resolution/value-ref-dispatchability.test.ts` FAILS the day it
does — a JS/TS rule for a bare callback argument, a Zig rule that grows a key, or
a fourth language emitting `value-ref` at all. Verified to fire: adding a
property key to a Zig value-ref rule fails the Zig case, and the splitter has its
own guard test so it cannot pass vacuously. `ZIG_SCOPE_QUERY` is exported for
that test only.

**R3-3 (valid, fixed) — a test comment claimed the wrong epistemic result.**
The `declines a qualified reference whose receiver cannot be resolved` case said
the shortfall shows up as `lower-bound`. It does not: with no edge there is no
evidence, and the target stays `exact`. The pass docstring was corrected in round
2 and the test comment was missed. It now states that the decline costs the
reference AND the hedge, and why that is still the right trade.

### Gates after review round 3

- `tsc --noEmit` clean, `npm run build` clean, `prettier --check` clean.
- `test/integration/resolvers` — 3,632 passed / 3 skipped (70 files).
- `test/unit/scope-resolution` — 2,015 passed (120 files).
- `impact-callable-value-references` under `lbug-db` — 7 passed.
- Bench `--check`: `receiver-resolution`, `zig-cross-file-resolution`,
  `scope-capture` (15 languages), `scope-emission` PASS, no baseline edited.
  `callable-value-flow` failed once on its TIMING budget (widening overhead
  2.006 > 1.9) with a byte-identical fingerprint, then passed twice at 1.788 /
  1.813 — machine load, not a regression.

---

## Review round 4 — local preflight, before pushing

`gitnexus-check[bot]` is a hosted GitHub App and cannot be run locally, so the
`.local-preflight/` harness (out of git) reproduces the two halves its output is
built from: the deterministic gates and blast radius off this checkout's own
graph, and an LLM reviewer pointed at the failure classes this bot has actually
reported here. Run on `3bd1337a` it returned five findings; one was a real hole
in R2-2, which is the point of running it before pushing rather than after.

**R4-1 (valid, REPRODUCED, fixed) — the container channel preempted the file's
own `@import`.** R2-2 added the module channel as a FALLBACK after
`findClassBindingInScope`. That is the wrong order, because
`findClassBindingInScope` does not stop at the scope chain: when its `isClassLike`
walk misses — and a namespace handle binds a Module, so it always misses — it
falls back to `scopes.qualifiedNames`, a workspace-wide index, and answers with
the unique def of that name anywhere in the repo. So:

    // decoy.zig — never imported by Element.zig
    pub const dom_utils = struct { pub fn compare(a: u8, b: u8) u8 {…} };

    // Element.zig
    const dom_utils = @import("dom_utils.zig");
    pub const comparator = bridge.accessor(dom_utils.compare, null, .{});

bound `Method:src/webapi/decoy.zig:dom_utils.compare#2` — a wrong edge, and the
module channel that would have answered correctly was never reached. R3-1's
shadow guard cannot catch it either: the import binds at MODULE scope, which the
guard treats as the floor.

Fixed by trying the module channel FIRST. An import written in this file is the
strongest available statement about what the name means here, and it outranks a
global uniqueness guess; when the handle is not an import of this file the
channel answers nothing and the container path runs exactly as before. Pinned by
`decoy.zig` plus a strengthened assertion on the existing module-owner test,
which fails on the old order.

**R4-2 (valid, fixed) — the cause documentation named shapes nothing captures.**
`tools.ts` illustrated `callableValueReferences` with "a callback argument", "a
stored function pointer" and `qsort(xs, n, sz, compareItems)`. Only Zig captures
a call argument or a const initialiser; JS/TS capture only object-literal
property values, and C has no value-ref rule at all, so the `qsort` example is
counted in no language. Both cause blocks now name the shapes that are actually
captured and say plainly that a bare JS/TS callback argument is not among them,
so a 0 does not rule it out.

**R4-3 (valid, fixed) — the same block exempted itself from the re-index caveat
this PR proves it needs.** "Read from the graph, so it needs no index-time
metadata" is true of the probe and false of the edges: an index built before a
language emitted these captures has none and reports 0 — which is exactly the
warm-cache failure R2-1 bumped `SCHEMA_BUMP` for. The doc now says to re-analyze
before reading a 0 as measured.

**R4-4 (valid, fixed) — the dispatchability canary was narrower than its own
promise.** Its header said it fails on "a fourth language emitting `value-ref` at
all"; it reads `languages/<dir>/query.ts`, so Vue — which owns no query and
borrows `emitTsScopeCaptures` / `emitJsScopeCaptures` — emits value-refs while
the assertion lists three languages, and a capture synthesized in code (the
mechanism `@reference.static-gated` uses) is invisible to it entirely. The case
now asserts on query OWNERS, which is what it actually checks and is sound
because a delegating language inherits the classification of the rules it
borrows, and the header states the synthesized-capture gap rather than leaving a
green tick to imply it away.

**R4-5 (valid, fixed as documentation) — the BARE docstring described a lexical
walk that is not one.** "resolved up the lexical chain, which is what an
unqualified name means" — `findCallableBindingInScope` applies the callable
predicate WHILE walking, so a nearer parameter or local is stepped over. Same
defect R3-1 fixed on the container channel, unguarded here, pre-existing since
#2437 and reachable in JS/TS. Out of scope for #3399, so the behaviour is
unchanged and the sentence now says what the walk does instead of implying a
guarantee it does not give.

### Gates after review round 4

- `tsc --noEmit` clean, `npm run build` clean, `prettier --check` clean.
- `test/integration/resolvers` — 3,632 passed / 3 skipped (70 files).
- `test/unit/scope-resolution` — 2,015 passed (120 files).
- `impact-callable-value-references` under `lbug-db` — 7 passed.
- Bench `--check`: `receiver-resolution`, `zig-cross-file-resolution`,
  `scope-capture` (15 languages), `scope-emission`, `callable-value-flow` all
  PASS, no baseline edited.

---

## Review round 5 — `gitnexus-check` bot on PR #3219 (head `1c7c05ff`)

One finding, valid and reproduced.

**R5-1 (valid, REPRODUCED, fixed) — a hub module's re-exports resolved for the
CALL form and declined for the REGISTRATION form.** `findNamespaceValueRefTarget`
accepted only `ref.origin === 'local'`. R2-2 recorded that as deliberate — "the
`namespaceExportsIncludeImportedNames` hub opt-in is a provider decision this
language-neutral pass does not make" — and that reasoning was wrong twice over.
Zig sets the flag (`languages/zig/scope-resolver.ts:41`, measured on ghostty and
tigerbeetle before it landed), and the pass DOES have the provider in scope:
`runScopeResolution` takes one and already forwards several of its hooks.

The result was the exact asymmetry R2-2 argued against in its own first
paragraph. A Zig hub declares nothing — every name it publishes it imported —
so requiring a local declaration declines every member reached through one:

    // hub.zig
    pub const scale = @import("dom_utils.zig").scale;

    // Element.zig
    const hub = @import("hub.zig");
    pub fn callsThroughTheHub(v: u8) u8 { return hub.scale(v); }   // resolved
    pub const scaled = bridge.accessor(hub.scale, null, .{});      // declined

One name meaning two different things depending on whether a `(` follows it.
Reproduced with that fixture before any fix.

Fixed by forwarding `provider.namespaceExportsIncludeImportedNames` into the pass
and consulting the published channel when it is set — the same question
`receiver-bound-calls` Case 1 asks, through the same `lookupBindingsAt` read that
`findExportedDefIncludingImportedNames` performs for the CALL form. Precedence is
unchanged where it mattered: a locally declared member still wins, ambiguity
still resolves nothing, and `CALL_TARGET_TYPES` still gates the answer — pinned
by `hub.DEFAULT_NS`, a re-exported CONSTANT, which stays unregistered. Languages
that do not opt in are unaffected: the parameter defaults to `false`. Verified
load-bearing — passing `false` fails the hub test.

The fixture uses a member (`scale`) republished by nothing else, so the hub
assertion cannot be satisfied by an edge another case emitted.

### Gates after review round 5

- `tsc --noEmit` clean, `npm run build` clean, `prettier --check` clean.
- `test/integration/resolvers` — 3,634 passed / 3 skipped (70 files).
- `test/unit/scope-resolution` — 2,015 passed (120 files).
- `impact-callable-value-references` under `lbug-db` — 7 passed.
- Bench `--check`: `receiver-resolution`, `zig-cross-file-resolution`,
  `scope-capture` (15 languages), `scope-emission`, `callable-value-flow` all
  PASS, no baseline edited.

### Note on `/autofix` (not a code issue)

`/autofix` answered "No successful autofix run found for this PR's current head
SHA" three times. The cause is not the branch and not a bot refusal: the
`PR Autofix` run on `1c7c05ff` (34253581982) FAILED at its last step —
`actions/upload-artifact` returned `Failed to FinalizeArtifact: (403) Forbidden`
from GitHub's artifact storage. `pr-autofix-apply.yml:243` selects only runs with
`conclusion == "success"` for the head SHA, so there was nothing to apply.
The same workflow succeeded on `cf53bbaa`, `3bd1337a` and `bd6e577e` with
identical permissions, so it is transient infrastructure, not configuration.

Two things worth knowing: re-running that workflow needs admin rights on the
upstream repo (a fork contributor gets `Must have admin rights to Repository`),
and the run's own output was `"changed_lines": 0` — ESLint reported 0 errors
(6868 pre-existing warnings) and Prettier reported every file `(unchanged)`, so
a successful run would have produced an empty patch anyway. Pushing this commit
triggers a fresh run, after which `/autofix` will answer normally.
