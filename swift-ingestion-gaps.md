# Swift Ingestion Gaps

Tracks missing Swift features in the GitNexus ingestion pipeline. Organized by priority.

## 🔴 High Priority

### Type Inference

| Gap | Description | Impact |
|-----|-------------|--------|
| `if let` / `guard let` inside for-loop bodies | Type-env binds the variable correctly but call-processor's re-parse path doesn't propagate for-loop element bindings to receiver resolution | Calls inside `for item in collection` are unresolved |
| `while let` binding | `while let x = iter.next()` not in `DECLARATION_NODE_TYPES` | Uncommon but valid Swift pattern |

### Call Resolution

| Gap | Description | Impact |
|-----|-------------|--------|
| `await expr` / `try expr` as call wrappers | `await_expression` and `try_expression` wrap `call_expression` — call extraction queries match but the outer wrapper can interfere with receiver resolution in some paths | Most cases work via `unwrapSwiftExpression` but edge cases remain |
| Multi-hop chains | `a.b.c()` — only single-hop `receiver.method()` resolved | Common in UIKit/SwiftUI code |
| Trailing closures | `items.map { $0.save() }` — `$0` type not inferrable | Functional-style Swift code |

## 🟡 Medium Priority

### Symbol Extraction

| Gap | Description | Impact |
|-----|-------------|--------|
| Enum `case` as callable | `MyEnum.case` calls are member-form, not caught by constructor fallback | Enum-heavy code (Result, State enums) |
| Subscript declarations | `subscript(i:) -> T` not captured | Protocol conformance tracking |
| Operator overloads | `static func + (lhs:, rhs:)` not captured | Mathematical types |
| `deinit` | `deinit {}` not captured | Minor — rarely called explicitly |
| Macro declarations | `@macro` / `#macro` (Swift 5.9+) not captured | Swift macro ecosystem is growing |

### Heritage / Inheritance

| Gap | Description | Impact |
|-----|-------------|--------|
| Multiple inheritance specifiers | `class Foo: Bar, P1, P2` — only first specifier captured | Missing protocol conformance edges |
| Generic constraints | `class Foo<T: Equatable>` — bounds not tracked | Advanced generics |
| Conditional conformance | `extension Array: P where Element: Q` — `where` clause not processed | Cross-platform code |
| Protocol composition | `typealias Codable = Encodable & Decodable` — not expanded | Type alias resolution |

### Export / Visibility

| Gap | Description | Impact |
|-----|-------------|--------|
| Nested function declarations | Inner `func` marked as exported — should be private | Conservative resolution still correct (over-exports) |

### Module / Import

| Gap | Description | Impact |
|-----|-------------|--------|
| `@testable import` | Test target imports treated as opaque | Test file cross-references |
| Cross-package SPM imports | External package symbols not resolved | Only affects multi-package repos |
| `@_exported import` | Module re-exports not tracked | Framework wrapper patterns |

## 🟢 Low Priority

### Type Inference

| Gap | Description | Impact |
|-----|-------------|--------|
| `switch` / `case` pattern binding | `case let x as Foo:` not tracked | Enum pattern matching |
| Tuple destructuring | `let (a, b) = fn()` not handled | Uncommon pattern |
| `@Environment` / `@EnvironmentObject` | SwiftUI dependency injection — no AST representation | Would need heuristic resolution |
| `@Query` (SwiftData) | Property wrapper types not inferrable from AST | SwiftData-specific |
| `#if canImport(...)` | Conditional compilation not evaluated | Cross-platform projects |

## ✅ Resolved

| Gap | Resolution | Commit |
|-----|-----------|--------|
| Cross-chunk implicit imports | `addSwiftImplicitImports` now uses `allFileList` instead of chunk-only `files` | `956dfd0` |
| `private(set)` false positive | Regex excludes `private(set)` / `fileprivate(set)` from unexported check | `0a3cdce` |
| `if let` / `guard let` binding | `extractIfGuardBinding` handles optional bindings | `16b1a63` |
| `await` / `try` unwrapping | `unwrapSwiftExpression` strips wrappers before RHS analysis | `16b1a63` |
| For-loop element type extraction | `extractForLoopBinding` + `extractSwiftElementTypeFromTypeNode` + type_annotation population in type-env | `956dfd0` |
| `self` / `super` resolution | `lookupInEnv` handles `self`/`super` via AST walk | `16b1a63` |
| Optional chaining `obj?.method()` | Handled via `optional_chaining_expression` | `16b1a63` |
| Multi-inheritance specifiers | First specifier captured via `inheritance_specifier` query | `16b1a63` |
