/**
 * Shared COBOL `COPY` target resolution (#2967 / #2908).
 *
 * Both the census (`cobolScopeResolver.resolveImportTarget`) and the live
 * regex processor (`resolveCopy` → `cobol-copy` IMPORTS) must answer the
 * same path for the same `(name, fromFile, allFilePaths)`. Greening only
 * the census would leave analyze fabricating an IMPORTS edge onto a vendor
 * decoy the compiler would never have searched.
 *
 * Well-known copybook directory segments (`copybooks`, `COPYBOOKS`, `cpy`,
 * `copy`) plus the importer's own directory are the preferred class. When
 * the file set contains at least one of those well-known segments, a `COPY`
 * name resolves only inside that class (first in Set-iteration order).
 * `vendor/EXTERNAL.cpy` therefore misses while `copybooks/CUSTREC.cpy` hits.
 *
 * When the file set has no such directory, fail-open to today's two-tier
 * first-wins basename index — shops whose copybooks *are* the tree have
 * nothing to prefer. The importer directory is *not* enough on its own to
 * leave fail-open (`{vendor/EXTERNAL.cpy, src/PROG.cbl}` must still answer
 * `vendor/EXTERNAL.cpy`).
 *
 * The two-tier index is still memoized on the `allFilePaths` Set identity
 * (#2908). Preferred-class filtering happens at pick time from the stored
 * per-name arrays, so a pass still scans the set once.
 */
import path from 'node:path';
import { perFileSet } from '../../import-resolvers/per-file-set.js';

const COPYBOOK_EXTENSIONS = new Set(['.cpy', '.copybook']);
const COBOL_SOURCE_EXTENSIONS = new Set(['.cbl', '.cob', '.cobol']);

/** Path-component names that mark a conventional copybook directory. */
const PREFERRED_DIR_NAMES = new Set(['copybooks', 'COPYBOOKS', 'cpy', 'copy']);

interface CobolCopyIndex {
  /** `.cpy` / `.copybook` files — tier 1, Set-iteration order per stem. */
  readonly copybooks: ReadonlyMap<string, readonly string[]>;
  /** `.cbl` / `.cob` / `.cobol` files — tier 2, Set-iteration order per stem. */
  readonly sources: ReadonlyMap<string, readonly string[]>;
  /** True iff any file path has a well-known copybook directory segment. */
  readonly hasPreferredDir: boolean;
}

function pathHasPreferredDir(fp: string): boolean {
  const parts = fp.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (PREFERRED_DIR_NAMES.has(parts[i])) return true;
  }
  return false;
}

function pushUnique(map: Map<string, string[]>, key: string, fp: string): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [fp]);
    return;
  }
  list.push(fp);
}

const getCobolCopyIndex = perFileSet((allFilePaths: ReadonlySet<string>): CobolCopyIndex => {
  const copybooks = new Map<string, string[]>();
  const sources = new Map<string, string[]>();
  let hasPreferredDir = false;
  for (const fp of allFilePaths) {
    if (!hasPreferredDir && pathHasPreferredDir(fp)) hasPreferredDir = true;
    const ext = path.extname(fp).toLowerCase();
    const tier = COPYBOOK_EXTENSIONS.has(ext)
      ? copybooks
      : COBOL_SOURCE_EXTENSIONS.has(ext)
        ? sources
        : undefined;
    if (tier === undefined) continue;
    const basename = path.basename(fp, ext).toUpperCase();
    pushUnique(tier, basename, fp);
  }
  return { copybooks, sources, hasPreferredDir };
});

function pickCopyPath(
  paths: readonly string[] | undefined,
  fromFile: string,
  hasPreferredDir: boolean,
): string | null {
  if (paths === undefined || paths.length === 0) return null;
  if (!hasPreferredDir) return paths[0] ?? null;
  const fromDir = path.dirname(fromFile);
  for (const fp of paths) {
    if (pathHasPreferredDir(fp) || path.dirname(fp) === fromDir) return fp;
  }
  return null;
}

/**
 * Resolve a COBOL `COPY` member name against the workspace file set.
 *
 * `fromFile` is the importing program (census) or the program currently
 * being expanded (processor). It is used only to include the importer's
 * directory in the preferred class when a well-known copybook dir exists.
 */
export function resolveCobolCopyTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const upper = targetRaw.toUpperCase();
  const index = getCobolCopyIndex(allFilePaths);
  return (
    pickCopyPath(index.copybooks.get(upper), fromFile, index.hasPreferredDir) ??
    pickCopyPath(index.sources.get(upper), fromFile, index.hasPreferredDir) ??
    null
  );
}
