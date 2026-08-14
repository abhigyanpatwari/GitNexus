/**
 * Java import resolution against DECLARED packages (#2953).
 *
 * A Java import is a fully-qualified type name, not a path. `com.example.model.User`
 * names the type `User` in the package `com.example.model`, and what places a
 * file in that package is its own `package` declaration — not where it sits on
 * disk. A file at `weird/path/User.java` declaring `package com.example.model;`
 * IS `com.example.model.User`; a file at `com/example/model/User.java` declaring
 * nothing is in the DEFAULT package and cannot be imported at all.
 *
 * The previous resolver worked the other way round: it turned dots into slashes
 * and looked for a file whose path ended that way, retrying with each leading
 * segment stripped. Path shape is a convention, so that mostly worked — and
 * failed in the one case that matters most, because it could not tell an import
 * of something outside the repository from one inside it. `java.util.List`
 * became `util/List`, then `List`, and bound to any `List.java` in the tree.
 * Every JDK and third-party import in a repo was a candidate for a fabricated
 * IMPORTS edge at full confidence.
 *
 * The fix needs no new I/O. Every Java file's `package` declaration is already
 * extracted during the parse pass and available here through
 * `getJavaPackageFact` — the resolver simply never read it. So resolution
 * becomes a lookup in an index the workspace already knows how to describe:
 *
 *   `com.example.model.User`  ->  package `com.example.model` declares `User`
 *   `java.util.List`          ->  no file declares package `java.util` -> null
 *
 * `null` for the second is the complete and correct answer: the JDK is not in
 * this repository, so there is no in-repo file the import could name.
 */

import type { ParsedFile } from 'gitnexus-shared';
import type { JvmPackageFact } from '../jvm/package-facts.js';

export interface JavaPackageIndex {
  /** Declared package -> importable type name -> the file declaring it. */
  readonly typesByPackage: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Declared package -> every file declaring it, for wildcard imports. */
  readonly filesByPackage: ReadonlyMap<string, readonly string[]>;
  /**
   * Files whose `package` header could not be read (a malformed header — see
   * `extractJvmPackageFact`). They are in no package, so nothing can import
   * them; counted so the gap is observable rather than silent.
   */
  readonly unreadablePackageFiles: number;
}

const EMPTY_INDEX: JavaPackageIndex = {
  typesByPackage: new Map(),
  filesByPackage: new Map(),
  unreadablePackageFiles: 0,
};

/**
 * Index the workspace by what each file DECLARES.
 *
 * The importable type name is the file's base name, which is not a convention
 * being relied on but the rule the language enforces: a type importable from
 * another package must be `public`, and a public type must live in a file named
 * after it. Additional package-private top-level types in the same file are
 * deliberately not indexed — they are unimportable from elsewhere, so an import
 * naming one is not a resolution this should find.
 */
export function buildJavaPackageIndex(
  parsedFiles: readonly ParsedFile[],
  packageOf: (filePath: string) => JvmPackageFact | undefined,
): JavaPackageIndex {
  if (parsedFiles.length === 0) return EMPTY_INDEX;

  const typesByPackage = new Map<string, Map<string, string>>();
  const filesByPackage = new Map<string, string[]>();
  let unreadablePackageFiles = 0;

  for (const parsed of parsedFiles) {
    const filePath = parsed.filePath;
    const fact = packageOf(filePath);
    if (fact === undefined) continue;
    if (fact.status !== 'known') {
      unreadablePackageFiles++;
      continue;
    }
    // The default package (`''`) is indexed like any other so a workspace of
    // package-less files still answers its own wildcards, but Java forbids
    // importing FROM it, which `resolveJavaModule` enforces rather than
    // pretending here that the entry does not exist.
    const packageName = fact.packageName;

    const typeName = baseTypeName(filePath);
    if (typeName !== null) {
      let types = typesByPackage.get(packageName);
      if (types === undefined) {
        types = new Map();
        typesByPackage.set(packageName, types);
      }
      // First declaration wins. Two files claiming the same package+type is not
      // legal Java; picking either is as correct as the input allows.
      if (!types.has(typeName)) types.set(typeName, filePath);
    }

    const files = filesByPackage.get(packageName);
    if (files === undefined) filesByPackage.set(packageName, [filePath]);
    else files.push(filePath);
  }

  return { typesByPackage, filesByPackage, unreadablePackageFiles };
}

/**
 * Resolve one import specifier to the file(s) it names, or `null`.
 *
 * A wildcard answers with every file in the package; a type import answers with
 * one file. Anything the workspace does not declare answers `null`.
 */
export function resolveJavaModule(
  targetRaw: string,
  index: JavaPackageIndex,
): string | readonly string[] | null {
  if (targetRaw === '') return null;

  if (targetRaw.endsWith('.*')) {
    const stem = targetRaw.slice(0, -2);
    const inPackage = index.filesByPackage.get(stem);
    // Only package wildcards retain `.*`. Static wildcards are interpreted with
    // the owning type path so a same-named package cannot capture the import.
    return inPackage !== undefined && stem !== '' ? inPackage : null;
  }

  return resolveTypeName(targetRaw, index);
}

/**
 * Split a qualified name into the longest DECLARED package prefix and the type
 * that follows it.
 *
 * Longest-first is what makes both of these land correctly without a rule about
 * capitalization, which Java does not actually enforce:
 *
 *   `com.example.model.User`   -> package `com.example.model`, type `User`
 *   `com.example.Utils.method` -> package `com.example`,       type `Utils`
 *
 * The second is a static member import; its trailing segments name members
 * inside the type, and the file the import binds to is the type's.
 */
function resolveTypeName(qualified: string, index: JavaPackageIndex): string | null {
  const parts = qualified.split('.').filter((part) => part !== '');
  // A single bare segment names a type in the default package, which Java
  // forbids importing. Nothing to resolve, and nothing to guess at.
  if (parts.length < 2) return null;

  for (let split = parts.length - 1; split >= 1; split--) {
    const packageName = parts.slice(0, split).join('.');
    const types = index.typesByPackage.get(packageName);
    if (types === undefined) continue;
    const file = types.get(parts[split]);
    if (file !== undefined) return file;
  }
  return null;
}

/** `src/main/java/com/example/User.java` -> `User`. */
function baseTypeName(filePath: string): string | null {
  const slash = filePath.replace(/\\/g, '/').lastIndexOf('/');
  const base = slash === -1 ? filePath : filePath.slice(slash + 1);
  if (!base.endsWith('.java')) return null;
  const name = base.slice(0, -'.java'.length);
  return name === '' ? null : name;
}
