# Receiver-resolution baseline

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

| Origin | Count | Is anything lost? |
|---|---|---|
| `external` | **76** | **No.** `System.out.println`, `fetch(...)`, `os.environ.setdefault`, `document.body.appendChild`, `.stream()`. The callee is not in the graph — there is no node an edge could point at. |
| `in-program` | 20 | Yes in principle — but see below. |
| `unknown` | 6 | Yes. Casts, ternaries, `globalThis.x ??= []`. |

**A compiler resolves `System.out.println` against the JDK.** Lacking the JDK,
the honest statement is *"this call leaves the analyzed program"* — not *"this
analysis is incomplete"*. Those are different epistemic states, and collapsing
them is what made `impact` report a lower bound on essentially every real
codebase, which is what teaches readers to ignore the signal.

`ResolutionOutcome.receiverOrigin` now records which one applies, and
`summarizeUnresolvedReceivers` skips `external`. `unknown` still counts —
assuming a completeness we cannot demonstrate is the unsafe direction.

### How origin is decided

By the receiver base's **declared type**, not its name. A first cut asked
whether the base was a local, which marked `inputs.stream()` in-program:
`inputs` is a local, but its type `List<String>` is JDK, so the target is
external. Asking whether the base's *type* is one this index contains moved 28
sites to the correct bucket.

### What the remaining 20 in-program drops actually are

Mostly **not** product defects. `user.Address.Save()` resolves cleanly in
isolation — the `csharp-deep-field-chain` fixture alone emits both expected
edges with **zero** drops. It drops in the count arm only because the corpus is
~200 independent mini-projects in one directory and **55 files define
`Address`**, so the resolver correctly declines on ambiguity rather than picking
one. That is right behaviour measured on an unrepresentative corpus.

The genuinely untypeable population is the 6 `unknown` — and those are the real
targets for type resolution, because a cast *gives* you the type
(`((Box<String>) obj).open()`) and a ternary needs a join of its branch types.
They were previously invisible under 76 stdlib calls.

`callDropsByOrigin` is now part of the gated projection, so this split cannot
drift silently.

---

## Phantom callee read sites — a duplicate-edge bug the U8 test missed

Go's `@reference.read` pattern matches **every** `selector_expression`, with no
call-position exclusion. So `h.dep.Work()` minted **three** reference sites:

| site | kind | name | what it is |
|---|---|---|---|
| S1 | `call` | `Work` | the member call |
| S2 | `read` | `Work` | **phantom** — the callee `h.dep.Work`, already captured by S1 |
| S3 | `read` | `dep` | the genuine field read |

S2 resolved through `findOwnedMember`, which prefers methods over fields, and
emitted an `ACCESSES` edge to the **method** duplicating S1's `CALLS` edge at the
same position.

**The U8 assertion passed by accident.** It asserted `RunSamePackage → Work` was
absent from `ACCESSES`, and it was — but only because that row has a *pointer*
receiver whose text-cascade head lookup failed for an unrelated reason. The
value-receiver twin was emitting the bad edge the whole time:

```
ACCESSES  RunFromValueReceiver -> DoWork:Method     <- phantom, shipped
ACCESSES  RunLocal             -> DoWork:Method     <- phantom, shipped
```

Fixed at the emitter: a selector in **function position** is never a read. A
method *value* (`f := h.dep.Work`) is not in function position and is untouched.
The assertion is now backed by an exact-set check over the whole fixture, so a
new phantom fails even on a row nobody wrote a targeted assertion for.

### What the numbers say

- `callDrops` **unchanged at 102** — no call was lost.
- `read` drops **27 → 22**: five phantom sites were being *recorded as drops*,
  inflating the read bucket with sites that were never field reads.
- One drop reclassified `chain-field` → `chain-unwrap`. The phantom and the real
  call share a site key, so the phantom's field-shaped chain was previously the
  one recorded. The census now describes the actual dropped call.

Caught by three review agents dispatched at the A1 regression; the phantom was
the mechanism, not the global-normalization story the first revert note asserted.

---

## U9 (part 2) — no drop ratchet is needed; the gate is already stronger

The plan's R10 set a ZERO supported-shape drop target, and review correctly
found that it contradicts R12: a site whose normalized name matches more than
one class MUST decline, a decline records a drop, and simple names collide
routinely in large Go and Java codebases. The proposed fix was a ratchet — the
count may not rise above the value measured after the last unit.

Neither is needed. `measure.mjs --check` already asserts **exact match** against
the committed baseline, which is strictly stronger than a ratchet: the count
cannot rise *or* fall without a deliberate `--update-baseline`, and that path
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

| Cap | Chain minted? | Cell state |
|---|---|---|
| 3 | **none** (confirmed by probing the emitter directly) | **RESOLVES** |
| 4 | `2\|root\|cgetSvc\|cgetUser\|faddress\|cgetCity` | RESOLVES |

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

