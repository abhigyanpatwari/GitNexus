/**
 * Language-agnostic primitives for `ScopeResolver.isGlobalNameFallbackPlausible`
 * implementations.
 *
 * The hook itself is per-language — the RULES here are not. What every
 * implementation needs is the same small set of path arithmetic: which
 * directory a file sits in, and whether a module path a caller wrote can name
 * a given file or directory. Those questions are about paths, not about any
 * language, so they live in shared code (see AGENTS.md: shared ingestion must
 * not name languages) and the language files supply only the semantics.
 */

import type { ParsedFile } from 'gitnexus-shared';

/** POSIX-style parent directory. `''` for a file at the repo root. */
export function directoryOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

/**
 * Split a module path into segments, accepting the three separators languages
 * spell module nesting with: `/` (Go, Node), `::` (Rust, C++) and `.` (JVM,
 * Python). Empty segments and `.` are dropped, so a leading `./` contributes
 * nothing. Named root prefixes are NOT stripped here — `crate::a` yields
 * `['crate', 'a']`; a language whose paths carry one (Rust's `crate::` /
 * `super::`) removes it before calling, see `rustUsePathOf`.
 *
 * `.` is only treated as a separator when the path contains no `/`: a Node
 * specifier like `./util/parse.js` must not split on the extension dot.
 */
export function moduleSegments(modulePath: string): readonly string[] {
  const bySlashOrColon = modulePath.split(/\/|::/).filter((s) => s !== '' && s !== '.');
  if (modulePath.includes('/')) return bySlashOrColon;
  return bySlashOrColon.flatMap((s) => s.split('.').filter((p) => p !== ''));
}

/**
 * Does a module path a caller wrote reach `targetPath`?
 *
 * True when either side's segments are a SUFFIX of the other's. Both directions
 * are needed and neither alone is sufficient:
 *
 *  - The written path is usually longer than the repo-relative one, because it
 *    carries a module/package prefix that is not a directory
 *    (`github.com/org/svc/internal/models` → `internal/models`).
 *  - The repo-relative path is longer when the manifest that defines the module
 *    root sits in a subdirectory of the analyzed tree (`svc/go.mod`, so
 *    `svc/internal/models` is written `mod/internal/models`).
 *
 * So the match is on ALIGNED TRAILING SEGMENTS, and it succeeds when either the
 * shorter side is fully contained in the longer, or at least two segments align.
 * Both conditions are needed: full containment covers a one-segment package
 * (`mod/models` reaching `models`), while the two-segment floor covers the case
 * where neither side contains the other because each carries a different root
 * (`mod/internal/models` vs `svc/internal/models`). A SINGLE aligned segment
 * with neither side contained is not enough — `handlers` appearing at the end of
 * two unrelated trees says nothing.
 *
 * Tolerance is the SAFE direction here: this predicate is consulted to decide
 * whether to REFUSE an edge, so over-matching loses a refusal (the edge stays,
 * labeled and excluded from flows) while under-matching loses a real edge.
 */
export function modulePathReaches(writtenPath: string, targetPath: string): boolean {
  const written = moduleSegments(writtenPath);
  const target = moduleSegments(targetPath);
  if (written.length === 0 || target.length === 0) return false;
  const shorter = Math.min(written.length, target.length);
  let aligned = 0;
  while (
    aligned < shorter &&
    written[written.length - 1 - aligned] === target[target.length - 1 - aligned]
  ) {
    aligned++;
  }
  return aligned === shorter || aligned >= 2;
}

/** Every module path this file's import statements named, in source order. */
function importedModulePaths(parsed: ParsedFile): readonly string[] {
  return parsed.parsedImports.map((imp) => imp.targetRaw);
}

/** True when any of the caller's imports reaches `targetPath`. */
export function anyImportReaches(parsed: ParsedFile, targetPath: string): boolean {
  for (const written of importedModulePaths(parsed)) {
    if (modulePathReaches(written, targetPath)) return true;
  }
  return false;
}

/** Strip a trailing file extension. `a/b.rs` → `a/b`; `a/b` → `a/b`. */
export function stripExtension(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const dot = filePath.lastIndexOf('.');
  return dot > slash ? filePath.slice(0, dot) : filePath;
}
