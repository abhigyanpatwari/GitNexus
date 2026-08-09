/**
 * Differential harness for the C# **csproj** leg of `resolveCSharpImportInternal`
 * (#2902).
 *
 * #2878 moved C#'s no-csproj leg onto memoized indexes. The csproj leg kept a
 * per-import, per-matching-config Θ(files) scan — step 3, "linear scan fallback
 * for directory matching" — measured at ~1.08 ms per import over 50 000 `.cs`
 * files. This PR answers that leg from a per-file-list directory index instead.
 *
 * WHY A VERBATIM COPY AND NOT A DELETION. The obvious cleanup is "step 2 already
 * asks the index the same question, so skip step 3 whenever an index exists".
 * That is wrong, and this file is the proof. Step 2 filters
 * `index.getFilesInDir(dirPrefix, '.cs')`, whose buckets are keyed on
 * SEGMENT-aligned directory suffixes; step 3 runs an UNANCHORED
 * `normalized.indexOf(dirPrefix + '/')`. Step 3 therefore answers strictly more:
 *
 *   - `dirPrefix = 'ubModels'` matches `src/SubModels/` (character suffix of a
 *     segment, not a segment);
 *   - `dirPrefix = 'rc/Models'` matches BOTH `src/Models/` and
 *     `vendor/mysrc/Models/`;
 *   - `dirPrefix = ''` — the "the import IS the root namespace and the config
 *     has no projectDir" case — matches every `.cs` file exactly one directory
 *     deep. `buildSuffixIndex` emits an empty directory suffix only for a path
 *     that BEGINS with '/', so over repo-relative paths `getFilesInDir('',
 *     '.cs')` is always empty and step 3 is the only implementation that case
 *     has ever had. (The leading-slash shape has its own arm below, kept off
 *     the main corpus precisely because step 2 DOES answer it.)
 *
 * Step 3 also runs only when step 2 found nothing, so those extra hits are
 * observable rather than shadowed. `skips step 3 when the index is present`
 * below pins that: it drives the naive cleanup and asserts it CHANGES answers.
 *
 * The arms all assert the full `string[]` and its order — this resolver returns
 * every match, not one, and `configs/csharp.ts` turns a multi-file result into a
 * `kind: 'package'` edge set whose order reaches the graph.
 */
import { describe, expect, it } from 'vitest';

import {
  resolveCSharpImportInternal,
  resolveCSharpNamespaceDir,
} from '../../../src/core/ingestion/import-resolvers/csharp.js';
import {
  buildSuffixIndex,
  suffixResolve,
  type SuffixIndex,
} from '../../../src/core/ingestion/import-resolvers/utils.js';
import { csharpSuffixFallbackAllowed } from '../../../src/core/ingestion/csharp-namespace-gate.js';
import type {
  CSharpProjectConfig,
  CSharpNamespaceEvidence,
} from '../../../src/core/ingestion/language-config.js';

// ─── verbatim pre-change implementation ──────────────────────────────────────
// `git show HEAD~:gitnexus/src/core/ingestion/import-resolvers/csharp.ts`, body
// copied unchanged. Its helpers (`suffixResolve`, `csharpSuffixFallbackAllowed`,
// `SuffixIndex`) are imported from production because this PR does not touch
// them; only the function below changed.

