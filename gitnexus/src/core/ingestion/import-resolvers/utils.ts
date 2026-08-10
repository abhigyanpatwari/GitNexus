/**
 * Suffix-index helpers for import path resolution.
 */

/** All file extensions to try during resolution */
export const EXTENSIONS = [
  '',
  // TypeScript/JavaScript
  '.tsx',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.js',
  '.mjs',
  '.cjs',
  '.vue',
  '/index.tsx',
  '/index.ts',
  '/index.jsx',
  '/index.js',
  // Python
  '.py',
  '/__init__.py',
  // Java
  '.java',
  // Kotlin
  '.kt',
  '.kts',
  // C/C++
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.cxx',
  '.hxx',
  '.hh',
  '.cu',
  '.cuh',
  // C#
  '.cs',
  // Go
  '.go',
  // Rust
  '.rs',
  '/mod.rs',
  // PHP
  '.php',
  '.phtml',
  // Swift
  '.swift',
  // Ruby
  '.rb',
];

/**
 * Try to match a path (with extensions) against the known file set.
 * Returns the matched file path or null.
 */
export function tryResolveWithExtensions(
  basePath: string,
  allFiles: ReadonlySet<string>,
): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Build a suffix index for O(1) endsWith lookups.
 * Maps every possible path suffix to its original file path.
 * e.g. for "src/com/example/Foo.java":
 *   "Foo.java" -> "src/com/example/Foo.java"
 *   "example/Foo.java" -> "src/com/example/Foo.java"
 *   "com/example/Foo.java" -> "src/com/example/Foo.java"
 *   etc.
 */
export interface SuffixIndex {
  /**
   * Exact suffix lookup (case-sensitive).
   *
   * The map behind this is built on the FIRST call and memoized — see
   * `buildSuffixIndex`. All three maps are deferred; a consumer pays only for
   * the questions it actually asks.
   */
  get(suffix: string): string | undefined;
  /**
   * Case-insensitive suffix lookup.
   *
   * Deferred like `get`, and — when `get` was asked first — DERIVED from that
   * map rather than traversed for a second time. See `buildSuffixIndex`.
   */
  getInsensitive(suffix: string): string | undefined;
  /**
   * Get all files in a directory suffix.
   *
   * `readonly` is the CONTRACT, and it is the contract for every implementation
   * of this interface, not a description of any one of them: an implementation
   * is free to return its own bucket by reference, so callers must treat the
   * result as shared and never `sort`/`splice` it in place. The compiler now
   * refuses that at the call site. Whether a given implementation shares or
   * copies is its own business and documented where it is built —
   * `buildSuffixIndex` shares, the root-anchored parity index in
   * `languages/php/import-target.ts` returns a filtered copy.
   *
   * Implementations that memoize should note the directory map behind this may
   * be built on the FIRST call rather than up front, so a caller that never
   * asks a directory question never pays for it — see `buildSuffixIndex`.
   */
  getFilesInDir(dirSuffix: string, extension: string): readonly string[];
}

export interface SuffixIndexOptions {
  /**
   * Promise from the caller that `normalizedFileList[i] === normalizedFileList[i].toLowerCase()`
   * for every `i` — i.e. the "normalized" list is a LOWERCASED file list, not
   * merely a slash-normalized one.
   *
   * `import-resolvers/pass-cache.ts` is the one caller that can make it: it
   * builds `normalizedFileList` as `allFileList.map((f) => f.toLowerCase())`.
   * Every suffix of an all-lowercase path is itself lowercase, so
   * `suffix.toLowerCase() === suffix` and the case-folded map came out a
   * byte-identical copy of the exact one — same keys, same values, same
   * insertion order. Measured 14.00 MiB at 32 000 paths, 29.8% of the retained
   * `ImportPassCache` — and one `ImportPassCache` is built per ts-family
   * adapter per pass, so the waste was carried once for each of them.
   *
   * With this set, `getInsensitive` reads the exact map directly instead. It is
   * the same map the derivation below would have produced, so this is a skipped
   * copy and not a second lookup rule — see `getLowerMap`.
   *
   * Setting it over a list that is NOT all-lowercase is a behaviour change, not
   * an optimization: `getInsensitive` would then answer case-sensitively.
   */
  readonly alreadyLowercased?: boolean;
}

