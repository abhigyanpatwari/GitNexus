/**
 * `buildSuffixIndex` builds NOTHING at construction. Each of its three maps is
 * built the first time a question needs it, and one of them is DERIVED from
 * another rather than traversed for. (The file name predates the change: #2903
 * deferred `dirMap` alone, and the two suffix maps followed.)
 *
 * What the index now does:
 *
 *  - `get` builds `exactMap` by one pass over the file list;
 *  - `getInsensitive` after `get` DERIVES `lowerMap` from `exactMap` — one pass
 *    over that map's distinct keys, not a second pass over the file list;
 *  - `getInsensitive` first builds `lowerMap` straight off the file list, so a
 *    case-insensitive-only consumer holds exactly one map. Asking `get`
 *    afterwards is the documented fallback and does cost the second traversal;
 *    no consumer uses that order;
 *  - `getFilesInDir` builds `dirMap`, unchanged since #2903;
 *  - and over the pre-lowercased list `pass-cache.ts` hands it (TypeScript,
 *    JavaScript, Vue) the derivation is the identity, so `getInsensitive` reads
 *    the exact map ITSELF rather than a copy of it — one map, both questions.
 *
 * All of it is memory. `dirMap` is the array-valued map — one entry and one
 * array push per file per directory component, O(files × depth) in entries and
 * in churn — and only four call sites ever read it
 * (`import-resolvers/{php,csharp,jvm}.ts`, `import-resolvers/configs/
 * python.ts`), yet `workspace-file-index.ts` serving Ruby,
 * `languages/typescript/scope-resolver.ts`, `languages/vue/import-target.ts`
 * and `group/extractors/include-extractor.ts` all built it and never touched
 * it: ~15% of the retained C# index and ~19% of the retained Ruby one on
 * `bench/import-target/`'s 32k-path arms. The suffix maps are the same story
 * one level down — `languages/java/import-target.ts` reads only `get` and was
 * carrying 49.98 MiB of dead `lowerMap` at 32k paths, `languages/php/
 * import-target.ts` reads only `getInsensitive` and was carrying 34.49 MiB of
 * dead `exactMap`. Retained index: Java 80.26 -> 25.61 MiB, PHP 60.86 ->
 * 32.09, JavaScript 44.07 -> 22.65. Since #2877-#2880 these indexes live for a
 * whole resolution pass rather than being rebuilt per import, so all of that is
 * retained memory against the #2649 kernel-scale OOM constraint.
 *
 * Deferring and deriving are only free if two things hold, and this file
 * asserts both:
 *
 *  1. **Nothing observable moved.** `eagerDirMap` and `eagerSuffixMaps` below
 *     are verbatim copies of the pre-change loops, and the parity arms compare
 *     the built-on-demand answers against them over the FULL key space each
 *     corpus can produce — every suffix in three spellings, every directory
 *     suffix crossed with every extension, hits and misses alike — plus
 *     hand-written arms that pin buckets, collisions and their ORDER outright,
 *     so a parity arm cannot pass by two implementations being wrong together.
 *     Order is load-bearing twice over: `php.ts` returns `candidates[0]`, and
 *     the derived `lowerMap` is claimed byte-equal to a freshly built one in
 *     keys, values AND insertion order. Insertion order is not readable through
 *     this API, but its one consequence is: which file a case-folded key
 *     resolves to when several fold together. The parity arms run in BOTH build
 *     orders — derived and built-direct — over corpora that include
 *     case-colliding twins and a context-sensitive Greek final sigma.
 *  2. **Each map is built at most ONCE, and only if asked for.** The laziness
 *     arms count index reads of the two input arrays. Every build pass reads
 *     each element exactly once, so the read count IS the pass count: 0 after
 *     construction, 1 for a `get`-only consumer however many times it asks, 1
 *     for a `getInsensitive`-only consumer, still 1 for `get` THEN
 *     `getInsensitive` because the derivation reads no file, and one more —
 *     once, forever — for `getFilesInDir`. Memoizing the DECISION rather than
 *     the MAP, rebuilding whenever a lookup misses, reads 3, 4, 5. This is a
 *     structural count, not a timing or a memory delta: exact and deterministic
 *     on any machine.
 *
 * What the counter cannot see is a map derived from another map, since that
 * touches no file: it would catch a `lowerMap` rebuilt from the LIST beside a
 * `get`, not one copied from `exactMap`. That is why the derivation is measured
 * as costing zero passes rather than assumed absent, and why its contents are
 * policed by the parity arms instead.
 *
 * Every count assertion is paired with a result assertion. A pass count of 0 is
 * equally true of an index that has stopped answering — the pairing rule of
 * `test/helpers/counting-file-set.ts` and the twelve
 * `test/integration/*-import-index-reuse.test.ts` guards.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSuffixIndex,
  type SuffixIndex,
} from '../../../src/core/ingestion/import-resolvers/utils.js';

// ─── verbatim pre-change implementations ─────────────────────────────────────

/**
 * The directory-membership half of `buildSuffixIndex` exactly as it stood
 * before #2903, lifted out of the shared loop and otherwise untouched. This is
 * the specification the deferred build is measured against.
 */
