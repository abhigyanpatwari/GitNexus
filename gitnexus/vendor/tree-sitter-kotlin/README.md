## GitNexus vendor notice

This directory is a GitNexus-managed minimal **runtime** package derived from
`tree-sitter-kotlin` (fwcd), pinned to the **unreleased `main` commit
[`c8ac3d26`](https://github.com/fwcd/tree-sitter-kotlin/commit/c8ac3d2627240160b999a2c100de3babbdb8f419)**
(`package.json` version `0.4.0`). It is pinned to `main` rather than
a tagged release because the latest release, `0.3.8` (tagged 2024-08-03),
predates `fun interface` (functional/SAM interface) support: it parsed
`fun interface Foo` as an `ERROR` node and dropped the declaration. That fix
landed in [PR #169](https://github.com/fwcd/tree-sitter-kotlin/pull/169)
(closing [issue #87](https://github.com/fwcd/tree-sitter-kotlin/issues/87)),
merged into `main` 2025-04-25 but **not yet in any npm release**.

It carries `bindings/node/`, `LICENSE`, the native `prebuilds/`, and the full C
source — `src/parser.c`, `src/scanner.c`, `src/node-types.json`,
`src/tree_sitter/`, and `binding.gyp`. The source IS vendored (despite the
~33 MB generated `parser.c`) for two reasons: it lets `build-tree-sitter-grammars.cjs`
source-build the binding on a toolchain host when no prebuild matches, and —
because the pinned commit is unreleased on npm — it is the source the prebuild
workflow itself compiles from (see below).

### Why this is vendored (unlike the npm grammars)

Upstream `tree-sitter-kotlin` ships **source only** — its npm tarball has no
`prebuilds/` — so a plain `npm install` compiles the native binding from source
and requires a C/C++ toolchain (`python3`/`make`/`g++`). To make Kotlin parsing
toolchain-free on every host (Swift parity), GitNexus builds the platform
prebuilds itself and vendors them here. `node-gyp-build` selects the correct
binary at require time; `build-tree-sitter-grammars.cjs` activates the binding
(prefer prebuild, else source-build) at install time.

`tree-sitter-swift` is handled the same way: its source is vendored and its
prebuilds are **GitNexus-cross-built** from that vendored source. Kotlin now
uses this exact path too (workflow registry `kind: 'vendored'`, switched from
`'npm'` when this pin moved to an unreleased commit), so all of
Dart/Proto/Swift/Kotlin go through one uniform `kind: 'vendored'` build.

### Updating this vendor package

1. Bump the pin: update `version` in `package.json` (this is the value the
   `build-tree-sitter-prebuilds` workflow diffs to decide whether to rebuild)
   and refresh `_vendoredBy` with the new ref.
2. Refresh `bindings/node/*`, `src/parser.c`, `src/scanner.c`,
   `src/node-types.json`, `src/tree_sitter/*`, and `binding.gyp` from the new
   upstream ref (a release tag, or — as now — a pinned `main` commit). For a
   pinned commit the generated `parser.c` is committed upstream, so copy it
   directly; if you re-pin to a ref that does not commit `parser.c`, regenerate
   it with `tree-sitter generate` first.
3. Regenerate the six native prebuilds by running the
   **`build-tree-sitter-prebuilds`** GitHub Actions workflow (it builds
   `{linux,darwin,win32}-{x64,arm64}` from this vendored source and opens a PR
   committing them under `prebuilds/`). While `kind: 'vendored'`, the workflow
   does NOT touch npm for kotlin.
4. Verify the packed GitNexus tarball can `require('tree-sitter-kotlin')` and
   parse a Kotlin snippet (including a `fun interface`) on each target
   platform-arch (the workflow's validate step does this in CI).

> Note: `darwin-x64` prebuilds depend on GitHub's `macos-15-intel` image, whose
> x86_64 macOS runners sunset ~Aug 2027. After that, darwin-x64 needs
> cross-compilation or dropping.
