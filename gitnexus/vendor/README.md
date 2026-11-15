# Vendored Tree-sitter grammars

These grammars use the bundled Tree-sitter 0.25.1 runtime (ABI 13–15).
Generated C sources and scanners must be copied from upstream; never patch them
by hand. JavaScript/TypeScript compatibility adapters belong in GitNexus.

| Grammar | Version / snapshot | Upstream source commit |
| --- | --- | --- |
| c | `0.24.2-gb780e47` | [b780e47fc780](https://github.com/tree-sitter/tree-sitter-c/commit/b780e47fc780ddc8da13afa35a3f4ed5c157823d) |
| dart | `1.0.0-gbe07cf7` | [be07cf7118d3](https://github.com/UserNobody14/tree-sitter-dart/commit/be07cf7118d3dba06236a3f19541685a68209934) |
| proto | `0.6.0-gd7d1542` | [d7d15427321d](https://github.com/coder3101/tree-sitter-proto/commit/d7d15427321da271cb1c25c12735e180ef981473) |
| kotlin | `0.4.0-g1852ea1` | [1852ea17b7f6](https://github.com/fwcd/tree-sitter-kotlin/commit/1852ea17b7f60fb3f9d84e0b1555d56b46b39fb1) |
| objc | `3.0.2-g181a81b` | [181a81b8f23a](https://github.com/tree-sitter-grammars/tree-sitter-objc/commit/181a81b8f23a2d593e7ab4259981f50122909fda) |
| zig | `1.1.2-g6479aa1` | [6479aa13f32f](https://github.com/tree-sitter-grammars/tree-sitter-zig/commit/6479aa13f32f701c383083d8b28360ebd682fb7d) |
| swift | `0.7.2` | [7b7909f2f6b9](https://github.com/alex-pinkus/tree-sitter-swift/commit/7b7909f2f6b9414be0958275f4c8e5d69c3bca43) |

Swift 0.7.2 is the newest release that passes our declaration-ownership tests.
Both 0.7.3 and 0.7.4 move a later top-level struct inside an earlier class after
a conditional group splits a function header. That input is invalid Swift,
but preserving recovery for partial source is an existing GitNexus contract.
The hold in `.github/vendored-grammars.json` remains until the real-parser and
worker-pipeline tests in `tree-sitter-languages.test.ts` and
`swift-conditional-directive.test.ts` pass with a newer upstream grammar.
No generated source was patched to preserve this behavior.

To refresh a grammar:

1. Resolve an immutable upstream commit (Swift publishes generated sources on
   `*-with-generated-files` tags). Copy `src/` runtime/build inputs and
   `bindings/node/binding.cc` byte-for-byte. Keep the GitNexus CommonJS loader
   and `binding.gyp`; upstream C's ESM loader uses top-level await and cannot be
   substituted into the synchronous worker import path.
2. Update the vendor package version, `_upstreamCommit`, `_vendoredBy`, this
   table and any hold in `.github/vendored-grammars.json`. GitHub snapshots use
   `<upstream-version>-g<sha7>` so the monitor recognizes the installed commit.
3. Run semantic tests, including CFG and call/reference resolution. Successful
   loading, parsing or definition captures alone do not prove compatibility.
4. Let `build-tree-sitter-prebuilds.yml` rebuild and execute the grammar on
   all six `{linux,darwin,win32}-{x64,arm64}` hosts. Check the installed tarball
   too; it must include the regenerated binaries and runtime metadata. Source
   builds use the repository checkout, which also contains the build inputs.

Protobuf's upstream `syntax` node collides with node-tree-sitter 0.25.1's
JavaScript `SyntaxNode` subclass generator. Its gRPC plugin uses a private
metadata wrapper to retain the native node and field/query APIs without
changing upstream sources. Native loading and comment/string-safe fallback
extraction are covered in `test/unit/group/grpc-extractor.test.ts`.
