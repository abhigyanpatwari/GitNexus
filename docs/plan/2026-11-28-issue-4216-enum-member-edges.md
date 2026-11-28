# Fix plan — #4216 remaining enum-member false edges (2026-11-28)

Issue: https://github.com/abhigyanpatwari/GitNexus/issues/4216
Branch: `fix/4216-enum-member-false-edges` from origin/main 0b6061a66 (has #4084 enum parse rules).
Scope per maintainer comment on #4243: enum nodes/HAS_PROPERTY/ACCESSES are done on main; still open:

1. `op.startsWith('not')` with `op: FilterOp` (string enum) → CALLS linked to enum member `startsWith` (should be none: value of an enum type is a string/number primitive).
2. Vue unique-name property fallback: untyped `x.Off` in a `.vue` file links to `Mode.Off` member in another `.vue` file; fallback to same-named object key elsewhere drops as ambiguous.

## TODO

- [x] Build origin/main, reproduce both wrong edges (resolver harness + CLI)
- [x] Trace where each edge is emitted (receiver-bound dispatch; unique-name-properties pass)
- [x] Decide fix layer (provider hook, no language names in shared code); ask user on design choices
- [x] Implement surgically
- [x] Regression tests: fail before, pass after; keep existing enum behavior (HAS_PROPERTY, ACCESSES Color.Red, USES Color)
- [x] Validate: tsc, eslint/prettier, language-boundary test, resolver suites, unit suite vs baseline
- [ ] Ask user to review; commit only after approval

## Progress notes

- REPRO (resolver harness, main 0b6061a66): `isNeg(op: FilterOp) → op.startsWith()` emits CALLS → Property filter.ts:startsWith (import-resolved 0.85). Vue: untyped `x.Off` in Use.vue → ACCESSES Mode.vue:Off (unique-name workspace-unique 0.5). Control: an enum member same-named as an object-literal key makes the key non-unique, so a cross-file fallback read of the key drops.
- CAUSE 1: enum member Property nodes carry no `isStatic`. TS sets `separateStaticAndInstanceMethods`, so instance call dispatch (`pickFirstNonStaticOnly`) already drops members whose graph node is `isStatic` — static class fields are filtered this way. Enum members are missed because `TypeScriptFieldExtractor` does not treat `enum_declaration` as a field owner.
- CAUSE 2: `buildPropertyNameIndex` (shared) indexes every Property node, including enum members.
- PROTOTYPE A (done, TS-owned file only): `field-extractors/typescript.ts` extracts enum members as `isStatic: true, isReadonly: true, visibility: public`. Removes the CALLS edge; `FilterOp.eq` still resolves. Read sites (`op.eq` on an enum-typed value) are not gated today for ANY static field (`c.staticField` read through an instance also links) — scope question for user.
- Prior art: closed PR #4217 added a new contract hook `isFieldUnreachableByInstance` threaded through 5 dispatch call sites + Enum-owned exclusion in the name index.

- USER DECISIONS: (1) gate instance READS/WRITES too, not just calls; (2) name-index exclusion via a provider hook, not unconditional.
- IMPLEMENTATION:
  - `field-extractors/typescript.ts`: `enum_declaration` is a field owner; members (`property_identifier`, `enum_assignment`) are `isStatic/isReadonly/public` fields. TS + Vue share this extractor.
  - `receiver-bound-calls.ts` `pickFirstNonStaticOnly`: field branch filters reads/writes as well as calls (was `site.kind === 'call'` only, from #4084). Only callers passing `excludeFromInstance`/`excludeFromClass` with `separateStaticAndInstanceMethods` (TS only) are affected; class-name reads use `findOwnedMember` and are unchanged.
  - Contract: `ScopeResolver.excludeEnumMembersFromNameFallback?: boolean`. `buildPropertyNameIndex` tags candidates owned only by `Enum` (HAS_PROPERTY); `emitUniqueNamePropertyAccesses` drops them before the language filter when the reading provider opts in. Vue opts in; run.ts passes the flag.
- PROBE before/after: removed edges = isNeg→FilterOp.startsWith CALLS, op.eq read on value, c.static read/write on instance, this.static in an instance method, Vue x.Off→Mode.Off. Kept: FilterOp.eq / Color.Red / Cfg.static via class, instance field reads, USES/HAS_PROPERTY. `this.count` inside a STATIC method was already unlinked on main (pre-existing, not touched).
- TESTS: test/integration/resolvers/typescript-enum-members.test.ts — 6/8 fail without src changes, 8/8 pass with.
- VALIDATION: tsc src + tests OK; eslint 0 errors (warnings pre-existing lines); prettier clean; language-boundary 26/26; resolvers 163 files / 5340 pass.
- KNOWN LIMIT: Vue does not set `separateStaticAndInstanceMethods`, so a call on an enum-typed value inside a .vue file is not gated by this change.
- UNIT: 12 failures in 8 files, identical with src changes reverted on main 0b6061a66 (pre-existing).
- CLI repro (dist): ACCESSES isRed→Red, USES isRed→Color, USES isNeg→FilterOp, HAS_PROPERTY x3; no CALLS isNeg→startsWith.
