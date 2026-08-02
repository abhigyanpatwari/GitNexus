# Migration Guide

## `impact` tool may now return `{ status: 'ambiguous' }` (PR #888, issue #470)

Before this change the `impact` MCP tool silently picked the first match
when the `target` name hit multiple symbols (Class → Interface → Function
→ Method → Constructor priority UNION). This often produced analysis for
the wrong symbol with no signal back to the caller.

After this change, when the resolver finds more than one viable match
and the caller supplied none of `target_uid` / `file_path` / `kind`,
`impact` returns a disambiguation response shaped like:

```json
{
  "status": "ambiguous",
  "message": "Found N symbols matching '<target>'. Use target_uid, file_path, or kind to disambiguate.",
  "target": { "name": "<target>" },
  "direction": "upstream",
  "impactedCount": null,
  "risk": "UNKNOWN",
  "candidates": [
    { "uid": "...", "name": "...", "kind": "Function", "filePath": "...", "line": 42, "score": 0.76 }
  ]
}
```

> `impactedCount` is `null`, not `0`, on an ambiguous result (#2687): no single
> symbol was resolved, so the blast radius is *undetermined*. A numeric `0` was
> indistinguishable from a genuine "nothing depends on this", so a caller
> testing `impactedCount === 0` read a false all-clear. Read `maxImpactedCount`
> (callgraph ambiguity) or the per-candidate counts in `candidates[]` for the
> real figure. Callers written as `impactedCount || 0` are unaffected.

### Do I need to migrate?

**Probably not, but check for assumptions.** Callers that unconditionally
read `result.byDepth` / `result.summary` / `result.affected_processes`
without first checking `result.status` will now see `undefined` in the
ambiguous case. The fix is to branch on `result.status === 'ambiguous'`
first and follow up with `target_uid` (preferred) or `file_path` / `kind`.

The `context` tool's ambiguous response is a strict superset of the
existing shape — every candidate gains a `score` field, no existing field
has changed. No migration required for `context` callers.

### What happens on re-index?

Nothing — this is an MCP-surface change only. The graph schema, indexer,
and stored data are untouched.

---

## OVERRIDES → METHOD_OVERRIDES (PR #642)

The `OVERRIDES` relationship type has been renamed to `METHOD_OVERRIDES` for
consistency with the new `METHOD_IMPLEMENTS` edge type.

### Do I need to migrate?

**No.** Backward compatibility is handled automatically at runtime:

- `local-backend.ts` dual-reads both `OVERRIDES` and `METHOD_OVERRIDES` in all
  impact-analysis and context queries. Existing stored graphs with `OVERRIDES`
  edges continue to return correct results without any manual intervention.
- The `REL_TYPES` array in `schema-constants.ts` includes both names so Cypher
  queries that reference either will work.

### What happens on re-index?

Running `npx gitnexus analyze` on a repository produces `METHOD_OVERRIDES`
edges going forward. The old `OVERRIDES` edges are replaced as part of the
normal full re-index.

### When will the legacy alias be removed?

The `OVERRIDES` compat alias will remain until a future major version. Removal
will be announced in this file and in the changelog before it happens.

## meta.json → gitnexus.json (PR #2363)

The per-repo index metadata file's primary name changed from
`.gitnexus/meta.json` to `.gitnexus/gitnexus.json` (and from
`branches/<slug>/meta.json` to `branches/<slug>/gitnexus.json` for
multi-branch indexes). This is purely a filename change — the JSON content
and every field in it are identical.

### Do I need to migrate?

**No.** Backward compatibility is handled automatically at runtime:

- `saveMeta` dual-writes both filenames on every analyze, so `meta.json`
  keeps existing and staying current. Older GitNexus binaries, still-running
  MCP servers, and the shipped editor hooks that read `meta.json` continue
  to work unchanged.
- `loadMeta` reads `gitnexus.json` first and falls back to `meta.json` when
  the primary file is absent, so a repo indexed by an older version works
  without re-analysis.
- Each `analyze` run also reconciles the two files (the fresher `indexedAt`
  wins and is written to both), so even a repo written by a mix of old and
  new versions converges. Nothing is ever deleted.

### What happens on re-index?

Running `npx gitnexus analyze` writes both `gitnexus.json` and `meta.json`
with identical content. A pre-existing repo that only has `meta.json` gets
`gitnexus.json` bootstrapped from it on the first run.

### What about rollback?

Downgrading to an older GitNexus version is safe: `meta.json` is always
present and current, so the older binary sees the existing index (including
the `incrementalInProgress` crash-recovery flag) instead of treating the
repo as never analyzed.

### When will the legacy mirror be removed?

The `meta.json` mirror will remain until a future major version. Removal
will be announced in this file and in the changelog before it happens.

## Ambiguous responses report the true match count (PR #2796, issue #2787)

The MCP symbol resolver returns at most 20 candidate rows. Every ambiguous
response used to take its count from that capped window, so a name with 92
matches (`constructor`, in this repo's own index) reported 20. The same PR
pinned the window with an `ORDER BY`, which turned that undercount from
flaky into stable — and a stable wrong number reads as authoritative.

Three consumer-visible changes follow:

- **`impact`'s `totalCandidates` changed meaning.** It was the length of the
  capped 20-row window; it is now the true `COUNT(*)` of matching symbols.
  Callers using `totalCandidates === candidates.length` as a "not truncated"
  proxy will now see the two diverge. This is a bug fix — the old number was
  wrong — but it is still a value change on a published field.
- **`totalCandidates` and `candidatesTruncated` are new on other tools.**
  They now also appear on `context`, `trace`, the `explain` / `pdg_query`
  block-anchor path, and on `rename` (which returns `context`'s ambiguous
  payload verbatim). `candidatesTruncated: true` is present only when
  `candidates[]` is shorter than `totalCandidates` — absent otherwise, never
  `false`.
- **The `message` template gained a `(showing M)` suffix.** It follows the
  total — `Found 92 symbols matching 'constructor' (showing 20). …` — and
  appears only when the returned window is smaller than the total. `impact`
  uses the longer `(showing M of N)` form.

### Do I need to migrate?

**Only if you read `totalCandidates` or parse `message`.** The last two
changes are purely additive — no field was removed or renamed and
`candidates[]` keeps its shape — so PR #888's "no existing field has changed.
No migration required for `context` callers" still holds for `context`.

- Reading `totalCandidates` on `impact`: it is a true total now. Detect a
  shortened window with `candidatesTruncated` (or `totalCandidates >
  candidates.length`) rather than by comparing it to an array length.
- Parsing `message` for a count: the total is still the first number, but a
  `(showing M)` parenthetical may now follow it. Prefer the structured
  `totalCandidates` field over the string.

### What happens on re-index?

Nothing — this is an MCP-surface change only. The graph schema, indexer,
and stored data are untouched.
