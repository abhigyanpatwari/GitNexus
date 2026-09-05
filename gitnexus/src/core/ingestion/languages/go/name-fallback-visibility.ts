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
 *  3. An exported identifier still requires the caller's file to import the
 *     package. Go has no ambient namespace, so an exported name from a package
 *     this file never imported cannot be called here either.
 *
 * Rule 2 is the one that matters most in practice: `uniqueHelperXyz` defined
 * once in package `a` used to acquire a caller in package `b` purely because
 * the name was unique in the repo, and the resulting edge was published as
 * `import-resolved` — a caller Go itself would reject.
 *
 * Note this checks the CALL's legality, not the callee's identity, so it is
 * safe against the aliasing and dot-import forms: both change the local handle,
 * neither changes the imported package PATH, which is what rule 3 reads.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import {
  anyImportReaches,
  directoryOf,
} from '../../scope-resolution/utils/name-fallback-visibility.js';
import { inferGoPackageName } from './package-clause.js';

/**
 * `foo_test` → `foo`. `package-siblings.ts` refines this with the directory's
 * non-test package clauses (a package genuinely NAMED `foo_test` keeps its
 * name there); this hook sees one file at a time and cannot, so such a
 * package's internal tests are classified external here. Refuse-only tier, so
 * the cost is a missed same-package guess, never a wrong edge.
 */
function internalPackageOf(pkgName: string): string {
  return pkgName.endsWith('_test') && pkgName.length > '_test'.length
    ? pkgName.slice(0, -'_test'.length)
    : pkgName;
}

/**
 * The same three-way split `package-siblings.ts` derives for the confident
 * tier: is this a `_test.go` file, and if so does it declare the EXTERNAL test
 * package (`foo_test`)? `external` is `undefined` when the package clause is
 * not available — an unanswered question the caller must treat as "cannot
 * decide", never as "internal".
 */
function classifyGoFile(
  filePath: string,
  sourceTextOf: ((p: string) => string | undefined) | undefined,
): { isTest: boolean; external: boolean | undefined } {
  const isTest = filePath.endsWith('_test.go');
  if (!isTest) return { isTest, external: false };
  const text = sourceTextOf?.(filePath);
  if (text === undefined) return { isTest, external: undefined };
  const declared = inferGoPackageName(text);
  if (declared === null) return { isTest, external: undefined };
  return { isTest, external: declared !== internalPackageOf(declared) };
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
    // An external test package and its tested package are different packages:
    // a BARE name cannot cross that boundary in either direction. Undecidable
    // (no package clause available) → allow.
    if (caller.external === true && cand.external === false) return false;
    if (cand.external === true && caller.external === false) return false;
    return true;
  }

  // Different directory, so a different package — and a `_test.go` file's
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

  // Exported, so legal to reference — but only from a file that imports the
  // package (rule 3). A candidate in the module ROOT package has an empty
  // directory, which `modulePathReaches` cannot align against any import path
  // (the root package is imported by the module path alone, which the repo-
  // relative layout does not carry). That is an unanswered question, not a
  // refusal — treat it as plausible.
  if (candidateDir === '') return true;
  return anyImportReaches(ctx.callerParsed, candidateDir);
}