| Cause | Unit | What it means | Is it a defect? |
|---|---|---|---|
| `receiverTyping` | call sites | Call sites dropped because the analyzer could not type the receiver | **Yes** — a resolver gap. This is the population this whole series targets. |
| `dispatchBoundary` | symbols | The symbol sits behind an interface with real consumers or 2+ implementations; the number is the implementations plus interface-level consumers behind it | **No** — callers binding through DI or dynamic dispatch are genuinely untraceable statically. A compiler refuses here too. |
| `externalBoundary` | call sites | The call left the indexed program (`System.out.println`, `fetch(...)`) | **No**, and not even a shortfall — there is no in-graph node an edge could have reached. An `epistemic: 'exact'` result can carry it. |

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

| Shape | Count | Share |
|---|---|---|
| `chain-field` — every step a field (`h.repo.save()`) | 60 | 59% |
| `chain-call` — every step a call (`svc.getUser().save()`) | 27 | 27% |
| `no-chain` — no chain minted; the walk found no nameable base | 12 | 12% |
| `chain-mixed` — interleaved (`svc.getUser().addr.save()`) | 2 | 2% |

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
  `-kotlin` and `-swift` are vendored *optional* grammars: absent when a run sets
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

| Cell | Receiver | Field | State |
|---|---|---|---|
| `fieldReceiverCall` | value | value | RESOLVES |
| `decoratedFieldType` | value | **pointer** | RESOLVES |
| `decoratedReceiverBase` | **pointer** | value | **VISIBLE-GAP** |

Only the pointer *receiver* fails. Go already normalizes field type bindings
through `normalizeGoTypeName`, so the step lookup is sound and the defect is
entirely the base — `synthesizeGoReceiverBinding` stores `typeNode.text` raw, so
`func (h *Host)` binds `h` to the literal `*Host`, which
`findClassBindingInScope` cannot resolve.

**PHP — the sigil hypothesis is dead.** The two rows differ only in whether the
called method declares a return type:

| Cell | Return type | State |
|---|---|---|
| `arrowCallChain` — `$svc->getUser()->save()` | unannotated | INVISIBLE-GAP |
| `plainChain` — `$svc->getUserTyped()->save()` | **annotated** | **RESOLVES** |

Same chain, same `->`, same base. PHP chains resolve when the return type is
declared; the `$` sigil is not involved. `decoratedFieldType` (`?User $repo`)
also resolves, so PHP nullable field types already work.

**C++ — the base already resolves, but `this->` field receivers do not.**
`pointerArrowChain` and `valueDotChain` both RESOLVE, so a decorated C++ base is
not a gap. But `this->repo.save()` and `this->repo->save()` are both
INVISIBLE-GAP — a distinct defect, not a decoration one.

**Rust — the decorated receiver is NOT a gap.** `&mut self` resolves, so Go is
the only language whose method receiver decoration defeats the lookup. Rust's
gap is the field: `Box<User>` is INVISIBLE-GAP.

### The decoration cells, across all 14

The rows U1 exists to fix. Everything else is a different defect. **Snapshot: as
measured at U2, i.e. BEFORE U1 landed** — it is the statement of the problem, not
of the current state. Go's `decoratedReceiverBase` and TypeScript's
`decoratedFieldType` have since moved; `baseline.json` has the live cells.

| Language | `decoratedReceiverBase` | `decoratedFieldType` |
|---|---|---|
| go | **VISIBLE-GAP** (`*Host`) | RESOLVES |
| rust | RESOLVES (`&mut self`) | **INVISIBLE-GAP** (`Box<User>`) |
| typescript | N/A | **INVISIBLE-GAP** (`User \| null`) |
| csharp | N/A | **VISIBLE-GAP** (`User?`) |
| swift | N/A | **INVISIBLE-GAP** (`User?`) |
| cpp | N/A | **INVISIBLE-GAP** (`User*`) |
| python, php, kotlin, dart | N/A | RESOLVES |
| java, c, javascript, ruby | N/A | N/A |

So U1's measured scope is **Go's receiver base**, plus the field-type gap in
**Rust, TypeScript, C#, Swift and C++** — and *not* PHP, Python, Kotlin, Dart or
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

| Metric | Control | Treatment | Δ | Threshold | Verdict |
|---|---|---|---|---|---|
| scope-resolution wall-clock, median of 3 | 25470.0 ms | 25687.9 ms | +0.86% | ≤ +3% | **PASS** |
| wall-clock, slowest of 3 | 25520.0 ms | 25832.6 ms | +1.22% | ≤ +5% p95 | **PASS** |
| serialized bytes per emitting site | — | **35.2 B** | — | ≤ 48 B | **PASS** |
| persisted store growth | 1 234 600 B | 1 235 340 B | **+0.0599%** | ≤ 3% | **PASS** |
| retained chain payload | — | 740 B | — | ≤ 6 MB | **PASS** |
| call drops (no regression) | 99 | 99 | 0 | no new drops | **PASS** |
| peak RSS | — | — | — | ≤ +2% | **NOT RESOLVABLE** |

