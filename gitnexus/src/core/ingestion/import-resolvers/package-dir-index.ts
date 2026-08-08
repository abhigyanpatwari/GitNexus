/**
 * "Which files live DIRECTLY inside a directory whose path ends with
 * `<pkgPath>`?" — the query Go's package resolution and C#'s namespace-directory
 * fallback both answered with a full `allFilePaths` scan per import.
 *
 * Both scans had the same shape:
 *
 *   for (const raw of allFilePaths) {
 *     const f = '/' + raw.replace(/\\/g, '/');       // Go prefixes '/'; C# splits
 *     if (!accept(f)) continue;                      // '.go' / '.cs' filter
 *     const at = f.indexOf('/' + pkgPath + '/');     // FIRST occurrence
 *     if (at < 0) continue;
 *     if (f.slice(at + pkgPath.length + 2).includes('/')) continue;
 *   }
 *
 * That predicate depends only on the file's DIRECTORY, so it can be answered
 * from an index built once per file set:
 *
 *   let D = '/' + <normalized dir of the file> + '/'
 *   let P = '/' + pkgPath + '/'
 *   match ⟺ D.length >= P.length && D.indexOf(P) === D.length - P.length
 *
 * The right-hand side says two things at once, and BOTH are load-bearing:
 *  1. `D` ends with `P` — the file's directory ends with `pkgPath`;
 *  2. that trailing occurrence is the FIRST one — so `a/pkg/b/pkg/x.go` does
 *     NOT answer `pkg`, because the original `indexOf` found the earlier `/pkg/`
 *     and `b/pkg/x.go` still contained a slash. Dropping condition 2 looks like
 *     a cleanup and moves edges in every repository that nests a directory name
 *     inside itself (`internal/…/internal`, `Models/…/Models`).
 *
 * Candidates are narrowed by the directory's LAST segment rather than by
 * indexing every directory suffix: a suffix map costs O(files × depth) entries,
 * which is exactly the memory this codebase runs out of at kernel scale
 * (#2649), while the last-segment bucket is O(directories) and is a superset of
 * the matches (`D` ends with `P` ⟹ the dir's last segment is `pkgPath`'s last
 * segment).
 *
 * Results keep Set-iteration order via the recorded `ord`, because the callers'
 * scans emitted in that order and Go returns the whole list as the import
 * target (one `ImportEdge` per file).
 *
 * Each language owns its own `WeakMap` memo and `accept` predicate, so a
 * polyglot repo never pays to index another language's files.
 */

interface IndexedFile {
  readonly raw: string;
  /** Position in `allFilePaths` iteration order. */
  readonly ord: number;
}

export interface PackageDirIndex {
  /** Last path segment of a directory → every normalized directory ending in it. */
  readonly dirsByLastSegment: Map<string, string[]>;
  /** Normalized directory → the accepted files directly inside it, in Set order. */
  readonly filesByDir: Map<string, IndexedFile[]>;
  /** Accepted files with no directory at all, in Set order. */
  readonly rootFiles: string[];
}

/**
 * @param accept  Runs on the normalized (forward-slash) path; return `false` to
 *                leave the file out of the index entirely.
 */
export function buildPackageDirIndex(
  allFilePaths: ReadonlySet<string>,
  accept: (normalized: string) => boolean,
): PackageDirIndex {
  const dirsByLastSegment = new Map<string, string[]>();
  const filesByDir = new Map<string, IndexedFile[]>();
  const rootFiles: string[] = [];

  let ord = 0;
  for (const raw of allFilePaths) {
    const ownOrd = ord++;
    const normalized = raw.replace(/\\/g, '/');
    if (!accept(normalized)) continue;

    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash < 0) {
      // No directory: `'/x.go'.indexOf('/pkg/')` can never hit, so a root file
      // answers no `pkgPath` query. Kept separately for Go's root-package leg.
      rootFiles.push(raw);
      continue;
    }

    const dir = normalized.slice(0, lastSlash);
    let files = filesByDir.get(dir);
    if (files === undefined) {
      files = [];
      filesByDir.set(dir, files);
      const lastSegment = dir.slice(dir.lastIndexOf('/') + 1);
      let dirs = dirsByLastSegment.get(lastSegment);
      if (dirs === undefined) {
        dirs = [];
        dirsByLastSegment.set(lastSegment, dirs);
      }
      dirs.push(dir);
    }
    files.push({ raw, ord: ownOrd });
  }

  return { dirsByLastSegment, filesByDir, rootFiles };
}

/** Every indexed directory matching `pkgPath`, in first-seen order. */
function* matchingDirs(index: PackageDirIndex, pkgPath: string): Generator<IndexedFile[]> {
  const lastSegment = pkgPath.slice(pkgPath.lastIndexOf('/') + 1);
  const dirs = index.dirsByLastSegment.get(lastSegment);
  if (dirs === undefined) return;
  const needle = `/${pkgPath}/`;
  for (const dir of dirs) {
    const haystack = `/${dir}/`;
    // The length guard is not redundant: for a shorter `haystack`,
    // `indexOf` returns -1 and `haystack.length - needle.length` can also be
    // -1, which would report a bogus match.
    if (haystack.length < needle.length) continue;
    if (haystack.indexOf(needle) !== haystack.length - needle.length) continue;
    const files = index.filesByDir.get(dir);
    if (files !== undefined) yield files;
  }
}

/**
 * Every accepted file directly inside a directory ending with `pkgPath`, in
 * `allFilePaths` iteration order.
 */
export function filesDirectlyInPkgDir(index: PackageDirIndex, pkgPath: string): string[] {
  let merged: IndexedFile[] | null = null;
  let dirCount = 0;
  for (const files of matchingDirs(index, pkgPath)) {
    dirCount++;
    merged = dirCount === 1 ? files : [...(merged ?? []), ...files];
  }
  if (merged === null) return [];
  // One directory is already in Set order; several interleave and need merging
  // back onto the order the original single-pass scan emitted.
  if (dirCount > 1) merged = [...merged].sort((a, b) => a.ord - b.ord);
  return merged.map((f) => f.raw);
}

/**
 * The FIRST accepted file (in `allFilePaths` iteration order) directly inside a
 * directory ending with `pkgPath`, or `null`.
 */
export function firstFileDirectlyInPkgDir(index: PackageDirIndex, pkgPath: string): string | null {
  let best: IndexedFile | null = null;
  for (const files of matchingDirs(index, pkgPath)) {
    const first = files[0];
    if (first !== undefined && (best === null || first.ord < best.ord)) best = first;
  }
  return best === null ? null : best.raw;
}
