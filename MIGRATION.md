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
  "impactedCount": 0,
  "risk": "UNKNOWN",
  "candidates": [
    { "uid": "...", "name": "...", "kind": "Function", "filePath": "...", "line": 42, "score": 0.76 }
  ]
}
```

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
