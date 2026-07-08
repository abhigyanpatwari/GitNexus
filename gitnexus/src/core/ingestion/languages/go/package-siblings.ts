import type { BindingRef, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

import { expandGoDotImports } from './expand-wildcards.js';

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
    const pkgName = inferPackageName(ctx.fileContents.get(parsed.filePath) ?? '');
    if (pkgName !== null) {
      packageByFile.set(parsed.filePath, `${packageDir(parsed.filePath)}\0${pkgName}`);
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

function inferPackageName(sourceText: string): string | null {
  const match = sourceText.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/m);
  return match?.[1] ?? null;
}

function packageDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
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
