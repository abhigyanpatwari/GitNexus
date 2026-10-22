# Receiver-resolution baseline

## Zig receiver gaps from the #3498 drop triage

Measured against main `2b6542737`, the four Zig fixes clear 18
`receiver-unresolved` sites: all-kind drops move from 200 to 182, reads from
42 to 27 and calls from 138 to 135. Writes and every shape-arm state are
unchanged.

- 9 reads of `const X = @import("f.zig").X;` (zig-hub `stdx.zig:2-4`,
  zig-receivers `stdx.zig:2`, zig-idioms `holder.zig:6`, `main.zig:6`,
  `Element.zig:35`, `hub.zig:9-10`): the `@import(…)` receiver is now bound as a
  namespace, so the read resolves through the written module (`import-resolved`).
- 3 reads off an anonymous container (`Sorter.zig:16`, `:23`, `:28`):
  the receiver names the container's minted identity. The site is now anchored
  on the member, so it moves off the reported `struct` position and resolves
  from the scope that evaluates it.
- 1 call and its callee-position read at zig-idioms `main.zig:42`
  (`Stack(u8).init()`): the new `isTypeApplicationCall` hook types the receiver
  as `Stack`.
- 2 calls and their callee-position reads at zig-filestruct `aliases.zig:86`
  and `:88` (`JsApi.Meta.prototype_chain` and `JsApi.value`): the
  `bridge = generic.Bridge(Local)` alias reaches `Builder` through the
  forwarding return type. These were lines 77 and 79 on the measured main.

Forwarding type constructors (`Bridge ↦ Builder`) also work through the
namespace-factory lookup already merged in #3648. The combined result clears
more sites than the original standalone branch, which cleared 14. The `b12`
alias control resolves. Zig call drops fall from 13 to 10; `no-chain` call
drops move from 34 to 31 and `in-program` calls from 60 to 57.

## JS/TS literal-key writes and class-level field receivers (#3498)

Measured on top of #3654 (`a3db31923`, tree-identical to its squash merge
`2b6542737`). Call drops move from 138 to 136, all-kind drops from 200 to
178, and writes from 20 to zero. Read drops remain 42 and every shape-arm
state is unchanged.

The 20 cleared writes are 19 object-literal keys answered by later resolution
passes and the CommonJS `module.exports.arrowRequest` declaration. Answered
sites withdraw only a matching kind/name/site drop; unanswered sites retain
theirs. A return-shape key's own write requires its exact declaration position
and file, so unrelated input reads and writes retain ordinary candidate ranking.

The two call-drop changes are `Config.DEFAULT.validate()` resolving through
its `new Config()` initializer and the owned `this.route.go()` site in
`ts-dynamic-this-no-seed` being classified as `receiver-owned-but-unbound`,
which is outside this gate. The latter does not gain a call edge, and its call
remains in the persisted unresolved-receiver summary used by impact/context.
Static field inference stops at an untyped override and resolves constructor names through
the value namespace; annotations retain type-namespace lookup.

Answered-site identity includes the full range, so an answered inner read in
`res.data.data` cannot withdraw the unresolved outer read with the same name.

## Go module visibility and qualified receiver refusal

Local imports now select the importer's own module or a module selected by its
nearest `go.work`. An independent sibling's matching module path is insufficient.
Qualified receiver types also stop when their import cannot resolve, instead of
borrowing a same-named type from another package. Local `replace` directives
remain unmodelled.

Compared with `85329b4de` on the same corpus, exactly two `CALLS` edges disappear:
`SpinGadget` and `Workshop.SpinGadgetField` in
`go-qualified-declared-types/services/foreign.go` no longer bind the unrelated
`gadgets.Gizmo.Spin`. No other `CALLS` or `ACCESSES` edge changes.

The two invalid calls now report drops. `ArchiveForeign`, which already had no
edge, also reports its refused qualified lookup; the simple calls additionally
report their read sites. Call drops move from 135 to 138, all-kind drops from
195 to 200, and `.go` call drops from 1 to 4. Every shape-arm state is unchanged.

## Go modules across several go.mod files

The Go resolver read only the repository-root `go.mod` and matched every other
import by directory suffix. In this combined corpus several fixtures declare
packages under the same import path (`internal/repository`,
`example.com/chaincall/models`), so their imports answered from the wrong
fixture or from none, and the receivers typed through them dropped. Each
import now belongs to the module whose path is its longest prefix, and names
the exact directory under that module's root.

Thirteen Go call drops clear, all `chain-field`/`chain-call` receivers in
`go-chain-call`, `go-grouped-type-decl`, `go-interface-field-dispatch` and
`go-pointer-receiver-field-chain`. Call drops move from 148 to 135, all-kind
drops from 208 to 195, `.go` call drops from 14 to 1, `chain-field` from 70 to
58, `chain-call` from 32 to 31, and `in-program` from 72 to 59. No drop was
added, and every shape-arm state is unchanged. Against main (`ab0b03846`) on
the same corpus, no `CALLS` or `ACCESSES` edge disappears or changes target,
and 70 are added outside the two new fixtures.

## Go package-qualified declared types

Go capture strips the package qualifier from field, parameter and local types,
so `*models.User` is stored as `User`. The receiver lookup then saw only the bare
name, and it resolves a bare name only while that name is unique in the
workspace. In this combined corpus, `User` is declared in 29 Go files and
`UserService` in 2. So every Go receiver chain rooted at a qualified parameter
(`models.User`, `*models.User`, `*models.UserService`) dropped, even though each
fixture resolves on its own and its standalone test passes. Receiver typing now
tries the qualified spelling first, grounded on the qualifier's import. If that
misses, it falls back to the bare name as before. A chain step keeps the
binding's own written spelling, and the qualified spelling must name `rawName`
itself, so a binding whose type a chain step replaced never borrows another
binding's package.

Thirteen Go drops clear: 5 calls and 8 reads in `go-deep-field-chain`,
`go-field-types` and `go-mixed-chain`. Call drops move from 153 to 148,
all-kind drops from 221 to 208, and reads from 48 to 40. `.go` call drops fall
from 19 to 14, `chain-field` from 73 to 70, `chain-mixed` from 2 to 0, and
`in-program` from 77 to 72. No drop was added, and every shape-arm state is
unchanged. The remaining Go chain-field drops come from packages that several
fixtures declare under the same import path, which nested `go.mod` resolution
addresses separately.

The new `go-qualified-declared-types` fixture records no drops. Compared with
main (`278863068`) on the same corpus, no `CALLS` or `ACCESSES` edge disappears
or changes target, with one exception inside the new fixture: main binds its
`Forward` to `api.User.Archive`, which is that row's bug. Outside the new
fixture, 19 edges are added. Thirteen belong to the chains cleared above. The
other six come from receivers that never recorded a drop:

