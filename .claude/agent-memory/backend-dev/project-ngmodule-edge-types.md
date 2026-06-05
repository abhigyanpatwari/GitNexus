---
name: ngmodule-edge-types
description: Four new edge types added for Angular @NgModule metadata (DECLARES, IMPORTS_MODULE, PROVIDES, BOOTSTRAPS)
metadata:
  type: project
---

Added 4 new edge types to the LadybugDB schema and graph types for Angular `@NgModule` metadata extraction (issue #32):

- `DECLARES` — Module → declared component/directive/pipe class
- `IMPORTS_MODULE` — Module → imported Module (distinct from `IMPORTS` which is reserved for TS import-statement semantics)
- `PROVIDES` — Module → DI provider token
- `BOOTSTRAPS` — Module → root component(s)

**Why:** The `IMPORTS` edge type carries TS `import statement` semantics (raw module specifier, not class reference), so a separate `IMPORTS_MODULE` was required to disambiguate.

**How to apply:** When adding new edge types, update both `src/core/lbug/schema.ts` (REL_TYPES) and `src/core/graph/types.ts` (RelationshipType union). The LadybugDB CodeRelation table stores `type` as a STRING column — no schema migration needed for new values.

See [[angular-metadata-extractor]] for the extractor implementation, [[angular-decorator-ast]] for AST shape notes.
