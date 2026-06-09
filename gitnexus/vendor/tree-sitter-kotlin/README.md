## GitNexus vendor notice

This directory is a GitNexus-managed minimal **runtime** package derived from
`tree-sitter-kotlin@0.3.8` (fwcd). It carries only what the runtime needs:
`bindings/node/`, `src/node-types.json`, `LICENSE`, and the native
`prebuilds/`. The C source (`parser.c`, `scanner.c`, `binding.gyp`) is **not**
vendored — `parser.c` alone is ~23 MB, and the prebuilds are produced from the
published npm package, so committing the source would bloat git history for no
runtime benefit.

### Why this is vendored (unlike the npm grammars)

Upstream `tree-sitter-kotlin` ships **source only** — its npm tarball has no
`prebuilds/` — so a plain `npm install` compiles the native binding from source
and requires a C/C++ toolchain (`python3`/`make`/`g++`). To make Kotlin parsing
toolchain-free on every host (Swift parity), GitNexus builds the platform
prebuilds itself and vendors them here. `node-gyp-build` selects the correct
binary at require time; `build-tree-sitter-grammars.cjs` activates the binding
(prefer prebuild, else source-build) at install time.

`tree-sitter-swift` is handled the same way now: its prebuilds were originally
**copied from upstream** (Swift ships them), but it is unified with this pipeline —
its source is vendored and its prebuilds are **GitNexus-cross-built** too, so all
of Dart/Proto/Swift/Kotlin go through one uniform build path.

### Updating this vendor package

1. Bump the upstream version: update `version` in `package.json` (this is the
   value the `build-tree-sitter-prebuilds` workflow diffs to decide whether to
   rebuild) and refresh `_vendoredBy`.
2. Refresh `bindings/node/*` and `src/node-types.json` from the new upstream
   `tree-sitter-kotlin` npm release.
3. Regenerate the six native prebuilds by running the
   **`build-tree-sitter-prebuilds`** GitHub Actions workflow (it builds
   `{linux,darwin,win32}-{x64,arm64}` from the published package and opens a PR
   committing them under `prebuilds/`).
4. Verify the packed GitNexus tarball can `require('tree-sitter-kotlin')` and
   parse a Kotlin snippet on each target platform-arch (the workflow's validate
   step does this in CI).

> Note: `darwin-x64` prebuilds depend on GitHub's `macos-15-intel` image, whose
> x86_64 macOS runners sunset ~Aug 2027. After that, darwin-x64 needs
> cross-compilation or dropping.