function eagerDirMap(normalizedFileList: string[], allFileList: string[]): Map<string, string[]> {
  const dirMap = new Map<string, string[]>();

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    const original = allFileList[i];
    const parts = normalized.split('/');

    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
      const dirParts = parts.slice(0, -1);
      const fileName = parts[parts.length - 1];
      const ext = fileName.substring(fileName.lastIndexOf('.'));

      for (let j = dirParts.length - 1; j >= 0; j--) {
        const dirSuffix = dirParts.slice(j).join('/');
        const key = `${dirSuffix}:${ext}`;
        let list = dirMap.get(key);
        if (!list) {
          list = [];
          dirMap.set(key, list);
        }
        list.push(original);
      }
    }
  }

  return dirMap;
}

/** The two suffix questions, however they happen to be answered. */
type SuffixAnswerer = Pick<SuffixIndex, 'get' | 'getInsensitive'>;

/**
 * The two suffix maps of `buildSuffixIndex` exactly as they stood before this
 * change: ONE fused traversal writing both, suffixes cut with `split('/')` plus
 * `slice(j).join('/')`, first spelling winning in each map independently. This
 * is the specification both the deferred exact map and the derived case-folded
 * map are measured against — and it is also the reference for the suffix-
 * cutting rewrite that came with them (the production loop now walks slash
 * offsets and slices the original string instead of re-joining parts).
 */
function eagerSuffixMaps(normalizedFileList: string[], allFileList: string[]): SuffixAnswerer {
  const exactMap = new Map<string, string>();
  const lowerMap = new Map<string, string>();

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    const original = allFileList[i];
    const parts = normalized.split('/');

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

  return {
    get: (suffix: string) => exactMap.get(suffix),
    getInsensitive: (suffix: string) => lowerMap.get(suffix.toLowerCase()),
  };
}

// ─── corpus ──────────────────────────────────────────────────────────────────

/**
 * Raw paths, in index order. Each entry is here for a reason the parity arms
 * would not otherwise reach:
 *
 *  - `src/com/{example,other}` — the same basename under two directories that
 *    share a parent, so `com/example` and `example` must select differently;
 *  - `app/Models/Legacy/User.php` — a file one level DEEPER than the bucket
 *    under test, which must not appear in `Models`'s bucket (the map is keyed
 *    on directory SUFFIX, not prefix);
 *  - `Makefile` — repo root, no directory at all, and no extension: skipped
 *    entirely by `dirMap`'s `lastSlash >= 0` guard, while the suffix maps still
 *    hold it under its whole-path key, which is the one key the slash walk
 *    cannot emit;
 *  - `scripts/build` — no extension, but IN a directory. `lastIndexOf('.')` is
 *    -1 and `substring(-1)` clamps to 0, so the extension is the whole
 *    filename and the key is `scripts:build`. Odd, long-standing, and pinned
 *    here so deferring the build cannot quietly "fix" it;
 *  - `lib/vendor.min.js` before `lib/vendor.js` — multiple dots (extension is
 *    the LAST one), and a two-entry bucket whose order is not alphabetical, so
 *    an implementation that sorted or reversed would be caught;
 *  - `win\pkg\Thing.cs` — a backslash path, so the arms cover the raw-vs-
 *    normalized split: keys come off the NORMALIZED path, values are the
 *    ORIGINAL one.
 */
const RAW_FILES: readonly string[] = [
  'src/com/example/Foo.java',
  'src/com/example/Bar.java',
  'src/com/other/Foo.java',
  'app/Models/User.php',
  'app/Models/Post.php',
  'app/Models/Legacy/User.php',
  'Makefile',
  'scripts/build',
  'scripts/deploy.sh',
  'lib/vendor.min.js',
  'lib/vendor.js',
  'a/b/c/d.ts',
  'b/c/d.ts',
  'win\\pkg\\Thing.cs',
];

const ALL_FILES: string[] = [...RAW_FILES];
const NORMALIZED_FILES: string[] = ALL_FILES.map((f) => f.replace(/\\/g, '/'));

/**
 * Two paths that differ only in case, plus a three-way collision. Nothing about
 * the exact map is exercised here; the point is the case-folded one, where all
 * three spellings collapse to a single key and only ONE file can answer it. The
 * file that does is decided by insertion order, so this corpus is what makes
 * "the derived map has the same insertion order as a freshly built one" an
 * observable claim rather than an internal one.
 */
const CASE_TWIN_FILES: readonly string[] = [
  'src/Util/Helper.php',
  'src/util/helper.php',
  'app/README.md',
  'app/ReadMe.md',
  'app/readme.md',
  'lib/Model/User.php',
  'lib/model/USER.PHP',
];

/**
 * Paths whose `.toLowerCase()` is not a per-character mapping.
 *
 * `Σ` folds to `ς` at the end of a word and to `σ` elsewhere, and JS applies
 * that context rule: `'ΟΔΟΣ/x'` folds the sigma to `ς` (a slash is not a cased
 * letter, so the word ends) while `'ΟΔΟΣ.ts'` folds it to `σ` (`t` is). So
 * `src/ΟΔΟΣ/ΟΔΟΣ.ts` contributes the same segment spelling under two DIFFERENT
 * folded keys. A derivation that folded the whole path once and sliced the
 * result, or that folded per character, would answer differently here.
 * `İstanbul` (one code point, two after folding) and `Gruß`/`GRUSS` (which do
 * NOT collide under `toLowerCase`, unlike under full case folding) pin the two
 * other classic hazards.
 */