function legacyResolveCSharpImportInternal(
  importPath: string,
  csharpConfigs: CSharpProjectConfig[],
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
  evidence?: CSharpNamespaceEvidence,
): string[] {
  const namespacePath = importPath.replace(/\./g, '/');
  const results: string[] = [];

  for (const config of csharpConfigs) {
    const nsPath = config.rootNamespace.replace(/\./g, '/');
    let relative: string;
    if (namespacePath.startsWith(nsPath + '/')) {
      relative = namespacePath.slice(nsPath.length + 1);
    } else if (namespacePath === nsPath) {
      // The import IS the root namespace — resolve to all .cs files in project root
      relative = '';
    } else {
      continue;
    }

    const dirPrefix = config.projectDir
      ? relative
        ? config.projectDir + '/' + relative
        : config.projectDir
      : relative;

    // 1. Try as single file: relative.cs (e.g., "Models/DlqMessage.cs")
    if (relative) {
      const candidate = dirPrefix + '.cs';
      if (index) {
        const result = index.get(candidate) || index.getInsensitive(candidate);
        if (result) return [result];
      }
      // Also try suffix match
      const suffixResult = index?.get(relative + '.cs') || index?.getInsensitive(relative + '.cs');
      if (suffixResult) return [suffixResult];
    }

    // 2. Try as directory: all .cs files directly inside (namespace import)
    if (index) {
      const dirFiles = index.getFilesInDir(dirPrefix, '.cs');
      for (const f of dirFiles) {
        const normalized = f.replace(/\\/g, '/');
        // Check it's a direct child by finding the dirPrefix and ensuring no deeper slashes
        const prefixIdx = normalized.indexOf(dirPrefix + '/');
        if (prefixIdx < 0) continue;
        const afterDir = normalized.substring(prefixIdx + dirPrefix.length + 1);
        if (!afterDir.includes('/')) {
          results.push(f);
        }
      }
      if (results.length > 0) return results;
    }

    // 3. Linear scan fallback for directory matching
    if (results.length === 0) {
      const dirTrail = dirPrefix + '/';
      for (let i = 0; i < normalizedFileList.length; i++) {
        const normalized = normalizedFileList[i];
        if (!normalized.endsWith('.cs')) continue;
        const prefixIdx = normalized.indexOf(dirTrail);
        if (prefixIdx < 0) continue;
        const afterDir = normalized.substring(prefixIdx + dirTrail.length);
        if (!afterDir.includes('/')) {
          results.push(allFileList[i]);
        }
      }
      if (results.length > 0) return results;
    }
  }

  // Fallback: suffix matching without namespace stripping (single file).
  // Gated on in-repo declared-namespace evidence (#1881).
  if (!csharpSuffixFallbackAllowed(importPath, evidence)) {
    return [];
  }
  const pathParts = namespacePath.split('/').filter(Boolean);
  const fallback = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return fallback ? [fallback] : [];
}

/**
 * The naive cleanup this PR deliberately did NOT do: keep step 3 only as an
 * un-indexed fallback. Same body as the legacy copy with step 3 gated on
 * `index === undefined`. Driven by one arm below, which asserts it diverges.
 */
function skipStep3WhenIndexed(
  importPath: string,
  csharpConfigs: CSharpProjectConfig[],
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
  evidence?: CSharpNamespaceEvidence,
): string[] {
  const namespacePath = importPath.replace(/\./g, '/');
  const results: string[] = [];

  for (const config of csharpConfigs) {
    const nsPath = config.rootNamespace.replace(/\./g, '/');
    let relative: string;
    if (namespacePath.startsWith(nsPath + '/')) {
      relative = namespacePath.slice(nsPath.length + 1);
    } else if (namespacePath === nsPath) {
      relative = '';
    } else {
      continue;
    }

    const dirPrefix = config.projectDir
      ? relative
        ? config.projectDir + '/' + relative
        : config.projectDir
      : relative;

    if (relative) {
      const candidate = dirPrefix + '.cs';
      if (index) {
        const result = index.get(candidate) || index.getInsensitive(candidate);
        if (result) return [result];
      }
      const suffixResult = index?.get(relative + '.cs') || index?.getInsensitive(relative + '.cs');
      if (suffixResult) return [suffixResult];
    }

    if (index) {
      const dirFiles = index.getFilesInDir(dirPrefix, '.cs');
      for (const f of dirFiles) {
        const normalized = f.replace(/\\/g, '/');
        const prefixIdx = normalized.indexOf(dirPrefix + '/');
        if (prefixIdx < 0) continue;
        const afterDir = normalized.substring(prefixIdx + dirPrefix.length + 1);
        if (!afterDir.includes('/')) {
          results.push(f);
        }
      }
      if (results.length > 0) return results;
      continue;
    }

    const dirTrail = dirPrefix + '/';
    for (let i = 0; i < normalizedFileList.length; i++) {
      const normalized = normalizedFileList[i];
      if (!normalized.endsWith('.cs')) continue;
      const prefixIdx = normalized.indexOf(dirTrail);
      if (prefixIdx < 0) continue;
      const afterDir = normalized.substring(prefixIdx + dirTrail.length);
      if (!afterDir.includes('/')) {
        results.push(allFileList[i]);
      }
    }
    if (results.length > 0) return results;
  }

  if (!csharpSuffixFallbackAllowed(importPath, evidence)) {
    return [];
  }
  const pathParts = namespacePath.split('/').filter(Boolean);
  const fallback = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return fallback ? [fallback] : [];
}

