# tree-sitter-dart
This is a tree-sitter grammar written for the dart programming language. We attempt to adhere as closely as possible to the dart language spec. Initially it was started with a copy of the tree-sitter Java grammar which is why there may be a few relics included in here. For the sake of simplifying the syntax tree, many items were made inlined with tree-sitter's "underscore" method of writing rules.

# Getting Started
- Go to the project directory
- run `npm install` (first time)
- run `npm run build_init` (first time) `npm run build` (subsequent times)
- run `npm run test`

# To test a single highlight file
- run `tree-sitter highlight test/highlight/types.dart`

# To test a single test file
- run `tree-sitter test -f 'testcasefilter'`
- for example `tree-sitter test -f 'dart string literals'`

# To show the output of a parse for a sample file (for example while debugging highlight issues)
- run `tree-sitter parse path/to/file.dart`