const UNICODE_FOLDING_FILES: readonly string[] = [
  'src/ΟΔΟΣ/Καλημέρα.ts',
  'src/ΟΔΟΣ.ts',
  'src/ΟΔΟΣ/ΟΔΟΣ.ts',
  'i18n/İstanbul/Page.tsx',
  'de/STRASSE/Gruß.ts',
  'de/strasse/GRUSS.ts',
];

/**
 * Slash spellings where cutting a suffix by slash offsets could disagree with
 * `split('/')` + `join('/')`: a leading slash (where the walk stops early and
 * the whole-path key is left to the write after the loop), a doubled slash (an
 * empty segment mid-path), a trailing slash (an empty final segment), and a
 * path with no slash at all, whose only key is that final write.
 */
const ODD_SLASH_FILES: readonly string[] = ['/root.ts', 'a//b/c.ts', 'dir/trailing/', 'plain.ts'];

interface Corpus {
  readonly name: string;
  readonly raw: readonly string[];
}

const PARITY_CORPORA: readonly Corpus[] = [
  { name: 'base', raw: RAW_FILES },
  { name: 'case-colliding twins', raw: CASE_TWIN_FILES },
  { name: 'unicode folding', raw: UNICODE_FOLDING_FILES },
  { name: 'slash oddities', raw: ODD_SLASH_FILES },
];

function corpusLists(raw: readonly string[]): { all: string[]; normalized: string[] } {
  const all = [...raw];
  return { all, normalized: all.map((f) => f.replace(/\\/g, '/')) };
}

// ─── probe spaces ────────────────────────────────────────────────────────────

/** Every directory suffix the corpus can produce, in first-seen order. */
function corpusDirSuffixes(normalized: readonly string[]): string[] {
  const suffixes: string[] = [];
  for (const path of normalized) {
    const parts = path.split('/');
    const dirParts = parts.slice(0, -1);
    for (let j = dirParts.length - 1; j >= 0; j--) {
      const suffix = dirParts.slice(j).join('/');
      if (!suffixes.includes(suffix)) suffixes.push(suffix);
    }
  }
  return suffixes;
}

/** Every extension the corpus can produce, in first-seen order. */
function corpusExtensions(normalized: readonly string[]): string[] {
  const extensions: string[] = [];
  for (const path of normalized) {
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    const ext = fileName.substring(fileName.lastIndexOf('.'));
    if (!extensions.includes(ext)) extensions.push(ext);
  }
  return extensions;
}

/**
 * The full `getFilesInDir` probe space: every directory suffix crossed with
 * every extension — so the parity arm asserts the misses too, not only the 19
 * populated keys — plus spellings that exist nowhere in the corpus at all.
 */
function dirProbeSpace(normalized: readonly string[]): Array<readonly [string, string]> {
  const probes: Array<readonly [string, string]> = [];
  for (const dirSuffix of corpusDirSuffixes(normalized)) {
    for (const ext of corpusExtensions(normalized)) probes.push([dirSuffix, ext]);
  }
  // Absent entirely: a directory PREFIX (`src`, which no file sits directly
  // in), a case variant (the map is case-sensitive, unlike `getInsensitive`), a
  // trailing-slash spelling, and a bare miss.
  for (const dirSuffix of ['src', 'app', 'models', 'Models/', 'nope']) {
    for (const ext of ['.php', '.java', '.nope', '']) probes.push([dirSuffix, ext]);
  }
  return probes;
}

function probeAllDirs(
  probes: ReadonlyArray<readonly [string, string]>,
  lookup: (dirSuffix: string, extension: string) => readonly string[],
): Record<string, readonly string[]> {
  const answers: Record<string, readonly string[]> = {};
  for (const [dirSuffix, ext] of probes)
    answers[`${dirSuffix}\u0000${ext}`] = lookup(dirSuffix, ext);
  return answers;
}

/**
 * The full suffix probe space: every key either suffix map can hold — every
 * suffix of every path, which is exactly what the build loops insert — each in
 * its own spelling plus its lowercased and uppercased forms, so the folded
 * lookups are driven with queries that hit, miss and collide. Plus spellings
 * absent from every corpus.
 */
function suffixProbeSpace(normalized: readonly string[]): string[] {
  const probes: string[] = [];
  const add = (probe: string): void => {
    if (!probes.includes(probe)) probes.push(probe);
  };
  for (const path of normalized) {
    const parts = path.split('/');
    for (let j = parts.length - 1; j >= 0; j--) {
      const suffix = parts.slice(j).join('/');
      add(suffix);
      add(suffix.toLowerCase());
      add(suffix.toUpperCase());
    }
  }
  for (const miss of ['', '/', 'nope.java', 'NOPE.JAVA', 'src', 'Foo', 'Foo.java/']) add(miss);
  return probes;
}

/**
 * Ask both suffix questions about every probe, `get` FIRST — so the exact map
 * exists before the first `getInsensitive` and the folded map is DERIVED.
 */