**The 35.2 B result confirms KTD7 by measurement rather than by assertion.** The
48-byte threshold was set deliberately so the object encoding (~71 B predicted)
fails and the compact string (~35 B predicted) passes. Measured: 35.2 B,
including the JSON key and quotes. The encoding decision is now evidence-backed.

**Peak RSS: the threshold is below this instrument's resolution, so it is
reported as unresolvable rather than as a pass or a fail.** Three *independent*
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

| Metric | Value at U7 |
|---|---|
| **Call drops (the gate number)** | **99** |
| Total drops, all site kinds | 124 |
| Split by site kind | `call: 99`, `read: 25` |

Call drops by extension, at U7:

| ext | n | ext | n | ext | n |
|---|---|---|---|---|---|
| `.java` | 49 | `.py` | 5 | `.rs` | 3 |
| `.cs` | 8 | `.go` | 5 | `.kt` | 3 |
| `.ts` | 7 | `.cpp` | 5 | `.rb` | 2 |
| `.tsx` | 6 | `.php` | 4 | `.js` | 1 |
| | | | | `.swift` | 1 |

**Why the split matters (KTD6 defect 1, now measured).** About a fifth of the
drops are property *reads*, not lost calls (25 of 124 at U7; `bySiteKind` in
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

| Language | Shape | State at pre-U10 | siteKind |
|---|---|---|---|
| TypeScript | `svc.getUser().save()` | RESOLVES | — |
| TypeScript | `svc.getUser().address.save()` | RESOLVES | — |
| TypeScript | `svc?.getUser().save()` | **INVISIBLE-GAP** | — |
| TypeScript | `svc!.getUser().save()` | VISIBLE-GAP | `call` |
| TypeScript | `(await svc.getUserAsync()).save()` | VISIBLE-GAP | `call` |
| TypeScript | `svc.getTyped<User>().save()` | **INVISIBLE-GAP** | — |
| TypeScript | `repos[0].save()` | **INVISIBLE-GAP** | — |
| PHP | `$svc->getUser()->save()` | VISIBLE-GAP | `call` |
| PHP | `$this->repo->save()` (typed property) | RESOLVES | — |
| C++ | `svc->getUser()->save()` | **INVISIBLE-GAP** | — |
| C++ | `svc2.getUser()->save()` | RESOLVES | — |

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

   | Shape | `@reference.receiver` |
   |---|---|
   | `svc?.getUser().save()` | `svc?.getUser()` |
   | `svc.getTyped<User>().save()` | `svc.getTyped<User>()` |
   | `repos[0].save()` | `repos[0]` |

   So a `ReferenceSite` exists for every one of them, and hanging a
   `receiverChain` field on `ReferenceSite` is a viable carrier for all of them.
   That was worth establishing before building on it.

   The drop suppression is therefore downstream of capture. For `repos[0]` the
   cause is known and matches the plan: the receiver has neither `.` nor `(`, so
   Case 0's gate never fires. For `?.` and `<T>` the receiver text satisfies the
   gate, so Case 0 *does* run and one of two things happens — the site was marked
   in `handledSites` by another case, or `resolveCompoundReceiverClass` returned a
   class on which the member was then not found, leaving
   `compoundReceiverUnresolved` false. Those are materially different defects and
   which one applies is **not yet determined**; it is the first thing U10 has to
   establish, since the second would mean the recorder under-reports by
   mis-attribution rather than by a gate.

   *(An earlier revision of this file asserted that these shapes produce no
   reference site at all. That was inferred from edge-and-drop absence and is
   disproven by the capture dump above.)*

3. **KTD6 defect 2 overstates the PHP blindness.** The claim is that Case 0's
   C-family punctuation test means PHP `->` receivers "never record a drop at
   all". Measured, `$svc->getUser()->save()` *is* recorded, because its receiver
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
  claim that `?.` and explicit type arguments *"produce no reference site at all"*.
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

| Language | Shape | Before | After |
|---|---|---|---|
| TypeScript | `svc?.getUser().save()` | INVISIBLE-GAP | **RESOLVES** |
| TypeScript | `svc!.getUser().save()` | VISIBLE-GAP | **RESOLVES** |
| TypeScript | `svc.getTyped<User>().save()` | INVISIBLE-GAP | **RESOLVES** |
| C++ | `svc->getUser()->save()` | INVISIBLE-GAP | **RESOLVES** |
| C++ | `svc2.getUser()->save()` (control) | RESOLVES | RESOLVES |
| PHP | `$svc->getUser()->save()` | VISIBLE-GAP | INVISIBLE-GAP |
| PHP | `$this->repo->save()` (control) | RESOLVES | RESOLVES |

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
