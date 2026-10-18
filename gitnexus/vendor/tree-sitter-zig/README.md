## GitNexus vendor notice

This runtime package uses upstream sources at [`6479aa13f32f701c383083d8b28360ebd682fb7d`](https://github.com/tree-sitter-grammars/tree-sitter-zig/commit/6479aa13f32f701c383083d8b28360ebd682fb7d)
with Tree-sitter **0.25.1**. The copied C sources, scanner (where present),
headers, node metadata and native binding source are upstream-identical.
GitNexus preserves its synchronous CommonJS loader and hardened `binding.gyp`.
The exact version and source commit are recorded in `package.json`.

All six platform/architecture prebuilds are built from this vendored source by
`.github/workflows/build-tree-sitter-prebuilds.yml`. Load through
`requireVendoredGrammar`; do not copy the package into `node_modules`.
See [the vendor update policy](../README.md), including the Swift release hold.
Do not edit generated C files by hand.
