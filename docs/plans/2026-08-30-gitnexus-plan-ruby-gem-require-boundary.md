# GitNexus Engineering Plan

> Task: Prevent Ruby gem requires from suffix-resolving to unrelated repository files (#2966).
> Evidence verified at commit 170eefd4a0893be9d255dc3581d51fd448ce2e96; GitNexus index fresh at that commit with schema-4 runner identity.
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 10 sorted entries; exact generated plan path excluded.

## Objective (§1)

Block a bare Ruby `require` before suffix matching when its first path segment is a dependency declared by Bundler/RubyGems metadata, while preserving local bare and `require_relative` resolution and failing open when no Gemfile or gemspec is available.

## Current Behaviour (§2–3)

- [verified] `resolveRubyImportTarget` sends every non-relative target to `resolveBare`, whose progressive suffix matching can drop `rails/` and select `lib/generators.rb` (`gitnexus/src/core/ingestion/languages/ruby/import-target.ts:34`).
- [verified] The scope-resolution pipeline already loads each language's opaque workspace config once and passes it to every import lookup (`gitnexus/src/core/ingestion/scope-resolution/pipeline/phase.ts:373`).
- [verified] Ruby currently exposes no `loadResolutionConfig`; PHP demonstrates the established bounded manifest-scan and resolver-config seam (`gitnexus/src/core/ingestion/languages/php/import-target.ts:295`).
- [verified] Existing parity coverage calls Ruby with no config and exercises both bare and `./`/`../` targets, pinning the fail-open and relative paths (`gitnexus/test/unit/scope-resolution/import-target-index-parity.test.ts:412`).

## Findings (§4–5)

- [graph] `impact resolveRubyImportTarget --direction upstream --depth 3 --include-tests` returned LOW risk with exactly two direct dependents: `rubyScopeResolver.resolveImportTarget` and `import-target-index-parity.test.ts`.
- [graph] `context resolveRubyImportTarget --file gitnexus/src/core/ingestion/languages/ruby/import-target.ts` found calls only to `resolveBare`, `resolveRelative`, and `isHeritageMarker`; no process membership was reported.
- [verified] The conformance fixture records `rails/generators -> lib/generators.rb` as Ruby's known external-import gap (`gitnexus/test/unit/scope-resolution/external-import-conformance.test.ts:270`, `:375`).
- No PDG slice is needed: this local fix adds one data gate before an existing pure resolver branch and changes no trust, persistence, concurrency, or state-mutation boundary.

## Proposed Changes (§6)

- Add `ruby/resolution-config.ts` with a bounded, static scanner that collects dependency names from Gemfile and gemspec declarations and transitive gem names from adjacent `Gemfile.lock` files; return `null` when no declarative manifest exists.
- Add `rubyScopeResolver.loadResolutionConfig` so the existing one-load-per-workspace pipeline threads the Ruby dependency set into import resolution.
- Update `resolveRubyImportTarget` to return `null` for bare targets whose first segment is in that set, before suffix matching; leave relative and no-config paths unchanged.
- Remove Ruby from `KNOWN_GAPS`, provide `rails` config to that fixture, and add focused loader/gate tests for Gemfile, gemspec, lockfile, local bare paths, relative paths, and no-manifest fail-open behavior.

## Implementation Sequence (§7)

1. Add the manifest scanner and focused tests; keep parsing static and bounded, with skipped dependency/build directories. Risk: Ruby manifests are executable, so recognize only explicit literal dependency declarations and never evaluate them.
2. Wire the config loader into `rubyScopeResolver`, then gate only non-relative targets in `resolveRubyImportTarget`. Risk: dependency-name/require-path conventions are not universal, so match only the literal first segment proven by metadata.
3. Turn the shared conformance fixture green, run focused/full validation, refresh the local graph, and account for all changed symbols before the implementation commit.

## Test Strategy (§8)

- First make the `rails/generators` regression test fail on the pre-fix resolver, then implement the gate.
- Assert declared direct and locked transitive dependencies return `null` despite decoy suffixes.
- Assert `app/models/user`, `generators`, and `require_relative` continue resolving; assert a workspace without Gemfile/gemspec retains legacy fail-open behavior.
- Run `npm test` and `npx tsc --noEmit` from `gitnexus`, plus targeted Vitest, formatting/lint checks, and `git diff --check`.

## Implementation Context (§11)

```yaml
implementation_context:
  task_summary: 'Prevent declared Ruby gem requires from suffix-resolving to unrelated repository files.'
  evidence_provenance:
    schema_version: 2
    head_commit: '170eefd4a0893be9d255dc3581d51fd448ce2e96'
    generated_plan_path: 'docs/plans/2026-08-30-gitnexus-plan-ruby-gem-require-boundary.md'
    global_dirty_digest:
      algorithm: 'sha256'
      canonicalization: 'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records'
      value: '0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd'
    cited_path_manifest:
      - path: 'gitnexus/package.json'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:157760d8e69666e9e228091077a8c62787d15c1e9e43b059601093d90c081976'
        index_digest: 'sha256:157760d8e69666e9e228091077a8c62787d15c1e9e43b059601093d90c081976'
        worktree_digest: 'sha256:157760d8e69666e9e228091077a8c62787d15c1e9e43b059601093d90c081976'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/languages/php/import-target.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:4e73c2e3f1322defaafcd543d715ab351c2d4f5af0fa481c3c81b3543e7618de'
        index_digest: 'sha256:4e73c2e3f1322defaafcd543d715ab351c2d4f5af0fa481c3c81b3543e7618de'
        worktree_digest: 'sha256:4e73c2e3f1322defaafcd543d715ab351c2d4f5af0fa481c3c81b3543e7618de'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/languages/ruby/import-target.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:326155551dda5d759e6d6e21b09b4e8b5c90b956ed11905568b146e8cc8a3fb8'
        index_digest: 'sha256:326155551dda5d759e6d6e21b09b4e8b5c90b956ed11905568b146e8cc8a3fb8'
        worktree_digest: 'sha256:326155551dda5d759e6d6e21b09b4e8b5c90b956ed11905568b146e8cc8a3fb8'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/languages/ruby/resolution-config.ts'
        object_kind: { head: 'absent', index: 'absent', worktree: 'absent', untracked: 'absent' }
        state: 'absent'
        rename_from: null
        rename_to: null
        head_digest: 'absent'
        index_digest: 'absent'
        worktree_digest: 'absent'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/languages/ruby/scope-resolver.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:d6b77df3b87b341f3cd7b30576e8fd9b89fbc78dec55a71cf4788c15deebc1bf'
        index_digest: 'sha256:d6b77df3b87b341f3cd7b30576e8fd9b89fbc78dec55a71cf4788c15deebc1bf'
        worktree_digest: 'sha256:d6b77df3b87b341f3cd7b30576e8fd9b89fbc78dec55a71cf4788c15deebc1bf'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/scope-resolution/contract/scope-resolver.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:84c8a5edc9776551df216cf3159fdbb0a68ebfb7b2f6d317cc0dd6e8522d93ab'
        index_digest: 'sha256:84c8a5edc9776551df216cf3159fdbb0a68ebfb7b2f6d317cc0dd6e8522d93ab'
        worktree_digest: 'sha256:84c8a5edc9776551df216cf3159fdbb0a68ebfb7b2f6d317cc0dd6e8522d93ab'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/scope-resolution/pipeline/phase.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:911f7cd3d76fc0c47db7498f93c163571440f7dd1d2c6bd9e23f1423465a1398'
        index_digest: 'sha256:911f7cd3d76fc0c47db7498f93c163571440f7dd1d2c6bd9e23f1423465a1398'
        worktree_digest: 'sha256:911f7cd3d76fc0c47db7498f93c163571440f7dd1d2c6bd9e23f1423465a1398'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/unit/scope-resolution/external-import-conformance.test.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:faa3f40d302ea7e4b9914aeb91b3ef3a32c511a4c4be16cea966ee0d0e92de55'
        index_digest: 'sha256:faa3f40d302ea7e4b9914aeb91b3ef3a32c511a4c4be16cea966ee0d0e92de55'
        worktree_digest: 'sha256:faa3f40d302ea7e4b9914aeb91b3ef3a32c511a4c4be16cea966ee0d0e92de55'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/unit/scope-resolution/import-target-index-parity.test.ts'
        object_kind: { head: 'regular', index: 'regular', worktree: 'regular', untracked: 'absent' }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:0154615b77157bbfd413867b6c83a837d7fa5d2bf03ecbc969cca873021cf51c'
        index_digest: 'sha256:0154615b77157bbfd413867b6c83a837d7fa5d2bf03ecbc969cca873021cf51c'
        worktree_digest: 'sha256:0154615b77157bbfd413867b6c83a837d7fa5d2bf03ecbc969cca873021cf51c'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/unit/scope-resolution/ruby/ruby-resolution-config.test.ts'
        object_kind: { head: 'absent', index: 'absent', worktree: 'absent', untracked: 'absent' }
        state: 'absent'
        rename_from: null
        rename_to: null
        head_digest: 'absent'
        index_digest: 'absent'
        worktree_digest: 'absent'
        untracked_digest: 'absent'
  files_to_modify:
    - file: 'gitnexus/src/core/ingestion/languages/ruby/resolution-config.ts'
      symbols: ['RubyResolutionConfig', 'loadRubyResolutionConfig']
      intended_change: 'Statically collect declared and locked gem names with bounded traversal; return null without Gemfile/gemspec evidence.'
    - file: 'gitnexus/src/core/ingestion/languages/ruby/import-target.ts'
      symbols: ['resolveRubyImportTarget']
      intended_change: 'Reject declared external-gem roots before bare suffix resolution.'
    - file: 'gitnexus/src/core/ingestion/languages/ruby/scope-resolver.ts'
      symbols: ['rubyScopeResolver']
      intended_change: 'Load Ruby resolution config once per workspace.'
    - file: 'gitnexus/test/unit/scope-resolution/external-import-conformance.test.ts'
      symbols: ['CASES', 'KNOWN_GAPS']
      intended_change: 'Provide rails dependency evidence and remove the Ruby gap.'
    - file: 'gitnexus/test/unit/scope-resolution/ruby/ruby-resolution-config.test.ts'
      symbols: []
      intended_change: 'Cover manifest parsing, gate behavior, local positives, relative behavior, and fail-open mode.'
  tests:
    - file: 'gitnexus/test/unit/scope-resolution/external-import-conformance.test.ts'
      scenarios:
        - "declared rails + require rails/generators + local generators.rb decoy -> null"
        - "same workspace + require generators -> lib/generators.rb"
    - file: 'gitnexus/test/unit/scope-resolution/ruby/ruby-resolution-config.test.ts'
      scenarios:
        - 'Gemfile/gemspec direct dependency and Gemfile.lock transitive name -> collected roots'
        - 'no Gemfile/gemspec -> null config and legacy bare resolution remains available'
        - 'declared dependency target -> null; local app/models/user -> local file'
        - 'require_relative target -> importer-relative file despite matching dependency name'
  verification_commands:
    - 'cd gitnexus && npx vitest run test/unit/scope-resolution/external-import-conformance.test.ts test/unit/scope-resolution/ruby/ruby-resolution-config.test.ts test/unit/scope-resolution/import-target-index-parity.test.ts'
    - 'cd gitnexus && npm test'
    - 'cd gitnexus && npx tsc --noEmit'
    - 'cd gitnexus && npx eslint src/core/ingestion/languages/ruby test/unit/scope-resolution/external-import-conformance.test.ts test/unit/scope-resolution/ruby/ruby-resolution-config.test.ts'
    - 'cd gitnexus && npx prettier --check src/core/ingestion/languages/ruby/import-target.ts src/core/ingestion/languages/ruby/resolution-config.ts src/core/ingestion/languages/ruby/scope-resolver.ts test/unit/scope-resolution/external-import-conformance.test.ts test/unit/scope-resolution/ruby/ruby-resolution-config.test.ts'
    - 'git diff --check'
  assumptions:
    - 'Recheck immediately before implementation that #2966 is open and has no overlapping PR.'
    - 'Verify the loader returns null when no Gemfile/gemspec is found, even if a lockfile exists.'
  open_questions: []
  avoid:
    - 'Do not evaluate Ruby manifest code.'
    - 'Do not classify undeclared require roots as external.'
    - 'Do not change suffix-matching order, WorkspaceFileIndex reuse, or require_relative semantics.'
    - 'Do not expand this PR to conventional-load-root heuristics beyond the accepted dependency gate.'
```

## Assumptions and Open Questions (§12)

- [assumed] Literal dependency declarations cover the accepted gate; dynamic Gemfile/gemspec logic remains fail-open and is explicitly deferred.
- [assumed] A lockfile contributes transitive names only when at least one Gemfile/gemspec proves the repository is Bundler/RubyGems-managed.
- No blocking open question remains; first-segment aliases for gems whose require path differs from their package name are deferred because metadata alone cannot prove them safely.

## Definition of Done (§13)

- `rails/generators` is unresolved with declared `rails`; local bare and relative fixtures still resolve.
- Ruby is removed from `KNOWN_GAPS`; focused, full, typecheck, lint, formatting, diff, and graph-change gates pass.
- No Ruby code is executed while reading manifests, and no-config workspaces retain existing behavior.
