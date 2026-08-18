# External Storage and Content Retention

Status: implemented

## Goal

Add two opt-in environment variables while preserving the current repository-local behavior by default:

```sh
GITNEXUS_STORAGE_PATH=/absolute/path/to/index-slot
GITNEXUS_CONTENT_RETENTION=full|symbol|none
```

`GITNEXUS_STORAGE_PATH` lets an orchestrator choose the exact directory for one repository index. `GITNEXUS_CONTENT_RETENTION` controls source-derived text written into LadybugDB. Neither option creates a shared graph database or makes GitNexus responsible for an external system's version lifecycle.

## Implemented scope

- The storage resolver is used for index files, metadata, parse caches, locks, branch placement, registry lookup, CLI status, MCP, HTTP, and cleanup operations.
- `full`, `symbol`, and `none` retention are persisted in metadata, select compatible FTS columns, and force a full rebuild when the recorded profile or FTS profile is incompatible.
- MCP and CLI content requests expose retention capability; the HTTP file-preview and grep endpoints return an explicit unavailable response when the profile or missing checkout cannot provide source. The Web UI renders that unavailable state.
- Regression coverage includes storage resolution, metadata compatibility, rebuild behavior, retention profiles, CLI/MCP/API/WebUI behavior, and Objective-C symbol snippets.

The implementation deliberately does not add ForgeMate lifecycle orchestration, external storage services, source-content authorization, project identity, or a shared graph database.

## Storage path contract

### Inputs and default

- A missing `GITNEXUS_STORAGE_PATH` keeps the upstream storage location: `<repo>/.gitnexus/`.
- A non-empty value must be an absolute, NUL-free path whose parent can be created and written. Relative, invalid, or unusable values fail before analysis begins.
- The supplied value is the complete directory for one index, not a common root. The caller owns repository identity and chooses a collision-free slot name.
- When external storage is selected, GitNexus must not create a `.gitnexus/` placeholder, symlink, or metadata duplicate in the source worktree.

### What moves

Every repository-index artifact must resolve through one storage resolver: LadybugDB (`lbug`), index metadata, GitNexus metadata, parse caches, parsed-file caches, lock files, branch placement, runner files, cleanup targets, and any future sibling artifacts. Redirecting only the database is incorrect because later CLI, MCP, server, or cleanup operations would still look in the temporary checkout.

Resolution order is:

```text
1. Explicit GITNEXUS_STORAGE_PATH
2. storagePath recorded in the registered repository entry
3. <repository>/.gitnexus/ compatibility default
```

Registry records may add an optional `storagePath`. On a successful analysis with an explicit path, GitNexus records the resolved absolute path so `status`, `serve`, and MCP can open the index after the source worktree has been removed. Existing registry entries without this field remain valid and use the local default.

### Concurrency and lifecycle

One storage slot permits one writer under the existing lock discipline. Distinct slots may analyze concurrently. GitNexus may know the checkout path used for analysis as diagnostic metadata, but it must not require that path to still exist for graph-only MCP/CLI operations.

An external caller may write to a staging slot and atomically promote it to its own `current` location, retaining a previous slot for rollback. That naming, retention, deletion, source checkout, source revision selection, and authorization are external orchestration concerns, not GitNexus behavior.

## Content retention contract

### Profiles

| Value    | File `content` | Symbol/section snippets | Graph and identities | Intended effect                                                 |
| -------- | -------------- | ----------------------- | -------------------- | --------------------------------------------------------------- |
| `full`   | Retained       | Retained                | Complete             | Current upstream-compatible behavior.                           |
| `symbol` | Omitted        | Retained                | Complete             | Preserve symbol-level evidence without full eligible file text. |
| `none`   | Omitted        | Omitted                 | Complete             | Preserve structural graph only.                                 |

Missing or empty `GITNEXUS_CONTENT_RETENTION` means `full`. An explicitly invalid value fails clearly; it must not silently select another profile.

`File.content` is normalized text used for retrieval, not a byte-faithful source archive. It may have normalized whitespace or CJK segmentation and cannot become a source viewer substitute.

### Query behavior

| Capability                                       | `full`                                  | `symbol`                             | `none`                   |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------ | ------------------------ |
| Symbol name/selector search                      | Available                               | Available                            | Available                |
| `context`, `impact`, `trace`, structural Cypher  | Available                               | Available                            | Available                |
| Arbitrary file-body keyword retrieval            | Available                               | Only if retained in a symbol snippet | Unavailable              |
| Content-bearing query/context response           | File and symbol content where supported | Symbol snippets only                 | Clear capability absence |
| Filesystem preview, grep, rename, detect-changes | Requires source worktree                | Requires source worktree             | Requires source worktree |

The `symbol` and `none` profiles do not change provider parsing, node IDs, line ranges, relationships, or call-graph correctness. They reduce text-retrieval evidence. `symbol` is not equivalent to `full` for natural-language searches that rely on arbitrary comments or method bodies; `none` intentionally removes source text as evidence.

No profile may fabricate an empty source result as though it were a valid source snippet. Commands and MCP tools must expose capability absence or omit content fields deliberately. Tools that require a live worktree remain unavailable after that worktree is deleted regardless of retained profile.

### FTS and stored text

Under `symbol` and `none`, GitNexus must not build file-content FTS indexes. Other FTS indexes may cover only fields allowed by the selected profile. Future FTS allocation improvements, such as skipping unused label indexes, are compatible optimizations but are not required for the first implementation.

`none` removes all source-derived body text, including source comments/descriptions and PDG basic-block text. It retains stable IDs, names, paths, line ranges, node/edge types, relation structure, resolution confidence, and non-text diagnostics.

## Metadata, compatibility, and rebuilds

Persist at least:

```json
{
  "contentRetention": "symbol",
  "contentRetentionSchemaVersion": 1,
  "ftsProfile": "symbol-no-file-content",
  "storagePath": "/absolute/path/to/index-slot"
}
```

Incremental reuse must compare source revision/file hashes, GitNexus build and schema, language-provider and grammar versions, retention profile/schema, FTS profile, and include/exclude/max-file-size configuration. A mismatch requires a clean full rebuild into a new database. Clearing `content` values in place is not a valid conversion because prior FTS and database page allocation may remain.

Indexes written before these fields existed are interpreted as `full` for read compatibility. The next successful full rebuild writes the new metadata.

## Web UI and missing source files

The existing Web UI's file preview and grep operations read the repository filesystem. They must not assume that database `File.content` is valid raw code. With an external index and deleted checkout, the UI must report full-file preview and filesystem grep as unavailable, while continuing to show graph data, symbol snippets permitted by the retention profile, file paths, line ranges, source revision, and resolution confidence. A future raw-code browser needs a separate, explicit byte-faithful retention design.

## Regression coverage

- No option: storage, metadata, CLI, MCP, and query results remain compatible with `<repo>/.gitnexus/` and `full` content.
- External storage: all artifacts reside in the selected directory; none appears in the source worktree; a deleted worktree does not prevent graph-only `status` and MCP queries through the registry.
- Storage failures: relative, invalid, unwritable, and conflicting paths fail cleanly without a usable partial index.
- Concurrency: two repositories with distinct external slots do not share locks, caches, metadata, or data.
- Retention: full/symbol/none keep identical structural node and edge counts for a fixture; only allowed text fields and FTS indexes differ.
- Rebuild: changing profile, provider/grammar version, schema, or indexing configuration forces full rebuild and produces a physically new index.
- MCP/CLI: content requests honor each profile and do not return misleading empty source text.
- Web UI: missing checkout, `symbol`, and `none` present explicit unavailable states rather than broken previews.
