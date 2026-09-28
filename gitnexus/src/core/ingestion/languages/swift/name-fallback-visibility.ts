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
 * Module identity is `swiftModuleKeysOf`, the membership every same-module
 * pass uses: SwiftPM targets (any default or custom path, including test
 * targets) and Xcode targets. A file in `__default__` has unknown identity.
 * `@testable import X` and Swift 5.9 `package` access both still require the
 * import, so the rule below covers them; access levels are not modeled.
 * Without workspace modules (hand-built configs), the module is approximated
 * by its `Sources/<Target>/…` or `src/<Target>/…` directory.
 *
 * The `private` / `fileprivate` half of the rule is NOT implemented, because
 * neither marker is recoverable from the parse model this hook sees —
 * `SymbolDefinition` carries no access level and `ParsedFile` no modifiers.
 * Those candidates keep the labeled low-confidence edge, which is the
 * "cannot decide, so do not refuse" direction the hook contract asks for.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { modulePathReaches } from '../../scope-resolution/utils/name-fallback-visibility.js';
import {
  DEFAULT_SWIFT_MODULE,
  swiftModuleKeysOf,
  swiftModuleSpecOf,
  swiftModuleSpecs,
} from './target-grouping.js';

/** Path-heuristic layouts, used only when the config carries no modules. */
const SWIFT_TARGET_ROOTS: ReadonlySet<string> = new Set(['Sources', 'src']);

/**
 * The module (target) a Swift file belongs to.
 *
 * `Sources/Core/User.swift` → `Core`. Arbitrary Xcode folders are not module
 * boundaries; without a recognized target layout leave the answer unknown.
 */
function swiftModuleOf(filePath: string): string {
  const segments = filePath.split('/').filter((s) => s !== '');
  for (let i = 0; i < segments.length - 2; i++) {
    if (SWIFT_TARGET_ROOTS.has(segments[i]!)) {
      // Keep the path through the target so `Sources/Core` and
      // `Package/Sources/Core` stay distinct modules. `import Core` still
      // reaches either via trailing-segment containment.
      return segments.slice(0, i + 2).join('/');
    }
  }
  return '';
}

export function swiftIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly resolutionConfig?: unknown;
}): boolean {
  if (ctx.candidate.filePath === ctx.callerParsed.filePath) return true;
  if (swiftModuleSpecs(ctx.resolutionConfig) !== null) {
    return moduleMembershipAllows(ctx.callerParsed, ctx.candidate, ctx.resolutionConfig);
  }

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

function moduleMembershipAllows(
  callerParsed: ParsedFile,
  candidate: SymbolDefinition,
  resolutionConfig: unknown,
): boolean {
  const callerKeys = swiftModuleKeysOf(callerParsed.filePath, resolutionConfig);
  const candidateKeys = swiftModuleKeysOf(candidate.filePath, resolutionConfig);
  // Same module: whole-module `internal` visibility, no import needed.
  if (candidateKeys.some((key) => callerKeys.includes(key))) return true;
  // Unknown identity on either side: cannot decide, so allow.
  if (callerKeys[0] === DEFAULT_SWIFT_MODULE || candidateKeys[0] === DEFAULT_SWIFT_MODULE) {
    return true;
  }
  const candidateNames = new Set<string>();
  for (const key of candidateKeys) {
    const spec = swiftModuleSpecOf(key, resolutionConfig);
    if (spec?.importable === true) candidateNames.add(spec.name);
  }
  for (const imp of callerParsed.parsedImports) {
    const moduleName = imp.targetRaw?.split('.')[0];
    if (moduleName !== undefined && candidateNames.has(moduleName)) return true;
  }
  return false;
}
