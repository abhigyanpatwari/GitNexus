/**
 * Swift's veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * Swift's default access level is `internal`: visible throughout the MODULE and
 * nowhere else. Swift needs no per-file import inside a module, which is why
 * the global fallback is enabled for it at all — but that whole-module
 * visibility stops hard at the module boundary. A candidate in a DIFFERENT
 * module is reachable only if the caller wrote `import <ThatModule>`, and even
 * then only if the declaration is `public`.
 *
 * A module is approximated by its source directory, the layout every Swift
 * package manifest produces: `Sources/<Target>/…` and `Tests/<Target>/…`.
 * `src/<Target>/…` is also recognized by the package configuration loader.
 * Files outside these layouts have unknown module identity.
 *
 * The `private` / `fileprivate` half of the rule is NOT implemented, because
 * neither marker is recoverable from the parse model this hook sees —
 * `SymbolDefinition` carries no access level and `ParsedFile` no modifiers.
 * Those candidates keep the labeled low-confidence edge, which is the
 * "cannot decide, so do not refuse" direction the hook contract asks for.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { modulePathReaches } from '../../scope-resolution/utils/name-fallback-visibility.js';

/** Directory names that hold one subdirectory PER TARGET rather than sources. */
const SWIFT_TARGET_ROOTS: ReadonlySet<string> = new Set([
  'Sources',
  'Tests',
  'sources',
  'tests',
  'src',
]);

/**
 * The module (target) a Swift file belongs to.
 *
 * `Sources/Core/User.swift` → `Core`. Arbitrary Xcode folders are not module
 * boundaries; without a recognized target layout leave the answer unknown.
 */
function swiftModuleOf(filePath: string): string {
  const segments = filePath.split('/').filter((s) => s !== '');
  for (let i = 0; i < segments.length - 2; i++) {
    if (SWIFT_TARGET_ROOTS.has(segments[i]!)) return segments[i + 1]!;
  }
  return '';
}

export function swiftIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
}): boolean {
  if (ctx.candidate.filePath === ctx.callerParsed.filePath) return true;

  const callerModule = swiftModuleOf(ctx.callerParsed.filePath);
  const candidateModule = swiftModuleOf(ctx.candidate.filePath);
  // Same module: whole-module `internal` visibility, no import needed.
  if (callerModule === candidateModule) return true;
  // A file the layout heuristic cannot place is not something this rule can
  // speak about — allow rather than refuse on an unanswered question.
  if (callerModule === '' || candidateModule === '') return true;

  for (const imp of ctx.callerParsed.parsedImports) {
    if (modulePathReaches(imp.targetRaw, candidateModule)) return true;
  }
  return false;
}
