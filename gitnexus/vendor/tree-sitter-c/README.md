## GitNexus vendor notice

This runtime package uses upstream sources at [`b780e47fc780ddc8da13afa35a3f4ed5c157823d`](https://github.com/tree-sitter/tree-sitter-c/commit/b780e47fc780ddc8da13afa35a3f4ed5c157823d)
with Tree-sitter **0.25.1**. The copied C sources, scanner (where present),
headers, node metadata and native binding source are upstream-identical.
GitNexus preserves its synchronous CommonJS loader and hardened `binding.gyp`.
The exact version and source commit are recorded in `package.json`.

All six platform/architecture prebuilds are built from this vendored source by
`.github/workflows/build-tree-sitter-prebuilds.yml`. Load through
`requireVendoredGrammar`; do not copy the package into `node_modules`.
See [the vendor update policy](../README.md), including the Swift release hold.
Do not edit generated C files by hand.
