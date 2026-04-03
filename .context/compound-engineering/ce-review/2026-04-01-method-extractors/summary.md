# ce:review autofix run — 2026-04-01-method-extractors

**Mode:** autofix
**Scope:** feat/remaining-method-extractor-configs vs origin/main (ba5de0bd)
**Plan:** docs/plans/2026-04-01-002-feat-remaining-language-method-extractor-configs-plan.md (explicit)

## Applied fixes
None — no safe_auto findings identified.

## Residual actionable work

### P1 — Testing gaps
1. Dart: Add tests for getter_signature, setter_signature, operator_signature, factory_constructor_signature
2. PHP: Add tests for constructor property promotion parameters and union/nullable return types

### P2 — Maintainability  
3. Extract duplicated annotation regex `@(\w+)` from swift.ts and dart.ts into shared helper

### P2 — Testing gaps
4. Dart: Add isFinal === false test
5. PHP: Expand variadic parameter test assertions (name + multiple types)
6. Rust: Add pub(super) visibility test

## Advisory
- PHP annotation prefix uses `#` vs `@` in other languages — intentional language-specific convention, not a bug
- PHP/Ruby omit isAsync — correct (languages have no async/await syntax)
- Python decorated_definition wrapper correctly handled via methodNodeTypes inclusion

## Verdict
Ready with fixes — testing gaps for advanced language features, no logic bugs.
