# Aptos release line

The `main-aptos` branch carries the compiler-backed Move integration separately
from the compilerless `main` release line. Keep it current by regularly merging
`main` into `main-aptos` through a pull request. Do not rewrite the shared branch:
published Aptos tags must remain reachable from it.

## Release an Aptos version

1. Synchronize `main-aptos` with `main` and pass the full CI suite.
2. Choose an unused npm prerelease version: `X.Y.Z-aptos` for the first release
   on a base version, then `X.Y.Z-aptos.N` for later revisions.
3. From `gitnexus/`, run:

   ```bash
   npm version X.Y.Z-aptos --no-git-tag-version
   ```

   This synchronizes `package.json`, `package-lock.json`, and the plugin
   manifests. Commit the version change to `main-aptos`.
4. Tag that versioned commit and push the tag:

   ```bash
   git tag -a vX.Y.Z-aptos -m vX.Y.Z-aptos
   git push origin main-aptos
   git push origin vX.Y.Z-aptos
   ```

The publish workflow rejects tags that do not match the package version or are
not contained in `main-aptos`. A valid tag publishes the exact npm version under
the `aptos` dist-tag, so users can install either form:

```bash
npm install gitnexus@X.Y.Z-aptos
npm install gitnexus@aptos
```

Aptos releases are GitHub prereleases and never update npm's `latest` tag.
