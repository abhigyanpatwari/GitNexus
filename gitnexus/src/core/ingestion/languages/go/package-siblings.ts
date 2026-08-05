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
export function populateGoPackageSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  ctx: { readonly fileContents: ReadonlyMap<string, string> },
): void {
  // 0. Filter out test files — Go _test.go files should not contribute
  //    same-package sibling bindings to non-test files.
  const nonTestFiles = parsedFiles.filter((f) => !f.filePath.endsWith('_test.go'));

  // 1. Expand dot imports first so subsequent same-package sibling
  //    augmentation can also see dot-imported names.
  expandGoDotImports(nonTestFiles, indexes);

  // 2. Group files by package directory plus package name. Go package
  //    identity is directory-scoped; repeated `package main` directories
  //    must not see each other's unqualified names.
  const packageByFile = new Map<string, string>();
  for (const parsed of nonTestFiles) {
    // Same derivation as `populateGoWorkspaceOwners` — one shared resolver, so
    // the two passes cannot disagree about a file's package (#2837). The
    // no-clause case is reported there; warning twice for one fact would be
    // noise.
    const pkgName = inferGoPackageName(ctx.fileContents.get(parsed.filePath) ?? '');
    if (pkgName !== null) {
      packageByFile.set(parsed.filePath, `${goPackageDir(parsed.filePath)}\0${pkgName}`);
    }
  }

  const filesByPackage = new Map<string, { filePath: string; defs: SymbolDefinition[] }[]>();
  for (const parsed of nonTestFiles) {
    const pkgName = packageByFile.get(parsed.filePath);
    if (pkgName === undefined) continue;
    const list = filesByPackage.get(pkgName) ?? [];
    list.push({ filePath: parsed.filePath, defs: [...parsed.localDefs] });
    filesByPackage.set(pkgName, list);
  }

  // 2. Use bindingAugmentations channel per I8
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  for (const [, siblings] of filesByPackage) {
    for (const target of siblings) {
      const targetModule = indexes.moduleScopes.byFilePath.get(target.filePath);
      if (targetModule === undefined) continue;

      for (const receiver of siblings) {
        if (receiver.filePath === target.filePath) continue; // no self-reference
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
