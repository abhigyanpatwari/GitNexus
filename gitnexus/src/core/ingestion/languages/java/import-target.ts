/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → the file(s) an import names.
 *
 * Delegates to `module-resolution.ts`, which resolves a Java import the way
 * Java defines it: a fully-qualified type name looked up against the packages
 * the workspace's files DECLARE.
 *
 * ## What #2953 replaced, and why path shape could not work
 *
 * This resolver used to turn dots into slashes and hunt for a file whose path
 * ended that way — exact whole path, then any segment-suffix, then the first
 * `.java` directly inside a matching directory — retrying the whole cascade
 * with each leading segment stripped. Four legs, all describing where a file
 * SITS rather than what it DECLARES.
 *
 * Path shape is a convention, so it mostly worked, and failed hardest on the
 * case that matters: it had no way to tell an import of something outside the
 * repository from one inside it. `java.util.List` became `util/List`, then
 * `List`, and bound to any `List.java` anywhere in the tree — a fabricated
 * IMPORTS edge at full confidence, for an import naming a JDK class. Every JDK
 * and third-party import in a repository was a candidate.
 *
 * Two secondary defects went with it, both consequences of resolving by shape:
 *
 *  - a wildcard `import com.example.*;` answered with ONE arbitrary file — the
 *    first `.java` in the package directory in `allFilePaths` iteration order,
 *    which the previous header documented at length as being decided by "a
 *    property of the file list, not of the import". It now answers with every
 *    file declaring that package, which is what the import actually names.
 *  - a file's location and its package were assumed to agree. They need not:
 *    `weird/path/User.java` declaring `package com.example;` is importable as
 *    `com.example.User`, and `com/example/User.java` declaring nothing is in
 *    the default package and importable as nothing at all. Both now resolve
 *    correctly, because the declaration is what is read.
 *
 * The package declaration was already being extracted during the parse pass and
 * has been reachable here through `getJavaPackageFact` the whole time; nothing
 * read it. So this costs no new I/O — no `pom.xml`, no `build.gradle`, no
 * source-root inference. The workspace describes itself.
 */

import type { ParsedFile, ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { getJavaPackageFact } from './package-facts.js';
import {
  buildJavaPackageIndex,
  resolveJavaModule,
  type JavaPackageIndex,
} from './module-resolution.js';

export interface JavaResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
  /**
   * The pass's parsed Java files — the only input this resolver needs, because
   * the package index is built from their declarations.
   *
   * Absent means "no workspace was supplied", not "the workspace declares
   * nothing": the index would be empty and every import would answer `null`.
   * The orchestrator always supplies it (`scope-resolution/pipeline/run.ts`
   * threads `context.parsedFiles`), and it must be passed THROUGH rather than
   * copied — the memo below keys on the array's identity.
   */
  readonly parsedFiles?: readonly ParsedFile[];
}

/**
 * The package index, built once per pass and read by every import.
 *
 * Keyed on the `parsedFiles` array the orchestrator already threads through the
 * pass, like PHP's `filesByDirectory` and Python's `parsedFileByPath`. The
 * instrument that can see this memo fail counts element reads on that array —
 * `countedParsedFiles` in `test/helpers/counting-file-set.ts`, asserted for
 * every language by `import-target-index-reuse.contract.test.ts`.
 */
const getJavaPackageIndex = perFileSet(
  (parsedFiles: readonly ParsedFile[]): JavaPackageIndex =>
    buildJavaPackageIndex(parsedFiles, getJavaPackageFact),
);

export function resolveJavaImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | readonly string[] | null {
  const ctx = narrowContext(workspaceIndex);
  if (ctx === null) return null;
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  const parsedFiles = ctx.parsedFiles;
  if (parsedFiles === undefined || parsedFiles.length === 0) return null;

  return resolveJavaModule(parsedImport.targetRaw, getJavaPackageIndex(parsedFiles));
}

/**
 * `WorkspaceIndex` is an opaque `unknown` placeholder in the shared contract;
 * the orchestrator hands us a `JavaResolveContext`-shaped object. Narrow
 * structurally rather than via a cast chain so unexpected shapes fail cleanly.
 */
function narrowContext(workspaceIndex: WorkspaceIndex): JavaResolveContext | null {
  const ctx = workspaceIndex as JavaResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  return ctx;
}