// ─── corpus ──────────────────────────────────────────────────────────────────

/**
 * Hand-built so every tie-break the scan expressed through `indexOf` positions
 * and file-list order has a witness. Order matters: the resolver emits in
 * file-list order, so the interleavings below (`src/Models/Late.cs` after
 * `other/Models/Thing.cs`, `src/Extra.cs` after `Models/TopLevel.cs`) are what
 * make a directory-at-a-time emit distinguishable from a merged one.
 */
const RAW_FILES: readonly string[] = [
  // Repo-root files: no directory at all, so no `dirPrefix + '/'` can ever hit.
  'Root.cs',
  'notes.txt',
  // The `src` project.
  'src/Program.cs',
  'src/Startup.cs',
  'src/Models/User.cs',
  'src/Models/Order.cs',
  'src/Models/Deep/Nested.cs',
  // Character suffix of a segment, NOT a segment: answers `ubModels`, and
  // answers `Models` only when no segment-aligned `Models` directory does.
  'src/SubModels/Widget.cs',
  'src/Services/UserService.cs',
  'src/Services/Sub/Inner.cs',
  // A second directory sharing the `Models` last segment, minted BEFORE
  // `src/Models/Late.cs` so multi-directory answers have to interleave.
  'other/Models/Thing.cs',
  // Character suffix across a segment boundary: answers `rc/Models`.
  'vendor/mysrc/Models/Vendored.cs',
  'src/Models/Late.cs',
  // `Models` nested inside `Models`: the FIRST `indexOf` occurrence is the
  // outer one, whose remainder still holds a slash, so this answers nothing.
  'nest/Models/inner/Models/Ignored.cs',
  // Single-segment directory, so it answers the empty `dirPrefix`.
  'Models/TopLevel.cs',
  // Backslash separators: `allFileList` keeps them, the predicate runs on the
  // normalized form, and the emitted value is the RAW one.
  'win\\Models\\Win.cs',
  'win\\Deep\\Models\\Deeper\\Skip.cs',
  // Second project root, plus a case-only twin for the case-insensitive leg.
  'lib/Core/Widgets/Widget.cs',
  'lib/Core/Widgets.cs',
  'lib/Core/widgets/Lower.cs',
  // Second single-segment-directory file, after `Models/TopLevel.cs`.
  'src/Extra.cs',
  // Non-`.cs` files INSIDE directories that answer queries, so dropping the
  // extension filter is visible rather than shadowed by the root-level
  // `notes.txt` (which no `dirPrefix + '/'` can reach anyway).
  'src/notes.md',
  'Models/schema.json',
];

const ALL_FILE_LIST: string[] = [...RAW_FILES];
const NORMALIZED_FILE_LIST: string[] = ALL_FILE_LIST.map((f) => f.replace(/\\/g, '/'));
const SUFFIX_INDEX: SuffixIndex = buildSuffixIndex(NORMALIZED_FILE_LIST, ALL_FILE_LIST);

const CONFIG_SHAPES: ReadonlyArray<readonly [string, CSharpProjectConfig[]]> = [
  ['no configs at all', []],
  ['projectDir=src', [{ rootNamespace: 'App', projectDir: 'src' }]],
  // `projectDir` is a required `string`, so "without projectDir" is the empty
  // string the `config.projectDir ? …` ternary treats as absent.
  ['no projectDir', [{ rootNamespace: 'App', projectDir: '' }]],
  ['dotted root namespace', [{ rootNamespace: 'Acme.App', projectDir: 'src' }]],
  ['nested projectDir', [{ rootNamespace: 'Lib', projectDir: 'lib/Core' }]],
  // Unanchored projectDirs: neither is a directory in the corpus, so both fall
  // through to step 3 and match by character suffix.
  ['unanchored projectDir', [{ rootNamespace: 'App', projectDir: 'rc' }]],
  // A projectDir that already starts with '/' makes `dirPrefix` one character
  // LONGER than a directory it shares a last segment with, the one shape where
  // `indexOf` and `haystack.length - needle.length` both come out -1.
  ['absolute projectDir', [{ rootNamespace: 'App', projectDir: '/Models' }]],
  [
    'two configs, both match',
    [
      { rootNamespace: 'App', projectDir: 'nope' },
      { rootNamespace: 'App', projectDir: 'src' },
    ],
  ],
  [
    'two configs, second root namespace extends the first',
    [
      { rootNamespace: 'App', projectDir: 'src' },
      { rootNamespace: 'App.Models', projectDir: 'other' },
    ],
  ],
  [
    'two configs, the matching one is second and has no projectDir',
    [
      { rootNamespace: 'Zzz', projectDir: 'src' },
      { rootNamespace: 'App', projectDir: '' },
    ],
  ],
  ['no config matches', [{ rootNamespace: 'Zzz', projectDir: 'src' }]],
];