- five simple `user.Save()` and `repo.Save()` receivers built as `models.X{}`
  or declared `var x models.X`, in `go-constructor-type-inference`,
  `go-member-calls` and `go-receiver-resolution`;
- the field chain `s.cartRepo.Get()` in `go-interface-field-dispatch`.

## Namespace factory results and shared-position drops (#3498)

Two changes move this baseline; neither moves an edge outside the new
fixtures. A same-corpus A/B against `origin/main` (`7090ac80f`, 2,838 `CALLS`
and `ACCESSES` edges) emits the identical edges on both sides; the full
corpus with this PR's fixtures is 2,871.

- **Namespace factory results.** `x = ns.make()` and inline `ns.make().m()`
  now take `make`'s return annotation, as a named import of `make` already
  did. The annotation must belong to the module's own `make` function (a
  method of the same name never qualifies), the namespace must bind that
  module (`import pkg.sub` binds `pkg`, not `pkg/sub.py`), and a dotted
  annotation (`-> models.Order`) is not followed further; each of those
  fails closed. A receiver bound to a namespace function with no usable
  return type (`x = ns.untyped()`) is recorded as dropped rather than read
  as an exact miss. The new `python-module-factory-return` fixture adds four
  call drops: `x = rp.untyped()`, inline `rp.untyped().m()`, `x = untyped()`,
  and `rp.make()` on a local `rp = Other()` that shadows the module alias.
  The Zig `bridge.prototypeChain()` and `bridge.accessor("value")` namespace
  calls in `zig-filestruct` are recorded as both a call and a read: +2
  calls, +2 reads. Dart (`final x = rp.make()`) binds the dotted callee so
  the same lookup applies; its fixture's untyped and awaited (`Future<C>`,
  not unwrapped yet) factories add two call drops. Zig resolves the inline
  form only: a file that imports a module cannot tell a namespace from a
  file-struct, so `const x = rp.make()` keeps main's binding.
- **Shared start positions.** Sites are keyed by `file:line:col`, and an outer
  call starts where its inner receiver does (`s.orderRepo.DeleteItem(id)`
  starts at `s.orderRepo`). A resolved inner site used to hide the outer
  site's drop. Now only a duplicate capture of the same site (same receiver
  and member, which also covers a call's own callee read) hides one. This
  adds 18 call drops (Go 14, TypeScript 1, Rust 1, JavaScript 1) and 2
  TypeScript reads. Each was checked against the corpus graph: none has a
  `CALLS` edge to that member from its enclosing function. The Go sites
  resolve when their fixture is analyzed alone, and are unresolved only in
  the combined corpus, where several fixtures declare the same packages. The
  same fix turns ten shape-arm cells from `INVISIBLE-GAP` to `VISIBLE-GAP`.

Totals: call drops 128 -> 153, reads 44 -> 48, all kinds 192 -> 221.

## Express inline-handler fixture (#3488)

The new `express-inline-handlers` fixture reads `req.query.path` inside an
inline handler whose `req` parameter is untyped. That chained field read is one
new `receiver-unresolved` read site (`src/server.ts:22`), so all-kind drops move
from 191 to 192 and reads from 43 to 44. Call drops and every shape-arm state
are unchanged; no existing site changed state.

## CommonJS member-assigned wrapper fixture (#3630)

The `fetch-wrapper-target-identity` fixture gained `lib/cjs-member.js`, which
exports `module.exports.arrowRequest = (url) => fetch(url);`. That
`module.exports` member write is one new `receiver-unresolved` write site, so
all-kind drops move from 190 to 191 and writes from 19 to 20. Call drops and
every shape-arm state are unchanged; no existing site changed state.

## Semantic rename provider captures (#3486)

A same-corpus A/B against `origin/main` (`191a954b`) reproduced the committed
129 call / 167 all-kind drops. The final provider source and rebuilt workers
measure 127 call / 189 all-kind drops, including 43 reads and 19 writes. The
original runner and a separate one-worker diagnostic agree exactly on every
gated count; all shape-arm states are unchanged.

The two removed call drops are `user.address.save` in
`ruby-field-type-disambig/service.rb:7` and `ruby-field-types/service.rb:6`.
Preserving the `./` distinction for bare `require_relative` paths resolves the
fixture imports. Both sites now emit `CALLS` to their own fixture's
`Address.save`, with no edge to the same-named `User.save`. Ruby call drops fall
from 2 to 0, `chain-call` from 32 to 30, and `in-program` from 56 to 54; every
other call bucket is unchanged.

The 24 added drops are newly captured Zig field reads, rather than lost call
edges. The Zig `field_expression` query now records complete receivers for
reads outside call/argument positions; its callee-position marker lets resolved
method reads avoid phantom edges. Every added suppressed site has exactly one
new `@reference.read` capture at the same written range and no corresponding
capture on `origin/main`. Existing suppressed read sites retain their ranges
and acquire receiver-chain metadata. These newly visible unresolved reads stay
in the exact all-kind gate; no coverage or threshold is relaxed.

## Python mixin dispatch (#3390)

The added mixin fixture deliberately calls an absent `missing_target` on a known
in-program receiver. The resolver now records that unresolved call rather than
silently treating missing edges as complete coverage. The focused Python resolver
test asserts this outcome. CI run 36319863343 at `4034cee` measured one additional
Python call drop (113 to 114; all-kind total 159 to 160), classified as in-program
with no receiver-shape annotation. No shape-arm result or performance threshold
changed. The renamed bound-receiver correction preserves the existing method's
effective arity. The measurements below supersede this earlier snapshot.

The final #3390 head did not retain that snapshot: its full corpus measured 125
call drops, including 12 in the new mixin fixture. At #3393 head, C3 resolves
`order_hook` to `OrderX.order_hook`, removing that fixture's one ambiguous drop.
The full corpus now measures 124 call drops (16 Python, 54 in-program), with 11
from the mixin fixture. The ten fixture outcomes missing from the old baseline
are three `helper()` calls with valid targets and an unproven variadic sibling,
field shadowing, three incompatible argument shapes, private-name lookup, an
abstract declaration, and duplicate definitions. The integration test pins
their exact call sites; none of these ten is the C3 `order_hook` call. These
counts track conservative unresolved coverage, including partial fan-out, not
only calls with no emitted edge.

