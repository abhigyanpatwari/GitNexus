/**
 * Rust's veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * Rust has NO ambient namespace. A bare `helper()` resolves only against names
 * in scope, and for an item declared in another module the only way in is a
 * `use` path (or a fully-qualified `crate::a::b::helper()` call, which is not a
 * bare free call and never reaches this tier — it carries a qualified name and
 * is resolved earlier by `resolveQualifiedFreeCall`).
 *
 * One rule therefore covers both halves the visibility question splits into:
 *
 *  - A non-`pub` item cannot be `use`d from outside its module at all, so the
 *    absence of a covering `use` correctly refuses it.
 *  - A `pub` item is reachable, but only from a file that actually wrote the
 *    `use`, which is the same check.
 *
 * That is why this does not need to read the `pub` marker, which
 * `SymbolDefinition` does not carry. It asks the decidable question — "did this
 * file bring the name's module into scope?" — instead of the undecidable one.
 *
 * Module paths are matched against the candidate's FILE path (extension
 * stripped, and `mod`/`lib`/`main` stem dropped, since `a/b/mod.rs` IS module
 * `a::b`). `use` targets are `::`-separated and `crate::`/`super::` prefixes
 * contribute no segments, so suffix matching lines the two up.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import {
  modulePathReaches,
  stripExtension,
} from '../../scope-resolution/utils/name-fallback-visibility.js';

/** File-stems that name their PARENT directory as the module, not themselves. */
const RUST_DIRECTORY_MODULE_STEMS: ReadonlySet<string> = new Set(['mod', 'lib', 'main']);

/** Directories that hold a crate's root and contribute no module segment, so
 *  `src/net/http.rs` is module `net::http` and not `src::net::http`. */
const RUST_CRATE_ROOT_DIRS: ReadonlySet<string> = new Set(['src', 'tests', 'benches', 'examples']);

/** Path prefixes of a `use` that name a root rather than a module segment. */
const RUST_USE_ROOT_PREFIXES: ReadonlySet<string> = new Set(['crate', 'self', 'super', '$crate']);

/**
 * The module path a Rust file provides, as a `/`-joined path.
 *
 * Two normalizations, both needed for a file path and a `use` path to line up
 * on their trailing segments: the `mod`/`lib`/`main` stem names its parent
 * directory, and a leading crate-root directory (`src/`) is not a module.
 */
function rustModulePathOf(filePath: string): string {
  const withoutExtension = stripExtension(filePath);
  const segments = withoutExtension.split('/').filter((s) => s !== '');
  const stem = segments[segments.length - 1];
  if (stem !== undefined && RUST_DIRECTORY_MODULE_STEMS.has(stem)) segments.pop();
  while (segments.length > 0 && RUST_CRATE_ROOT_DIRS.has(segments[0]!)) segments.shift();
  return segments.join('/');
}

/** A `use` target with its root prefix dropped: `crate::a::b` → `a::b`. */
function rustUsePathOf(targetRaw: string): string {
  const segments = targetRaw.split('::').filter((s) => s !== '');
  while (segments.length > 0 && RUST_USE_ROOT_PREFIXES.has(segments[0]!)) segments.shift();
  return segments.join('::');
}

export function rustIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly site: { readonly rawQualifiedName?: string };
}): boolean {
  if (ctx.candidate.filePath === ctx.callerParsed.filePath) return true;
  // A PATH-QUALIFIED call (`User::new(...)`, `crate::a::helper()`) reaches this
  // tier when the qualifier could not be followed, carrying only its tail name.
  // It is not a bare-name guess: the source named the path, so the module rule
  // below would refuse an edge the code spells out.
  if (ctx.site.rawQualifiedName !== undefined) return true;

  const candidateModule = rustModulePathOf(ctx.candidate.filePath);
  // A candidate whose file maps to no module path (a crate root reduced to '')
  // is not something this rule can speak about; allow the labeled edge rather
  // than refuse on an unanswered question.
  if (candidateModule === '') return true;

  for (const imp of ctx.callerParsed.parsedImports) {
    const usePath = rustUsePathOf(imp.targetRaw);
    if (modulePathReaches(usePath, candidateModule)) return true;
    // A `use` names an ITEM as often as a module (`use crate::user::User`), and
    // whether `targetRaw` includes that final name varies by import form. Try
    // the parent path too, or a module-only match would be missed.
    const parent = usePath.slice(0, Math.max(0, usePath.lastIndexOf('::')));
    if (parent !== '' && modulePathReaches(parent, candidateModule)) return true;
  }
  return false;
}
