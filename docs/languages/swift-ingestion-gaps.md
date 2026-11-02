# Swift Ingestion Gaps

Audited on 2026-10-23 with freshly built production sources at `c35806d24` and
the accompanying benchmark changes. See the [measurement audit](receiver-resolution-audit.md)
for commands, target checks, exclusions and test limits. Historical reports below
remain separate from freshly measured receiver cases; broader ingestion is not
exhaustively assessed.

## Receiver shape snapshot

States below come from [baseline.json](../../gitnexus/bench/receiver-resolution/baseline.json).
The [harness](../../gitnexus/bench/receiver-resolution/measure.mjs) defines each
spelling and its N/A reason. RESOLVES requires the exact expected declaration ID
and no same-named call to a different owner. WRONG-TARGET records incorrect edges.

| Shape                   | Recorded state | Expression or exclusion                                                                    |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `plainChain`            | RESOLVES       | `svc.getUser().save()`                                                                     |
| `plainDeepChain`        | RESOLVES       | `svc.getUser().address.save()`                                                             |
| `optionalChain`         | RESOLVES       | `svc.getUser().optionalAddress?.save()`                                                    |
| `nonNullAssert`         | RESOLVES       | `svc.getUser().optionalAddress!.save()`                                                    |
| `awaitParen`            | RESOLVES       | `(await svc.getUserAsync()).save()`                                                        |
| `explicitTypeArgs`      | N/A            | Swift infers generic parameters; there is no call-site type-argument spelling on a method. |
| `indexElement`          | VISIBLE-GAP    | `repos[0].save()`                                                                          |
| `fieldReceiverCall`     | RESOLVES       | `self.repo.save()`                                                                         |
| `decoratedReceiverBase` | N/A            | Swift `self` carries no type decoration.                                                   |
| `decoratedFieldType`    | RESOLVES       | `self.repo?.save()`                                                                        |

## Verified receiver coverage

Swift is registered in `SCOPE_RESOLVERS`. Optional grammar availability is an
environment condition, not a global Node 22 blocker.

The combined #3666/#3667 implementation resolves the typed Swift benchmark cells
`plainChain`, `plainDeepChain`, `optionalChain`, `nonNullAssert` and `awaitParen`.
Hoisted return lookup checks declaration ownership. Exact captured fixed/variadic
Swift override replay has positive regression controls; this does not establish
argument-label or generic-aware overload completeness.

`indexElement` is now a VISIBLE-GAP: the walker reads the subscript spelling, but
Swift has no `elementTypeOf` hook. Argument-aware inherited-overload selection and
associated/generic type handling remain bounded follow-up work.

Sources: [receiver baseline](../../gitnexus/bench/receiver-resolution/BASELINE.md),
[Swift resolver](../../gitnexus/src/core/ingestion/languages/swift/scope-resolver.ts),
[override replay tests](../../gitnexus/test/integration/swift-parameterized-override-replay.test.ts).

## Planning candidates

| ID       | Evidence           | Gap or boundary                                                                                                          | Next planning step and acceptance                                                                                                           |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SWIFT-01 | Measured gap       | `indexElement` is visible but Swift has no elementTypeOf hook.                                                           | Carry a proven element type through the provider and assert its exact member owner; preserve unsupported-container and same-name negatives. |
| SWIFT-02 | Recorded boundary  | Inherited overload selection is bounded; fixed/variadic positives do not prove argument-label or generic-aware dispatch. | Specify one callable identity rule at a time and retain the current override replay positives and owner-mismatch negatives.                 |
| SWIFT-03 | Historical reports | The extraction, inheritance and module items below have not all been revalidated.                                        | Reproduce each item on a pinned base before assigning implementation priority. Record both reference resolution and extraction evidence.    |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/swift/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/swift/scope-resolver.ts).
- [swift-hoisted-return-ownership.test.ts](../../gitnexus/test/integration/swift-hoisted-return-ownership.test.ts).
- [swift-parameterized-override-replay.test.ts](../../gitnexus/test/integration/swift-parameterized-override-replay.test.ts).
- [swift.test.ts](../../gitnexus/test/integration/resolvers/swift.test.ts).

## Historical reports requiring revalidation

The older backlog below is not a fresh feature matrix. Reproduce each item through
the current scope-resolution pipeline before treating it as open or resolved.
TypeEnv extraction support alone does not prove reference resolution.

## 🔴 High Priority

### Type Inference