function answersGetFirst(
  probes: readonly string[],
  answerer: SuffixAnswerer,
): Record<string, string | null> {
  const answers: Record<string, string | null> = {};
  for (const probe of probes) {
    answers[`exact\u0000${probe}`] = answerer.get(probe) ?? null;
    answers[`folded\u0000${probe}`] = answerer.getInsensitive(probe) ?? null;
  }
  return answers;
}

/**
 * The same probes, `getInsensitive` FIRST — PHP's order, where the folded map
 * is built straight off the file list and the exact map is the later fallback.
 * `undefined` is mapped to `null` in both collectors because `toEqual` treats
 * an explicitly-undefined property as an absent one.
 */
function answersInsensitiveFirst(
  probes: readonly string[],
  answerer: SuffixAnswerer,
): Record<string, string | null> {
  const answers: Record<string, string | null> = {};
  for (const probe of probes) {
    answers[`folded\u0000${probe}`] = answerer.getInsensitive(probe) ?? null;
    answers[`exact\u0000${probe}`] = answerer.get(probe) ?? null;
  }
  return answers;
}

/** Every probe of every corpus, one flat table, so one `toEqual` covers all four. */
function answersAcrossCorpora(
  collect: (probes: readonly string[], answerer: SuffixAnswerer) => Record<string, string | null>,
  build: (normalized: string[], all: string[]) => SuffixAnswerer,
): Record<string, string | null> {
  const answers: Record<string, string | null> = {};
  for (const corpus of PARITY_CORPORA) {
    const { all, normalized } = corpusLists(corpus.raw);
    const collected = collect(suffixProbeSpace(normalized), build(normalized, all));
    for (const [key, value] of Object.entries(collected)) {
      answers[`${corpus.name}\u0000${key}`] = value;
    }
  }
  return answers;
}

// ─── read-counting file lists ────────────────────────────────────────────────

interface CountingList {
  /** A real `string[]`, so `buildSuffixIndex` takes it unmodified. */
  readonly list: string[];
  /** Element reads so far. Every build pass reads each element once. */
  reads: () => number;
}

/**
 * A `string[]` whose elements are accessor properties, so every `list[i]` is
 * counted. An accessor on a real array rather than a `Proxy` keeps the value a
 * genuine `Array` — `.length` and every array method behave normally — and
 * counts only indexed reads, never `.length`.
 */
function countingList(paths: readonly string[]): CountingList {
  let reads = 0;
  const list = new Array<string>(paths.length);
  paths.forEach((value, i) => {
    Object.defineProperty(list, i, {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return value;
      },
    });
  });
  return { list, reads: () => reads };
}

/** One full pass over the file list reads every element of both arrays once. */
const ONE_PASS = RAW_FILES.length;

/** Lookups driven bare before a count is read — the count must not move. */
const LOOKUP_REPEATS = 20;

/** `import-resolvers/pass-cache.ts` builds exactly this: lowercased, not slash-normalized. */
const LOWERCASED_FILES: string[] = ALL_FILES.map((f) => f.toLowerCase());

// ─── parity: the directory map ───────────────────────────────────────────────

