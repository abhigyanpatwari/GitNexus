import type { BindingRef, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

import { expandGoDotImports } from './expand-wildcards.js';
import { goPackageDir, inferGoPackageName } from './package-clause.js';

/**
 * O(n²×d) where n = files per package, d = defs per file.
 * Acceptable for V1 since Go packages are typically small (< 20 files).
 * Future optimization: build a name→def inverted index per package to reduce
 * to O(n×d).
 */
/**
 * Go test files. `_test.go` files are compiled into the package's test binary:
 * an INTERNAL test (`package foo`) sees every name its non-test siblings and
 * the other `_test.go` files of the package declare; an EXTERNAL test
 * (`package foo_test`) is a separate package that imports `foo` and therefore
 * sees only its EXPORTED names. Non-test files never see test-only helpers —
 * `go build` does not compile them.
 *
 * Before this, `_test.go` files were dropped from sibling augmentation
 * entirely, so every same-package free call from a test fell through to the
 * global unique-name fallback: 4,857 labeled guesses on grafana@871af0720,
 * 25/25 sampled being test → same-directory helper — the right target reached
 * through the wrong path, at guess confidence.
 */
function isGoTestFile(filePath: string): boolean {
  return filePath.endsWith('_test.go');
}

/**
 * The package a `_test.go` file's clause belongs to, given the package names
 * the directory's NON-test files declare.
 *
 * `package foo_test` is the external-test convention ONLY when the directory's
 * real package is `foo`; the `_test` suffix is otherwise a legal identifier
 * (`package foo_test` in a directory whose non-test files also say `foo_test`).
 * Stripping it unconditionally keyed such a package's own internal tests as
 * external tests of a non-existent `foo`, so they saw no sibling at all — a
 * resolution miss on every same-package call. Strip only when the stripped
 * name is what the non-test siblings declare; with no non-test sibling to ask
 * (a test-only directory) the convention is assumed, as before.
 */
function testFilePackageOf(
  declared: string,
  nonTestPackagesInDir: ReadonlySet<string> | undefined,
): { readonly pkg: string; readonly external: boolean } {
  if (!declared.endsWith('_test') || declared.length <= '_test'.length) {
    return { pkg: declared, external: false };
  }
  const stripped = declared.slice(0, -'_test'.length);
  if (nonTestPackagesInDir !== undefined && nonTestPackagesInDir.has(declared)) {
    return { pkg: declared, external: false };
  }
  if (nonTestPackagesInDir === undefined || nonTestPackagesInDir.has(stripped)) {
    return { pkg: stripped, external: true };
  }
  // Neither name is declared by a non-test sibling: keep the clause as written.
  return { pkg: declared, external: false };
}

export function populateGoPackageSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  ctx: { readonly fileContents: ReadonlyMap<string, string> },
): void {
  // 1. Expand dot imports first so subsequent same-package sibling
  //    augmentation can also see dot-imported names. Test files dot-import too.
  expandGoDotImports(parsedFiles, indexes);

  // 2. Group files by package directory plus package name. Go package
  //    identity is directory-scoped; repeated `package main` directories
  //    must not see each other's unqualified names.
  //
  //    `_test.go` files join the INTERNAL package's bucket (a `foo_test`
  //    external test is keyed by `foo`, its `external` flag recording the
  //    exported-only rule), so one bucket holds everything the test binary
  //    compiles together, and the visibility rules below decide who sees whom.
  interface SiblingFile {
    readonly filePath: string;
    readonly defs: readonly SymbolDefinition[];
    readonly isTest: boolean;
    readonly external: boolean;
  }
  const filesByPackage = new Map<string, SiblingFile[]>();
  // Same derivation as `populateGoWorkspaceOwners` — one shared resolver, so
  // the two passes cannot disagree about a file's package (#2837). The
  // no-clause case is reported there; warning twice for one fact would be
  // noise.
  const declaredByFile = new Map<string, string>();
  const nonTestPackagesByDir = new Map<string, Set<string>>();
  for (const parsed of parsedFiles) {
    const declared = inferGoPackageName(ctx.fileContents.get(parsed.filePath) ?? '');
    if (declared === null) continue;
    declaredByFile.set(parsed.filePath, declared);
    if (isGoTestFile(parsed.filePath)) continue;
    const dir = goPackageDir(parsed.filePath);
    const names = nonTestPackagesByDir.get(dir) ?? new Set<string>();
    names.add(declared);
    nonTestPackagesByDir.set(dir, names);
  }
  for (const parsed of parsedFiles) {
    const declared = declaredByFile.get(parsed.filePath);
    if (declared === undefined) continue;
    const isTest = isGoTestFile(parsed.filePath);
    const dir = goPackageDir(parsed.filePath);
    const { pkg, external } = isTest
      ? testFilePackageOf(declared, nonTestPackagesByDir.get(dir))
      : { pkg: declared, external: false };
    const key = `${dir}\0${pkg}`;
    const list = filesByPackage.get(key) ?? [];
    list.push({ filePath: parsed.filePath, defs: [...parsed.localDefs], isTest, external });
    filesByPackage.set(key, list);
  }

  // 3. Use bindingAugmentations channel per I8
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  for (const [, siblings] of filesByPackage) {
    for (const target of siblings) {
      const targetModule = indexes.moduleScopes.byFilePath.get(target.filePath);
      if (targetModule === undefined) continue;

      for (const receiver of siblings) {
        if (receiver.filePath === target.filePath) continue; // no self-reference
        // Non-test files never see test-only declarations.
        if (target.isTest && !receiver.isTest) continue;
        // A `foo` internal test does not see a `foo_test` file's declarations
        // at all (different packages) — and an external test package sees `foo`
        // ONLY qualified (`foo.NewThing`), never as a bare name: that binding
        // comes from its explicit import of the package path, through the
        // ordinary import resolver. Publishing bare exported names here bound
        // `NewThing()` in `foo_test` to a call Go itself would reject.
        if (target.external && !receiver.external) continue;
        if (receiver.external && !target.external) continue;

        const receiverModule = indexes.moduleScopes.byFilePath.get(receiver.filePath);
        if (receiverModule === undefined) continue;

        for (const def of target.defs) {
          // Go: same-package sibling files can see ALL names (both
          // exported/uppercase and unexported/lowercase). Only cross-
          // package visibility requires uppercase first letter.
          const name = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
          if (name === '') continue;

          const bucket = getAugmentationBucket(augmentations, receiverModule, name);
          if (bucket.some((b) => b.def.nodeId === def.nodeId)) continue;
          bucket.push({ def, origin: 'namespace' });
        }
      }
    }
  }
}

function getAugmentationBucket(
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
  scopeId: ScopeId,
  name: string,
): BindingRef[] {
  let scopeBindings = augmentations.get(scopeId);
  if (scopeBindings === undefined) {
    scopeBindings = new Map<string, BindingRef[]>();
    augmentations.set(scopeId, scopeBindings);
  }
  let bucketArr = scopeBindings.get(name);
  if (bucketArr === undefined) {
    bucketArr = [];
    scopeBindings.set(name, bucketArr);
  }
  return bucketArr;
}
