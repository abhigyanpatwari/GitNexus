import type { CaptureMatch, ParsedImport, ParsedTypeBinding } from 'gitnexus-shared';

/**
 * `source()` is a side-effect import — it establishes a file dependency but
 * binds no name (cross-file free calls into a `source()`d file resolve via
 * `rScopeResolver.allowGlobalFreeCallFallback` instead).
 *
 * `library()`/`require()` are wildcard imports — every top-level name of the
 * named local package becomes visible (`rProvider.expandsWildcardTo`).
 *
 * `resolveRImportTarget` (`import-resolvers/r.ts`) guards on
 * `context.parsedImport.kind === 'wildcard'` specifically to refuse a
 * `library()`/`require()` package name that isn't a known local package
 * (rather than falling through to a cross-language suffix-match false
 * positive) — the two kinds set here are what that guard keys on.
 */
export function interpretRImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source']?.text;
  if (source === undefined || source.length === 0) return null;

  if (captures['@import.wildcard'] !== undefined) {
    return { kind: 'wildcard', targetRaw: source };
  }
  return { kind: 'side-effect', targetRaw: source };
}

/**
 * `x <- Type$new(...)` — R6's constructor spelling. `@type-binding.type` is
 * the `$` receiver (the class name), captured only when the extract
 * operator's rhs is literally `new` (see `query.ts`), so this always
 * resolves via the shared `constructor-inferred` sub-kind — the same one
 * Zig's `interpretZigTypeBinding` uses for `Counter.init()`.
 */
export function interpretRTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  return { boundName: name, rawTypeName: type, source: 'constructor-inferred' };
}