describe('buildSuffixIndex.getFilesInDir — the deferred build is behaviour-identical', () => {
  it('answers the full probe space exactly as the eager implementation did', () => {
    const index = buildSuffixIndex(NORMALIZED_FILES, ALL_FILES);
    const reference = eagerDirMap(NORMALIZED_FILES, ALL_FILES);
    const probes = dirProbeSpace(NORMALIZED_FILES);

    const deferred = probeAllDirs(probes, (dir, ext) => index.getFilesInDir(dir, ext));
    const eager = probeAllDirs(probes, (dir, ext) => reference.get(`${dir}:${ext}`) ?? []);

    // A guard on the instrument: an empty or collapsed probe space would make
    // the comparison below vacuous.
    expect(probes.length).toBe(164);
    expect(Object.values(eager).filter((files) => files.length > 0).length).toBe(19);
    expect(deferred).toEqual(eager);
  });

  it('pins each bucket and its order outright, not only against the old code', () => {
    const index = buildSuffixIndex(NORMALIZED_FILES, ALL_FILES);

    expect({
      // Same basename under sibling directories: the deeper suffix disambiguates.
      'example:.java': index.getFilesInDir('example', '.java'),
      'com/example:.java': index.getFilesInDir('com/example', '.java'),
      'src/com/example:.java': index.getFilesInDir('src/com/example', '.java'),
      'other:.java': index.getFilesInDir('other', '.java'),
      // `Legacy/User.php` is one level deeper and belongs to `Legacy`, not `Models`.
      'Models:.php': index.getFilesInDir('Models', '.php'),
      'Legacy:.php': index.getFilesInDir('Legacy', '.php'),
      'Models/Legacy:.php': index.getFilesInDir('Models/Legacy', '.php'),
      // Multiple dots: the extension is the LAST one, and the bucket keeps
      // index order (`vendor.min.js` was indexed first) rather than sorting.
      'lib:.js': index.getFilesInDir('lib', '.js'),
      // No extension at all: `substring(-1)` clamps to 0, so the "extension"
      // is the whole filename.
      'scripts:build': index.getFilesInDir('scripts', 'build'),
      'scripts:.sh': index.getFilesInDir('scripts', '.sh'),
      // Keyed on the normalized path, holding the ORIGINAL raw one.
      'pkg:.cs': index.getFilesInDir('pkg', '.cs'),
      'win/pkg:.cs': index.getFilesInDir('win/pkg', '.cs'),
      // Two files in same-named leaf directories at different depths.
      'c:.ts': index.getFilesInDir('c', '.ts'),
      'b/c:.ts': index.getFilesInDir('b/c', '.ts'),
      'a/b/c:.ts': index.getFilesInDir('a/b/c', '.ts'),
      // Misses: a repo-root file is in no bucket; `src` is a PREFIX, never a
      // directory suffix any file sits directly in; the key is case-sensitive.
      ':': index.getFilesInDir('', ''),
      'src:.java': index.getFilesInDir('src', '.java'),
      'models:.php': index.getFilesInDir('models', '.php'),
      'Models:.java': index.getFilesInDir('Models', '.java'),
    }).toEqual({
      'example:.java': ['src/com/example/Foo.java', 'src/com/example/Bar.java'],
      'com/example:.java': ['src/com/example/Foo.java', 'src/com/example/Bar.java'],
      'src/com/example:.java': ['src/com/example/Foo.java', 'src/com/example/Bar.java'],
      'other:.java': ['src/com/other/Foo.java'],
      'Models:.php': ['app/Models/User.php', 'app/Models/Post.php'],
      'Legacy:.php': ['app/Models/Legacy/User.php'],
      'Models/Legacy:.php': ['app/Models/Legacy/User.php'],
      'lib:.js': ['lib/vendor.min.js', 'lib/vendor.js'],
      'scripts:build': ['scripts/build'],
      'scripts:.sh': ['scripts/deploy.sh'],
      'pkg:.cs': ['win\\pkg\\Thing.cs'],
      'win/pkg:.cs': ['win\\pkg\\Thing.cs'],
      'c:.ts': ['a/b/c/d.ts', 'b/c/d.ts'],
      'b/c:.ts': ['a/b/c/d.ts', 'b/c/d.ts'],
      'a/b/c:.ts': ['a/b/c/d.ts'],
      ':': [],
      'src:.java': [],
      'models:.php': [],
      'Models:.java': [],
    });
  });

  it('returns the same answers whether or not suffix lookups came first', () => {
    const warmed = buildSuffixIndex(NORMALIZED_FILES, ALL_FILES);
    warmed.get('Foo.java');
    warmed.getInsensitive('USER.PHP');
    warmed.getFilesInDir('nope', '.nope');
    const cold = buildSuffixIndex(NORMALIZED_FILES, ALL_FILES);
    const probes = dirProbeSpace(NORMALIZED_FILES);

    expect(probeAllDirs(probes, (d, e) => warmed.getFilesInDir(d, e))).toEqual(
      probeAllDirs(probes, (d, e) => cold.getFilesInDir(d, e)),
    );
  });

  it('leaves the suffix answers untouched — building the dir map moves nothing', () => {
    const index = buildSuffixIndex(NORMALIZED_FILES, ALL_FILES);
    index.getFilesInDir('Models', '.php');

    expect({
      exact: index.get('example/Foo.java'),
      // First path wins for an ambiguous suffix.
      ambiguous: index.get('Foo.java'),
      insensitive: index.getInsensitive('APP/MODELS/USER.PHP'),
      // The suffix maps are built off the normalized path and return the raw one.
      backslash: index.get('pkg/Thing.cs'),
      miss: index.get('nope.java'),
    }).toEqual({
      exact: 'src/com/example/Foo.java',
      ambiguous: 'src/com/example/Foo.java',
      insensitive: 'app/Models/User.php',
      backslash: 'win\\pkg\\Thing.cs',
      miss: undefined,
    });
  });
});

// ─── parity: the derived case-folded map ─────────────────────────────────────

