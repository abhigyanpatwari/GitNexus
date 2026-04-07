# Migration Guide

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
