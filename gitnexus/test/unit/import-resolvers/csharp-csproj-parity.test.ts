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
 * `normalized.lastIndexOf(dirPrefix + '/')` (`indexOf` before #2881, which is
 * the first-occurrence rule that issue removed; the empty-prefix case still
 * takes `indexOf` — see `directChildIdx`, which both copies call). Step 3
 * therefore answers strictly more:
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
import { CountingSet } from '../../helpers/counting-file-set.js';
import type {
  CSharpProjectConfig,
  CSharpNamespaceEvidence,
} from '../../../src/core/ingestion/language-config.js';

// ─── verbatim pre-change implementation ──────────────────────────────────────
// `git show HEAD~:gitnexus/src/core/ingestion/import-resolvers/csharp.ts`, body
// copied unchanged. Its helpers (`suffixResolve`, `csharpSuffixFallbackAllowed`,
// `SuffixIndex`) are imported from production because this PR does not touch
// them; only the function below changed.

/**
 * The direct-child probe the frozen copies below run — four call sites, two in
 * each copy, that have to move together.
 *
 * Direct child of a directory ENDING with `dirPrefix` — since #2881, minus
 * "…and that occurrence is the FIRST". Empty `dirPrefix` keeps `indexOf`: its
 * needle is a bare '/', and step 3 answers that query from the
 * one-directory-deep set, which only the first occurrence expresses.
 *
 * Local to this file on purpose. A parity harness has to stay independent of
 * PRODUCTION — that independence is the whole instrument, and importing this
 * expression from `csharp.ts` would make the differential compare production
 * against itself. But all four copies live inside the harness, so one local
 * helper keeps the independence while removing three sites that could silently
 * drift apart from each other.
 */