export function buildSuffixIndex(
  normalizedFileList: readonly string[],
  allFileList: readonly string[],
  options?: SuffixIndexOptions,
): SuffixIndex {
  const alreadyLowercased = options?.alreadyLowercased === true;

  /**
   * Map: normalized suffix -> original file path.
   *
   * DEFERRED, like `dirMap` below and for the same reason (#2903 extended to
   * the two suffix maps). Several consumers on the ScopeResolver path ask only
   * ONE of the two suffix questions and were paying for both:
   *
   *   - `languages/java/import-target.ts` and the no-csproj leg of
   *     `languages/csharp/import-target.ts` call `get` and never
   *     `getInsensitive` — measured 49.98 MiB dead of a 100.82 MiB Java index
   *     at 32 000 paths (49.6%), against a gated ceiling of 146.9 MiB;
   *   - `languages/php/import-target.ts` calls `getInsensitive` and never `get`
   *     — 34.49 MiB of 69.85 MiB (49.4%).
   *
   * Ruby, the csproj leg of C#, `group/extractors/include-extractor.ts` and
   * `suffixResolve` below read both, and all four read `get` FIRST (they are
   * written `get(s) || getInsensitive(s)`), which is what makes the derivation
   * in `getLowerMap` the cheap order rather than the expensive one.
   */
  let exactMap: Map<string, string> | null = null;

  const getExactMap = (): Map<string, string> => {
    if (exactMap !== null) return exactMap;
    const built = new Map<string, string>();
    for (let i = 0; i < normalizedFileList.length; i++) {
      const normalized = normalizedFileList[i];
      const original = allFileList[i];

      // Index all suffixes: "a/b/c.java" -> ["c.java", "b/c.java", "a/b/c.java"].
      //
      // Walked as slash offsets into `normalized` rather than as
      // `normalized.split('/')` + `parts.slice(j).join('/')`: the slice of the
      // ORIGINAL string is byte-identical to the re-joined parts (no separator
      // is invented or dropped — verified over 361 865 suffix strings including
      // leading, doubled and trailing slashes), and it allocates one string
      // instead of a parts array, a slice array and a joined string per suffix.
      // Measured 357.4 ms -> 264.5 ms at 32 000 paths.
      let slash = normalized.lastIndexOf('/');
      while (slash >= 0) {
        const suffix = normalized.slice(slash + 1);
        // Only store first match (longest path wins for ambiguous suffixes)
        if (!built.has(suffix)) built.set(suffix, original);
        // A path may begin with '/', whose suffix is the whole string below.
        if (slash === 0) break;
        slash = normalized.lastIndexOf('/', slash - 1);
      }
      // j = 0 — the whole path, which the slash walk cannot emit.
      if (!built.has(normalized)) built.set(normalized, original);
    }
    exactMap = built;
    return built;
  };

  /**
   * Map: lowercase suffix -> original file path.
   *
   * Deferred, and when the exact map already exists DERIVED from it instead of
   * traversed for: one pass over that map's DISTINCT keys rather than a second
   * pass over every (file × depth) suffix. Measured 330.3 ms total (200.6 build
   * + 129.7 derive) against 388.8 ms for the single fused traversal that built
   * both eagerly — so the two-map consumers get cheaper too, which per-map
   * laziness on its own does not (407.1 ms, a second full traversal).
   *
   * The derivation is EQUAL, not approximate, and the argument is short. Let
   * the fused loop's global order be the pairs (suffix, file) it visited. For a
   * lowercase key L, let p be the first position whose suffix lowercases to L —
   * the entry today's `lowerMap` keeps. Nothing before p carries that suffix
   * spelled ANY way, so p is also the first occurrence of its exact spelling
   * and is therefore in the exact map, holding that same file. Exact-map
   * insertion order is by first-occurrence position, so among the exact keys
   * folding to L, p's is reached first and first-wins keeps it. Insertion order
   * of the derived map is the order of those p's, which is the order today's
   * `lowerMap` inserts L. Verified rather than only argued: byte-equal keys,
   * values and order over 968 418 entries across bench-shaped, PascalCase,
   * case-colliding, deep-monorepo, Unicode-adversarial and 400 seeded-fuzz
   * corpora.
   *
   * When `getInsensitive` is asked FIRST (PHP), there is nothing to derive
   * from, so it is built straight — one traversal, one map, which is the point.
   * Asking `get` afterwards would then cost the second traversal; no consumer
   * does, and the fallback stays correct if one ever starts.
   */
  let lowerMap: Map<string, string> | null = null;

  const getLowerMap = (): Map<string, string> => {
    // Over an already-lowercased file list the derivation is the identity, so
    // the exact map IS the case-folded map. Skip the copy.
    if (alreadyLowercased) return getExactMap();
    if (lowerMap !== null) return lowerMap;

    const built = new Map<string, string>();
    if (exactMap !== null) {
      for (const [suffix, original] of exactMap) {
        const lower = suffix.toLowerCase();
        if (!built.has(lower)) built.set(lower, original);
      }
      lowerMap = built;
      return built;
    }

    for (let i = 0; i < normalizedFileList.length; i++) {
      const normalized = normalizedFileList[i];
      const original = allFileList[i];
      let slash = normalized.lastIndexOf('/');
      while (slash >= 0) {
        const lower = normalized.slice(slash + 1).toLowerCase();
        if (!built.has(lower)) built.set(lower, original);
        if (slash === 0) break;
        slash = normalized.lastIndexOf('/', slash - 1);
      }
      const whole = normalized.toLowerCase();
      if (!built.has(whole)) built.set(whole, original);
    }
    lowerMap = built;
    return built;
  };

  /**
   * Map: `${directory suffix}:${extension}` -> file paths in that directory.
   *
   * DEFERRED, not dropped (#2903). This is the array-valued map of the three
   * and by far the most expensive: one entry — and one array push — per file
   * per directory component, so O(files × depth) in entries AND in array
   * churn. Measured on the 32k-path arms of `bench/import-target/`, it is
   * ~15% of the retained C# index and ~19% of the retained Ruby one.
   *
   * Only `getFilesInDir` reads it, and only four call sites reach that:
   * `import-resolvers/{php,csharp,jvm}.ts` and `import-resolvers/configs/
   * python.ts`. Every other consumer of this index — `workspace-file-index.ts`
   * serving Ruby, `languages/typescript/scope-resolver.ts`,
   * `languages/vue/import-target.ts`, `group/extractors/include-extractor.ts`
   * — asks only suffix questions and was paying the whole footprint for a map
   * it never touched. Since these indexes are now retained for a whole
   * resolution pass rather than rebuilt per import (#2877-#2880), that is
   * retained memory against the #2649 kernel-scale OOM constraint.
   *
   * `null` until the first `getFilesInDir`; the MAP is memoized, not the
   * decision to build it, so a repeated miss cannot rebuild it. Building it
   * later is behaviour-identical because it is a pure function of
   * `normalizedFileList` / `allFileList`, and it retains nothing new: every
   * production caller already holds both arrays alive alongside the index
   * (`WorkspaceFileIndex.normalized`/`.all`, the TS and Vue `PassCache`s,
   * `IncludeExtractor.extract`'s locals).
   */
  let dirMap: Map<string, string[]> | null = null;

  const getDirMap = (): Map<string, string[]> => {
    if (dirMap !== null) return dirMap;
    const built = new Map<string, string[]>();
    for (let i = 0; i < normalizedFileList.length; i++) {
      const normalized = normalizedFileList[i];
      const original = allFileList[i];
      const lastSlash = normalized.lastIndexOf('/');
      // A file at the repo root is in no directory suffix.
      if (lastSlash < 0) continue;

      // The file name from its last '.', or the WHOLE file name when it carries
      // none — `substring(-1)` clamps to 0, which is what the `parts` form
      // (`fileName.substring(fileName.lastIndexOf('.'))`) spelled. A '.' in a
      // DIRECTORY is not an extension, hence `dot > lastSlash` rather than
      // `dot >= 0`.
      const dot = normalized.lastIndexOf('.');
      const ext = dot > lastSlash ? normalized.slice(dot) : normalized.slice(lastSlash + 1);

      // Every directory suffix of `normalized.slice(0, lastSlash)`, shortest
      // first — the order `for (j = dirParts.length - 1; j >= 0; j--)` emitted,
      // and load-bearing: `php.ts` returns `candidates[0]` of a bucket, so a
      // reordered bucket is a behaviour change, not a wash.
      //
      // Walked as slash offsets into `normalized`, the same rewrite `getExactMap`
      // above documents and for the same reason — a slice of the ORIGINAL string
      // is byte-identical to the re-joined parts, and it allocates one string per
      // suffix instead of a parts array, a slice array and a joined string per
      // suffix. This is the map where it pays most: one entry, one array push AND
      // one key per file per directory component, the "by far the most expensive"
      // of the three. Measured 226.9 ms -> 173.1 ms at 32 000 paths averaging
      // ~10 directory components (min of 9, both loops alternating in one
      // process). Verified rather than argued, over a 32 000-path corpus
      // carrying absolute paths, doubled separators (`a//b`), backslash paths,
      // root-level and extensionless files, dotted directories and trailing
      // separators: 272 956 keys and 329 361 bucket entries came out with
      // identical key sets in identical INSERTION order and identical buckets
      // element-for-element, and 767 732 probes of the built index — every
      // emitted (directory, extension) pair plus a wrong-extension and a
      // one-level-deeper miss for each — answered exactly as the `parts` form's
      // map did. 0 differences.
      //
      // `slash < 0` is the whole directory, which no slash search can emit and
      // the only suffix a one-component directory has.
      let start = lastSlash;
      while (start >= 0) {
        const slash = start > 0 ? normalized.lastIndexOf('/', start - 1) : -1;
        const key = `${normalized.slice(slash + 1, lastSlash)}:${ext}`;
        let list = built.get(key);
        if (!list) {
          list = [];
          built.set(key, list);
        }
        list.push(original);
        start = slash;
      }
    }
    dirMap = built;
    return built;
  };

  return {
    get: (suffix: string) => getExactMap().get(suffix),
    getInsensitive: (suffix: string) => getLowerMap().get(suffix.toLowerCase()),
    // THIS implementation shares: it hands back `dirMap`'s own bucket rather
    // than a copy. The map is built on first query and then held for the whole
    // pass, so the window in which a mutating caller could corrupt later
    // imports is the whole pass — which is why the interface makes the result
    // `readonly` and the compiler refuses the mutation at the call site.
    //
    // Sharing beats copying because no caller keeps the array: two only measure
    // it and two build a fresh array from it, so a defensive copy would
    // allocate a whole bucket per import on the path this index exists to keep
    // flat. `package-dir-index.ts` reached the same conclusion the same way —
    // read-only containers, plus one copy where a bucket genuinely LEAVES
    // (`sortedRootFiles`), which is the case `configs/swift.ts` is in.
    getFilesInDir: (dirSuffix: string, extension: string) => {
      return getDirMap().get(`${dirSuffix}:${extension}`) || [];
    },
  };
}

/**
 * Suffix-based resolution using index. O(1) per lookup instead of O(files).
 */
export function suffixResolve(
  pathParts: string[],
  normalizedFileList: readonly string[],
  allFileList: readonly string[],
  index?: SuffixIndex,
): string | null {
  if (index) {
    for (let i = 0; i < pathParts.length; i++) {
      const suffix = pathParts.slice(i).join('/');
      for (const ext of EXTENSIONS) {
        const suffixWithExt = suffix + ext;
        const result = index.get(suffixWithExt) || index.getInsensitive(suffixWithExt);
        if (result) return result;
      }
    }
    return null;
  }

  // Fallback: linear scan (for backward compatibility)
  for (let i = 0; i < pathParts.length; i++) {
    const suffix = pathParts.slice(i).join('/');
    for (const ext of EXTENSIONS) {
      const suffixWithExt = suffix + ext;
      const suffixPattern = '/' + suffixWithExt;
      const matchIdx = normalizedFileList.findIndex(
        (filePath) =>
          filePath.endsWith(suffixPattern) ||
          filePath.toLowerCase().endsWith(suffixPattern.toLowerCase()),
      );
      if (matchIdx !== -1) {
        return allFileList[matchIdx];
      }
    }
  }
  return null;
}
