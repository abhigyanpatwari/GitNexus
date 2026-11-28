# Fix plan — #4252 TS ↔ JS cross-language imports (2026-11-28)

Issue: https://github.com/abhigyanpatwari/GitNexus/issues/4252
Branch (to create from main acf755a1b): `fix/4252-ts-js-cross-language-imports`
Early #4250 / #4247 fixes now live on local branch `wip/4250-4247-early-fixes` (commit 14934a6bc), not on this branch.

## Symptom (verified with CLI)

- `app/jj.js → jslib/a.js`: IMPORTS + CALLS present.
- `app/t.ts → jslib/a.js`: no IMPORTS, no CALLS.
- `app/j.js → tslib/b.ts`: no IMPORTS, no CALLS.

## TODO

- [x] Find where an import specifier becomes a target file for TS and for JS (file candidates / extension lists)
- [x] Find whether cross-language binding (import → exported def in another provider's file) is supported at all in scope resolution
- [x] Decide fix layer; ask user if there is a design choice
- [x] Implement surgically
- [x] Integration test: t.ts→a.js, j.js→b.ts, plus aggregated-object case; fails before, passes after
- [x] Validate: tsc, eslint, prettier, resolver suites (TS/JS/TSX/Vue), unit suite vs baseline
- [x] Ask user to review; commit only after approval (approved 2026-11-28)

## Progress notes

- ROOT CAUSE: scope resolution runs once per language (`scope-resolution/pipeline/phase.ts` loops `SCOPE_RESOLVERS`). `run.ts:1080` builds `allFilePaths` from that run's parsedFiles only, so the TS run cannot resolve `../jslib/a` to `a.js` and its model holds no JS defs (and vice-versa).
- Path resolution is NOT the problem: `TS_EXTENSIONS` (typescript/file-candidates.ts) includes `.js`; JS import-target delegates to `resolveTsTarget`.
- Precedent: Vue implements `ScopeResolver.collectScopeContextPaths` to pull its TS/JS import closure into the Vue run; context files reuse the parse-phase ParsedFile (`preExtractedByPath`). TS and JS do not implement the hook.

- DESIGN (user chose): TS and JS implement `collectScopeContextPaths` via new `languages/typescript/ecma-scope-context.ts` (`collectEcmaCrossLanguageContext`): from primary files follow only cross-language ECMA imports; from context files follow both languages (re-export chains). Graph dedupes relationships by id (graph.ts addRelationship), as for Vue context files.
- Cost guard: phase.ts read EVERY primary source up front when a context hook exists (Vue needs it). New contract option `scopeContextSourceText: 'none'` (TS/JS) keeps the provider's normal source-read policy (`selectScopeSourcePathsToRead`) for primary + context files. Vue unchanged (default 'primary-files').
- Known limit (same as Vue): on the disk-store path only primary ParsedFiles are loaded before the hook, so a context file's own imports are followed only when its ParsedFile is already resident.
- Tests: resolvers/typescript-javascript-cross-language.test.ts — 4/5 fail without the hook wiring, 5/5 pass with it (5th = no duplicate CALLS ids).
- Validation on main-based branch: tsc (src + tests), eslint/prettier clean, language-boundary 26/26, all 164 resolver files (5605), unit 12 failures = identical to clean main, scope/parsing integration failures only analyze-cli-embedding-phases (fails on main too). Real CLI repro now produces the issue's Expected table.
