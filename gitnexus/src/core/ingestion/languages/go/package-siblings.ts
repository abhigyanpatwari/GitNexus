import type { BindingRef, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

import { expandGoDotImports } from './expand-wildcards.js';
import { goPackageDir, inferGoPackageName } from './package-clause.js';

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

interface IndexedDef {
  readonly filePath: string;
  readonly ref: BindingRef;
}

/** name → defs, in package file order. */
type NameIndex = Map<string, IndexedDef[]>;

function defBareName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}

function appendToIndex(
  index: NameIndex,
  filePath: string,
  defs: readonly SymbolDefinition[],
): void {
  for (const def of defs) {
    const name = defBareName(def);
    if (name === '') continue;
    const list = index.get(name) ?? [];
    list.push({ filePath, ref: { def, origin: 'namespace' } });
    index.set(name, list);
  }
}

function publishIndex(
  augmentations: Map<ScopeId, Map<string, BindingRef[]>>,
  index: NameIndex,
  receiverPath: string,
  receiverModule: ScopeId,
): void {
  if (index.size === 0) return;
  let scopeBindings = augmentations.get(receiverModule);
  if (scopeBindings === undefined) {
    scopeBindings = new Map<string, BindingRef[]>();
    augmentations.set(receiverModule, scopeBindings);
  }
  for (const [name, entries] of index) {
    let bucket = scopeBindings.get(name);
    const seen =
      bucket === undefined ? new Set<string>() : new Set(bucket.map((b) => b.def.nodeId));
    for (const entry of entries) {
      if (entry.filePath === receiverPath) continue;
      if (seen.has(entry.ref.def.nodeId)) continue;
      if (bucket === undefined) {
        bucket = [];
        scopeBindings.set(name, bucket);
      }
      bucket.push(entry.ref);
      seen.add(entry.ref.def.nodeId);
    }
  }
}

/**
 * Publish same-package sibling bindings, including `_test.go` files.
 *
 * Internal tests (`package foo`) see production and other internal-test names.
 * External tests (`package foo_test`) get no bare-name bindings across that
 * partition — qualified `foo.X` and `import .` stay on the import resolver.
 * Non-test files never see test-only helpers (`go build` does not compile them).
 *
 * Per-package name→def indexes are built in O(n×d). Each receiver walks only
 * the partitions it can see, so defs are not re-scanned against every sibling
 * file. Binding refs are allocated once and reused across receivers.
 */
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
  //    external test is keyed by `foo`, its `external` flag marking the
  //    partition so no bare-name bindings cross it), so one bucket holds
  //    everything the test binary compiles together, and the visibility
  //    rules below decide who sees whom.
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
    list.push({ filePath: parsed.filePath, defs: parsed.localDefs, isTest, external });
    filesByPackage.set(key, list);
  }

  // 3. Use bindingAugmentations channel per I8. Same-package files see ALL
  //    sibling names (exported and unexported). Cross-package visibility is
  //    the import resolver's job.
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;

  for (const siblings of filesByPackage.values()) {
    if (siblings.length < 2) continue;
    const production: NameIndex = new Map();
    const internalTest: NameIndex = new Map();
    const external: NameIndex = new Map();
    const receivers: { file: SiblingFile; module: ScopeId }[] = [];
    for (const file of siblings) {
      const module = indexes.moduleScopes.byFilePath.get(file.filePath);
      if (module === undefined) continue;
      receivers.push({ file, module });
      if (file.external) appendToIndex(external, file.filePath, file.defs);
      else if (file.isTest) appendToIndex(internalTest, file.filePath, file.defs);
      else appendToIndex(production, file.filePath, file.defs);
    }
    for (const { file, module } of receivers) {
      if (file.external) {
        publishIndex(augmentations, external, file.filePath, module);
        continue;
      }
      publishIndex(augmentations, production, file.filePath, module);
      if (file.isTest) publishIndex(augmentations, internalTest, file.filePath, module);
    }
  }
}
