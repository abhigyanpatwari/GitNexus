/**
 * "Which files live DIRECTLY inside a directory whose path ends with
 * `<pkgPath>`?" — the query Go's package resolution and C#'s namespace-directory
 * fallback both answered with a full `allFilePaths` scan per import.
 *
 * Both scans ran the same predicate: normalize to forward slashes, apply the
 * language's extension filter, find the FIRST `'/' + pkgPath + '/'` occurrence,
 * and keep the file only if nothing after that occurrence contains a slash.
 *
 * That predicate depends only on the file's DIRECTORY, so it can be answered
 * from an index built once per file set:
 *
 *   let D = '/' + <normalized dir of the file> + '/'
 *   let P = '/' + pkgPath + '/'
 *   match ⟺ D.endsWith(P)
 *
 * It used to say one more thing, and #2881 removed it:
 *
 *   match ⟺ D.length >= P.length && D.indexOf(P) === D.length - P.length
 *
 * — i.e. `D` ends with `P` AND that trailing occurrence is the FIRST one, so
 * `a/pkg/b/pkg/x.go` did NOT answer `pkg`. The second half was never a rule
 * anyone chose. It is what the pre-index per-import scan happened to compute
 * (it called `indexOf`, then checked that nothing after the match contained a
 * slash), and the index was built to reproduce that scan byte for byte. It
 * dropped exactly the repositories that nest a directory name inside itself:
 * `internal/…/internal`, `Models/…/Models`, and the reported shape
 * `data/src/main/kotlin/com/example/data/Repo.kt`, where `import data.helper`
 * resolved to null. Kotlin was fixed first, in its own `dirChildren`
 * (`languages/kotlin/import-target.ts`); this index, the C# csproj index and
 * the legacy `go.ts` scan followed.
 *
 * The strongest evidence that the rule was accidental is that a sixth
 * implementation of the same question never had it. `import-resolvers/jvm.ts`
 * answers "files directly inside a directory ending with <packagePath>" for
 * Java and Kotlin wildcard imports, and has used `lastIndexOf` since #488 — it
 * is live, wired as `importResolver` by `languages/{java,kotlin}.ts`. So before
 * #2881 the Java and Kotlin LanguageProvider hook and their ScopeResolver hook
 * disagreed about which files a package holds. Now all six agree.
 *
 * The length guard the `indexOf` form needed is gone with it: `endsWith` is
 * false for a shorter `D` instead of comparing -1 to -1.
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
 * Each language owns its own `WeakMap` memo and `accept` predicate, so the
 * STORED index holds only that language's files — the build pass itself still
 * walks every path it is handed once per language. That is not a polyglot tax
 * in practice: `scope-resolution/pipeline/run.ts:673` rebuilds `allFilePaths`
 * from the provider's own `parsedFiles`, so the set already contains only that
 * language's files.
 */

interface IndexedFile {
  readonly raw: string;
  /**
   * Position in `allFilePaths` iteration order. Still load-bearing:
   * `filesDirectlyInPkgDir` sorts on it to interleave several directories back
   * into the order the original single-pass scan emitted.
   */
  readonly ord: number;
}

/**
 * Deeply read-only on purpose. The memo hoist turned what used to be per-call
 * scratch into state shared by every import in a run, and `readonly` on the
 * PROPERTY still lets a caller do `idx.rootFiles.sort()` in place. Typing the
 * containers as read-only makes the copy-before-mutating rule compile-enforced
 * instead of comment-enforced — but `readonly` is erased at runtime and is not
 * hard to widen back (the sibling Kotlin index documents `Array.isArray`'s
 * `arg is any[]` predicate doing exactly that), so the one container callers
 * read directly is handed out through `sortedRootFiles` rather than raw.
 */
export interface PackageDirIndex {
  /** Last path segment of a directory → every normalized directory ending in it. */
  readonly dirsByLastSegment: ReadonlyMap<string, readonly string[]>;
  /** Normalized directory → the accepted files directly inside it, in Set order. */
  readonly filesByDir: ReadonlyMap<string, readonly IndexedFile[]>;
  /** Accepted files with no directory at all, in Set order. */
  readonly rootFiles: readonly string[];
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
function* matchingDirs(index: PackageDirIndex, pkgPath: string): Generator<readonly IndexedFile[]> {
  const lastSegment = pkgPath.slice(pkgPath.lastIndexOf('/') + 1);
  const dirs = index.dirsByLastSegment.get(lastSegment);
  if (dirs === undefined) return;
  const needle = `/${pkgPath}/`;
  for (const dir of dirs) {
    const haystack = `/${dir}/`;
    // `endsWith` subsumes the length guard the `indexOf` form needed: a shorter
    // haystack is simply false, where `indexOf` returned -1 and
    // `haystack.length - needle.length` could also be -1 and report a bogus
    // match.
    if (!haystack.endsWith(needle)) continue;
    const files = index.filesByDir.get(dir);
    if (files !== undefined) yield files;
  }
}

/**
 * Every accepted file directly inside a directory ending with `pkgPath`, in
 * `allFilePaths` iteration order.
 */
export function filesDirectlyInPkgDir(index: PackageDirIndex, pkgPath: string): string[] {
  // The first bucket is held by reference, not copied into an accumulator: one
  // matching directory is the overwhelmingly common case (every unique-leaf
  // call, and any query whose package path has more than one segment), and it
  // then reaches the `map` with zero intermediate copies.
  //
  // A second directory promotes that reference to a real accumulator, which is
  // appended to once per file from then on — never re-spread per directory,
  // because that costs O(files × dirs²) copies, which a monorepo carrying the
  // same package directory under many services (`svcN/internal/models`, queried
  // by Go's two-segment GOPATH tail) would pay on every import.
  let first: readonly IndexedFile[] | null = null;
  let merged: IndexedFile[] | null = null;
  for (const files of matchingDirs(index, pkgPath)) {
    if (first === null) {
      first = files;
      continue;
    }
    if (merged === null) merged = [...first];
    for (const f of files) merged.push(f);
  }
  if (first === null) return [];
  // One directory is already in Set order; several interleave and need merging
  // back onto the order the original single-pass scan emitted.
  if (merged === null) return first.map((f) => f.raw);
  merged.sort((a, b) => a.ord - b.ord);
  return merged.map((f) => f.raw);
}

/** Root-package files in sorted order. Copies: the index array is shared by
 *  every import in the run and the result leaves as an edge target list. */
export function sortedRootFiles(index: PackageDirIndex): string[] {
  return [...index.rootFiles].sort();
}

/**
 * The FIRST accepted file (in `allFilePaths` iteration order) directly inside a
 * directory ending with `pkgPath`, or `null`.
 */
export function firstFileDirectlyInPkgDir(index: PackageDirIndex, pkgPath: string): string | null {
  // Returning the FIRST match is already the minimum-`ord` answer, and it is
  // the build loop that makes it so: `buildPackageDirIndex` appends a directory
  // to its last-segment bucket at the moment it accepts that directory's first
  // file, so bucket order IS ascending first-file-`ord` order. Comparing `ord`
  // across the remaining directories can never improve on the first hit
  // (differentially verified: 0 divergences). Change that append point — buffer
  // the directories, sort them, populate `filesByDir` before `dirsByLastSegment`
  // — and this early return silently starts answering with the wrong file.
  for (const files of matchingDirs(index, pkgPath)) {
    const first = files[0];
    if (first !== undefined) return first.raw;
  }
  return null;
}
