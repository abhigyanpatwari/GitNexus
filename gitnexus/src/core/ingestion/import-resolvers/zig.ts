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
 *                                                  (TODO: resolve via build.zig.zon)
 *
 * Only the relative-path cases are resolved here. Stdlib / builtin / root
 * names and unrecognised package names return null so the standard fallback
 * can attempt suffix matching.
 */

const ZIG_STDLIB_NAMES = new Set(['std', 'builtin', 'root']);

/** Resolve a Zig @import argument to a file path in the repository.
 *  Returns null when the import is a stdlib / builtin / root reference,
 *  a build.zig.zon package dep, or genuinely unresolvable. */
export function resolveZigImportInternal(
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
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
  // TODO: resolve via build.zig.zon package map. For now, return null and
  // let the standard suffix matcher try its luck.
  return null;
}
