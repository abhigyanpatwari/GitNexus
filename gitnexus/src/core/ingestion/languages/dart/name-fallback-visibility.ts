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
 * make this legal"; that claim was false, so the hook refuses NO `_` candidate
 * and every cross-file `_` candidate stays a LABELED edge (0.5 /
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

import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { dartCandidateIsExportOnly } from './library-exports.js';
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

interface DartNameFallbackContext {
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
  readonly parsedFileOf?: (filePath: string) => ParsedFile | undefined;
  readonly site?: { readonly inScope?: ScopeId };
}

interface DartLocalCallables {
  /** The Function or Block scope that binds each local callable, by def id. */
  readonly owners: ReadonlyMap<string, ScopeId>;
  readonly parents: ReadonlyMap<ScopeId, ScopeId | null>;
}

/** Carried on the ParsedFile, not keyed by its identity: disk scope mode
 *  replaces every file by a `{ ...file, scopes: [] }` copy before the name
 *  fallback runs, and a spread keeps a symbol-keyed property. */
const LOCAL_CALLABLES: unique symbol = Symbol('dartLocalCallables');
type WithLocalCallables = ParsedFile & { readonly [LOCAL_CALLABLES]?: DartLocalCallables };

/** Files that never went through `recordDartLocalCallables` (direct callers of
 *  the predicate) still have their scopes; index those once per file. */
const residentLocalCallables = new WeakMap<ParsedFile, DartLocalCallables>();

function buildDartLocalCallables(parsed: ParsedFile): DartLocalCallables {
  const owners = new Map<string, ScopeId>();
  const parents = new Map<ScopeId, ScopeId | null>();
  for (const scope of parsed.scopes) {
    parents.set(scope.id, scope.parent);
    if (scope.kind !== 'Function' && scope.kind !== 'Block') continue;
    for (const bindings of scope.bindings.values()) {
      for (const binding of bindings) {
        if (binding.origin === 'local' && binding.def.type === 'Function') {
          owners.set(binding.def.nodeId, scope.id);
        }
      }
    }
  }
  return { owners, parents };
}

/**
 * Index each file's local callables while its scopes are still resident, and
 * carry the index on the file. Runs in the workspace-reference hook, before
 * scope sealing can strip `scopes` from the files the fallback later sees.
 *
 * A file that declares no local callable is left as it is: the lazy index of
 * such a file answers the same (no owner) with or without its scopes.
 */
export function recordDartLocalCallables(files: ParsedFile[]): void {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file === undefined) continue;
    const index = buildDartLocalCallables(file);
    if (index.owners.size === 0) continue;
    const withFacts: WithLocalCallables = { ...file, [LOCAL_CALLABLES]: index };
    files[i] = withFacts;
  }
}

function dartLocalCallables(parsed: ParsedFile): DartLocalCallables {
  const recorded = (parsed as WithLocalCallables)[LOCAL_CALLABLES];
  if (recorded !== undefined) return recorded;
  let index = residentLocalCallables.get(parsed);
  if (index === undefined) {
    index = buildDartLocalCallables(parsed);
    residentLocalCallables.set(parsed, index);
  }
  return index;
}

/**
 * Is the candidate a LOCAL callable — a local function, or a closure bound to a
 * local variable — that the call site cannot see?
 *
 * Such a name is bound in the body or block that declares it and is visible
 * nowhere else: not in another function of the same file, and never in another
 * file. The name-guess tier consults no scope chain, so without this a bare
 * `helper()` whose own declaration was not found (an SDK or package function,
 * an inherited member of an unindexed class) took an edge to whichever
 * function in the workspace happens to declare a local `helper`. A site inside
 * the declaring scope keeps its candidate; a site whose scope is unknown is
 * undecidable and allowed.
 */
function isOutOfScopeLocalCallable(ctx: DartNameFallbackContext): boolean {
  const { callerParsed, candidate } = ctx;
  const sameFile = candidate.filePath === callerParsed.filePath;
  const candidateParsed = sameFile ? callerParsed : ctx.parsedFileOf?.(candidate.filePath);
  if (candidateParsed === undefined) return false;
  const index = dartLocalCallables(candidateParsed);
  const owner = index.owners.get(candidate.nodeId);
  if (owner === undefined) return false;
  if (!sameFile) return true;
  const from = ctx.site?.inScope;
  if (from === undefined) return false;
  for (
    let scope: ScopeId | null | undefined = from;
    scope != null;
    scope = index.parents.get(scope)
  ) {
    if (scope === owner) return false;
  }
  return true;
}

export function dartIsGlobalNameFallbackPlausible(ctx: DartNameFallbackContext): boolean {
  if (dartCandidateIsExportOnly(ctx.callerParsed, ctx.candidate)) return false;
  if (isOutOfScopeLocalCallable(ctx)) return false;
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
