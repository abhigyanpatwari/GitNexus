# tree-sitter-lua (vendored)

Vendored copy of [tree-sitter-lua](https://github.com/tree-sitter-grammars/tree-sitter-lua) (v2.1.3, MIT).

## Why vendored

The upstream npm package ships `nan`-based node bindings that are ABI-incompatible with the `tree-sitter@0.21.1` runtime GitNexus pins (`setLanguage` rejects with "Invalid language object"). The grammar C sources (`src/parser.c`, `src/scanner.c`) are vendored unmodified and rebuilt against a Napi `binding.cc` adapted from `tree-sitter-c`'s vendored binding, so the grammar loads under the pinned runtime.

## Files

- `src/` — upstream grammar sources (unmodified)
- `bindings/node/binding.cc` — Napi binding (adapted from `tree-sitter-c`)
- `bindings/node/index.js`, `index.d.ts` — node entry + types (adapted from `tree-sitter-c`)
- `binding.gyp`, `package.json` — build config

Built by `scripts/build-tree-sitter-grammars.cjs` at install time; `build/` artifacts are gitignored.