describe('buildSuffixIndex suffix maps — derived answers are the eager answers', () => {
  it('answers the full suffix key space as the eager fused loop did, in both build orders', () => {
    const eager = answersAcrossCorpora(answersGetFirst, eagerSuffixMaps);
    // `get` first: the folded map is DERIVED from the exact one.
    const derived = answersAcrossCorpora(answersGetFirst, (normalized, all) =>
      buildSuffixIndex(normalized, all),
    );
    // `getInsensitive` first: the folded map is built straight off the list,
    // and the exact map is the fallback traversal behind it.
    const direct = answersAcrossCorpora(answersInsensitiveFirst, (normalized, all) =>
      buildSuffixIndex(normalized, all),
    );

    // Guards on the instrument: a collapsed probe space, or a reference that
    // answered nothing, would make both comparisons vacuous.
    expect(Object.keys(eager).length).toBe(430);
    expect(Object.values(eager).filter((file) => file !== null).length).toBe(268);
    expect(derived).toEqual(eager);
    expect(direct).toEqual(eager);
  });

  it('pins first-in-file-order for case-folded collisions, derived or built direct', () => {
    const { all, normalized } = corpusLists(CASE_TWIN_FILES);
    const derived = buildSuffixIndex(normalized, all);
    // Exact map first, so the folded map below is derived rather than built.
    const derivedExact = derived.get('Util/Helper.php');
    const direct = buildSuffixIndex(normalized, all);

    expect({
      derivedExact,
      // Two spellings of one path; the FIRST indexed answers both queries and
      // `src/util/helper.php` answers neither. Insertion order is the only
      // thing that decides this, and it must survive the derivation.
      derivedTwin: derived.getInsensitive('HELPER.PHP'),
      directTwin: direct.getInsensitive('HELPER.PHP'),
      derivedTwinPath: derived.getInsensitive('SRC/UTIL/HELPER.PHP'),
      directTwinPath: direct.getInsensitive('SRC/UTIL/HELPER.PHP'),
      // Three spellings collapse to one folded key: the first still wins.
      derivedThreeWay: derived.getInsensitive('app/readme.md'),
      directThreeWay: direct.getInsensitive('app/readme.md'),
      // The exact map keeps them apart; only the folded one collapses.
      derivedUpper: derived.get('Model/User.php'),
      derivedLower: derived.get('model/USER.PHP'),
      // `get` after `getInsensitive` is the fallback order: a second traversal,
      // the same answers.
      directUpper: direct.get('Model/User.php'),
      directLower: direct.get('model/USER.PHP'),
      directMiss: direct.get('model/User.php'),
    }).toEqual({
      derivedExact: 'src/Util/Helper.php',
      derivedTwin: 'src/Util/Helper.php',
      directTwin: 'src/Util/Helper.php',
      derivedTwinPath: 'src/Util/Helper.php',
      directTwinPath: 'src/Util/Helper.php',
      derivedThreeWay: 'app/README.md',
      directThreeWay: 'app/README.md',
      derivedUpper: 'lib/Model/User.php',
      derivedLower: 'lib/model/USER.PHP',
      directUpper: 'lib/Model/User.php',
      directLower: 'lib/model/USER.PHP',
      directMiss: undefined,
    });
  });

  it('pins the context-sensitive folds outright, derived or built direct', () => {
    const { all, normalized } = corpusLists(UNICODE_FOLDING_FILES);
    const derived = buildSuffixIndex(normalized, all);
    const derivedExact = derived.get('ΟΔΟΣ.ts');
    const direct = buildSuffixIndex(normalized, all);

    expect({
      derivedExact,
      // `Σ` before `.ts` is not word-final, so it folds to `σ`...
      derivedNonFinal: derived.getInsensitive('ΟΔΟΣ.ts'),
      directNonFinal: direct.getInsensitive('ΟΔΟΣ.ts'),
      // ...and the folded key really is spelled with `σ`, not `ς`.
      derivedSigmaKey: derived.getInsensitive('οδοσ.ts'),
      derivedFinalSigmaKey: derived.getInsensitive('οδος.ts'),
      // Before a slash it IS word-final and folds to `ς` — the same segment
      // spelling, a different key, from the same path.
      derivedFinal: derived.getInsensitive('ΟΔΟΣ/ΟΔΟΣ.ts'),
      directFinal: direct.getInsensitive('ΟΔΟΣ/ΟΔΟΣ.ts'),
      derivedFinalTyped: derived.getInsensitive('οδος/οδοσ.ts'),
      // One code point folding to two: `İ` -> `i` + U+0307.
      derivedDotted: derived.getInsensitive('İSTANBUL/PAGE.TSX'),
      directDotted: direct.getInsensitive('İstanbul/Page.tsx'),
      // `ß` and `SS` are distinct under `toLowerCase`, unlike full case folding.
      derivedSharpS: derived.getInsensitive('STRASSE/GRUß.TS'),
      derivedDoubleS: derived.getInsensitive('STRASSE/GRUSS.TS'),
    }).toEqual({
      derivedExact: 'src/ΟΔΟΣ.ts',
      derivedNonFinal: 'src/ΟΔΟΣ.ts',
      directNonFinal: 'src/ΟΔΟΣ.ts',
      derivedSigmaKey: 'src/ΟΔΟΣ.ts',
      derivedFinalSigmaKey: undefined,
      derivedFinal: 'src/ΟΔΟΣ/ΟΔΟΣ.ts',
      directFinal: 'src/ΟΔΟΣ/ΟΔΟΣ.ts',
      derivedFinalTyped: 'src/ΟΔΟΣ/ΟΔΟΣ.ts',
      derivedDotted: 'i18n/İstanbul/Page.tsx',
      directDotted: 'i18n/İstanbul/Page.tsx',
      derivedSharpS: 'de/STRASSE/Gruß.ts',
      derivedDoubleS: 'de/strasse/GRUSS.ts',
    });
  });
});

// ─── laziness ────────────────────────────────────────────────────────────────

