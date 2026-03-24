# Changelog

All notable changes to GitNexus will be documented in this file.

## [1.4.8] - 2026-03-23

### Added
- **Type resolution Milestone D — Phases 10–13** consolidated into a single milestone with full integration test coverage across 11 languages (#387)
  - Phase A/B/C: overload disambiguation via argument literal types, constructor-visible virtual dispatch via `constructorTypeMap`, `parameterTypes` extraction in `extractMethodSignature`
  - Phase 14 enhancements: single-pass seeding, Tarjan's SCC for cyclic resolution, cross-file return types
  - Optional parameter arity resolution
  - Per-language cross-file binding tests and resolver fixes
  - Store all overloads in `fileIndex` instead of last-write-wins
- **Cross-file binding propagation** for multiple languages
- **HTTP embedding backend** for self-hosted/remote endpoints with dynamic dimensions, batch guards, and dimension mismatch handling (#395)
- **Markdown file indexing** — headings and cross-links as graph nodes (#399)
- **MiniMax provider support** (#224)
- **Codex MCP and skills support** with CLI setup flow and e2e tests
- **HelpPanel UI** — built-in help for the web interface (#465)
- **Section node type** registered in `NODE_TABLES` and `NODE_SCHEMA_QUERIES` (#401)
- **Community and Process node properties** documented in cypher tool description (#411)
- **Server-mode hydration regression tests**
- **Pre-commit hooks** via husky for typecheck + unit tests

### Fixed
- **Python import alias resolution** — `import X as Y` now routes module aliases directly to `moduleAliasMap` in import processor (#417, #461)
- **Python module-qualified calls** resolved via `moduleAliasMap` (#337)
- **Python module-qualified constructor calls** (Issue #337)
- **Heritage/MRO edges** now calculate confidence per resolution tier (#412)
- **LadybugDB lock** — retry on DB lock with session-safe cleanup (#325)
- **CORS** — allow private/LAN network origins (#390)
- **Analyze without git** — allow indexing folders without a `.git` directory (#384)
- **Web: LadybugDB** — `getAllRows`, `loadServerGraph`, BM25, highlight clearing (#474)
- **Server-mode hydration** — await server connect hydration flow (#398, #404)
- **Embedding dimensions** — validate on every vector, not just the first; hard-throw on mismatch
- **Timeout detection** — always-on dim validation, test hardening
- **ONNX CUDA** — prevent uncatchable native crash when CUDA libs present but ORT lacks CUDA provider; clarify linux/x64-only
- **CLI** — run codex mcp add via shell on Windows; write tool output to stdout via fd 1
- **Stale progress, cross-platform prepare, DEV log** fixes
- **Import resolution API** simplified per PR #409 review findings (P0–P3)
- **Auto-labeling** — switched from clustering to z-score method; multi-dim aware Mahalanobis threshold
- **PR/issue filtering** — fixed prop cutoff issue
- **Sequential enrichment queries** + stale data detection
- **package-lock.json** synced with `onnxruntime-node ^1.24.0`

### Changed
- **Unified language dispatch** with compile-time exhaustive tables
- **Prepare script simplified** — removed `scripts/prepare.cjs`
- **Switched from .githooks to husky** for pre-commit hooks
- **`@claude` workflow** restricted to maintainers and above via `author_association` check

### Performance
- **O(1) per-chunk synthesis guard** using `boolean[]` instead of Set
- **`sizeBefore` optimization** in type resolution
- **Token truncation** improvements

### Chore
- Strengthened Python module-import tests, un-skipped match/case, added perf guard
- Added positive and negative tests for all 4 bug fixes
- E2e tests for stale detection, sequential enrichment, stability (#396)
- Integration tests for Milestone D across all 11 languages
- `gitnexus-stable-ops` added to community integrations
- `.env.example` added for embedding backend configuration

## [1.4.7] - 2026-03-19

### Added
- **Phase 8 field/property type resolution** — ACCESSES edges with `declaredType` for field reads/writes (#354)
- **Phase 9 return-type variable binding** — call-result variable binding across 11 languages (#379)
  - `extractPendingAssignment` in per-language type extractors captures `let x = getUser()` patterns
  - Unified fixpoint loop resolves variable types from function return types after initial walk
  - Field access on call-result variables: `user.name` resolves `name` via return type's class definition
  - Method-call-result chaining: `user.getProfile().bio` resolves through intermediate return types
  - 22 new test fixtures covering call-result and method-chain binding across all supported languages
  - Integration tests added for all 10 language resolver suites
- **ACCESSES edge type** with read/write field access tracking (#372)
- **Python `enumerate()` for-loop support** with nested tuple patterns (#356)
- **MCP tool/resource descriptions** updated to reflect Phase 9 ACCESSES edge semantics and `declaredType` property

### Fixed
- **mcp**: server crashes under parallel tool calls (#326, #349)
- **parsing**: undefined error on languages missing from call routers (#364)
- **web**: add missing Kotlin entries to `Record<SupportedLanguages>` maps
- **rust**: `await` expression unwrapping in `extractPendingAssignment` for async call-result binding
- **tests**: update property edge and write access expectations across multiple language tests
- **docs**: corrected stale "single-pass" claims in type-resolution-system.md to reflect walk+fixpoint architecture

### Changed
- **Upgrade `@ladybugdb/core` to 0.15.2** and remove segfault workarounds (#374)
- **type-resolution-roadmap.md** overhauled — completed phases condensed to summaries, Phases 10–14 added with full engineering specs

## [1.4.6] - 2026-03-18

### Added
- **Phase 7 type resolution** — return-aware loop inference for call-expression iterables (#341)
  - `ReturnTypeLookup` interface with `lookupReturnType` / `lookupRawReturnType` split
  - `ForLoopExtractorContext` context object replacing positional `(node, env)` signature
  - Call-expression iterable resolution across 8 languages (TS/JS, Java, Kotlin, C#, Go, Rust, Python, PHP)
  - PHP `$this->property` foreach via `@var` class property scan (Strategy C)
  - PHP `function_call_expression` and `member_call_expression` foreach paths
  - `extractElementTypeFromString` as canonical raw-string container unwrapper in `shared.ts`
  - `extractReturnTypeName` deduplicated from `call-processor.ts` into `shared.ts` (137 lines removed)
  - `SKIP_SUBTREE_TYPES` performance optimization with documented `template_string` exclusion
  - `pendingCallResults` infrastructure (dormant — Phase 9 work)

### Fixed
- **impact**: return structured error + partial results instead of crashing (#345)
- **impact**: add `HAS_METHOD` and `OVERRIDES` to `VALID_RELATION_TYPES` (#350)
- **cli**: write tool output to stdout via fd 1 instead of stderr (#346)
- **postinstall**: add permission fix for CLI and hook scripts (#348)
- **workflow**: use prefixed temporary branch name for fork PRs to prevent overwriting real branches
- **test**: add `--repo` to CLI e2e tool tests for multi-repo environment
- **php**: add `declaration_list` type guard on `findClassPropertyElementType` fallback
- **docs**: correct `pendingCallResults` description in roadmap and system docs

### Chore
- Add `.worktrees/` to `.gitignore`

## [1.4.5] - 2026-03-17

### Added
- **Ruby language support** for CLI and web (#111)
- **TypeEnvironment API** with constructor inference, self/this/super resolution (#274)
- **Return type inference** with doc-comment parsing (JSDoc, PHPDoc, YARD) and per-language type extractors (#284)
- **Phase 4 type resolution** — nullable unwrapping, for-loop typing, assignment chain propagation (#310)
- **Phase 5 type resolution** — chained calls, pattern matching, class-as-receiver (#315)
- **Phase 6 type resolution** — for-loop Tier 1c, pattern matching, container descriptors, 10-language coverage (#318)
  - Container descriptor table for generic type argument resolution (Map keys vs values)
  - Method-aware for-loop extractors with integration tests for all languages
  - Recursive pattern binding (C# `is` patterns, Kotlin `when/is` smart casts)
  - Class field declaration unwrapping for C#/Java
  - PHP `$this->property` foreach member access
  - C++ pointer dereference range-for
  - Java `this.data.values()` field access patterns
  - Position-indexed when/is bindings for branch-local narrowing
- **Type resolution system documentation** with architecture guide and roadmap
- `.gitignore` and `.gitnexusignore` support during file discovery (#231)
- Codex MCP configuration documentation in README (#236)
- `skipGraphPhases` pipeline option to skip MRO/community/process phases for faster test runs
- `hookTimeout: 120000` in vitest config for CI beforeAll hooks

### Changed
- **Migrated from KuzuDB to LadybugDB v0.15** (#275)
- Dynamically discover and install agent skills in CLI (#270)

### Performance
- Worker pool threshold — skip worker creation for small repos (<15 files or <512KB total)
- AST walk pruning via `SKIP_SUBTREE_TYPES` for leaf-only nodes (string, comment, number literals)
- Pre-computed `interestingNodeTypes` set — single Set.has() replaces 3 checks per AST node
- `fastStripNullable` — skip full nullable parsing for simple identifiers (90%+ case)
- Replace `.children?.find()` with manual for loops in `extractFunctionName` to eliminate array allocations

### Fixed
- Same-directory Python import resolution (#328)
- Ruby method-level call resolution, HAS_METHOD edges, and dispatch table (#278)
- C++ fixture file casing for case-sensitive CI
- Template string incorrectly included in AST pruning set (contains interpolated expressions)

## [1.4.0] - Previous release
