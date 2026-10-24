# LadybugDB VECTOR artifacts

These unmodified binaries come from the official LadybugDB
[v0.21.1 build](https://github.com/LadybugDB/ladybug/actions/runs/36647903773),
at core commit `17a70e51c31b50d30231da32154d9ff4bef0d95f` and extensions
commit `bf74ab654af6bd40a0e3208ac4e8bcf5cb45a7a0`.

`manifest.json` records each GitHub artifact ID, the archive digest supplied by
GitHub, and the extracted binary's SHA-256. Every archive was checked against
that digest before extracting `vector/libvector.lbug_extension`.

The core's `0.21.0` CDN compatibility path can serve a VECTOR binary built
against incompatible core symbols. Load the matching packaged artifact first
so vector indexes work without a network install or a mutable home-cache copy.
The existing `never` policy still disables the extension; missing artifacts
retain the normal named-load and install fallback.

To refresh, select an official build matching the exact `@ladybugdb/core` pin,
download its platform artifacts, verify their GitHub archive digests, and
update the binaries and manifest together. Validate Linux, macOS, and Windows
native tests before changing the pin. Do not substitute a nightly binary.

For example, the Linux x64 archive is available with:

```sh
gh api repos/LadybugDB/ladybug/actions/artifacts/11069747578/zip > vector-linux.zip
```

GitHub Actions artifacts expire; the committed binaries and checksums preserve
the verified build. `test/unit/vector-artifact-coverage.test.ts` checks the core
pin, platform coverage, and binary digests. The upstream MIT license is included
in `LICENSE`.