const IMPORTS: readonly string[] = [
  // Root-namespace-equals-import, against every projectDir shape.
  'App',
  'Acme.App',
  'Lib',
  // Directories that exist, segment-aligned.
  'App.Models',
  'App.Services',
  'App.Services.Sub',
  'App.Models.Deep',
  'App.SubModels',
  'Acme.App.Models',
  'Lib.Widgets',
  // Case-only variants (step 1's `getInsensitive` legs).
  'Lib.widgets',
  'App.models',
  // Character-suffix-only directories: segment-aligned lookups find nothing.
  'App.ubModels',
  'App.odels',
  'App.Models.Late',
  // A namespace with no matching directory anywhere — the issue's trigger.
  'App.Missing',
  'App.Missing.Deeper',
  'Acme.App.Missing',
  // Single files rather than directories.
  'App.Program',
  'App.Root',
  'Lib.Core.Widgets',
  // Imports that match no configured root namespace at all (BCL usings).
  'System',
  'System.Threading.Tasks',
  'Models',
  'Models.TopLevel',
];

/** Every (config shape, import) pair, plus both index modes. */
const PAIRS: ReadonlyArray<{
  readonly key: string;
  readonly configs: CSharpProjectConfig[];
  readonly importPath: string;
  readonly index: SuffixIndex | undefined;
}> = CONFIG_SHAPES.flatMap(([shape, configs]) =>
  IMPORTS.flatMap((importPath) =>
    [SUFFIX_INDEX, undefined].map((index) => ({
      key: `${shape} | ${importPath} | index=${index === undefined ? 'absent' : 'present'}`,
      configs,
      importPath,
      index,
    })),
  ),
);

function runCurrent(pair: (typeof PAIRS)[number]): string[] {
  return resolveCSharpImportInternal(
    pair.importPath,
    pair.configs,
    NORMALIZED_FILE_LIST,
    ALL_FILE_LIST,
    pair.index,
  );
}

function runLegacy(pair: (typeof PAIRS)[number]): string[] {
  return legacyResolveCSharpImportInternal(
    pair.importPath,
    pair.configs,
    NORMALIZED_FILE_LIST,
    ALL_FILE_LIST,
    pair.index,
  );
}

/** `label -> joined result`, so a mismatch prints the pair AND both answers. */
function table(run: (pair: (typeof PAIRS)[number]) => string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of PAIRS) out[pair.key] = run(pair).join(' , ');
  return out;
}

describe('C# csproj leg — directory index vs the pre-change linear scan (#2902)', () => {
  it('returns byte-identical results, in order, for every config shape and import', () => {
    expect(table(runCurrent)).toEqual(table(runLegacy));
  });

  it('agrees on the `#1881` evidence gate too (the suffix fallback is downstream of step 3)', () => {
    const evidence: CSharpNamespaceEvidence = {
      declaredNamespaces: new Set(['App', 'App.Models', 'Lib.Core']),
      rootNamespaces: new Set(['App', 'Lib']),
      truncated: false,
    };
    const current: Record<string, string> = {};
    const legacy: Record<string, string> = {};
    for (const pair of PAIRS) {
      current[pair.key] = resolveCSharpImportInternal(
        pair.importPath,
        pair.configs,
        NORMALIZED_FILE_LIST,
        ALL_FILE_LIST,
        pair.index,
        evidence,
      ).join(' , ');
      legacy[pair.key] = legacyResolveCSharpImportInternal(
        pair.importPath,
        pair.configs,
        NORMALIZED_FILE_LIST,
        ALL_FILE_LIST,
        pair.index,
        evidence,
      ).join(' , ');
    }
    expect(current).toEqual(legacy);
  });

  it('leaves `resolveCSharpNamespaceDir` — the sibling that shares the dirPrefix maths — alone', () => {
    const dirs: Record<string, string | null> = {};
    for (const [shape, configs] of CONFIG_SHAPES) {
      for (const importPath of IMPORTS) {
        dirs[`${shape} | ${importPath}`] = resolveCSharpNamespaceDir(importPath, configs);
      }
    }
    expect(dirs['projectDir=src | App.Models']).toBe('/src/Models/');
    expect(dirs['no projectDir | App']).toBeNull();
    expect(dirs['no projectDir | App.Models']).toBe('/Models/');
    expect(dirs['no config matches | App.Models']).toBeNull();
  });
});

