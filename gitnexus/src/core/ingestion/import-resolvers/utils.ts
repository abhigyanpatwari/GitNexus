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
  /** Exact suffix lookup (case-sensitive) */
  get(suffix: string): string | undefined;
  /** Case-insensitive suffix lookup */
  getInsensitive(suffix: string): string | undefined;
  /**
   * Get all files in a directory suffix.
   *
   * The directory map behind this is built on the FIRST call and memoized —
   * see `buildSuffixIndex`. Callers that never ask a directory question never
   * pay for it.
   */
  getFilesInDir(dirSuffix: string, extension: string): string[];
}

export function buildSuffixIndex(normalizedFileList: string[], allFileList: string[]): SuffixIndex {
  // Map: normalized suffix -> original file path
  const exactMap = new Map<string, string>();
  // Map: lowercase suffix -> original file path
  const lowerMap = new Map<string, string>();

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    const original = allFileList[i];
    const parts = normalized.split('/');

    // Index all suffixes: "a/b/c.java" -> ["c.java", "b/c.java", "a/b/c.java"]
    for (let j = parts.length - 1; j >= 0; j--) {
      const suffix = parts.slice(j).join('/');
      // Only store first match (longest path wins for ambiguous suffixes)
      if (!exactMap.has(suffix)) {
        exactMap.set(suffix, original);
      }
      const lower = suffix.toLowerCase();
      if (!lowerMap.has(lower)) {
        lowerMap.set(lower, original);
      }
    }
  }

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

      // Build all directory suffixes
      const parts = normalized.split('/');
      const dirParts = parts.slice(0, -1);
      const fileName = parts[parts.length - 1];
      const ext = fileName.substring(fileName.lastIndexOf('.'));

      for (let j = dirParts.length - 1; j >= 0; j--) {
        const dirSuffix = dirParts.slice(j).join('/');
        const key = `${dirSuffix}:${ext}`;
        let list = built.get(key);
        if (!list) {
          list = [];
          built.set(key, list);
        }
        list.push(original);
      }
    }
    dirMap = built;
    return built;
  };

  return {
    get: (suffix: string) => exactMap.get(suffix),
    getInsensitive: (suffix: string) => lowerMap.get(suffix.toLowerCase()),
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
  normalizedFileList: string[],
  allFileList: string[],
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
