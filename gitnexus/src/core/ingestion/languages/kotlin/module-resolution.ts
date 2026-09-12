/**
 * Kotlin import resolution against declared packages and module exports (#2960).
 *
 * Kotlin source layout is conventional, not semantic: a file may declare any
 * package from any directory, and a top-level class, function or property need
 * not match the file name. Resolution therefore uses the package fact captured
 * during parsing plus the file's module-scope bindings. It never guesses from a
 * coincidental path suffix.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { JvmPackageFact } from '../jvm/package-facts.js';

export interface KotlinPackageIndex {
  /** Declared package -> top-level exported name -> files declaring that name. */
  readonly declarationsByPackage: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** Declared package -> every file declaring it, for wildcard imports. */
  readonly filesByPackage: ReadonlyMap<string, readonly string[]>;
  /** Files whose package header could not be interpreted conservatively. */
  readonly unreadablePackageFiles: number;
}

const EMPTY_INDEX: KotlinPackageIndex = {
  declarationsByPackage: new Map(),
  filesByPackage: new Map(),
  unreadablePackageFiles: 0,
};

export function buildKotlinPackageIndex(
  parsedFiles: readonly ParsedFile[],
  packageOf: (filePath: string) => JvmPackageFact | undefined,
): KotlinPackageIndex {
  if (parsedFiles.length === 0) return EMPTY_INDEX;

  const declarationsByPackage = new Map<string, Map<string, string[]>>();
  const filesByPackage = new Map<string, string[]>();
  let unreadablePackageFiles = 0;

  for (const parsed of parsedFiles) {
    const fact = packageOf(parsed.filePath);
    if (fact === undefined) continue;
    if (fact.status !== 'known') {
      unreadablePackageFiles++;
      continue;
    }

    const packageName = fact.packageName;
    const packageFiles = filesByPackage.get(packageName);
    if (packageFiles === undefined) filesByPackage.set(packageName, [parsed.filePath]);
    else packageFiles.push(parsed.filePath);

    const moduleScope =
      parsed.scopes.find((scope) => scope.id === parsed.moduleScope && scope.kind === 'Module') ??
      parsed.scopes.find((scope) => scope.kind === 'Module');
    if (moduleScope === undefined) continue;

    let declarations = declarationsByPackage.get(packageName);
    if (declarations === undefined) {
      declarations = new Map();
      declarationsByPackage.set(packageName, declarations);
    }

    for (const [name, refs] of moduleScope.bindings) {
      if (
        name === '' ||
        !refs.some((ref) => ref.origin === 'local' && ref.def.filePath === parsed.filePath)
      ) {
        continue;
      }
      const files = declarations.get(name);
      if (files === undefined) declarations.set(name, [parsed.filePath]);
      else if (!files.includes(parsed.filePath)) files.push(parsed.filePath);
    }
  }

  return { declarationsByPackage, filesByPackage, unreadablePackageFiles };
}

/** Resolve a Kotlin import to the file(s) its declarations name. */
export function resolveKotlinModule(
  targetRaw: string,
  index: KotlinPackageIndex,
): string | readonly string[] | null {
  if (targetRaw === '') return null;

  if (targetRaw.endsWith('.*')) {
    const stem = targetRaw.slice(0, -2);
    if (stem === '') return null;

    const packageFiles = index.filesByPackage.get(stem);
    if (packageFiles !== undefined) return packageFiles;

    // Kotlin also permits star imports from a class or object. Resolve the
    // owning top-level declaration, while keeping an undeclared package null.
    return resolveTopLevelDeclaration(stem, index);
  }

  return resolveTopLevelDeclaration(targetRaw, index);
}

function resolveTopLevelDeclaration(
  qualifiedName: string,
  index: KotlinPackageIndex,
): string | readonly string[] | null {
  const parts = qualifiedName.split('.').filter((part) => part !== '');
  if (parts.length === 0) return null;

  // A bare name can refer to the special root package. It is still backed by
  // package and binding evidence; no path fallback is involved.
  if (parts.length === 1) {
    const name = parts[0];
    return name === undefined
      ? null
      : declarationFiles(index.declarationsByPackage.get('')?.get(name));
  }

  for (let split = parts.length - 1; split >= 1; split--) {
    const packageName = parts.slice(0, split).join('.');
    const declarations = index.declarationsByPackage.get(packageName);
    if (declarations === undefined) continue;

    const declarationName = parts[split];
    if (declarationName === undefined) continue;
    const files = declarations.get(declarationName);
    if (files === undefined) continue;
    return declarationFiles(files);
  }
  return null;
}

function declarationFiles(files: readonly string[] | undefined): string | readonly string[] | null {
  if (files === undefined || files.length === 0) return null;
  // Kotlin permits overloaded top-level callables across files. Preserve the
  // complete candidate set instead of choosing one by parse order.
  return files.length === 1 ? (files[0] ?? null) : files;
}