The Python capture fingerprint is also intentionally regenerated: ordinary call
captures now include statically known argument counts, the corpus includes eight
new mixin fixture files, and bound method parameter counts exclude receivers by
class/decorator context rather than spelling. Unknown splat cardinalities remain
unknown. The final deterministic corpus contains 213 entries and 3,463 capture
groups. The golden test pins each fixture; only the mixin and renamed target
digests changed in the bound-receiver delta, with their group counts unchanged.
Scaling limits and all non-Python capture baselines remain unchanged.

> **`baseline.json` is the source of truth for every number.** It is what
> `measure.mjs --check` enforces byte-exactly. This file is a lab notebook:
> each section records what was measured AT THAT UNIT and why it changed the
> plan. A figure here that disagrees with `baseline.json` is a superseded
> snapshot, not a live claim — sections carry a snapshot marker where that has
> already happened. Never quote a count from this file into code, a gate, or a
> commit message; read it from `baseline.json`.

## Receiver ORIGIN — three quarters of the hedge was the program boundary

The drop count was measuring two different things and reporting both as
uncertainty. Dumping all 102 call drops with source context settles it:

| Origin       | Count  | Is anything lost?                                                                                                                                                                        |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external`   | **44** | **No.** `System.out.println`, `fetch(...)`, `os.environ.setdefault`, `document.body.appendChild`, `.stream()`. The callee is not in the graph — there is no node an edge could point at. |
| `in-program` | 36     | Yes in principle — but see below.                                                                                                                                                        |
| `unknown`    | 22     | Yes. Casts, ternaries, `globalThis.x ??= []`, and everything the classifier will not guess about.                                                                                        |

> **These numbers moved once, in review, and the movement is the point.** They
> were first measured as 76 / 20 / 6, when `external` was the FALLTHROUGH: any
> base whose type did not resolve was called external. Review reproduced two
> triggers where that published `epistemic: 'exact'` over a real in-program loss
> — a Go pointer receiver (`*Host`, whose lookup was missing the decoration
> stripper) and any base with no type binding at all, including this branch's own
> `droppedCall(svc)` fixture. `external` is now a POSITIVE determination via
> `LanguageProvider.isBuiltInName`, and everything unproven is `unknown`, which
> still hedges. So `external` fell 76 -> 44 and the difference went to
> `in-program` (+16, the drops that really were ours) and `unknown` (+16, the
> drops we decline to characterize). Total call drops is unchanged at 102 —
> this is re-bucketing, not resolution.
>
> A controlled A/B over the Java built-in set (off vs on, same tree) reads
> 7/36/59 vs 44/36/22: `in-program` is byte-identical across the toggle, so
> naming built-ins reclassified nothing the index can demonstrate is ours.

**A compiler resolves `System.out.println` against the JDK.** Lacking the JDK,
the honest statement is _"this call leaves the analyzed program"_ — not _"this
analysis is incomplete"_. Those are different epistemic states, and collapsing
them is what made `impact` report a lower bound on essentially every real
codebase, which is what teaches readers to ignore the signal.

`ResolutionOutcome.receiverOrigin` now records which one applies, and
`summarizeUnresolvedReceivers` skips `external`. `unknown` still counts —
assuming a completeness we cannot demonstrate is the unsafe direction.

### How origin is decided

By the receiver base's **declared type**, not its name. A first cut asked
whether the base was a local, which marked `inputs.stream()` in-program:
`inputs` is a local, but its type `List<String>` is JDK, so the target is
external. Asking whether the base's _type_ is one this index contains moved 28
sites to the correct bucket.

### What the remaining in-program drops actually are

Mostly **not** product defects. `user.Address.Save()` resolves cleanly in
isolation — the `csharp-deep-field-chain` fixture alone emits both expected
edges with **zero** drops. It drops in the count arm only because the corpus is
~200 independent mini-projects in one directory and **55 files define
`Address`**, so the resolver correctly declines on ambiguity rather than picking
one. That is right behaviour measured on an unrepresentative corpus.

The genuinely untypeable population is the `unknown` bucket — and those are the real
targets for type resolution, because a cast _gives_ you the type
(`((Box<String>) obj).open()`) and a ternary needs a join of its branch types.
They were previously invisible under the stdlib calls the old fallthrough swept
into `external`.

`callDropsByOrigin` is now part of the gated projection, so this split cannot
drift silently.

---

## Phantom callee read sites — a duplicate-edge bug the U8 test missed

Go's `@reference.read` pattern matches **every** `selector_expression`, with no
call-position exclusion. So `h.dep.Work()` minted **three** reference sites:

| site | kind   | name   | what it is                                                    |
| ---- | ------ | ------ | ------------------------------------------------------------- |
| S1   | `call` | `Work` | the member call                                               |
| S2   | `read` | `Work` | **phantom** — the callee `h.dep.Work`, already captured by S1 |
| S3   | `read` | `dep`  | the genuine field read                                        |

S2 resolved through `findOwnedMember`, which prefers methods over fields, and
emitted an `ACCESSES` edge to the **method** duplicating S1's `CALLS` edge at the
same position.

**The U8 assertion passed by accident.** It asserted `RunSamePackage → Work` was
absent from `ACCESSES`, and it was — but only because that row has a _pointer_
receiver whose text-cascade head lookup failed for an unrelated reason. The
value-receiver twin was emitting the bad edge the whole time:

```
ACCESSES  RunFromValueReceiver -> DoWork:Method     <- phantom, shipped
ACCESSES  RunLocal             -> DoWork:Method     <- phantom, shipped
```

First fix, at capture: drop the match outright, on the rule _"a selector in
function position is never a read."_ **That rule is false, and review caught
it.** In Go a func-typed struct field IS read and then called indirectly —
`h.dep.Work()` where `Work func() error` — and `isCalleeOfMemberCall` cannot
tell a method from a func-valued field, because the AST shape is identical.
Dropping at capture therefore deleted the only `ACCESSES` evidence for callback
structs, hook structs and hand-rolled mocks (`mock.DoFunc`, `opts.OnEvent`).

Second fix, and the one that shipped: **split the decision across the two layers
that each hold half of it.** Capture records the POSITION as a fact
(`@reference.callee-position` → `ReferenceSite.inCalleePosition`) — only the AST
knows it, and it is gone by resolution time. Emit makes the DECISION from the
resolved target's kind — only resolution knows whether the tail is a method or a
field, and it may be declared in another package. Neither layer can answer alone.
The suppression is language-neutral in `graph-bridge/edges.ts` and keys on the
canonical `CALL_TARGET_TYPES`, so `Macro` and `Delegate` targets are covered too.

A method _value_ (`f := h.dep.Work`) is not in function position and is
untouched. The assertion is backed by an exact-set check over the whole fixture —
now carrying target KINDS, so it catches both a new phantom and a deleted
genuine read.

### What the numbers say

- `callDrops` **unchanged at 102** — no call was lost, in either fix.
- `read` drops went **27 → 22** under the capture-time drop, then **22 → 27**
  again once the marker replaced it. The round trip is the finding: those five
  sites are genuine field reads, and the first fix was scoring their deletion as
  an improvement.
- `totalDropsAllKinds` **124 → 129**, the same five sites.
- One drop reclassified `chain-field` → `chain-unwrap`. The phantom and the real
  call share a site key, so the phantom's field-shaped chain was previously the
  one recorded. The census now describes the actual dropped call.

Caught by three review agents dispatched at the A1 regression; the phantom was
the mechanism, not the global-normalization story the first revert note asserted.
The func-field regression it introduced was then caught by two more, on the
tri-review of #2782 — which is the argument for the exact-set-with-kinds
assertion over the targeted one that passed by accident the first time.

---

## U9 (part 2) — no drop ratchet is needed; the gate is already stronger

The plan's R10 set a ZERO supported-shape drop target, and review correctly
found that it contradicts R12: a site whose normalized name matches more than
one class MUST decline, a decline records a drop, and simple names collide
routinely in large Go and Java codebases. The proposed fix was a ratchet — the
count may not rise above the value measured after the last unit.

Neither is needed. `measure.mjs --check` already asserts **exact match** against
the committed baseline, which is strictly stronger than a ratchet: the count
cannot rise _or_ fall without a deliberate `--update-baseline`, and that path
prints an instruction to explain the movement in the commit message. A ratchet
would be a weakening.

So R10 as written (zero) was wrong, and the ratchet proposed to repair it is
redundant. The existing gate stands, now also covering `callDropsByShape` since
the shape census joined the gated projection.

**Deferred and NOT done: the `impact` risk-cutoff recalibration.** Review flagged
that added edges push symbols toward the absolute cutoffs (`directCount >= 30`,
`impacted.length >= 200`), so edits read HIGHER risk without being more
dangerous, and agents warning on HIGH/CRITICAL escalate more often. That is real,
but measuring it honestly needs a before/after risk distribution over a corpus
large enough for those thresholds to bind — the committed fixtures are nowhere
near 200 impacted symbols. Recording it as owed rather than inventing a number
from fixtures that cannot exercise the cutoffs.

---

## U6 — the depth cap does NOT limit resolution. Measured, not raised.

The premise was that a chain deeper than `MAX_CHAIN_DEPTH` (3) is discarded
whole rather than truncated, so a 4-hop builder chain "contributes nothing at
all". The first half is true; the second is not.

`fourHopChain` was added to the TypeScript corpus as a declared extra
specifically to make the question answerable — without a chain longer than the
cap, raising the cap measures nothing:

```ts
root.getSvc().getUser().address.getCity().save();
//   ^step1     ^step2   ^step3   ^step4   receiver of `save` = 4 steps
```

| Cap | Chain minted?                                        | Cell state   |
| --- | ---------------------------------------------------- | ------------ |
| 3   | **none** (confirmed by probing the emitter directly) | **RESOLVES** |
| 4   | `2\|root\|cgetSvc\|cgetUser\|faddress\|cgetCity`     | RESOLVES     |

The site resolves at BOTH depths. At 3 it resolves through the text cascade,
which owns the fallback path and runs to its own
`COMPOUND_RECEIVER_MAX_DEPTH` of 8.

**So the cap bounds which chains are typed structurally, not which calls
resolve.** Raising it moves work from the cascade to the fold without changing a
single edge — measured across the whole matrix: totals identical at 3 and 4,
`callDrops` 102 at both.

Left at 3. The fixture is committed so the next person to reach for this number
inherits the measurement instead of the intuition.

What DID need fixing: `unwrapTransparentReceiver` shared `MAX_CHAIN_DEPTH` as
its iteration bound. The two answer unrelated questions — how many chain hops do
we type, versus how many redundant parens might someone write — so raising the
chain cap would have silently widened the paren peel as a side effect. That
coupling got worse when the await/subscript work added a peel call at loop
entry. Now `MAX_TRANSPARENT_WRAPPER_DEPTH`, its own constant.

---

## U9 — the epistemic hedge has TWO producers, and only one is a defect

`impact` reports `epistemic: 'lower-bound'` for two independent reasons that were
previously indistinguishable in the output:

| Cause              | Unit       | What it means                                                                                                                                             | Is it a defect?                                                                                                                       |
| ------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `receiverTyping`   | call sites | Call sites dropped because the analyzer could not type the receiver                                                                                       | **Yes** — a resolver gap. This is the population this whole series targets.                                                           |
| `dispatchBoundary` | symbols    | The symbol sits behind an interface with real consumers or 2+ implementations; the number is the implementations plus interface-level consumers behind it | **No** — callers binding through DI or dynamic dispatch are genuinely untraceable statically. A compiler refuses here too.            |
| `externalBoundary` | call sites | The call left the indexed program (`System.out.println`, `fetch(...)`)                                                                                    | **No**, and not even a shortfall — there is no in-graph node an edge could have reached. An `epistemic: 'exact'` result can carry it. |

Both collapsed into one enum plus prose, so a consumer — especially a coding
agent gating its own edits on the result — could tell THAT a count was short but
not WHY, and could not branch on the difference. Worse, it made "the hedge should
stop appearing" unfalsifiable: with no way to see which producer fired, there was
no way to check whether fixing receiver typing had done anything.

`impact` and `context` now carry a structured `causes: { receiverTyping,
dispatchBoundary, externalBoundary }` alongside the prose. Every field counts
MISSING THINGS, never notes: there is one note per symbol name (and one per
boundary node) but each reports N of something, so counting notes published `1`
next to prose reading "2 call sites", and a consumer branching on the number
would have read a different magnitude than the human reading the text. The same
rule applies to `dispatchBoundary`, which counts the implementations plus
interface-level consumers behind the boundary rather than the boundary sentences
— one sentence can describe an interface with 40 implementations. Its unit is
SYMBOLS rather than call sites because per-site multiplicity is not retained on
those edges (consumers are counted `DISTINCT`, and
`collapseMemberCallsByCallerTarget` languages emit one CALLS edge per
caller/target pair); the units are stated per field on `EpistemicCauses` so a
consumer knows which it is holding.

**Only the `receiverTyping` producer is addressed by this series.** The dispatch
boundary is untouched and will keep firing for interface-dispatched symbols —
which is correct. Any claim that the hedge has "stopped appearing" has to be read
per-producer, and that is now possible.

Measured on the #2766 reproduction: `WithTx` went from `impactedCount: 0` with a
`lower-bound` hedge to `impactedCount: 1` with `epistemic: exact`. The hedge is
gone there because its cause is gone, not because it was suppressed.

---

## U10 — recorded drops, censused by receiver shape

`ResolutionOutcome`'s suppressed variant now carries `receiverShape`, set by the
emitting case from the site's ENCODED CHAIN — the compact string the capture
emitters mint by walking the real AST. Never re-derived from the source line:
doing that would mean regex-classifying the number that gates this work, the
same textual-shape dispatch the structural-receiver line exists to remove.
Diagnostic only, so the persisted `RepoMeta.unresolvedReceiverMembers` artifact
is unchanged.

Census of the call drops on the committed fixture corpus, **as measured at U10**
— it predates the phantom-read fix documented above, which reclassified one drop
`chain-field` → `chain-unwrap`. `callDropsByShape` in `baseline.json` is current:

| Shape                                                         | Count | Share |
| ------------------------------------------------------------- | ----- | ----- |
| `chain-field` — every step a field (`h.repo.save()`)          | 60    | 59%   |
| `chain-call` — every step a call (`svc.getUser().save()`)     | 27    | 27%   |
| `no-chain` — no chain minted; the walk found no nameable base | 12    | 12%   |
| `chain-mixed` — interleaved (`svc.getUser().addr.save()`)     | 2     | 2%    |

Two decisions come out of it.

**The `.java` bucket is not one defect.** Its 49 call drops split 30 field-chain
/ 14 call-chain / 5 no-chain, so the open question of whether Java's largest-
single-bucket status hides a single cause is answered: it does not. It is the
same population as everywhere else, just more of it.

**Field-receiver chains are where the remaining value is.** At 59% of the U10
census they dominate, and they are precisely the shape U1 fixed for Go. The same
defect class in java, csharp, cpp, php, py and rust is the largest addressable
population the count arm can see. (This paragraph used to quote a per-extension ×
per-shape split from the U10 run. `baseline.json` carries `callDropsByExtension`
and `callDropsByShape` but not their cross-product, so that split has to be
re-derived from a fresh run rather than read off the committed baseline.)

**What this census CANNOT justify.** Await-wrapped and subscript receivers barely
appear, because the committed fixture corpus contains almost no such sites — not
because they are rare in real code. At U10 `indexElement` was a gap in every
language in the shape arm, so U5's population was real but structurally invisible
to the count arm. (It no longer is uniform — the subscript route resolves in
several languages now; read the current per-language state from `indexElement` in
`baseline.json`, not from this paragraph.) The durable point: any decision to fund
or drop U4 and U5 has to be read off the SHAPE arm, because reading it off this
census confuses "absent from these fixtures" with "does not happen".

## U2 — shape matrix expanded to a canonical axis

The shape arm was three languages with an ad-hoc shape list each. It is now a
**canonical 10-shape axis** (`SHAPE_IDS`) that every language must answer for,
with two states added so a hole cannot masquerade as a measurement:

- `N/A` — the grammar does not admit this spelling. **A reason is required.** An
  omitted cell and a genuinely inapplicable cell look identical in a diff
  otherwise, which is how coverage rots.
- `GRAMMAR-UNAVAILABLE` — the parser could not be loaded, so nothing was
  measured. Neither passes nor fails the gate, and `drift` skips it on **both**
  sides so the gate cannot fail for the environment it ran in. `tree-sitter-dart`,
  `-kotlin` and `-swift` are vendored _optional_ grammars: absent when a run sets
  `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1`, and soft-failing when no vendored prebuild
  matches the host (the set covers darwin/linux arm64+x64 and win32-arm64 — a
  win32-x64 or musl host has none). **All 14 load on a glibc linux-x64 host, so
  this state has no producer in the committed baseline** — it guards the
  skip-flag and unsupported-host cases rather than a condition seen here.

`assertMatrixComplete` throws when a language omits a cell, declares an unknown
id, or writes an `N/A` with no reason. Languages may declare `extraShapeIds` for
diagnostics the canonical axis cannot express (PHP's annotated/unannotated
return-type pair, C++'s pointer/value base pair) — an extra must be declared, so
it stays a deliberate diagnostic rather than a typo'd canonical id.

**Vue and COBOL** are language-level `N/A` rows: their emitters never call
`synthesizeReceiverChainCapture`, so there is nothing to measure — but the
language axis now obeys the same no-omitted-cells rule as the shape axis.

### What the first expanded run found

Three results that redirected the plan they were built to serve. **Snapshot: the
first U2 run, before any of the fixes below landed** — these cells state the
problem, and several have since flipped (`baseline.json` is current):

**Go — the root cause, isolated to one cell.** Three rows vary receiver
decoration and field decoration independently:

| Cell                    | Receiver    | Field       | State           |
| ----------------------- | ----------- | ----------- | --------------- |
| `fieldReceiverCall`     | value       | value       | RESOLVES        |
| `decoratedFieldType`    | value       | **pointer** | RESOLVES        |
| `decoratedReceiverBase` | **pointer** | value       | **VISIBLE-GAP** |

Only the pointer _receiver_ fails. Go already normalizes field type bindings
through `normalizeGoTypeName`, so the step lookup is sound and the defect is
entirely the base — `synthesizeGoReceiverBinding` stores `typeNode.text` raw, so
`func (h *Host)` binds `h` to the literal `*Host`, which
`findClassBindingInScope` cannot resolve.

**PHP — the sigil hypothesis is dead.** The two rows differ only in whether the
called method declares a return type:

| Cell                                          | Return type   | State         |
| --------------------------------------------- | ------------- | ------------- |
| `arrowCallChain` — `$svc->getUser()->save()`  | unannotated   | INVISIBLE-GAP |
| `plainChain` — `$svc->getUserTyped()->save()` | **annotated** | **RESOLVES**  |

Same chain, same `->`, same base. PHP chains resolve when the return type is
declared; the `$` sigil is not involved. `decoratedFieldType` (`?User $repo`)
also resolves, so PHP nullable field types already work.

**C++ — the base already resolves, but `this->` field receivers do not.**
`pointerArrowChain` and `valueDotChain` both RESOLVE, so a decorated C++ base is
not a gap. `this->repo.save()` and `this->repo->save()` were both INVISIBLE-GAP
when this was written — a distinct defect, not a decoration one — and #2833
closed it: a language that declares `this` IS the enclosing class
(`resolveThisViaEnclosingClass`) synthesizes no `this` typeBinding anywhere, so
a chain whose BASE is `this` could never seed its head. It was never a generics
gap; the NON-generic control failed identically. C++'s `fieldReceiverCall` and
`decoratedFieldType` cells moved INVISIBLE-GAP -> RESOLVES with it.

**Rust — the decorated receiver is NOT a gap.** `&mut self` resolves, so Go is
the only language whose method receiver decoration defeats the lookup. Rust's
gap is the field: `Box<User>` is INVISIBLE-GAP.

### The decoration cells, across all 14

The rows U1 exists to fix. Everything else is a different defect. **Snapshot: as
measured at U2, i.e. BEFORE U1 landed** — it is the statement of the problem, not
of the current state. Go's `decoratedReceiverBase` and TypeScript's
`decoratedFieldType` have since moved; `baseline.json` has the live cells.

| Language                  | `decoratedReceiverBase`   | `decoratedFieldType`               |
| ------------------------- | ------------------------- | ---------------------------------- |
| go                        | **VISIBLE-GAP** (`*Host`) | RESOLVES                           |
| rust                      | RESOLVES (`&mut self`)    | **INVISIBLE-GAP** (`Box<User>`)    |
| typescript                | N/A                       | **INVISIBLE-GAP** (`User \| null`) |
| csharp                    | N/A                       | **VISIBLE-GAP** (`User?`)          |
| swift                     | N/A                       | **INVISIBLE-GAP** (`User?`)        |
| cpp                       | N/A                       | **INVISIBLE-GAP** (`User*`)        |
| python, php, kotlin, dart | N/A                       | RESOLVES                           |
| java, c, javascript, ruby | N/A                       | N/A                                |

So U1's measured scope is **Go's receiver base**, plus the field-type gap in
**Rust, TypeScript, C#, Swift and C++** — and _not_ PHP, Python, Kotlin, Dart or
Java, whose decoration handling already works or does not exist. Five of the
seven hooks the plan speculatively listed were aimed at languages that need
none; three languages that do need one were not on the list at all.

### Other gaps this run surfaced, not in the plan

- **Swift resolves almost nothing.** `plainChain`, `plainDeepChain`,
  `optionalChain` and `nonNullAssert` are all INVISIBLE-GAP, while
  `fieldReceiverCall` resolves. Chained receivers are essentially unsupported.
- **Ruby chains are VISIBLE-GAPs** (`plainChain`, `plainDeepChain`,
  `optionalChain`) and `fieldReceiverCall` on `@repo` is INVISIBLE.
- **C++ `this->` field receivers** are INVISIBLE-GAP in both the value and
  pointer form.
- **C# has four gaps** beyond the field one: `optionalChain`, `nonNullAssert`,
  `awaitParen`, `explicitTypeArgs`.
- **Dart `await` already resolves** — the only language where `awaitParen` is
  green, which makes it the reference for U4's unwrap direction.
- **`indexElement` was INVISIBLE-GAP in all 14** at U2 — uniform, and exactly what
  U5 targets. (Superseded: several languages resolve it now; see `baseline.json`.)

### Coverage status

All 14 languages measured, plus `vue` and `cobol` as language-level `N/A` rows.
The cell tally recorded at U2 was 164 cells / 42 RESOLVES / 22 VISIBLE-GAP / 31
INVISIBLE-GAP / 69 N/A / 0 GRAMMAR-UNAVAILABLE — a snapshot, superseded by every
unit since (the axis also gained TypeScript's declared `fourHopChain` extra).
Count the states off `baseline.json` rather than quoting this line.

The **count arm did not move when the shape axis was expanded** — shape fixtures
are built in temp directories and never touch the committed corpus, so expanding
the shape axis moves the shape arm only.

---

> **Updated after U10** (structural receiver typing wired into Case 0). Three
> TypeScript shapes flipped to `RESOLVES` — `svc?.getUser().save()`,
> `svc!.getUser().save()`, `svc.getTyped<User>().save()` — and the call-drop
> count did **not** move: 99 before, 99 after.
>
> That is the whole argument for the shape arm, now demonstrated rather than
> predicted. The committed fixture corpus contains none of those three
> spellings, so a gate reading only the drop count would have scored a working
> change as "no improvement" and stopped the series. Nothing regressed: no edge
> was lost and no new drop appeared.
>
> Two gaps remained open **at U10**, both genuine at the time:
>
> - `(await svc.getUserAsync()).save()` — `extractMixedChain` reached `await …`,
>   which is not a chain node, so no chain was minted. It was a VISIBLE-GAP and is
>   the call-kind fixture in the drop-recorder test.
> - `repos[0].save()` — Case 0's punctuation gate never fired for a subscript
>   receiver, so it was INVISIBLE.
>
> Both were subsequently closed for TypeScript by the `await`/`index` step kinds
> (wire format v2) and by Case 0's third gate arm, which admits any site carrying
> a minted chain regardless of receiver punctuation. Per-language state is in
> `baseline.json` — `awaitParen` and `indexElement`.
>
> The tables below are the pre-U10 measurement, kept as the reference point.

## U7 — the go/no-go gate: PASS

A/B produced by reverting ONLY the fold wiring (`compound-receiver.ts` +
`receiver-bound-calls.ts`) to the pre-U10 commit and rebuilding, so capture
emission — and therefore the persisted bytes — is identical in both arms and the
delta isolates the fold. Build + both caches wiped before every run (KTD4).

| Metric                                   | Control     | Treatment   | Δ            | Threshold    | Verdict            |
| ---------------------------------------- | ----------- | ----------- | ------------ | ------------ | ------------------ |
| scope-resolution wall-clock, median of 3 | 25470.0 ms  | 25687.9 ms  | +0.86%       | ≤ +3%        | **PASS**           |
| wall-clock, slowest of 3                 | 25520.0 ms  | 25832.6 ms  | +1.22%       | ≤ +5% p95    | **PASS**           |
| serialized bytes per emitting site       | —           | **35.2 B**  | —            | ≤ 48 B       | **PASS**           |
| persisted store growth                   | 1 234 600 B | 1 235 340 B | **+0.0599%** | ≤ 3%         | **PASS**           |
| retained chain payload                   | —           | 740 B       | —            | ≤ 6 MB       | **PASS**           |
| call drops (no regression)               | 99          | 99          | 0            | no new drops | **PASS**           |
| peak RSS                                 | —           | —           | —            | ≤ +2%        | **NOT RESOLVABLE** |

**The 35.2 B result confirms KTD7 by measurement rather than by assertion.** The
48-byte threshold was set deliberately so the object encoding (~71 B predicted)
fails and the compact string (~35 B predicted) passes. Measured: 35.2 B,
including the JSON key and quotes. The encoding decision is now evidence-backed.

**Peak RSS: the threshold is below this instrument's resolution, so it is
reported as unresolvable rather than as a pass or a fail.** Three _independent_
treatment runs with the code held constant gave 414.9 / 436.6 / 436.9 MB — a
5.3% spread, wider than the ±2% being tested. (An earlier pair of 3-reps-in-one-
process runs read 536 vs 551 MB and looked like a +2.77% regression; that was
heap accumulating across reps, not growth.) Corroborating argument that no growth
exists to find: the change persists 740 bytes across the entire corpus and the
fold allocates nothing retained — it returns `SymbolDefinition`s the indexes
already hold.

**Fold hit-rate.** Chains are minted for 21 of 529 TypeScript reference sites
(4.0%) — the field costs nothing on the 96% of sites with a bare-name receiver.
On the shape corpus, all 5 chain-carrying shapes resolve, so the fold is not pure
added cost on this population.

**Not measured: a dedicated synthetic miss-dominant scaling corpus.** The plan
asks for `scaling_ratio < 1.5` on one, on the grounds that a same-name corpus
hits at `ownerChain[0]` and never exercises the MRO tail. Stated plainly so it is
not mistaken for a silent pass. What bounds the cost instead: the fold runs with
`fieldFallback: false`, so the O(fields × depth × names) path the threshold exists
to police cannot execute at all, and the remaining work is at most
`MAX_CHAIN_DEPTH` (3) map lookups per MRO ancestor per chained site, over a
population of 21 sites. The wall-clock A/B above is the empirical check on that
reasoning.

Measured with `bench/receiver-resolution/measure.mjs` on `f87b2cbe`.

Hygiene (a run without both steps is void — `analyze --force` clears neither cache,
and the parse worker runs from `dist/`):

```
npm run build
rm -rf .gitnexus/parse-cache .gitnexus/parsedfile-cache
node --import tsx bench/receiver-resolution/measure.mjs --corpus test/fixtures/lang-resolution
```

Two consecutive runs were byte-identical, not merely within noise.

## Count arm — `test/fixtures/lang-resolution`

**Snapshot: the U7-era measurement (commit `f87b2cbe`), kept as the reference
point for the A/B above.** The gate enforces `countArm` in `baseline.json`, which
has moved since — read the live call-drop number, site-kind split, and
per-extension breakdown from there.

| Metric                           | Value at U7            |
| -------------------------------- | ---------------------- |
| **Call drops (the gate number)** | **99**                 |
| Total drops, all site kinds      | 124                    |
| Split by site kind               | `call: 99`, `read: 25` |

Call drops by extension, at U7:

| ext     | n   | ext    | n   | ext      | n   |
| ------- | --- | ------ | --- | -------- | --- |
| `.java` | 49  | `.py`  | 5   | `.rs`    | 3   |
| `.cs`   | 8   | `.go`  | 5   | `.kt`    | 3   |
| `.ts`   | 7   | `.cpp` | 5   | `.rb`    | 2   |
| `.tsx`  | 6   | `.php` | 4   | `.js`    | 1   |
|         |     |        |     | `.swift` | 1   |

**Why the split matters (KTD6 defect 1, now measured).** About a fifth of the
drops are property _reads_, not lost calls (25 of 124 at U7; `bySiteKind` in
`baseline.json` is current). Case 0's recorder gates on the receiver's
punctuation, not on what the reference is, so `d.source.kind` lands in the same
bucket as a dropped method call. Gating on the unsplit total would have measured a
population one fifth of which this work does not target.

## Shape arm

`RESOLVES` means an edge exists — **not** that it points at the right target. A
name-keyed fallback onto a same-named member reads as `RESOLVES`, so a shape whose
receiver has no well-defined type is not a usable control.

**Snapshot: the pre-U10 measurement over three languages**, kept because it is the
evidence that the shape arm moves when the count arm does not. Superseded twice —
by U8's rollout table above and by the canonical shape axis in `baseline.json`.
The three TypeScript rows marked as gaps here (`?.`, `!`, `<T>`) all resolve now.

| Language   | Shape                                  | State at pre-U10  | siteKind |
| ---------- | -------------------------------------- | ----------------- | -------- |
| TypeScript | `svc.getUser().save()`                 | RESOLVES          | —        |
| TypeScript | `svc.getUser().address.save()`         | RESOLVES          | —        |
| TypeScript | `svc?.getUser().save()`                | **INVISIBLE-GAP** | —        |
| TypeScript | `svc!.getUser().save()`                | VISIBLE-GAP       | `call`   |
| TypeScript | `(await svc.getUserAsync()).save()`    | VISIBLE-GAP       | `call`   |
| TypeScript | `svc.getTyped<User>().save()`          | **INVISIBLE-GAP** | —        |
| TypeScript | `repos[0].save()`                      | **INVISIBLE-GAP** | —        |
| PHP        | `$svc->getUser()->save()`              | VISIBLE-GAP       | `call`   |
| PHP        | `$this->repo->save()` (typed property) | RESOLVES          | —        |
| C++        | `svc->getUser()->save()`               | **INVISIBLE-GAP** | —        |
| C++        | `svc2.getUser()->save()`               | RESOLVES          | —        |

## Corrections to the plan, forced by measurement

1. **Three target shapes are invisible, not one.** The plan records only
   `repos[0].save()` as unrecorded. Measured, `svc?.getUser().save()` and
   `svc.getTyped<User>().save()` are equally invisible: no edge and no drop.

   This is the load-bearing correction. A gate built on the call-drop count alone
   would move by **zero** when those three shapes are fixed, reading a working
   change as "no improvement" — the same false-negative hazard the plan flags for
   stale shards, arriving by a different route. Hence the shape arm: it is blind
   to nothing, because it asks about edge presence rather than about a recorder
   that has to have fired.

2. **Invisibility is NOT a capture-layer gap.** Measured directly against
   `emitTsScopeCaptures`, all five TypeScript shapes emit a full call match —
   `@reference.call.member`, `@reference.name`, and crucially
   `@reference.receiver`:

   | Shape                         | `@reference.receiver`  |
   | ----------------------------- | ---------------------- |
   | `svc?.getUser().save()`       | `svc?.getUser()`       |
   | `svc.getTyped<User>().save()` | `svc.getTyped<User>()` |
   | `repos[0].save()`             | `repos[0]`             |

   So a `ReferenceSite` exists for every one of them, and hanging a
   `receiverChain` field on `ReferenceSite` is a viable carrier for all of them.
   That was worth establishing before building on it.

   The drop suppression is therefore downstream of capture. For `repos[0]` the
   cause is known and matches the plan: the receiver has neither `.` nor `(`, so
   Case 0's gate never fires. For `?.` and `<T>` the receiver text satisfies the
   gate, so Case 0 _does_ run and one of two things happens — the site was marked
   in `handledSites` by another case, or `resolveCompoundReceiverClass` returned a
   class on which the member was then not found, leaving
   `compoundReceiverUnresolved` false. Those are materially different defects and
   which one applies is **not yet determined**; it is the first thing U10 has to
   establish, since the second would mean the recorder under-reports by
   mis-attribution rather than by a gate.

   _(An earlier revision of this file asserted that these shapes produce no
   reference site at all. That was inferred from edge-and-drop absence and is
   disproven by the capture dump above.)_

3. **KTD6 defect 2 overstates the PHP blindness.** The claim is that Case 0's
   C-family punctuation test means PHP `->` receivers "never record a drop at
   all". Measured, `$svc->getUser()->save()` _is_ recorded, because its receiver
   text `$svc->getUser()` contains `(` and satisfies the gate. And the plan's own
   example, `$this->repo->save()`, does not need recording — with a typed property
   it resolves. The genuine PHP gap is the call chain, and it is already visible.

4. **The C++ defect is the `->` base receiver specifically.** `svc->getUser()->save()`
   is invisible while `svc2.getUser()->save()` resolves. Same chain, same `->save()`
   tail — only the base differs. This is exactly why `cpp-chain-call/` has never
   caught it: that fixture uses the value `.` form, which works.

## Known blind spots

Every count here is a lower bound on a known-biased population, and any later delta
must be read against the same bias. Kept in sync with `KNOWN_BLIND` in
`measure.mjs`, which prints these on every run.

- Case 0 is reached by a receiver-TEXT punctuation test (`.` or `(`) **or** by a
  minted receiver chain. A receiver spelled without that punctuation — a subscript
  `repos[0]`, a PHP `->` / `::` property path — therefore reaches the recorder only
  where its emitter mints a chain. Where no chain is minted, the call still
  vanishes with the instrument blind to it.
- A drop is recorded only while `compoundReceiverUnresolved` stays true. When the
  cascade TYPES the receiver but then finds no member on it, the flag is false and
  no drop is recorded even though no edge was emitted. So an absent drop is not
  evidence a site resolved — the recorder can under-report by mis-attribution, not
  only by a gate. (This is what moved PHP's `arrowCallChain` from VISIBLE-GAP to
  INVISIBLE-GAP when its fixture parameter was typed; see U8 below.)
- Retracted, and left here because it was quoted for several units: the earlier
  claim that `?.` and explicit type arguments _"produce no reference site at all"_.
  They do — the capture dump under "Corrections to the plan" §2 shows a full call
  match with `@reference.receiver` for all three of `svc?.getUser()`,
  `svc.getTyped<User>()` and `repos[0]`. The absence was of an EDGE and of a DROP,
  never of a site.

## U8 — per-language rollout

Emission moved into one shared helper
(`utils/receiver-chain-captures.ts`) and is wired into all 14 language
emitters. The helper is language-free (R6): its call gate reads the
`@reference.call.*` tag prefix, a vocabulary every language's `.scm` query
shares, rather than a per-language tag list. It is self-gating — a non-call
match, an absent receiver, or a chain with no nameable base all leave the match
untouched — so inserting the call before every `out.push(grouped)` is safe even
in the emitters that have three or four such paths.

| Language   | Shape                              | Before        | After         |
| ---------- | ---------------------------------- | ------------- | ------------- |
| TypeScript | `svc?.getUser().save()`            | INVISIBLE-GAP | **RESOLVES**  |
| TypeScript | `svc!.getUser().save()`            | VISIBLE-GAP   | **RESOLVES**  |
| TypeScript | `svc.getTyped<User>().save()`      | INVISIBLE-GAP | **RESOLVES**  |
| C++        | `svc->getUser()->save()`           | INVISIBLE-GAP | **RESOLVES**  |
| C++        | `svc2.getUser()->save()` (control) | RESOLVES      | RESOLVES      |
| PHP        | `$svc->getUser()->save()`          | VISIBLE-GAP   | INVISIBLE-GAP |
| PHP        | `$this->repo->save()` (control)    | RESOLVES      | RESOLVES      |

The C++ row is the one the plan flagged as having **no fixture anywhere** —
`cpp-chain-call/` uses the value `.` form, which already worked. It now has one,
plus the value-dot control that proves the defect was the `->` base specifically.

### PHP: a measured residual, with the trap checked

PHP does **not** resolve yet, and the plan's named trap — a language whose node
type is missing from `extractMixedChain`'s tables reads as "didn't need it" when
it in fact cannot be measured — is **not** the cause. Checked directly against
the emitter:

```
name=save   chain=1|$svc|cgetUser   recv=$svc.getUser()
```

The leading `1` is the **v1** wire prefix current when this dump was taken; the
codec is at v2 now (`2|$svc|cgetUser`), and a v2 decoder refuses a v1 payload by
design — do not copy this literal into a fixture.

The chain is minted correctly. The residual is that the fold's base, `$svc`,
does not bind in the PHP resolver, so the fold returns `undefined` and the site
falls through to the text cascade. That is PHP binding-key work, not a
chain-layer defect, and it is left as a recorded residual rather than absorbed
into this series.

Two incidental corrections from that check, both to KTD6:

- PHP's receiver capture text is normalized to `$svc.getUser()` — DOTS, not
  `->`. So Case 0's "C-family punctuation" gate fires for PHP after all, which
  is why the call chain was recorded as a VISIBLE-GAP to begin with.
- Typing the fixture parameter (`function f(Service $svc)`) moved the row from
  VISIBLE-GAP to INVISIBLE-GAP: with a type binding the cascade now types the
  receiver but finds no member, so `compoundReceiverUnresolved` is false and no
  drop is recorded. An untyped fixture parameter had been reporting a language
  gap that was really a fixture defect — the same error class as the untyped
  `$repo` control caught earlier.


### Merged main `f6e42092`

Re-measured both benchmark arms after merging the Zig receiver fix from main.
Shape states remain unchanged; counts are 133 call drops and
160 drops of all kinds (27 reads,
0 writes). The counts include both main and this branch's fixes.

### C++ qualified receivers after #3653

Main `2b4456553` is merged normally. The field lookup retains both the declared namespace purpose and provider-qualified type handling. Build and both TypeScript configurations pass, and all 59 focused C++ and CommonJS merge checks pass. The measured receiver baseline has 133 call drops, 160 total drops, 27 reads and 0 writes.
