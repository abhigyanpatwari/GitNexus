## GitNexus vendor notice

This directory is a GitNexus-managed vendored copy of
`@tree-sitter-grammars/tree-sitter-zig@1.1.2`. GitNexus keeps the top-level
`tree-sitter` dependency pinned to `0.21.1` until the broader parser runtime
upgrade is handled separately (#858). The upstream package declares
`peerOptional tree-sitter@^0.22.1`; that peer is ABI-compatible with 0.21.x
but npm still warns on `npm i -g gitnexus` because a published package's
`overrides` are ignored by dependents.

Unified with the Dart/Proto/Kotlin/Swift/C vendored grammars, this copy
vendors the grammar **source** — `binding.gyp`, `bindings/node/binding.cc`,
`src/parser.c` (ABI 14), and `src/tree_sitter/` — so
`gitnexus/scripts/build-tree-sitter-grammars.cjs` can source-build the native
binding on a toolchain host when no committed prebuild matches. The native
`prebuilds/` are loaded in place by `node-gyp-build`. Upstream's published
`linux-arm64` `.node` is a mispackaged x86-64 binary and is not shipped;
`.github/workflows/build-tree-sitter-prebuilds.yml` rebuilds all six tuples.

When updating this vendor package, replace it from the official
`@tree-sitter-grammars/tree-sitter-zig` npm release: refresh
`src/parser.c`/`src/tree_sitter/`/`binding.gyp`/`bindings/node/`, bump
`version` in `package.json` to retrigger the prebuild workflow, update the
`_vendoredBy` provenance, and verify the packed GitNexus tarball can both
load a committed prebuild and source-build `tree-sitter-zig`.