describe('C# csproj leg — the answers only step 3 can give (#2902)', () => {
  const withIndex = (configs: CSharpProjectConfig[], importPath: string): string[] =>
    resolveCSharpImportInternal(
      importPath,
      configs,
      NORMALIZED_FILE_LIST,
      ALL_FILE_LIST,
      SUFFIX_INDEX,
    );

  it('`relative === ""` with no projectDir gives dirPrefix "" — every .cs one level deep, merged', () => {
    // `getFilesInDir('', '.cs')` is empty for every file set, so step 2 cannot
    // answer this at all. Two directories match (`src`, `Models`) and their
    // files interleave, so a directory-at-a-time emit reorders this.
    expect(withIndex([{ rootNamespace: 'App', projectDir: '' }], 'App')).toEqual([
      'src/Program.cs',
      'src/Startup.cs',
      'Models/TopLevel.cs',
      'src/Extra.cs',
    ]);
  });

  it('`relative === ""` WITH a projectDir gives dirPrefix = projectDir, answered by step 2', () => {
    expect(withIndex([{ rootNamespace: 'App', projectDir: 'src' }], 'App')).toEqual([
      'src/Program.cs',
      'src/Startup.cs',
      'src/Extra.cs',
    ]);
  });

  it('matches a directory by CHARACTER suffix of a segment, which no segment bucket holds', () => {
    expect(withIndex([{ rootNamespace: 'App', projectDir: '' }], 'App.ubModels')).toEqual([
      'src/SubModels/Widget.cs',
    ]);
  });

  it('matches a character suffix ACROSS a segment boundary, over several directories', () => {
    expect(withIndex([{ rootNamespace: 'App', projectDir: 'rc' }], 'App.Models')).toEqual([
      'src/Models/User.cs',
      'src/Models/Order.cs',
      'vendor/mysrc/Models/Vendored.cs',
      'src/Models/Late.cs',
    ]);
  });

  it('keeps the FIRST-occurrence tie-break: a directory nested inside a same-named one loses', () => {
    // `nest/Models/inner/Models/Ignored.cs` is absent: `indexOf('odels/')` finds
    // the outer `Models/`, and `inner/Models/Ignored.cs` still has a slash.
    expect(withIndex([{ rootNamespace: 'App', projectDir: '' }], 'App.odels')).toEqual([
      'src/Models/User.cs',
      'src/Models/Order.cs',
      'src/SubModels/Widget.cs',
      'other/Models/Thing.cs',
      'vendor/mysrc/Models/Vendored.cs',
      'src/Models/Late.cs',
      'Models/TopLevel.cs',
      'win\\Models\\Win.cs',
    ]);
  });

  it('emits the RAW path for backslash-separated files while matching on the normalized one', () => {
    expect(withIndex([{ rootNamespace: 'App', projectDir: 'win' }], 'App.Models')).toEqual([
      'win\\Models\\Win.cs',
    ]);
  });

  it('a leading-slash dirPrefix cannot bogus-match a shorter directory', () => {
    // `dirPrefix = '/Models'` (projectDir used verbatim, since the import IS
    // the root namespace): `'Models/'` is SHORTER than `'/Models/'`, and both
    // `indexOf` and `haystack.length - needle.length` come out -1 without a
    // length guard, so `Models/TopLevel.cs` would join the answer.
    expect(withIndex([{ rootNamespace: 'App', projectDir: '/Models' }], 'App')).toEqual([
      'src/Models/User.cs',
      'src/Models/Order.cs',
      'other/Models/Thing.cs',
      'vendor/mysrc/Models/Vendored.cs',
      'src/Models/Late.cs',
      'win\\Models\\Win.cs',
    ]);
  });

  it('an import with no matching directory resolves to nothing (the issue trigger)', () => {
    expect(withIndex([{ rootNamespace: 'App', projectDir: 'src' }], 'App.Missing')).toEqual([]);
  });

  it('skipping step 3 when the index is present CHANGES answers — the fallback is load-bearing', () => {
    const divergent = PAIRS.filter(
      (pair) =>
        pair.index !== undefined &&
        runCurrent(pair).join(' , ') !==
          skipStep3WhenIndexed(
            pair.importPath,
            pair.configs,
            NORMALIZED_FILE_LIST,
            ALL_FILE_LIST,
            pair.index,
          ).join(' , '),
    ).map((pair) => pair.key);
    expect(divergent).toContain('no projectDir | App | index=present');
    expect(divergent).toContain('no projectDir | App.ubModels | index=present');
    expect(divergent).toContain('unanchored projectDir | App.Models | index=present');
    expect(divergent.length).toBeGreaterThan(10);
  });

  it('the parity arms are not vacuous: most pairs resolve, and step 3 answers many of them', () => {
    const nonEmpty = PAIRS.filter((pair) => runCurrent(pair).length > 0);
    const multiFile = PAIRS.filter((pair) => runCurrent(pair).length > 1);
    expect(nonEmpty.length).toBeGreaterThan(PAIRS.length / 3);
    expect(multiFile.length).toBeGreaterThan(20);
  });
});

