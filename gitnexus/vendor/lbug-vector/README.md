# LadybugDB VECTOR artifacts

These unmodified binaries come from the official LadybugDB
[v0.22.0 build](https://github.com/LadybugDB/ladybug/actions/runs/40157072171),
at core commit `4ca22377b85a33a10247410fe3944a5224b1169d` and extensions
commit `119912e604ebbaad64072a701698d6fcf4140051`.

`manifest.json` records each GitHub artifact ID, the archive digest supplied by
GitHub, and the extracted binary's SHA-256. Every archive was checked against
that digest before extracting `vector/libvector.lbug_extension`.

The CDN compatibility path can serve a VECTOR binary built against
incompatible core symbols. Load the matching packaged artifact first
so vector indexes work without a network install or a mutable home-cache copy.
The existing `never` policy still disables the extension; missing artifacts
retain the normal named-load and install fallback.

To refresh, select an official build matching the exact `@ladybugdb/core` pin,
download its platform artifacts, verify their GitHub archive digests, and
update the binaries and manifest together. Validate Linux, macOS, and Windows
native tests before changing the pin. Do not substitute a nightly binary.

For example, the Linux x64 archive is available with:

```sh
gh api repos/LadybugDB/ladybug/actions/artifacts/12584987551/zip > vector-linux.zip
```

GitHub Actions artifacts expire; the committed binaries and checksums preserve
the verified build. `test/unit/vector-artifact-coverage.test.ts` checks the core
pin, platform coverage, and binary digests. The upstream MIT license is included
in `LICENSE`.
