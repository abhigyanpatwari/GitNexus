## GitNexus vendor notice

This directory is a GitNexus-managed runtime package derived from
`tree-sitter-objc@3.0.2` at upstream commit
`181a81b8f23a2d593e7ab4259981f50122909fda`
(`tree-sitter-grammars/tree-sitter-objc`). The upstream license is MIT; its
verbatim text is retained in `LICENSE`.

The committed runtime inputs are `bindings/node/`, `src/node-types.json`, the
generated `src/parser.c`, the Tree-sitter headers, and `binding.gyp`. GitNexus
loads this package from `vendor/` by absolute path. It must never be copied to
or required as an undeclared package from `node_modules`.

### Compatibility pin

The parser was generated with Tree-sitter CLI 0.24.5 from
`tree-sitter-c@0.23.4` and reports Tree-sitter language ABI 14. Upstream declares
`tree-sitter@^0.22.1`, while GitNexus intentionally remains on
`tree-sitter@0.21.1`. GitNexus therefore treats the version relationship as
unproven metadata and gates this vendor with a real native load,
`Parser.setLanguage`, query compilation, and Objective-C parse smoke test.

### Prebuilds and source fallback

GitNexus' `build-tree-sitter-prebuilds` workflow owns the six supported tuples:
Darwin, Linux, and Windows on x64 and arm64. `prebuilds/SHA256SUMS` records every
committed binary. Until all six prebuilds are present, the source remains in the
npm package so a host with a C/C++ toolchain can build the optional grammar.
Failure to load or build this package disables Objective-C only; it must not
abort installation or affect other languages.

To update the grammar, change the pinned upstream commit deliberately, refresh
the generated/source files and this provenance note, regenerate all six
prebuilds, and rerun the grammar loader, publish coverage, npm-pack, and corpus
gates. Do not upgrade the shared Tree-sitter runtime as part of a grammar-only
change.
