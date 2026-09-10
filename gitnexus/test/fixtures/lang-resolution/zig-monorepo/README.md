A Zig MONOREPO: several build packages, and no `build.zig` at the repo root.

This is the layout the root-only config loader could not see at all. With no
root `build.zig` / `build.zig.zon`, `loadZigBuildConfig` answered `null`, and
every bare `@import("<module>")` below went unresolved — so cross-file symbol
resolution in a repo like this degraded to relative imports only.

The three packages are not interchangeable:

- `core` declares module `core` and is imported by `app`.
- `app` declares module `app` and depends on `core` through a
  `build.zig.zon` `.path = "../core"` — a spelling relative to the PACKAGE,
  which has to be rebased to repo-relative `packages/core` before it can be
  matched against indexed files.
- `tool` is the discriminating control. It binds the SAME alias `core` to its
  OWN `src/core.zig`. A workspace that flattened every package's modules into
  one repo-wide map would resolve `tool`'s `@import("core")` to `core`'s root
  — a confident edge into a package `tool` never depends on. Only per-package
  scoping (`zigPackageFor`, the `tsconfigFor` analogue) keeps them apart.
