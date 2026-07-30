# Receiver-resolution baseline

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
> Still gaps after U10, both genuine:
> - `(await svc.getUserAsync()).save()` — `extractMixedChain` reaches
>   `await …`, which is not a chain node, so no chain is minted. Remains a
>   VISIBLE-GAP and is now the call-kind fixture in the drop-recorder test.
> - `repos[0].save()` — Case 0's punctuation gate never fires for a subscript
>   receiver, so it stays INVISIBLE.
>
> The tables below are the pre-U10 measurement, kept as the reference point.

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

| Metric | Value |
|---|---|
| **Call drops (the gate number)** | **99** |
| Total drops, all site kinds | 124 |
| Split by site kind | `call: 99`, `read: 25` |

Call drops by extension:

| ext | n | ext | n | ext | n |
|---|---|---|---|---|---|
| `.java` | 49 | `.py` | 5 | `.rs` | 3 |
| `.cs` | 8 | `.go` | 5 | `.kt` | 3 |
| `.ts` | 7 | `.cpp` | 5 | `.rb` | 2 |
| `.tsx` | 6 | `.php` | 4 | `.js` | 1 |
| | | | | `.swift` | 1 |

**Why the split matters (KTD6 defect 1, now measured).** 25 of the 124 drops — 20% —
are property *reads*, not lost calls. Case 0's recorder gates on the receiver's
punctuation, not on what the reference is, so `d.source.kind` lands in the same
bucket as a dropped method call. Gating on the unsplit 124 would have measured a
population one fifth of which this work does not target.

## Shape arm

`RESOLVES` means an edge exists — **not** that it points at the right target. A
name-keyed fallback onto a same-named member reads as `RESOLVES`, so a shape whose
receiver has no well-defined type is not a usable control.

| Language | Shape | State | siteKind |
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
must be read against the same bias.

- Case 0's gate is a C-family punctuation test (`.` or `(`), so a receiver that is a
  plain property path (`$this->repo`, `a::b`) never reaches the recorder.
- `repos[0].save()` has neither `.` nor `(` in its receiver — same result.
- `?.` and explicit type arguments produce no reference site at all.
