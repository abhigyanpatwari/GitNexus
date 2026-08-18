/**
 * Zig module import resolution — internal helpers.
 *
 * Zig imports take three shapes:
 *   const std = @import("std");                  → stdlib, unresolvable
 *   const builtin = @import("builtin");          → compiler builtin, unresolvable
 *   const root = @import("root");                → user's main module, unresolvable here
 *   const foo = @import("./foo.zig");            → relative path
 *   const foo = @import("foo.zig");              → also relative (Zig treats unprefixed
 *                                                  paths with a `.zig` extension as
 *                                                  filesystem-relative to the importer)
 *   const bar = @import("bar");                  → package dep declared in build.zig.zon
 *
 * Bare-name (build.zig.zon) resolution is handled when a parsed
 * ZigBuildZonConfig is supplied (see `loadZigBuildZon`). `.url`-based deps
 * unpack into a build cache outside the repo and so are returned as null;
 * `.path`-based deps are resolved through the root the dep's own build.zig
 * declares, then the conventional `<dep_root>/src/root.zig`,
 * `<dep_root>/src/<name>.zig`, `<dep_root>/src/main.zig` layouts.
 */

import { normalizeZigDepPath, type ZigBuildZonConfig } from '../language-config.js';

const ZIG_STDLIB_NAMES = new Set(['std', 'builtin', 'root']);

/** Resolve a Zig @import argument to a file path in the repository.
 *  Returns null when the import is a stdlib / builtin / root reference,
 *  an unresolvable build.zig.zon package dep, or genuinely unresolvable.
 *
 *  `buildZon` (optional) supplies the parsed `.dependencies` map from
 *  build.zig.zon. */
export function resolveZigImportInternal(
  currentFile: string,
  importPath: string,
  allFiles: ReadonlySet<string>,
  buildZon?: ZigBuildZonConfig | null,
): string | null {
  // Stdlib / compiler builtin / root — not resolvable from source files alone.
  if (ZIG_STDLIB_NAMES.has(importPath)) return null;

  // Normalize path separators for the path arithmetic below. The `.zig`
  // extension is kept as written: the first candidate is the path as spelled
  // and only the fallback appends `.zig` for extension-less spellings.
  const trimmed = importPath.replace(/\\/g, '/');

  // Absolute paths point outside the repository (Zig itself rejects
  // `@import("/abs.zig")` as an import outside the module path). Splitting
  // would drop the empty leading component and read `/foo.zig` as an
  // importer-relative `foo.zig`, fabricating an in-repo edge.
  if (trimmed.startsWith('/')) return null;

  // Path-bearing import: resolve relative to the current file's directory.
  // Zig allows both "./foo.zig" and "foo.zig" — both are filesystem-relative.
  if (trimmed.endsWith('.zig') || trimmed.includes('/')) {
    const currentDir = currentFile.split('/').slice(0, -1);
    const parts = trimmed.split('/');
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        // Above the repository root: the import names a file outside the
        // repo, so it must not alias a same-named root file (`../bar.zig`
        // from `main.zig` is NOT `bar.zig`).
        if (currentDir.length === 0) return null;
        currentDir.pop();
      } else {
        currentDir.push(part);
      }
    }
    const candidate = currentDir.join('/');
    if (allFiles.has(candidate)) return candidate;
    if (allFiles.has(candidate + '.zig')) return candidate + '.zig';
    return null;
  }

  // Bare name without extension or slashes (e.g. @import("bar")).
  // Try to resolve via build.zig.zon `.path` deps.
  if (buildZon) {
    const depPath = buildZon.pathDeps.get(importPath);
    if (depPath) {
      const normalized = normalizeZigDepPath(depPath);
      if (normalized !== null) {
        // What the dep's own build.zig declares comes first (its
        // `addModule` root_source_file — see `parseZigBuildModuleRoots`), then
        // the conventional layouts: `src/root.zig` (the `zig init` library
        // root since 0.12), `src/<name>.zig` (older name-matched convention),
        // `src/main.zig` (executables / older inits). A dep at `.path = "."`
        // (the repo itself) normalizes to '' and must not grow a leading slash
        // — `allFiles` keys are repo-relative.
        const prefix = normalized === '' ? '' : `${normalized}/`;
        const candidates = [
          ...(buildZon.moduleRoots?.get(importPath) ?? []),
          `${prefix}src/root.zig`,
          `${prefix}src/${importPath}.zig`,
          `${prefix}src/main.zig`,
        ];
        for (const c of candidates) {
          if (allFiles.has(c)) return c;
        }
      }
    }
  }

  // Bare name with no resolution (no build.zig.zon, .url-based dep, or
  // unconventional layout).
  return null;
}
