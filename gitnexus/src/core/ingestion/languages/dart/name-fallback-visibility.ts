/**
 * Dart's veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * Dart's privacy is LIBRARY-scoped and marked in the identifier itself: a name
 * beginning with `_` is visible only inside its own library and cannot be
 * imported by any spelling. So a `_`-prefixed candidate in another file is an
 * impossible call, not an unlikely one.
 *
 * "Library" is approximated by "the same DIRECTORY". The exact boundary is
 * `part` / `part of` — one library spanning several files, with `_` names
 * shared between them — and the extractor does not surface `part` directives
 * yet (nothing in `languages/dart/` reads them). Refusing on "same file" would
 * therefore delete real edges on Flutter's dominant generated-code idiom:
 * `factory Foo.fromJson(j) => _$FooFromJson(j)` calls into `foo.g.dart`, a
 * `part` of the same library that sits beside it. Parts are, in practice,
 * always siblings of their library file, so a same-directory `_` candidate is
 * treated as plausible (and stays a LABELED edge); only a `_` candidate in
 * another directory is refused, which no `part` layout can make legal. A caller
 * that names the candidate's file in a directive is also accepted, for the day
 * the extractor surfaces `part` as an import target.
 *
 * Public names are left to the labeled-edge path. Dart does require an import
 * for a cross-library public name, but the fallback exists partly to recover
 * edges where the import chain was not reconstructed, and refusing every
 * cross-file public call would delete real edges to buy a rule the `_` marker
 * already gives for free.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import {
  directoryOf,
  modulePathReaches,
  stripExtension,
} from '../../scope-resolution/utils/name-fallback-visibility.js';

/** Dart privacy marker: a leading underscore on the declared identifier. Read
 *  from the last `qualifiedName` segment, so `_Foo.bar` is public `bar` on a
 *  private class and `Foo._bar` is the private member. */
function isPrivateDartName(candidate: SymbolDefinition): boolean {
  const qualified = candidate.qualifiedName ?? '';
  const dot = qualified.lastIndexOf('.');
  const simple = dot === -1 ? qualified : qualified.slice(dot + 1);
  return simple.startsWith('_');
}

/**
 * Are these two files parts of one library? True when the caller names the
 * candidate's file in a `part` / `part of` directive, which the extractor
 * surfaces as an ordinary import target.
 */
function sharesLibrary(callerParsed: ParsedFile, candidateFilePath: string): boolean {
  const candidateModule = stripExtension(candidateFilePath);
  for (const imp of callerParsed.parsedImports) {
    if (modulePathReaches(stripExtension(imp.targetRaw), candidateModule)) return true;
  }
  return false;
}

export function dartIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
}): boolean {
  if (ctx.candidate.filePath === ctx.callerParsed.filePath) return true;
  if (!isPrivateDartName(ctx.candidate)) return true;
  // Sibling files may be `part`s of one library (see the header) — undecidable
  // without `part` extraction, so allowed rather than refused.
  if (directoryOf(ctx.candidate.filePath) === directoryOf(ctx.callerParsed.filePath)) return true;
  return sharesLibrary(ctx.callerParsed, ctx.candidate.filePath);
}
