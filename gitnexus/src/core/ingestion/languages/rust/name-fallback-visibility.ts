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
 * This hook checks import evidence, not Rust item visibility. A child module
 * can use private ancestor items, and visibility restrictions such as
 * `pub(crate)` require more context than `SymbolDefinition` carries. A matching
 * import therefore keeps a labeled guess rather than proving accessibility.
 *
 * Module paths are matched against the candidate's FILE path (extension
 * stripped, and `mod`/`lib`/`main` stem dropped, since `a/b/mod.rs` IS module
 * `a::b`). `crate::` names the root; `self::` and `super::` resolve relative
 * to the caller's module before comparison.
 */

import type { ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
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
const RUST_USE_ROOT_PREFIXES: ReadonlySet<string> = new Set(['crate', '$crate']);

// One scope lookup per immutable parsed-file snapshot, not per fallback site.
// Weak keys release both the snapshot and its index at the end of ingestion.
const scopeLookupByFile = new WeakMap<ParsedFile, ReadonlyMap<ScopeId, Scope>>();

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

/** Resolve explicit relative prefixes against the caller's module path. */
function rustUsePathOf(targetRaw: string, callerFilePath: string): string {
  const segments = targetRaw.split('::').filter((s) => s !== '');
  if (segments[0] === 'self' || segments[0] === 'super') {
    const base = rustModulePathOf(callerFilePath).split('/').filter(Boolean);
    if (segments[0] === 'self') segments.shift();
    while (segments[0] === 'super') {
      base.pop();
      segments.shift();
    }
    return [...base, ...segments].join('::');
  }
  while (segments.length > 0 && RUST_USE_ROOT_PREFIXES.has(segments[0]!)) segments.shift();
  return segments.join('::');
}

export function rustIsGlobalNameFallbackPlausible(ctx: {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly site: {
    readonly name: string;
    readonly rawQualifiedName?: string;
    readonly inScope?: ScopeId;
  };
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

  const candidateName = rustSimpleNameOf(ctx.candidate);
  // Imports are lexical evidence, not a file-wide allowlist. Legacy/synthetic
  // imports without a scope receipt retain the previous conservative behavior.
  let visibleScopes: Set<ScopeId> | undefined;
  if (ctx.site.inScope !== undefined) {
    let scopes = scopeLookupByFile.get(ctx.callerParsed);
    if (scopes === undefined) {
      scopes = new Map(ctx.callerParsed.scopes.map((scope) => [scope.id, scope]));
      scopeLookupByFile.set(ctx.callerParsed, scopes);
    }
    visibleScopes = new Set();
    let current: ScopeId | null = ctx.site.inScope;
    while (current !== null && !visibleScopes.has(current)) {
      visibleScopes.add(current);
      const scope = scopes.get(current);
      if (scope === undefined || scope.kind === 'Namespace') break;
      current = scope.parent;
    }
  }
  for (const imp of ctx.callerParsed.parsedImports) {
    if (
      imp.declaredAtScope !== undefined &&
      visibleScopes !== undefined &&
      !visibleScopes.has(imp.declaredAtScope)
    )
      continue;
    const usePath = rustUsePathOf(imp.targetRaw, ctx.callerParsed.filePath);
    // Only a glob introduces every bare item of a module. A named import must
    // match both the candidate's original name and the call's local spelling.
    if (imp.kind === 'wildcard') {
      if (modulePathReaches(usePath, candidateModule)) return true;
      continue;
    }
    if (!('localName' in imp) || imp.localName !== ctx.site.name) continue;
    // Otherwise the path names ONE item inside a module (`use crate::a::other`).
    // Its PARENT is the candidate's module only if that item IS the candidate:
    // importing `other` says nothing about a `helper` in `a`, and the bare
    // parent-path match used to accept every item of `a` on its strength.
    // An alias authorizes only the local spelling checked above.
    if (importedNameOf(imp) !== candidateName) continue;
    if (modulePathReaches(usePath, candidateModule)) return true;
    const parent = usePath.slice(0, Math.max(0, usePath.lastIndexOf('::')));
    if (parent !== '' && modulePathReaches(parent, candidateModule)) return true;
  }
  return false;
}

/** The identifier a `use` binds, as written at its source (`importedName`). */
function importedNameOf(imp: ParsedFile['parsedImports'][number]): string | undefined {
  return 'importedName' in imp ? imp.importedName : undefined;
}

/**
 * The identifier a Rust declaration contributes to its module: the FIRST
 * segment of `qualifiedName` after any module prefix — `User` for `User.new`
 * (an associated function is reached through its type, so it is the type the
 * `use` must name), the bare name for a free function.
 */
function rustSimpleNameOf(candidate: SymbolDefinition): string {
  const qualified = candidate.qualifiedName ?? '';
  const segments = qualified.split(/::|\./).filter((s) => s !== '');
  return segments[0] ?? '';
}
