# Audited npm grammar prebuild repairs

These five exact npm releases ship x86-64 binaries in their `linux-arm64`
prebuild directories: C++ 0.23.4, Java 0.23.5, Ruby 0.23.1, JavaScript 0.23.1
(the TypeScript dependency), and TypeScript 0.23.2. The direct JavaScript 0.25.0
package is unaffected. See GitNexus issue #3599.

`manifest.json` records each immutable npm tarball URL, SHA-512 integrity,
SHA-256, upstream commit, unchanged source-file hashes, replacement SHA-256,
and build inputs. All generated parser C and scanner sources remain upstream
bytes. The TypeScript binary retains both TypeScript and TSX exports.

The committed replacements were cross-built using GCC/G++ 13.3.0, binutils
2.42, node-gyp 11.5.0, node-addon-api 8.9.2 and Node 22.23.1 headers. Although
the build sysroot contains glibc 2.39, `readelf` confirms the outputs require
only GLIBC 2.17, GLIBCXX 3.4.21 and CXXABI 1.3.9, with a non-executable stack.
All six language exports loaded and parsed using tree-sitter 0.25.1 under ARM64
Node 22.18.0, 22.23.1 and 24.19.0 via QEMU 8.2.2 user emulation. This is emulated
execution evidence; the packaged-install CI job supplies native ARM64 evidence.

## Regeneration

On Linux ARM64 with Node, npm, Python, make, GCC/G++, tar and readelf installed:

```sh
cd gitnexus
node scripts/rebuild-bundled-grammar-prebuilds.cjs
node scripts/prepare-tree-sitter-bundle.cjs --for-publication
npx vitest run test/unit/prepare-tree-sitter-bundle.test.ts test/unit/prebuild-coverage.test.ts test/unit/parser-loader-abi.test.ts
```

The script downloads the recorded tarballs and headers, verifies their hashes,
installs the pinned build helpers with lifecycle scripts disabled, and builds
packages serially in a temporary tree. Builds use `gcc` and `g++` from `PATH`,
preserving only `PATH` and `HOME` from the caller's environment. Compiler,
make, and gyp overrides (including `CC`, `CXX`, and flags) are ignored so the
recorded toolchain matches the build. It checks unchanged source bytes, ELF
architecture, N-API, dynamic dependency baselines, and real native parsing
before replacing any committed output. Compiler changes can change the binary
hashes; review the updated binaries and provenance together. This is a bounded
npm-package overlay rebuild, separate from the source-vendored grammar matrix.

## tree-sitter runtime

The upstream `tree-sitter@0.25.1` `linux-x64` and `linux-arm64` runtime
prebuilds were built with GCC 13 and require `GLIBCXX_3.4.31`. Ubuntu 22.04 and
Debian 12 provide up to `GLIBCXX_3.4.30`, so loading fails there and
`node-gyp-build` falls back to a source build, which fails without Python, make
and a C++ compiler. See GitNexus issue #4165.

`tree-sitter@0.25.1/linux-{x64,arm64}/tree-sitter.node` are rebuilt from the
unchanged npm tarball inside the Ubuntu 22.04 image pinned in
`runtime-manifest.json` (GCC/G++ 11.4.0, binutils 2.38, glibc 2.35), using
node-gyp 11.5.0, node-addon-api 8.9.2 and Node 22.23.1 headers. `readelf`
confirms they require at most GLIBC 2.17, GLIBCXX 3.4.29 and CXXABI 1.3.9, with
a non-executable stack. Each was built and validated natively (x86-64 and
AArch64): the script loads the new runtime and parses JavaScript with it. A
packed tarball installed without a compiler on Ubuntu 22.04 and Debian 12, on
both architectures, loaded and parsed all 21 grammars, and `gitnexus analyze`
completed. CI repeats that install on Ubuntu 22.04 for both Linux runners.

To regenerate one architecture, run on a native Linux host of that
architecture with Docker, from the repository root:

```sh
docker run --rm -v "$PWD/gitnexus:/src/gitnexus" \
  "$(node -p "require('./gitnexus/prebuilds/bundled/runtime-manifest.json').build.image")" \
  bash -euc '
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils python3 make g++ binutils
    arch=$(uname -m | sed "s/aarch64/arm64/;s/x86_64/x64/")
    manifest=/src/gitnexus/prebuilds/bundled/runtime-manifest.json
    read -r v sum < <(python3 -c "import json;b=json.load(open(\"$manifest\"))[\"build\"][\"node\"];print(b[\"version\"],b[\"sha256\"][\"linux-$arch\"])")
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v$v/node-v$v-linux-$arch.tar.xz"
    echo "$sum  /tmp/node.tar.xz" | sha256sum -c -
    tar -xJf /tmp/node.tar.xz -C /opt
    PATH="/opt/node-v$v-linux-$arch/bin:$PATH" node /src/gitnexus/scripts/rebuild-runtime-prebuild.cjs
  '
```

The script verifies the tarball, headers and build helper hashes, rejects a
binary for the wrong architecture or above the libstdc++ ceiling, and only
then replaces that architecture's binary and manifest entry. Update the audit
hash in `test/unit/prebuild-coverage.test.ts` after reviewing the changes.

## Packaging behavior

Bundle preparation validates every repair before writing peer manifests or
binary files. `prepack` supplies `--for-publication` to remove local
`build/Release/*.node` and `build/Debug/*.node` outputs from repaired packages
and the runtime,
which would otherwise shadow their platform prebuilds. Normal consumer
postinstall keeps legitimate source-built fallbacks intact. Repair assets are
included in the npm package so postinstall remains self-contained.

Corrected bytes must exist before consumer child install scripts run. The
upstream TypeScript and nested JavaScript builds share node-addon-api Makefile
outputs; configuring them at different dependency depths can overwrite those
outputs with conflicting relative stamp paths. Repairing this upstream build
behavior for explicit `--build-from-source` or raw source-checkout installation
is outside this fix. Ordinary supported Linux ARM64 glibc tarball installation
uses the corrected prebuilds and does not require compilation.
