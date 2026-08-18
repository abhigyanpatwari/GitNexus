# Forge-Specific Extensions

Status: implementation baseline

This directory records behavior that belongs to the `mengkaka/GitNexus` fork. It is intentionally separate from upstream-oriented architecture and user documentation so that a future rebase can distinguish fork contracts from upstream behavior.

## Baseline and status

- Upstream project: <https://github.com/abhigyanpatwari/GitNexus>
- Fork remote: <https://github.com/mengkaka/GitNexus>
- Current fork revision when this directory was introduced: `28187bb3a708`
- Public compatibility rule: without a documented fork option, GitNexus must preserve upstream behavior.

| Capability                 | Status      | Contract                                                                               |
| -------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| Objective-C Provider       | Implemented | [OBJECTIVE_C_PROVIDER.md](OBJECTIVE_C_PROVIDER.md)                                     |
| External index storage     | Implemented | [EXTERNAL_STORAGE_AND_CONTENT_RETENTION.md](EXTERNAL_STORAGE_AND_CONTENT_RETENTION.md) |
| Content retention profiles | Implemented | [EXTERNAL_STORAGE_AND_CONTENT_RETENTION.md](EXTERNAL_STORAGE_AND_CONTENT_RETENTION.md) |

`Implemented` means the documented MVP, regression tests, metadata contract, and package/runtime wiring are present on the fork's `dev` branch. It does not expand the provider into full Objective-C runtime dispatch. `Planned` means no CLI, MCP, Web UI, or environment-variable behavior may claim support yet. Each implementation PR must update this table, its related design document, tests, and the public README environment-variable table where applicable.

## Reading order

1. Read this file for scope and compatibility boundaries.
2. Read [OBJECTIVE_C_PROVIDER.md](OBJECTIVE_C_PROVIDER.md) before adding Objective-C parsing or resolution.
3. Read [EXTERNAL_STORAGE_AND_CONTENT_RETENTION.md](EXTERNAL_STORAGE_AND_CONTENT_RETENTION.md) before changing repository storage, metadata, content fields, FTS, CLI, MCP, or Web UI behavior.
4. Read `ARCHITECTURE.md`, `AGENTS.md`, and the affected implementation code before editing.

## Ownership boundary

GitNexus fork responsibilities:

- Parse and model Objective-C with explicit confidence and unresolved cases.
- Persist one repository index at a caller-selected directory while preserving the existing default location.
- Control which source-derived text is stored in that index and expose the resulting capabilities honestly.

ForgeMate responsibilities, intentionally not implemented here:

- Temporary checkout lifecycle, repository identity, index slot naming, and `current` / `previous` retention.
- Source SHA selection, Wiki publication, job status, access control, and cross-repository authorization.
- Combining Wiki and code evidence in its own MCP facade.

The fork must not turn GitNexus into ForgeMate's authoritative version database or a multi-repository shared graph database. A GitNexus index remains a rebuildable per-repository artifact.

## Change rules

- Keep default, no-option behavior byte-for-byte compatible where practical.
- Persist every option that changes index semantics in repository metadata and reject unsafe incremental reuse.
- Treat an index as valid only for its recorded source revision, parser/provider versions, schema, retention profile, and indexing configuration.
- Do not silently substitute filesystem source content for stored content, or vice versa.
- Do not add ForgeMate-specific paths, project IDs, credentials, or runner behavior to GitNexus core.

## Documentation lifecycle

The local `docs/plans/` files are working notes and may remain ignored. Once a design is adopted, this directory is the tracked source of truth for fork contracts. User-facing documentation must not advertise a planned option as available before its code and regression tests land.
