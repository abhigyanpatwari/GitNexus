import type { CaptureMatch, ParsedImport, ParsedTypeBinding } from 'gitnexus-shared';

/**
 * `source()` is a side-effect import — it establishes a file dependency but
 * binds no name (cross-file free calls into a `source()`d file resolve via
 * `rScopeResolver.allowGlobalFreeCallFallback` instead).
 *
 * `library()`/`require()` are wildcard imports — the exported names of the named
 * local package (every top-level name when it has no NAMESPACE) become visible
 * (`rScopeResolver.expandsWildcardTo`).
 *
 * `resolveRImportTarget` (`languages/r/import-target.ts`) guards on
 * `context.parsedImport.kind === 'wildcard'` specifically to refuse a
 * `library()`/`require()` package name that isn't a known local package
 * (rather than falling through to a cross-language suffix-match false
 * positive) — the two kinds set here are what that guard keys on.
 */
export function interpretRImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source']?.text;
  // The capture keeps its quotes, so `source("")` is two characters long: test the bare text.
  if (source === undefined || source.replace(/^["']|["']$/g, '').length === 0) return null;

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

  // `self` in an R6 method, typed as its class by `emitRScopeCaptures` (the shared `self` source,
  // as Ruby's interpreter reads it).
  if (captures['@type-binding.self'] !== undefined) {
    return { boundName: name, rawTypeName: type, source: 'self' };
  }
  return { boundName: name, rawTypeName: type, source: 'constructor-inferred' };
}
