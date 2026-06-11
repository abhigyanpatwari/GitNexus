---
name: 159-callsite-id-heritage-mode-a
type: feature
risk: high
impacted: [c3_ingestion, c3_lbug]
status: proposed
date: 2026-06-10
branch: main-afk (pre-branch; feature branch cut at ship time)
base: "#159 P3 Mode A (PR #168, merged) on the PR #165 foundation"
implements: "#159 next slice — (A) CALLS call-site identity (:L line in edge id, RFC §5 Open Q1) + (B) IMPLEMENTS/EXTENDS Mode A augmentation (TS-only)"
---

# #159 slice — CALLS call-site identity + IMPLEMENTS/EXTENDS Mode A

> Companion to the plan `docs/plans/159-callsite-id-heritage-mode-a.md`. AI agents read this `.md`; no separate `.likec4`/`.html` for this slice. All file:line cites verified against trunk `main-afk` (post-PR #168) by a 10-agent explore→design→adversarial-verify pass (5 load-bearing claims attacked; 3 confirmed, 2 refuted-on-phrasing and folded in).

## Problem & Approach

**Problem.** Two gaps remain after P3 Mode A (PR #168):

1. **(A) Call-site identity loss.** Heuristic TS/JS CALLS ids are `CALLS:${sourceId}:${calledName}->${targetId}` (`call-processor.ts:668`, `:1537`) — no line component. `graph.addRelationship` dedups solely on id (`graph.ts:14`), so repeated same-name calls from one function silently collapse into one edge. RFC #159 §5 flagged this as the prerequisite for clean per-site reconciliation (Open Q1). COBOL already embeds `:L${line}`; TS/JS does not. Post-#168 this is now load-bearing: corrections key on call sites, but the graph cannot represent two sites to the same target.
2. **(B) Heritage edges are heuristic-only.** IMPLEMENTS/EXTENDS resolution falls back to a generated parent id at confidence 0.5 for unresolved/global parents (`heritage-processor.ts:74-91`) with no LSP augmentation — Mode A is CALLS-only.

**Approach.** Fix (A) first — it changes the default-analyze baseline **exactly once, deliberately** (duplicate-site edge counts grow; ids gain `:L<row>`) and is independently landable. Then (B) extends the *existing* Mode A machinery — feeds, one session, decision engine, mapper — to heritage edges with zero duplication: a `heritageFeed` populated at the heritage emit sites (gated `opts?.lsp` ∧ TS-family ∧ `parent.confidence === 0.5` ∧ position available), candidates tagged `relType: 'IMPLEMENTS' | 'EXTENDS'`, per-type target-label gates, and `textDocument/definition` at the **parent-identifier** position (KD-5). Correction precision under the new multiplicity is guaranteed by a feed-carried `oldRelId` + direct-id lookup, and by making the reconciler's collapse/index keys line-aware.

```mermaid
graph TD
    subgraph default path - byte-identical except the one WI-1 change
        PC["processCalls / processCallsFromExtracted<br/>id: ...->target:L&lt;row&gt; + line prop (WI-1)"]
        HP["heritage-processor emit sites<br/>(ids unchanged, KD-2)"]
    end
    subgraph lsp path - behind --lsp
        CF["correctionFeed/recallFeed + oldRelId (WI-1)"]
        HF["heritageFeed: HeritageFeedItem (WI-4)"]
        DD["candidateLocationKey dedup<br/>+ |relType only-when-set (WI-5)"]
        SESS["ONE withReconciliationSession (WI-6)"]
        ENG["decideForCandidate (UNCHANGED)<br/>gate = relType ? HERITAGE_TARGET_LABELS : CALLABLE (WI-5)"]
        APPLY["applyDecisions: line-aware keys +<br/>oldRelId direct lookup; mint :L for CALLS only (WI-2)"]
    end
    PC --> CF --> DD
    HP --> HF --> DD
    DD --> SESS --> ENG --> APPLY
```

## KeyDecisions

| # | Decision | Why |
|---|---|---|
| KD-1 | Line-aware CALLS ids `…->${target}:L${row}` at the two per-site heuristic emit sites; in-memory `line?: number` on `GraphRelationship`, NOT serialized | Restores per-site multiplicity; CSV (`csv-generator.ts:457`, no id column) and Kùzu REL table (no uniqueness constraint) are id-agnostic; mirrors the COBOL convention |
| KD-2 | Route/tool/heritage ids stay unsuffixed (`:1803/:1817/:1830/:2891`; `IMPLEMENTS:${from}->${to}`) | Synthetic 1:1 edges / one-edge-per-clause — `:L` churns ids with zero dedup benefit |
| KD-3 | Feed-carried `oldRelId` on correction candidates (CALLS + heritage) + direct-id lookup before the index | Post-(A) multiplicity makes the `(sourceId,targetId)` last-writer-wins index (`mode-a-reconciler.ts:1603-1611`) unsafe — a `correct` could remove the WRONG site's edge |
| KD-4 | Line-aware collapse/index key `${from}\|${to}\|${type}\|${line ?? ''}` at all four key sites (`:1151/:1293/:1314/:1382`) | Adversarially confirmed: collapse runs on every non-dryRun apply (`:1275-1277`); without this, `--lsp` silently deletes distinct-line duplicates the default keeps. `''` suffix keeps non-CALLS byte-identical |
| KD-5 | Heritage via `textDocument/definition` at the parent-identifier position — NOT `typeHierarchy/supertypes` | definition is the ONLY LspClient method; didOpen-on-demand hard-keyed to it (`lsp-client.ts:309`); no capability additions (`:102-122`); direction natively child→parent. typeHierarchy = future implicit-heritage-recall slice |
| KD-6 | One shared session for CALLS + heritage; `Candidate.relType?` (absent ⇒ CALLS) | Reuses the whole shipped funnel; exactly ONE `withReconciliationSession` call must remain — the AC-7 partial-mock (`mode-a-golden.test.ts:1312-1324`, `.mockImplementationOnce`) intercepts only the first |
| KD-7 | Per-type gates `IMPLEMENTS→{Interface}`, `EXTENDS→{Class}` via the existing `deps.callableLabels` (`:1473`); `decideForCandidate` (`:935-1042`) unchanged | Refuse-over-guess: type-flips → `keep`; the `non_callable` reason string is test-pinned and kept |
| KD-8 | `candidateLocationKey` gains `\|${relType}` only-when-set (`:1627-1629`) | CALLS keys byte-identical; single shared helper for producer + consumer |
| KD-9 | A before B; (A) independently landable; one deliberate baseline change | (B) lands on stabilized keys; determinism guards are RELATIVE two-run comparisons (adversarially confirmed, no stored literals) so the format change is safe; BFS dedups on node id (`local-backend.ts:2379`) |

## Contracts

- **`GraphRelationship.line?: number`** (new, in-memory only): 0-based call-site line; set only on per-site CALLS edges; never serialized to CSV.
- **CALLS id (per-site heuristic sites)**: `` generateId('CALLS', `${sourceId}:${calledName}->${targetId}:L${row}`) `` where `row = nameNode.startPosition.row` (`:668`) / `effectiveCall.line ?? 0` (`:1537`). Reconciler-minted CALLS: `` `${d.from}->${d.to}:L${d.candidate.line}` ``.
- **`CorrectionFeedItem` += `oldRelId: string`** — the exact heuristic edge id (in scope at `:668`; at `:1526-1535` the `relId` computation moves above the push — verified the push currently precedes it).
- **`HeritageFeedItem`** (new): `{ sourceId, parentName, oldTargetId, oldRelId, relType: 'IMPLEMENTS'|'EXTENDS', file, line, character }`; **`ProcessHeritageOpts`** `{ lsp?, heritageFeed? }` on `processHeritage` (`:93-98`) and `processHeritageFromExtracted` (`:362-367`).
- **Heritage position contract:** `line/character` = `captureMap['heritage.X'].startPosition` of the **parent** identifier (the `B` in `class A extends B`); `ExtractedHeritage` gains optional `line?/character?` (`parse-worker.ts:364-370`, populated at `:2737-2760`). Ruby heritage records keep `line` undefined → excluded by the feed gate.
- **Heritage feed gate:** `opts?.lsp` ∧ TS-family file ∧ `parent.confidence === 0.5` ∧ position available ∧ edge actually emitted. Never: same-file/import-scoped (0.95/0.9), Go `cross-file-implements|…`, Ruby include/extend/prepend, trait-impl, composition.
- **`Candidate` += `relType?: 'IMPLEMENTS'|'EXTENDS'`, `oldRelId?: string`**; `candidateLocationKey` += `|${relType}` only-when-set.
- **`HERITAGE_TARGET_LABELS`** = `{ IMPLEMENTS: {Interface}, EXTENDS: {Class} }`, passed per-candidate as `deps.callableLabels`.
- **Collapse/index key** = `${sourceId}|${targetId}|${type}|${line ?? ''}` at `:1151/:1293/:1314/:1382`.
- **Decision table** (inherited): existing edge + LSP B==A → confirm (id preserved via `...existing` spread `:1246-1250`) / B≠A → correct (old edge removed by exact `oldRelId`) / refusal → keep; no edge + callable/gated B → add; multi-Location → AMBIGUOUS → keep.

## Invariants

- **I-1** Default `analyze` (no `--lsp`) byte-identical run-to-run; the only baseline change vs PR #168 is WI-1's (ids gain `:L`, duplicate sites stop collapsing), made exactly once.
- **I-2** Every default-path CALLS and heritage edge stamps in-memory `source:'heuristic'` (B1 contract); the `mode-a-golden.test.ts:370/:486/:602` hard-equality guards pass UNMODIFIED — never coalesced.
- **I-3** `--lsp` with no server ⇒ relationship set identical to default — the line-aware collapse key (KD-4) makes `--lsp`-only edge loss impossible.
- **I-4** A `correct` removes exactly the edge cited by `oldRelId`; wrong-site removal impossible under multiplicity.
- **I-5** CALLS candidates without `relType` produce byte-identical keys/decisions vs PR #168 (compat pins).
- **I-6** Heritage regression guard fires server-independently (feed population asserted with NO server — the #166 lesson).
- **I-7** Exactly ONE `withReconciliationSession` call in `pipeline.ts`.
- **I-8** Heritage `from` is always the child class node (direction native to definition-at-parent-identifier).
- **I-9** Type-flip corrections never emitted (label gates refuse → keep).

## Flows

```mermaid
sequenceDiagram
    participant P as runPipelineFromRepo --lsp
    participant CP as processCalls (per-site ids :L)
    participant HP as heritage-processor
    participant G as in-memory graph
    participant R as mode-a-reconciler (ONE session)
    participant L as LspClient (tsserver)
    P->>CP: processCalls(..., lspFeedsOpt)
    CP->>G: addRelationship CALLS id ...->T:L<row> (source heuristic)
    opt opts?.lsp and reason === 'global'
        CP->>CP: correctionFeed.push({..., oldRelId})
    end
    P->>HP: processHeritage*(..., heritageOpts)
    HP->>G: addRelationship IMPLEMENTS/EXTENDS (source heuristic, id unchanged)
    opt opts?.lsp and TS-family and parent.confidence === 0.5 and position
        HP->>HP: heritageFeed.push({..., relType, oldRelId})
    end
    P->>P: candidates = dedup(correction ∪ recall ∪ heritage) by candidateLocationKey(+relType)
    alt probe ready
        P->>R: withReconciliationSession(candidates)
        loop sorted prefix ≤ cap (shared CALLS+heritage)
            R->>L: textDocument/definition(line, character)
            L-->>R: Location | null
            R->>R: gate = relType ? HERITAGE_TARGET_LABELS[relType] : CALLABLE
            alt B == oldTarget
                R->>G: confirm (id preserved, 0.70 lsp-confirmed)
            else B ≠ oldTarget, label in gate
                R->>G: correct — remove exact oldRelId, mint typed edge (0.70 lsp-corrected; :L only for CALLS)
            else refusal (NO_NODE / AMBIGUOUS / label out of gate / self-loop)
                R->>R: keep (heuristic stands)
            end
        end
        R->>G: applyDecisions — line-aware collapse keys (KD-4)
    else server absent / not ready
        P->>P: session null — every candidate keeps heuristic; graph == default
    end
```

## EdgeCases

- **Duplicate call sites:** `f(){ a(); b(); a(); }` → TWO CALLS edges to `a` (`:L10`/`:L12`-style), both heuristic; LSP correcting only L12 leaves L10 untouched (asserted by exact ids).
- **Position-less fast-path calls:** `effectiveCall.line` undefined → `:L0`; same-name `:L0` calls still collapse (no regression vs today; documented).
- **`--lsp`, no server, duplicate sites:** session null + line-aware collapse → relationship set identical to default (the KD-4 regression this design exists to prevent).
- **`class A implements I1, I2`:** two heritage records with distinct positions → distinct candidates.
- **`implements SomeClass` (legal TS) / EXTENDS resolving to an Interface:** target label out of gate → `keep` (type-flip is a non-goal).
- **Go/Ruby heritage under `--lsp`:** excluded by the TS-family/kind gate; PR #156 tests (`go-implements-cross-file`, `go-implements-anonymous`, `issue-88-verification`, `java-heritage-generic`) pass UNMODIFIED.
- **Heritage minted id == heuristic template:** `IMPLEMENTS:${from}->${to}` — format-consistent; collisions tolerated by collapse (`:1164-1174`).
- **Shared 2000 cap:** CALLS + heritage compete; deterministic prefix after stable sort; partitioning is a documented follow-up.

## BlastRadius

- **d1 (will-break / must-update):** `call-processor.ts` (`:668`, `:1537`, `CorrectionFeedItem`, `:1526` reorder) · `mode-a-reconciler.ts` (`makeLspRelationship :1332-1350`, four key sites, `Candidate`, `candidateLocationKey`, existing-rel lookup `:1529-1534`) · `heritage-processor.ts` (opts + push sites worker `:378-411` / AST `:190-246`) · `pipeline.ts` (feed declaration, threading at `:368/:491/:494`, candidate merge `:645-692`) · `parse-worker.ts:364-370, :2737-2760` · `graph/types.ts` (+`line?`).
- **d2 (likely-affected / should-test):** every consumer of CALLS edge counts (count-pins on duplicate-site fixtures — updated with per-case justification); the exact-shape feed pin `call-processor.test.ts:827-834` (+`oldRelId`, conscious tripwire update); mode-a-engine manual-Decision fixtures (gain `line`/`oldRelId`); golden (d) block candidate construction.
- **d3 (may-need-testing):** CSV/Kùzu roundtrip with duplicate `(from,to,type)` rows (REL table, no uniqueness constraint — re-proven); `impacted_endpoints` BFS (node-id dedup `local-backend.ts:2379` — unaffected); dry-run print shape (action-set regex — unchanged).
- **Confirmed non-impact:** route/tool/COBOL id sites; `decideForCandidate` body; session funnel/probe/mapper (`MAPPER_LEAF_LABELS` already includes Class+Interface, `location-mapper.ts:92-97`); `detect_changes`/`context`/`rename`; `gitnexus-web/`.
- **Untouchable tests:** `mode-a-golden.test.ts:370/:486/:602` source guards, the relative snapshot assertions (`:355/:379/:475/:612`), the AC-7 block, PR #156 heritage tests.
