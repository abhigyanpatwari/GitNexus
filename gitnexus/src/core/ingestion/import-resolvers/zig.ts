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
 * `.path`-based deps are resolved through the conventional
 * `<dep_root>/src/<name>.zig` or `<dep_root>/src/main.zig` layout.
 */

import type { ZigBuildZonConfig } from '../language-config.js';

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
  allFiles: Set<string>,
  buildZon?: ZigBuildZonConfig | null,
): string | null {
  // Stdlib / compiler builtin / root — not resolvable from source files alone.
  if (ZIG_STDLIB_NAMES.has(importPath)) return null;

  // Strip any explicit `.zig` extension for path arithmetic; we re-add it below.
  const trimmed = importPath.replace(/\\/g, '/');

  // Path-bearing import: resolve relative to the current file's directory.
  // Zig allows both "./foo.zig" and "foo.zig" — both are filesystem-relative.
  if (trimmed.endsWith('.zig') || trimmed.includes('/')) {
    const currentDir = currentFile.split('/').slice(0, -1);
    const parts = trimmed.split('/');
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
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
      const normalized = normalizeDepPath(depPath);
      if (normalized !== null) {
        // Conventional Zig layout: <pkg_root>/src/<name>.zig (matches the
        // package's primary module name) or <pkg_root>/src/main.zig.
        const candidates = [
          `${normalized}/src/${importPath}.zig`,
          `${normalized}/src/main.zig`,
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

/**
 * Normalize a `.path` value from build.zig.zon into a repo-relative form.
 * Returns null for paths that escape the repo root (start with `..`) or
 * are absolute — those point to files we don't index in `allFilePaths`.
 */
function normalizeDepPath(depPath: string): string | null {
  if (depPath.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of depPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}