describe('buildSuffixIndex — nothing is built at construction, each map once on first use', () => {
  it('reads the file list zero times at construction, and one pass for all suffix lookups', () => {
    const normalized = countingList(NORMALIZED_FILES);
    const all = countingList(ALL_FILES);

    const index = buildSuffixIndex(normalized.list, all.list);
    const afterBuild = { normalized: normalized.reads(), all: all.reads() };

    index.get('Foo.java');
    index.get('nope.java');
    index.getInsensitive('APP/MODELS/USER.PHP');
    index.getInsensitive('nope.java');

    expect({
      afterBuild,
      afterSuffixLookups: { normalized: normalized.reads(), all: all.reads() },
      // A count of zero is equally the count of an index that answers nothing.
      answer: index.get('Foo.java'),
      folded: index.getInsensitive('APP/MODELS/USER.PHP'),
    }).toEqual({
      afterBuild: { normalized: 0, all: 0 },
      afterSuffixLookups: { normalized: ONE_PASS, all: ONE_PASS },
      answer: 'src/com/example/Foo.java',
      folded: 'app/Models/User.php',
    });
  });

  it('builds ONE map for a get-only consumer — Java never pays for the folded map', () => {
    const normalized = countingList(NORMALIZED_FILES);
    const all = countingList(ALL_FILES);

    const index = buildSuffixIndex(normalized.list, all.list);
    const atConstruction = { normalized: normalized.reads(), all: all.reads() };

    // Driven bare: asserting inside the loop restates one bit twenty times.
    for (let i = 0; i < LOOKUP_REPEATS; i++) {
      index.get('Foo.java');
      index.get('example/Foo.java');
      index.get('nope.java');
    }

    expect({
      // A second map built eagerly BESIDE the exact one shows up HERE — fused
      // into the same loop, as it used to be, or in a loop of its own. Fused,
      // the total below does not move at all, so this field is the only thing
      // that catches it.
      atConstruction,
      afterManyGets: { normalized: normalized.reads(), all: all.reads() },
      exact: index.get('example/Foo.java'),
      ambiguous: index.get('Foo.java'),
      miss: index.get('nope.java'),
    }).toEqual({
      atConstruction: { normalized: 0, all: 0 },
      afterManyGets: { normalized: ONE_PASS, all: ONE_PASS },
      exact: 'src/com/example/Foo.java',
      ambiguous: 'src/com/example/Foo.java',
      miss: undefined,
    });
  });

  it('builds ONE map for a getInsensitive-only consumer — PHP never pays for the exact map', () => {
    const normalized = countingList(NORMALIZED_FILES);
    const all = countingList(ALL_FILES);

    const index = buildSuffixIndex(normalized.list, all.list);
    const atConstruction = { normalized: normalized.reads(), all: all.reads() };

    for (let i = 0; i < LOOKUP_REPEATS; i++) {
      index.getInsensitive('USER.PHP');
      index.getInsensitive('APP/MODELS/USER.PHP');
      index.getInsensitive('NOPE.PHP');
    }

    expect({
      atConstruction,
      afterManyLookups: { normalized: normalized.reads(), all: all.reads() },
      basename: index.getInsensitive('USER.PHP'),
      path: index.getInsensitive('APP/MODELS/USER.PHP'),
      miss: index.getInsensitive('NOPE.PHP'),
    }).toEqual({
      atConstruction: { normalized: 0, all: 0 },
      afterManyLookups: { normalized: ONE_PASS, all: ONE_PASS },
      basename: 'app/Models/User.php',
      path: 'app/Models/User.php',
      miss: undefined,
    });
  });

  it('derives the folded map from the exact one — the second question costs no pass', () => {
    const normalized = countingList(NORMALIZED_FILES);
    const all = countingList(ALL_FILES);

    const index = buildSuffixIndex(normalized.list, all.list);
    const exact = index.get('Foo.java');
    const afterGet = { normalized: normalized.reads(), all: all.reads() };

    for (let i = 0; i < LOOKUP_REPEATS; i++) {
      index.getInsensitive('FOO.JAVA');
      index.getInsensitive('APP/MODELS/USER.PHP');
      index.getInsensitive('NOPE.JAVA');
    }

    expect({
      afterGet,
      // The derivation walks the exact map's keys, never the file list, so this
      // must not move. A second full traversal would read a second pass.
      afterDerivation: { normalized: normalized.reads(), all: all.reads() },
      exact,
      folded: index.getInsensitive('FOO.JAVA'),
      foldedPath: index.getInsensitive('APP/MODELS/USER.PHP'),
      foldedMiss: index.getInsensitive('NOPE.JAVA'),
    }).toEqual({
      afterGet: { normalized: ONE_PASS, all: ONE_PASS },
      afterDerivation: { normalized: ONE_PASS, all: ONE_PASS },
      exact: 'src/com/example/Foo.java',
      folded: 'src/com/example/Foo.java',
      foldedPath: 'app/Models/User.php',
      foldedMiss: undefined,
    });
  });

  it('pays the second traversal only in the order no consumer uses — folded, then exact', () => {
    const normalized = countingList(NORMALIZED_FILES);
    const all = countingList(ALL_FILES);

    const index = buildSuffixIndex(normalized.list, all.list);
    const folded = index.getInsensitive('FOO.JAVA');
    const afterInsensitive = { normalized: normalized.reads(), all: all.reads() };

    for (let i = 0; i < LOOKUP_REPEATS; i++) index.get('Foo.java');

    expect({
      afterInsensitive,
      // There is nothing to derive an exact map FROM, so this order costs the
      // traversal the other one saves. Documented, unused, and still correct.
      afterFallback: { normalized: normalized.reads(), all: all.reads() },
      folded,
      exact: index.get('Foo.java'),
      // Case-sensitive again, which is the point of the fallback being a real
      // second map rather than an alias of the folded one.
      exactMiss: index.get('FOO.JAVA'),
    }).toEqual({
      afterInsensitive: { normalized: ONE_PASS, all: ONE_PASS },
      afterFallback: { normalized: ONE_PASS * 2, all: ONE_PASS * 2 },
      folded: 'src/com/example/Foo.java',
      exact: 'src/com/example/Foo.java',
      exactMiss: undefined,
    });
  });

  it('takes exactly one more pass on the first getFilesInDir, and none after', () => {
    const normalized = countingList(NORMALIZED_FILES);
    const all = countingList(ALL_FILES);

    const index = buildSuffixIndex(normalized.list, all.list);
    const beforeFirst = { normalized: normalized.reads(), all: all.reads() };

    index.getFilesInDir('Models', '.php');
    const afterFirst = { normalized: normalized.reads(), all: all.reads() };

    // Hits, misses and repeats alike: memoizing the DECISION instead of the
    // MAP would rebuild on every one of these and the count would climb.
    index.getFilesInDir('Models', '.php');
    index.getFilesInDir('example', '.java');
    index.getFilesInDir('nope', '.nope');
    index.getFilesInDir('nope', '.nope');
    index.getFilesInDir('', '');

    expect({
      beforeFirst,
      afterFirst,
      afterMany: { normalized: normalized.reads(), all: all.reads() },
      answer: index.getFilesInDir('Models', '.php'),
    }).toEqual({
      beforeFirst: { normalized: 0, all: 0 },
      afterFirst: { normalized: ONE_PASS, all: ONE_PASS },
      afterMany: { normalized: ONE_PASS, all: ONE_PASS },
      answer: ['app/Models/User.php', 'app/Models/Post.php'],
    });
  });

  it('defers per index, not per module — a second index starts cold', () => {
    const firstNormalized = countingList(NORMALIZED_FILES);
    const firstAll = countingList(ALL_FILES);
    const first = buildSuffixIndex(firstNormalized.list, firstAll.list);
    first.getFilesInDir('Models', '.php');

    const secondNormalized = countingList(NORMALIZED_FILES);
    const secondAll = countingList(ALL_FILES);
    const second = buildSuffixIndex(secondNormalized.list, secondAll.list);

    expect({
      first: { normalized: firstNormalized.reads(), all: firstAll.reads() },
      // Cold even though a fully built index of the same paths exists: the maps
      // hang off the closure, not off the module.
      second: { normalized: secondNormalized.reads(), all: secondAll.reads() },
      // Pairing rule: a count of zero must not be the count of an index that
      // answers nothing. The second index still resolves once asked.
      secondAnswer: second.getFilesInDir('Models', '.php'),
      secondReadsAfterAsking: secondNormalized.reads(),
    }).toEqual({
      first: { normalized: ONE_PASS, all: ONE_PASS },
      second: { normalized: 0, all: 0 },
      secondAnswer: ['app/Models/User.php', 'app/Models/Post.php'],
      secondReadsAfterAsking: ONE_PASS,
    });
  });

  it('aliases one map for both questions when the caller pre-lowercased the list', () => {
    // `pass-cache.ts` (TypeScript, JavaScript, Vue) passes a lowercased list and
    // says so, and over such a list the derivation is the identity — so the
    // folded map is the exact map, not a copy of it, in either asking order.
    const getFirstNormalized = countingList(LOWERCASED_FILES);
    const getFirstAll = countingList(ALL_FILES);
    const getFirst = buildSuffixIndex(getFirstNormalized.list, getFirstAll.list, {
      alreadyLowercased: true,
    });
    const getFirstExact = getFirst.get('app/models/user.php');
    const getFirstFolded = getFirst.getInsensitive('APP/MODELS/USER.PHP');

    const foldedFirstNormalized = countingList(LOWERCASED_FILES);
    const foldedFirstAll = countingList(ALL_FILES);
    const foldedFirst = buildSuffixIndex(foldedFirstNormalized.list, foldedFirstAll.list, {
      alreadyLowercased: true,
    });
    const foldedFirstFolded = foldedFirst.getInsensitive('APP/MODELS/USER.PHP');
    const foldedFirstExact = foldedFirst.get('app/models/user.php');

    expect({
      getFirstReads: { normalized: getFirstNormalized.reads(), all: getFirstAll.reads() },
      foldedFirstReads: { normalized: foldedFirstNormalized.reads(), all: foldedFirstAll.reads() },
      getFirstExact,
      getFirstFolded,
      foldedFirstFolded,
      foldedFirstExact,
      // Values are the ORIGINAL paths; only the keys were lowercased.
      backslash: getFirst.getInsensitive('PKG/THING.CS'),
    }).toEqual({
      getFirstReads: { normalized: ONE_PASS, all: ONE_PASS },
      foldedFirstReads: { normalized: ONE_PASS, all: ONE_PASS },
      getFirstExact: 'app/Models/User.php',
      getFirstFolded: 'app/Models/User.php',
      foldedFirstFolded: 'app/Models/User.php',
      foldedFirstExact: 'app/Models/User.php',
      backslash: undefined,
    });
  });
});