function directChildIdx(normalized: string, dirPrefix: string, dirTrail: string): number {
  return dirPrefix === '' ? normalized.indexOf(dirTrail) : normalized.lastIndexOf(dirTrail);
}

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

    // Shared by steps 2 and 3 — the same needle, and since #2881 the same
    // `indexOf`-only-when-empty rule, so it is declared once rather than
    // re-derived per step.
    const dirTrail = dirPrefix + '/';

    // 2. Try as directory: all .cs files directly inside (namespace import)
    if (index) {
      const dirFiles = index.getFilesInDir(dirPrefix, '.cs');
      for (const f of dirFiles) {
        const normalized = f.replace(/\\/g, '/');
        const prefixIdx = directChildIdx(normalized, dirPrefix, dirTrail);
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
      for (let i = 0; i < normalizedFileList.length; i++) {
        const normalized = normalizedFileList[i];
        if (!normalized.endsWith('.cs')) continue;
        const prefixIdx = directChildIdx(normalized, dirPrefix, dirTrail);
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

    const dirTrail = dirPrefix + '/';

    if (index) {
      const dirFiles = index.getFilesInDir(dirPrefix, '.cs');
      for (const f of dirFiles) {
        const normalized = f.replace(/\\/g, '/');
        const prefixIdx = directChildIdx(normalized, dirPrefix, dirTrail);
        if (prefixIdx < 0) continue;
        const afterDir = normalized.substring(prefixIdx + dirPrefix.length + 1);
        if (!afterDir.includes('/')) {
          results.push(f);
        }
      }
      if (results.length > 0) return results;
      continue;
    }

    for (let i = 0; i < normalizedFileList.length; i++) {
      const normalized = normalizedFileList[i];
      if (!normalized.endsWith('.cs')) continue;
      const prefixIdx = directChildIdx(normalized, dirPrefix, dirTrail);
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
  // `Models` nested inside `Models`. Answered nothing until #2881, because the
  // FIRST `indexOf` occurrence was the outer one and its remainder still held a
  // slash; the predicate now asks whether the file's DIRECTORY ends with the
  // prefix, which the inner `Models` satisfies.
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
// One Set per corpus, built once: `resolveCSharpImportInternal` now derives its
// normalized/raw lists from `getWorkspaceFileIndex(allFilePaths)`, whose memo is
// keyed on this object's identity. `RAW_FILES` is duplicate-free, so the derived
// pair is `NORMALIZED_FILE_LIST`/`ALL_FILE_LIST` element for element — which is
// what keeps the differential below a like-for-like comparison against the
// frozen legacy implementation, which still takes the two arrays.
const ALL_FILE_PATHS: ReadonlySet<string> = new Set(ALL_FILE_LIST);

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
  return resolveCSharpImportInternal(pair.importPath, pair.configs, ALL_FILE_PATHS, pair.index);
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
        ALL_FILE_PATHS,
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
    resolveCSharpImportInternal(importPath, configs, ALL_FILE_PATHS, SUFFIX_INDEX);

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

  it('a directory nested inside a same-named one now answers too (#2881)', () => {
    // `nest/Models/inner/Models/Ignored.cs` used to be absent: `indexOf('odels/')`
    // found the OUTER `Models/`, and `inner/Models/Ignored.cs` still had a
    // slash. The predicate is now "the file's directory ends with the prefix",
    // which the inner `Models` satisfies. Note this arm queries `App.odels` —
    // the UNANCHORED half — so it also pins that removing the first-occurrence
    // rule did not accidentally anchor the match to a segment boundary:
    // `src/SubModels/Widget.cs` is still here.
    expect(withIndex([{ rootNamespace: 'App', projectDir: '' }], 'App.odels')).toEqual([
      'src/Models/User.cs',
      'src/Models/Order.cs',
      'src/SubModels/Widget.cs',
      'other/Models/Thing.cs',
      'vendor/mysrc/Models/Vendored.cs',
      'src/Models/Late.cs',
      'nest/Models/inner/Models/Ignored.cs',
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
    // the root namespace): `'Models/'` is SHORTER than `'/Models/'`, so
    // `Models/TopLevel.cs` must not join the answer. The `indexOf` form needed
    // an explicit length guard for this, because `indexOf` and
    // `haystack.length - needle.length` both came out -1; `endsWith` is simply
    // false on a shorter haystack, so the property now holds without one, and
    // this case is what proves the guard's removal was safe.
    expect(withIndex([{ rootNamespace: 'App', projectDir: '/Models' }], 'App')).toEqual([
      'src/Models/User.cs',
      'src/Models/Order.cs',
      'other/Models/Thing.cs',
      'vendor/mysrc/Models/Vendored.cs',
      'src/Models/Late.cs',
      'nest/Models/inner/Models/Ignored.cs',
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

describe('C# csproj leg — the directory index is built once per file set (#2902)', () => {
  it('resolves many imports with a single pass over the file set', () => {
    // `CountingSet`, not a counting ARRAY. This arm used to proxy
    // `normalizedFileList` and count reads of `[0]`, because the index was keyed
    // on that array; #2911 rekeyed it onto the Set, so the file set is now the
    // only thing a rebuild has to re-traverse and the one instrument every other
    // import-index guard already uses covers this leg too.
    const files = new CountingSet(ALL_FILE_LIST);
    const index = buildSuffixIndex([...NORMALIZED_FILE_LIST], ALL_FILE_LIST);
    const configs: CSharpProjectConfig[] = [{ rootNamespace: 'App', projectDir: 'src' }];
    for (let i = 0; i < 40; i++) {
      // Every one of these misses steps 1 and 2 and reaches step 3, so the
      // directory index is genuinely consulted 40 times.
      resolveCSharpImportInternal(`App.Missing${i % 4}`, configs, files, index);
    }
    expect(files.scans).toBe(1);
  });

  it('a path that BEGINS with a slash keeps parity (its directory is the empty string)', () => {
    // Kept off the main corpus on purpose: `buildSuffixIndex` DOES emit an
    // empty directory suffix for such a path, so step 2 would answer the empty
    // `dirPrefix` here and short-circuit the very leg the arms above pin.
    const raw = ['/Rooted.cs', 'src/Nested.cs', '/Other.cs'];
    const normalized = raw.map((f) => f.replace(/\\/g, '/'));
    // Duplicate-free, so the resolver derives exactly `normalized`/`raw` from
    // it and the two sides of the differential still see the same corpus.
    const rootedPaths: ReadonlySet<string> = new Set(raw);
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
          current.push(resolveCSharpImportInternal(importPath, configs, rootedPaths, withIndex));
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
        rootedPaths,
        undefined,
      ),
    ).toEqual(['/Rooted.cs', 'src/Nested.cs', '/Other.cs']);
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    const other: ReadonlySet<string> = new Set(['App2/Models/Only.cs']);
    const configs: CSharpProjectConfig[] = [{ rootNamespace: 'App', projectDir: 'App2' }];
    expect(resolveCSharpImportInternal('App.Models', configs, other, undefined)).toEqual([
      'App2/Models/Only.cs',
    ]);
    expect(resolveCSharpImportInternal('App.Models', configs, ALL_FILE_PATHS, undefined)).toEqual(
      [],
    );
  });
});

/**
 * ABSOLUTE arms, deliberately not differential.
 *
 * The harness above is blind to everything in this block. Its frozen legacy copy
 * carries the same `dirPrefix === '' ? indexOf : lastIndexOf` rule production
 * does (see `directChildIdx`, and the header's note that #2881's edit landed in
 * BOTH), so where #2881 moved step 2 the two sides moved together and the
 * differential stays green by construction. Only stated expectations can see
 * these, so each arm below names the exact line it gates.
 */
describe('C# csproj leg — where step 2 stops and step 3 begins (absolute)', () => {
  function corpus(raw: readonly string[]): { paths: ReadonlySet<string>; index: SuffixIndex } {
    const all = [...raw];
    const normalized = all.map((f) => f.replace(/\\/g, '/'));
    return { paths: new Set(all), index: buildSuffixIndex(normalized, all) };
  }

  const ROOT_NS_ONLY: CSharpProjectConfig[] = [{ rootNamespace: 'App', projectDir: '' }];

  it("step 2's empty-`dirPrefix` filter rejects a doubled slash, which is NOT one directory deep", () => {
    // Gates the five-line `if (dirPrefix === '')` guard in step 2 of
    // `resolveCSharpImportInternal`. Delete it and this arm is the only thing in
    // the suite that fails.
    //
    // `getDirMap` keys a file under every suffix of its DIRECTORY, so the empty
    // key holds every path whose directory's last component is empty. That is a
    // leading '/' on a root-level file (`/Root.cs`, directory ''), but ALSO a
    // doubled slash immediately before the file name (`a//Doubled.cs`, directory
    // 'a/'). Only the first is one directory deep — the query an empty
    // `dirPrefix` is asking, and the one step 3 answers from `singleSegmentDirs`
    // — so without the guard step 2 and step 3 disagree.
    const { paths, index } = corpus([
      '/Root.cs',
      'a//Doubled.cs',
      'Top.cs',
      'one/Deep.cs',
      'a/b/Deeper.cs',
    ]);
    // Not vacuous: `a//Doubled.cs` really is in the bucket step 2 filters, so
    // this arm fails by ADDING it rather than by finding nothing to reject.
    expect(index.getFilesInDir('', '.cs')).toEqual(['/Root.cs', 'a//Doubled.cs']);
    expect(resolveCSharpImportInternal('App', ROOT_NS_ONLY, paths, index)).toEqual(['/Root.cs']);
  });

  it('step 2 answering a query it used to miss also PREEMPTS step 3', () => {
    // #2881 widened step 2 from "the FIRST `/<dirPrefix>/`" to "the directory
    // ENDS with `dirPrefix`". The justification reasons about step 2's own
    // bucket and is right there — but step 2 returns as soon as it pushes
    // anything, so a query it used to answer with nothing now also suppresses
    // step 3, whose unanchored match set is a strict SUPERSET of step 2's.
    //
    // Pinned in both directions: step 2's answer with an index, and step 3's own
    // answer with none. The gap between them is the suppression.
    const { paths, index } = corpus([
      'nest/src/SubModels/F0.cs',
      'SubModels/Models/F1.cs',
      'F2.cs',
      'SubModels/F3.cs',
    ]);
    // Step 2 alone: `SubModels/Models` is the only SEGMENT-aligned `Models`.
    expect(resolveCSharpImportInternal('App.Models', ROOT_NS_ONLY, paths, index)).toEqual([
      'SubModels/Models/F1.cs',
    ]);
    // Step 3 alone: every directory whose path merely ENDS with `Models`, which
    // is the segment-aligned hit plus both `SubModels` character-suffix ones.
    // Before #2881 step 2 rejected here and this was the answer; the widened
    // step 2 now returns first, and the narrower, more precise answer above is
    // the one that reaches the graph.
    expect(resolveCSharpImportInternal('App.Models', ROOT_NS_ONLY, paths, undefined)).toEqual([
      'nest/src/SubModels/F0.cs',
      'SubModels/Models/F1.cs',
      'SubModels/F3.cs',
    ]);
  });

  it('a name that is not a suffix of the PARENT directory stays out of the bucket', () => {
    // The negative control for the widened rule, matching the one Kotlin's
    // parity test carries. The rule is "the file's parent directory ENDS with
    // `dirPrefix`", not "`dirPrefix` appears anywhere in the path" — dropping
    // the first-occurrence half must not widen it that far. Both positions the
    // old `indexOf` distinguished are covered: leading, and mid-path.
    //
    // Asserted through both legs, because they run different predicates on
    // different indexes and either one alone could widen without the other.
    const { paths, index } = corpus([
      'Models/sub/Leading.cs',
      'top/Models/mid/Middle.cs',
      'Models/Direct.cs',
    ]);
    expect(resolveCSharpImportInternal('App.Models', ROOT_NS_ONLY, paths, index)).toEqual([
      'Models/Direct.cs',
    ]);
    expect(resolveCSharpImportInternal('App.Models', ROOT_NS_ONLY, paths, undefined)).toEqual([
      'Models/Direct.cs',
    ]);
  });
});