describe('C# csproj leg — the directory index is built once per file list (#2902)', () => {
  /** Counts element reads, so a rebuild per import shows up as N reads of `[0]`. */
  function countingList(values: readonly string[]): { list: string[]; reads: () => number } {
    let reads = 0;
    const list = new Proxy([...values], {
      get(target: string[], property: string | symbol, receiver: unknown): unknown {
        reads += Number(property === '0');
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    return { list, reads: () => reads };
  }

  it('resolves many imports with a single pass over the normalized list', () => {
    const { list, reads } = countingList(NORMALIZED_FILE_LIST);
    const index = buildSuffixIndex([...NORMALIZED_FILE_LIST], ALL_FILE_LIST);
    const configs: CSharpProjectConfig[] = [{ rootNamespace: 'App', projectDir: 'src' }];
    for (let i = 0; i < 40; i++) {
      resolveCSharpImportInternal(`App.Missing${i % 4}`, configs, list, ALL_FILE_LIST, index);
    }
    expect(reads()).toBe(1);
  });

  it('a path that BEGINS with a slash keeps parity (its directory is the empty string)', () => {
    // Kept off the main corpus on purpose: `buildSuffixIndex` DOES emit an
    // empty directory suffix for such a path, so step 2 would answer the empty
    // `dirPrefix` here and short-circuit the very leg the arms above pin.
    const raw = ['/Rooted.cs', 'src/Nested.cs', '/Other.cs'];
    const normalized = raw.map((f) => f.replace(/\\/g, '/'));
    const index = buildSuffixIndex([...normalized], [...raw]);
    const shapes: CSharpProjectConfig[][] = [
      [{ rootNamespace: 'App', projectDir: '' }],
      [{ rootNamespace: 'App', projectDir: 'src' }],
      [{ rootNamespace: 'App', projectDir: '/' }],
    ];
    const current: string[][] = [];
    const legacy: string[][] = [];
    for (const configs of shapes) {
      for (const importPath of ['App', 'App.Nested', 'App.Rooted']) {
        for (const withIndex of [index, undefined]) {
          current.push(
            resolveCSharpImportInternal(importPath, configs, [...normalized], raw, withIndex),
          );
          legacy.push(
            legacyResolveCSharpImportInternal(importPath, configs, [...normalized], raw, withIndex),
          );
        }
      }
    }
    expect(current).toEqual(legacy);
    // Not vacuous: the un-indexed empty-dirPrefix query reaches `dir === ''`.
    expect(
      resolveCSharpImportInternal(
        'App',
        [{ rootNamespace: 'App', projectDir: '' }],
        [...normalized],
        raw,
        undefined,
      ),
    ).toEqual(['/Rooted.cs', 'src/Nested.cs', '/Other.cs']);
  });

  it('a distinct file list gets its own index (no stale cross-run reuse)', () => {
    const other = ['App2/Models/Only.cs'];
    const configs: CSharpProjectConfig[] = [{ rootNamespace: 'App', projectDir: 'App2' }];
    expect(
      resolveCSharpImportInternal('App.Models', configs, [...other], [...other], undefined),
    ).toEqual(['App2/Models/Only.cs']);
    expect(
      resolveCSharpImportInternal(
        'App.Models',
        configs,
        NORMALIZED_FILE_LIST,
        ALL_FILE_LIST,
        undefined,
      ),
    ).toEqual([]);
  });
});
