# Objective-C Framework Imports and Selector Lookup Design

## Goal

Improve Objective-C analysis for real iOS workspaces without changing another
language's resolution semantics:

- resolve project-local `#import <Framework/Header.h>` statements;
- make declarations from local umbrella-header import closures visible to
  inheritance and call resolution;
- let MCP/CLI symbol tools accept an unsigned Objective-C selector when the
  exact name lookup has no result.

## Boundaries

- Only workspace-local headers that resolve uniquely are eligible. SDK and
  ambiguous imports fail closed.
- No Xcode project, header-map, module-map, CocoaPods metadata, or build-setting
  parser. CocoaPods-style source layouts are recognized from workspace paths
  only when the module directory and header basename produce one unique match.
- No changes to iOS business source.
- No changes to the wildcard semantics of C, Python, TypeScript, or another
  language.
- No commit or push without separate maintainer approval.

## Import Resolution

Objective-C import interpretation retains angle-bracket imports as wildcard
imports and marks their system/angle origin. The Objective-C resolver resolves
the direct target with the unique-workspace resolver, then expands only the
transitive local `.h` closure. Angle imports never receive quoted-header sibling
precedence. `<Module/Header.h>` may cross an intermediate directory such as
`Classes/` only when `Module` occurs as real path segments and the header match
is unique; duplicate candidates still fail closed.
The existing multi-target `ScopeResolver.resolveImportTarget` contract carries
that closure into finalize, where every reachable header gets an ordinary
wildcard binding edge.

Traversal is deterministic, cycle-safe, and memoized for the lifetime of one
`ParsedFile[]` batch. Workspace paths are indexed once by basename; resolutions,
including SDK misses, are cached. Each nested import is resolved relative to the
header that contains it. An unresolved or ambiguous edge terminates that branch.
Static symbols continue to be filtered by the existing C-family wildcard hook.

This language-specific expansion avoids modifying shared finalize behavior and
therefore isolates the semantic change to Objective-C.

## Selector Lookup

`LocalBackend.resolveSymbolCandidates` keeps its current exact UID/name query as
the first tier. Only when an exact name query returns zero rows, the input name
has no `+`/`-` prefix, and the requested kind is absent or `Method`, it performs
one fallback query for the Objective-C method spellings `-name` and `+name`.

The fallback remains subject to existing repository, file, kind, candidate cap,
scoring, deterministic ordering, and ambiguity behavior, and filters candidates
to `language = 'objective-c'`. An explicitly non-Method kind never falls back.
Existing exact names and all non-Objective-C symbols remain unchanged.

## Failure Safety

- External framework imports produce no local binding.
- Duplicate workspace suffixes remain unresolved.
- Duplicate module-scoped CocoaPods-style header candidates remain unresolved.
- Header cycles terminate through a visited set.
- Multiple matching selectors are reported through the existing ambiguity
  path; no candidate is guessed.
- Exact lookup always wins over selector fallback.

## Tests

TDD coverage will include:

1. angle-bracket import interpretation;
2. unique local framework resolution and external/ambiguous negative cases;
3. umbrella-header inheritance, protocol heritage, and `super` calls;
4. cyclic local headers;
5. exact selector precedence, unsigned instance/class fallback, ambiguity,
   file filtering, and non-Method kind isolation;
6. Objective-C unit/integration suites, Core full test suite, and TypeScript
   typecheck;
7. cold and warm indexing of `ZKJAIRecord`, including the known
   `ZKJAIRemoteSeatRecordInteractor -> ZKJAIRecordInteractor` regression.

The parse-cache schema and incremental graph schema are bumped so an existing
index cannot silently reuse pre-feature Objective-C facts.

## Risk

Graph impact classifies `interpretObjectiveCImport` as LOW risk and
`LocalBackend.resolveSymbolCandidates` as HIGH risk. The maintainer explicitly
accepted the HIGH-risk shared lookup change on 2026-08-04. The shared lookup
change is intentionally exact-first and covered by the full Core suite.
