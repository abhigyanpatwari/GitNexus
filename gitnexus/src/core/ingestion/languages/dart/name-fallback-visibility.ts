/**
 * Dart's veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * Dart's privacy is LIBRARY-scoped and marked in the identifier itself: a name
 * beginning with `_` is visible only inside its own library and cannot be
 * imported by any spelling. So a `_`-prefixed candidate in another file is an
 * impossible call, not an unlikely one.
 *
 * The exact boundary is `part` / `part of` — one library spanning several
 * files, with `_` names shared between them — and the extractor does not
 * surface `part` directives yet (the Dart query captures only `library_import`;
 * nothing in `languages/dart/` reads `part`). Without them a cross-file `_`
 * candidate is UNDECIDABLE, not impossible: refusing on "different file" would
 * delete real edges on Flutter's dominant generated-code idiom (`factory
 * Foo.fromJson(j) => _$FooFromJson(j)` calls into `foo.g.dart`, a `part` beside
 * it), and refusing on "different directory" is wrong too — a `part` URI is a
 * relative URI and legally traverses directories (`part '../shared/gen.dart';`).
 * An earlier version refused the cross-directory case as "no `part` layout can
 * make this legal"; that claim was false, so the hook now REFUSES NOTHING and
 * every cross-file `_` candidate stays a LABELED edge (0.5 /
 * `global-name-fallback`), which is the honest answer until `part` is
 * extracted. A caller that names the candidate's file in a directive is
 * recognized already, for the day the extractor surfaces `part` as an import
 * target; at that point "not the same library" becomes decidable and the
 * refusal can return.
 *
 * Public names are left to the labeled-edge path. Dart does require an import
 * for a cross-library public name, but the fallback exists partly to recover
 * edges where the import chain was not reconstructed, and refusing every
 * cross-file public call would delete real edges to buy a rule the `_` marker
 * already gives for free.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import {
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
  // A directive naming the candidate's file is positive evidence of one library.
  if (sharesLibrary(ctx.callerParsed, ctx.candidate.filePath)) return true;
  // Any other file may be a `part` of the caller's library — a sibling or, via
  // a relative `part` URI, a file in another directory. Undecidable without
  // `part` extraction (see the header), so allowed as a labeled guess, never
  // refused.
  return true;
}
