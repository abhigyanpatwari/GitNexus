/**
 * Go's veto on the global-name fallback — see
 * `ScopeResolver.isGlobalNameFallbackPlausible`.
 *
 * Go's visibility rules are unusually decidable from a file path and an
 * identifier, which is why this is the language the guard is most complete for:
 *
 *  1. A package IS a directory. Two files in the same directory see each
 *     other's identifiers with no import and no qualification, so a same-
 *     directory candidate is always plausible.
 *  2. An identifier is exported iff it begins with an upper-case letter. An
 *     UNEXPORTED identifier is invisible outside its own package — no import
 *     makes it reachable, so a cross-directory candidate with a lower-case
 *     initial is not unlikely, it is IMPOSSIBLE.
 *  3. A bare exported identifier from another package requires a DOT import.
 *     Ordinary, alias, and blank imports never introduce a bare callable.
 *
 * Rule 2 is the one that matters most in practice: `uniqueHelperXyz` defined
 * once in package `a` used to acquire a caller in package `b` purely because
 * the name was unique in the repo, and the resulting edge was published as
 * `import-resolved` — a caller Go itself would reject.
 *
 * Methods require a receiver and never qualify for this bare-name tier.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import {
  modulePathReaches,
  directoryOf,
} from '../../scope-resolution/utils/name-fallback-visibility.js';
import { inferGoPackageName } from './package-clause.js';

/**
 * Compare actual package clauses, not a guessed `_test` suffix convention:
 * `foo_test` can itself be a production package name. Missing source remains
 * undecidable, while the test-file boundary is always available from the path.
 */
function classifyGoFile(
  filePath: string,
  sourceTextOf: ((p: string) => string | undefined) | undefined,
): { isTest: boolean; declared: string | undefined } {
  const isTest = filePath.endsWith('_test.go');
  const text = sourceTextOf?.(filePath);
  return {
    isTest,
    declared: text === undefined ? undefined : (inferGoPackageName(text) ?? undefined),
  };
}

/** Go export rule: an upper-case initial, by Unicode letter case. */
function isExportedGoName(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

/**
 * The simple identifier a Go declaration contributes to its package scope: the
 * last segment of `qualifiedName`, which is `Type.method` for a method and the
 * bare identifier for a function. Either way the LAST segment is the identifier
 * whose case decides export.
 */
function goSimpleName(candidate: SymbolDefinition): string {
  const qualified = candidate.qualifiedName ?? '';
  const dot = qualified.lastIndexOf('.');
  return dot === -1 ? qualified : qualified.slice(dot + 1);
}

export function goIsGlobalNameFallbackPlausible(ctx: {
  readonly sourceTextOf?: (filePath: string) => string | undefined;
  readonly callerParsed: ParsedFile;
  readonly candidate: SymbolDefinition;
}): boolean {
  // Methods require a receiver, even within their own package or a dot import.
  if (ctx.candidate.type === 'Method' || ctx.candidate.qualifiedName?.includes('.')) return false;
  const callerDir = directoryOf(ctx.callerParsed.filePath);
  const candidateDir = directoryOf(ctx.candidate.filePath);
  // Same directory is NOT the same package (rule 1, refined): a `_test.go`
  // file may declare `foo_test`, and test-only declarations are invisible to
  // non-test files. Apply the split `package-siblings.ts` uses for the
  // confident tier, so the heuristic tier cannot reopen what it closed.
  if (callerDir === candidateDir) {
    const caller = classifyGoFile(ctx.callerParsed.filePath, ctx.sourceTextOf);
    const cand = classifyGoFile(ctx.candidate.filePath, ctx.sourceTextOf);
    // Non-test files never see test-only declarations.
    if (cand.isTest && !caller.isTest) return false;
    // Different clauses require an explicit dot import, even in one directory.
    // Fall through to the exported/import checks for external test packages.
    // Missing source leaves package identity undecidable.
    if (
      caller.declared === undefined ||
      cand.declared === undefined ||
      caller.declared === cand.declared
    )
      return true;
  }

  // Different package — and a `_test.go` file's
  // declarations are compiled only into ITS OWN package's test binary. No other
  // package, test or not, can see them, exported or not. Decidable from the
  // path alone, so it comes before every exception below (the module-root
  // exception in particular used to accept a root `helper_test.go` export).
  if (classifyGoFile(ctx.candidate.filePath, ctx.sourceTextOf).isTest) return false;

  const simpleName = goSimpleName(ctx.candidate);
  // No identifier to read the case of — an unanswered question, not a refusal.
  if (simpleName === '') return true;
  // Unexported across a package boundary (rule 2): no import can reach it.
  if (!isExportedGoName(simpleName)) return false;

  // Only a dot import introduces a bare name. A candidate in the module ROOT package has an empty
  // directory, which `modulePathReaches` cannot align against any import path
  // (the root package is imported by the module path alone, which the repo-
  // relative layout does not carry). That is an unanswered question, not a
  // refusal — a dot import is plausible even if its path cannot be aligned.
  return ctx.callerParsed.parsedImports.some(
    (imp) =>
      imp.kind === 'wildcard' &&
      (candidateDir === '' || modulePathReaches(imp.targetRaw, candidateDir)),
  );
}
