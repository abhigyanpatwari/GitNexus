## GitNexus vendor notice

This directory is a GitNexus-managed **runtime** package derived from
`tree-sitter-c@0.21.4` (tree-sitter/tree-sitter-c). It carries the runtime files
(`bindings/node/`, `src/node-types.json`, `LICENSE`), the native `prebuilds/`,
**and** the grammar source (`binding.gyp`, `src/parser.c`, `src/tree_sitter/`).
The prebuilds make C parsing toolchain-free; the source lets
`build-tree-sitter-grammars.cjs` compile the binding on a toolchain host when no
prebuild matches (e.g. CI before the prebuilds are vendored).

### Why this is vendored (unlike the other npm grammars)

`tree-sitter-c` is the one grammar dependency upstream ships **incomplete**
prebuilds for: only 4 of 6 platform-archs (no `linux-arm64` / `win32-arm64`,
[#2116](https://github.com/abhigyanpatwari/GitNexus/issues/2116)). And unlike
the optional grammars, `tree-sitter-c` is a **required** grammar whose own
`install` script (`node-gyp-build`) compiles from source when no prebuild
matches — which **hard-fails `npm install`** on a toolchain-less ARM host
(`node-gyp rebuild` exits non-zero for a required dependency). To make C parsing
toolchain-free on every platform, GitNexus builds all six prebuilds itself (via
the `build-tree-sitter-prebuilds` workflow) and vendors them; `node-gyp-build`
selects the right `.node` at require time.

### Held at 0.21.4 (do not bump here)

The version is pinned to **0.21.4** for ABI compatibility with the bundled
`tree-sitter@0.21.1` runtime — `tree-sitter-c@0.23.x` prebuilds segfault under
0.21.1 on Windows ([#1242](https://github.com/abhigyanpatwari/GitNexus/issues/1242),
[#858](https://github.com/abhigyanpatwari/GitNexus/issues/858)). Vendoring 0.21.4
*preserves* that pin while closing the ARM prebuild gap. Bump only as part of the
deliberate tree-sitter 0.21→0.23 runtime upgrade.

### Updating this vendor package

1. (Runtime upgrade only) bump `version` in `package.json` + refresh
   `bindings/node/*` and `src/node-types.json` from the new `tree-sitter-c`
   release, and refresh `_vendoredBy`.
2. Regenerate the six prebuilds by running the **`build-tree-sitter-prebuilds`**
   workflow.
3. Verify the packed tarball can `require('tree-sitter-c')` and parse C on each
   target platform-arch (the workflow's validate step does this in CI).