| Gap                                      | Description                                                                                                    | Impact                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Optional bindings inside for-loop bodies | Re-test capture ownership and scope type bindings; the old call-processor re-parse diagnosis no longer applies | Requires a current positive/negative fixture |
| `while let` binding                      | `while let x = iter.next()` not in `DECLARATION_NODE_TYPES`                                                    | Uncommon but valid Swift pattern             |

### Call Resolution

| Gap                                        | Description                                                                                                                                                               | Impact                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `await expr` / `try expr` as call wrappers | `await_expression` and `try_expression` wrap `call_expression` — call extraction queries match but the outer wrapper can interfere with receiver resolution in some paths | Most cases work via `unwrapSwiftExpression` but edge cases remain |
| Trailing closures                          | `items.map { $0.save() }` — `$0` type not inferrable                                                                                                                      | Functional-style Swift code                                       |

## 🟡 Medium Priority

### Symbol Extraction

| Gap                     | Description                                                             | Impact                                |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| Enum `case` as callable | `MyEnum.case` calls are member-form, not caught by constructor fallback | Enum-heavy code (Result, State enums) |
| Subscript declarations  | `subscript(i:) -> T` not captured                                       | Protocol conformance tracking         |
| Operator overloads      | `static func + (lhs:, rhs:)` not captured                               | Mathematical types                    |
| `deinit`                | `deinit {}` not captured                                                | Minor — rarely called explicitly      |
| Macro declarations      | `@macro` / `#macro` (Swift 5.9+) not captured                           | Swift macro ecosystem is growing      |

### Heritage / Inheritance

| Gap                             | Description                                                                                                | Impact                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Multiple inheritance specifiers | Verify all parent/protocol captures and emitted edges for `class Foo: Bar, P1, P2` on the current provider | Historical first-specifier report needs revalidation |
| Generic constraints             | `class Foo<T: Equatable>` — bounds not tracked                                                             | Advanced generics                                    |
| Conditional conformance         | `extension Array: P where Element: Q` — `where` clause not processed                                       | Cross-platform code                                  |
| Protocol composition            | `typealias Codable = Encodable & Decodable` — not expanded                                                 | Type alias resolution                                |

### Export / Visibility

| Gap                          | Description                                         | Impact                                               |
| ---------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Nested function declarations | Inner `func` marked as exported — should be private | Conservative resolution still correct (over-exports) |

### Module / Import

| Gap                       | Description                           | Impact                           |
| ------------------------- | ------------------------------------- | -------------------------------- |
| `@testable import`        | Test target imports treated as opaque | Test file cross-references       |
| Cross-package SPM imports | External package symbols not resolved | Only affects multi-package repos |
| `@_exported import`       | Module re-exports not tracked         | Framework wrapper patterns       |

## 🟢 Low Priority

### Type Inference

| Gap                                   | Description                                          | Impact                          |
| ------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| `switch` / `case` pattern binding     | `case let x as Foo:` not tracked                     | Enum pattern matching           |
| Tuple destructuring                   | `let (a, b) = fn()` not handled                      | Uncommon pattern                |
| `@Environment` / `@EnvironmentObject` | SwiftUI dependency injection — no AST representation | Would need heuristic resolution |
| `@Query` (SwiftData)                  | Property wrapper types not inferrable from AST       | SwiftData-specific              |
| `#if canImport(...)`                  | Conditional compilation not evaluated                | Cross-platform projects         |

## ✅ Historical extraction fixes

These entries record earlier fixes. They are not proof that every corresponding
receiver or cross-file form is covered by the current pipeline.

| Gap                               | Resolution                                                                                               | Commit    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | --------- |
| Cross-chunk implicit imports      | `addSwiftImplicitImports` now uses `allFileList` instead of chunk-only `files`                           | `956dfd0` |
| `private(set)` false positive     | Regex excludes `private(set)` / `fileprivate(set)` from unexported check                                 | `0a3cdce` |
| `if let` / `guard let` binding    | `extractIfGuardBinding` handles optional bindings                                                        | `16b1a63` |
| `await` / `try` unwrapping        | `unwrapSwiftExpression` strips wrappers before RHS analysis                                              | `16b1a63` |
| For-loop element type extraction  | `extractForLoopBinding` + `extractSwiftElementTypeFromTypeNode` + type_annotation population in type-env | `956dfd0` |
| `self` / `super` resolution       | `lookupInEnv` handles `self`/`super` via AST walk                                                        | `16b1a63` |
| Optional chaining `obj?.method()` | Handled via `optional_chaining_expression`                                                               | `16b1a63` |
| Initial inheritance capture       | First-specifier capture was added; this does not establish complete protocol-list coverage               | `16b1a63` |

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
