import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

export interface KotlinResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

export function resolveKotlinImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | readonly string[] | null {
  const ctx = workspaceIndex as KotlinResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  const target = parsedImport.targetRaw.endsWith('.*')
    ? parsedImport.targetRaw.slice(0, -2)
    : parsedImport.targetRaw;
  const pathLike = target.replace(/\./g, '/');

  // Resolution tiers, most-specific first:
  //  1. The full `pathLike` matches a `.kt`/`.kts` file directly
  //     (`import util.User` → `util/User.kt`).
  //  2. Stripped (last-segment removed) `pathLike` matches a file
  //     directly (`import util.OneArg.writeAudit` → `util/OneArg.kt`,
  //     a class-or-object holding `writeAudit`).
  //  3. Stripped `pathLike` matches a *package directory* — fan out to
  //     every `.kt`/`.kts` file inside it (`import models.getRepo` →
  //     `[models/User.kt, models/Repo.kt]`). The finalize pass walks
  //     each candidate and picks the one whose `localDefs` actually
  //     export the imported name (#1759).
  //  4. Progressive prefix strip for deeper namespace aliases that
  //     don't map 1:1 to directories.
  const stripped = pathLike.split('/').slice(0, -1).join('/');
  return (
    findKotlinFile(ctx.allFilePaths, pathLike) ??
    findKotlinExactOrSuffix(ctx.allFilePaths, stripped) ??
    findKotlinPackageFiles(ctx.allFilePaths, stripped) ??
    findByProgressivePrefixStrip(ctx.allFilePaths, pathLike)
  );
}

function findKotlinFile(allFilePaths: ReadonlySet<string>, pathLike: string): string | null {
  return (
    findKotlinExactOrSuffix(allFilePaths, pathLike) ??
    findKotlinDirectoryChild(allFilePaths, pathLike)
  );
}

/** Exact (`file === pathLike+ext`) or suffix (`file ends with /pathLike+ext`)
 *  match — does NOT fall back to picking an arbitrary file inside a
 *  `pathLike/` directory. Used by the stripped-path tier in
 *  `resolveKotlinImportTarget` so a package import like `models.getRepo`
 *  delegates to `findKotlinPackageFiles` (multi-file fan-out) instead of
 *  silently committing to the first directory child. */
function findKotlinExactOrSuffix(
  allFilePaths: ReadonlySet<string>,
  pathLike: string,
): string | null {
  if (pathLike === '') return null;
  const extensions = ['.kt', '.kts'];
  const suffix = `/${pathLike}`;
  let suffixFile: string | null = null;

  for (const raw of allFilePaths) {
    const file = raw.replace(/\\/g, '/');
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    for (const ext of extensions) {
      if (file === `${pathLike}${ext}`) return raw;
      if (suffixFile === null && file.endsWith(`${suffix}${ext}`)) suffixFile = raw;
    }
  }

  return suffixFile;
}

/** First directory child of `pathLike/` — preserves the legacy single-
 *  file fallback for cases where `pathLike` itself is an unqualified
 *  package reference (rare in real Kotlin code; some fixtures rely on
 *  it). Multi-file package fan-out goes through
 *  `findKotlinPackageFiles` instead. */
function findKotlinDirectoryChild(
  allFilePaths: ReadonlySet<string>,
  pathLike: string,
): string | null {
  if (pathLike === '') return null;
  const extensions = ['.kt', '.kts'];
  const dirPrefix = `${pathLike}/`;
  const suffixDirPrefix = `/${dirPrefix}`;

  for (const raw of allFilePaths) {
    const file = raw.replace(/\\/g, '/');
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    const atRoot = file.startsWith(dirPrefix);
    const atNested = file.includes(suffixDirPrefix);
    if (!atRoot && !atNested) continue;
    const idx = atRoot ? 0 : file.indexOf(suffixDirPrefix) + 1;
    const after = file.slice(idx + dirPrefix.length);
    if (after.length > 0 && !after.includes('/')) return raw;
  }

  return null;
}

/**
 * Return every `.kt`/`.kts` file inside the package directory `dirPath`
 * (e.g. `models` → `['models/User.kt', 'models/Repo.kt']`). Used as a
 * fallback when an import like `models.getRepo` does not resolve to a
 * file named after the symbol — in Kotlin the symbol can live in any
 * file inside the package directory. The finalize pass walks each
 * candidate and picks the one whose `localDefs` actually export the
 * imported name (#1759).
 */
function findKotlinPackageFiles(
  allFilePaths: ReadonlySet<string>,
  dirPath: string,
): readonly string[] | null {
  if (dirPath === '') return null;
  const extensions = ['.kt', '.kts'];
  const dirPrefix = `${dirPath}/`;
  const suffixDirPrefix = `/${dirPrefix}`;
  const out: string[] = [];

  for (const raw of allFilePaths) {
    const file = raw.replace(/\\/g, '/');
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    const atRoot = file.startsWith(dirPrefix);
    const atNested = file.includes(suffixDirPrefix);
    if (!atRoot && !atNested) continue;
    const idx = atRoot ? 0 : file.indexOf(suffixDirPrefix) + 1;
    const after = file.slice(idx + dirPrefix.length);
    // Direct children only — `models/sub/Util.kt` is a different package
    // (`models.sub`) and must not be merged with `models`.
    if (after.length === 0 || after.includes('/')) continue;
    out.push(raw);
  }

  return out.length === 0 ? null : out;
}

function findByProgressivePrefixStrip(
  allFilePaths: ReadonlySet<string>,
  pathLike: string,
): string | null {
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const found = findKotlinFile(allFilePaths, segments.slice(skip).join('/'));
    if (found !== null) return found;
  }
  return null;
}
