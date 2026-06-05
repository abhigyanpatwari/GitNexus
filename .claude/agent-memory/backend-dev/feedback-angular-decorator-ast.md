---
name: angular-decorator-ast
description: tree-sitter-typescript AST shape for Angular decorators — class_declaration + decorator are siblings inside export_statement
metadata:
  type: feedback
---

In tree-sitter-typescript, Angular `@NgModule` decorators are NOT children of the class_declaration. They are siblings inside the enclosing `export_statement`:

```
export_statement
  decorator (named child 0)
  class_declaration (named child 1)
```

For un-exported classes the decorator is `previousNamedSibling` of the class.

**Why:** This was discovered while debugging why issue #32's extractor found 0 edges — my initial code looked for decorators only inside `class_declaration.namedChildren` and missed the export-statement case. The fix collects decorators from BOTH positions and dedupes by node identity.

**How to apply:** When writing any extractor that targets TS/TSX class decorators, walk the parent of the `class_declaration` to find decorator siblings. The linter/Serena sometimes merges files — if a pre-existing route-extractors/angular-metadata.ts is in scope, prefer that one over creating a new file. Use the same `extractDecoratorName` helper that unwraps `decorator > call_expression > identifier` to get the decorator name (since `decorator.childForFieldName('name')` is undefined).
