/**
 * Differential harness for the import-target index hoist (#2877 go, #2878
 * csharp, #2879 dart, #2880 ruby).
 *
 * Each of those resolvers answered its lookups with a full `allFilePaths` scan
 * per import — Ruby went further and rebuilt a whole `buildSuffixIndex` per
 * `require`. Replacing the scans with a per-run index is a pure performance
 * change ONLY if every implicit tie-break survives, and those tie-breaks are
 * expressed through Set-iteration order and `indexOf` positions rather than
 * through anything the type system or the existing tests can see:
 *
 *   - Go sorts the root-package leg and does NOT sort the package-dir leg;
 *   - Go and C# both take the FIRST occurrence of `/<segment>/` in the path, so
 *     a directory nested inside a same-named directory does not match;
 *   - C#'s `resolveDirectMatch` lets a whole-path match win over a suffix match
 *     found EARLIER in iteration order, while `resolveByProgressiveStripping`
 *     takes whichever comes first;
 *   - Dart tries `lib/<rel>` fully before bare `<rel>`, and compares raw paths
 *     (no backslash normalization) on both legs.
 *
 * So this file keeps verbatim copies of the pre-change implementations and
 * asserts the new ones agree with them on a deterministic corpus built to force
 * exactly those cases. The copies are the specification; if a future change
 * makes one of these fail, the resolver's OUTPUT moved and the graph's edges
 * move with it.
 *
 * The second half asserts the index is built once per file set rather than once
 * per import, by counting how often the Set is iterated. That is the regression
 * guard for PR #1918 review finding P1: an adapter that copies the Set
 * (`new Set(allFilePaths)`) hands a fresh `WeakMap` key per call and silently
 * restores the O(imports × files) behaviour while every correctness test still
 * passes.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';

import { resolveGoImportTarget } from '../../../src/core/ingestion/languages/go/import-target.js';
import { resolveDartImportTarget } from '../../../src/core/ingestion/languages/dart/import-target.js';
import { resolveRubyImportTarget } from '../../../src/core/ingestion/languages/ruby/import-target.js';
import {
  resolveCsharpImportTarget,
  type CsharpResolveContext,
} from '../../../src/core/ingestion/languages/csharp/import-target.js';
import { resolveRubyImportInternal } from '../../../src/core/ingestion/import-resolvers/ruby.js';
import { buildSuffixIndex } from '../../../src/core/ingestion/import-resolvers/utils.js';
import { isHeritageMarker } from '../../../src/core/ingestion/utils/heritage-marker.js';
import { csharpSuffixFallbackAllowed } from '../../../src/core/ingestion/csharp-namespace-gate.js';
import { DART_HERITAGE_PREFIX } from '../../../src/core/ingestion/languages/dart/interpret.js';

// ─── verbatim pre-change implementations ─────────────────────────────────────

function legacyFindRootPackageFiles(allFilePaths: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (const raw of allFilePaths) {
    const normalized = raw.replace(/\\/g, '/');
    if (normalized.includes('/')) continue;
    if (!normalized.endsWith('.go') || normalized.endsWith('_test.go')) continue;
    result.push(raw);
  }
  return result.sort();
}

function legacyFindAllFilesInPkgDir(allFilePaths: ReadonlySet<string>, pkgPath: string): string[] {
  const pkgDir = '/' + pkgPath + '/';
  const result: string[] = [];
  for (const raw of allFilePaths) {
    const normalized = '/' + raw.replace(/\\/g, '/');
    if (!normalized.includes(pkgDir)) continue;
    if (!normalized.endsWith('.go') || normalized.endsWith('_test.go')) continue;
    const afterPkg = normalized.substring(normalized.indexOf(pkgDir) + pkgDir.length);
    if (!afterPkg.includes('/')) result.push(raw);
  }
  return result;
}

function legacyResolveGoImportTarget(
  targetRaw: string,
  allFilePaths: ReadonlySet<string>,
  modulePath: string | undefined,
): string | readonly string[] | null {
  if (!targetRaw) return null;
  if (
    modulePath !== undefined &&
    (targetRaw === modulePath || targetRaw.startsWith(`${modulePath}/`))
  ) {
    const relativePkg = targetRaw === modulePath ? '' : targetRaw.slice(modulePath.length + 1);
    const files =
      relativePkg === ''
        ? legacyFindRootPackageFiles(allFilePaths)
        : legacyFindAllFilesInPkgDir(allFilePaths, relativePkg);
    if (files.length > 0) return files;
  }
  const parts = targetRaw.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const files = legacyFindAllFilesInPkgDir(allFilePaths, parts.slice(i).join('/'));
    if (files.length > 0) return files;
  }
  return null;
}

function legacyResolveDartRelative(
  rel: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const normFrom = fromFile.replace(/\\/g, '/');
  const fromDir = normFrom.includes('/') ? normFrom.slice(0, normFrom.lastIndexOf('/')) : '';
  const parts = fromDir.length > 0 ? fromDir.split('/') : [];
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const target = parts.join('/');
  if (allFilePaths.has(target)) return target;
  for (const fp of allFilePaths) {
    if (fp === target || fp.endsWith('/' + target)) return fp;
  }
  return null;
}

function legacyResolveDartImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | readonly string[] | null {
  if (targetRaw.startsWith(DART_HERITAGE_PREFIX)) return null;
  if (targetRaw === '') return null;
  if (targetRaw.startsWith('dart:')) return null;
  if (targetRaw.startsWith('package:')) {
    const slash = targetRaw.indexOf('/');
    if (slash === -1) return null;
    const relPath = targetRaw.slice(slash + 1);
    for (const candidate of [`lib/${relPath}`, relPath]) {
      for (const fp of allFilePaths) {
        if (fp === candidate || fp.endsWith('/' + candidate)) return fp;
      }
    }
    return null;
  }
  return legacyResolveDartRelative(targetRaw, fromFile, allFilePaths);
}

function legacyResolveRubyBare(
  targetRaw: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const normalizedFileList = [...allFilePaths].map((f) => f.replace(/\\/g, '/'));
  const allFileList = [...allFilePaths];
  const index = buildSuffixIndex(normalizedFileList, allFileList);
  return resolveRubyImportInternal(targetRaw, normalizedFileList, allFileList, index);
}

function legacyResolveRubyRelative(
  targetRaw: string,
  fromDir: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const segments = (fromDir ? fromDir + '/' + targetRaw : targetRaw).split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') resolved.pop();
    else resolved.push(seg);
  }
  const resolvedPath = resolved.join('/');
  const rbFile = `${resolvedPath}.rb`;
  if (allFilePaths.has(rbFile)) return rbFile;
  const indexFile = `${resolvedPath}/index.rb`;
  if (allFilePaths.has(indexFile)) return indexFile;
  if (resolvedPath.endsWith('.rb') && allFilePaths.has(resolvedPath)) return resolvedPath;
  return null;
}

function legacyResolveRubyImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | readonly string[] | null {
  if (!targetRaw) return null;
  if (isHeritageMarker(targetRaw)) return null;
  const fromNormalized = fromFile.replace(/\\/g, '/');
  const fromDir = fromNormalized.includes('/')
    ? fromNormalized.slice(0, fromNormalized.lastIndexOf('/'))
    : '';
  if (targetRaw.startsWith('./') || targetRaw.startsWith('../')) {
    return legacyResolveRubyRelative(targetRaw, fromDir, allFilePaths);
  }
  return legacyResolveRubyBare(targetRaw, allFilePaths);
}

function legacyFindDirectChild(
  allFilePaths: ReadonlySet<string>,
  dirSegment: string,
): string | null {
  const dirPrefix = `${dirSegment}/`;
  const nestedDirPrefix = `/${dirPrefix}`;
  for (const raw of allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.cs')) continue;
    const atRoot = f.startsWith(dirPrefix);
    const atNested = f.includes(nestedDirPrefix);
    if (!atRoot && !atNested) continue;
    const idx = atRoot ? 0 : f.indexOf(nestedDirPrefix) + 1;
    const after = f.slice(idx + dirPrefix.length);
    if (after.length > 0 && !after.includes('/')) return raw;
  }
  return null;
}

function legacyResolveDirectMatch(
  allFilePaths: ReadonlySet<string>,
  pathLike: string,
): string | null {
  const exactName = `${pathLike}.cs`;
  const nestedSuffix = `/${exactName}`;
  let suffixFile: string | null = null;
  for (const raw of allFilePaths) {
    const f = raw.replace(/\\/g, '/');
    if (!f.endsWith('.cs')) continue;
    if (f === exactName) return raw;
    if (suffixFile === null && f.endsWith(nestedSuffix)) suffixFile = raw;
  }
  if (suffixFile !== null) return suffixFile;
  return legacyFindDirectChild(allFilePaths, pathLike);
}

function legacyResolveByProgressiveStripping(
  allFilePaths: ReadonlySet<string>,
  pathLike: string,
): string | null {
  const segments = pathLike.split('/').filter(Boolean);
  for (let skip = 1; skip < segments.length; skip++) {
    const tail = segments.slice(skip).join('/');
    if (tail === '') continue;
    const tailFile = `${tail}.cs`;
    const tailSuffix = `/${tailFile}`;
    let tailFileMatch: string | null = null;
    for (const raw of allFilePaths) {
      const f = raw.replace(/\\/g, '/');
      if (!f.endsWith('.cs')) continue;
      if (f === tailFile || f.endsWith(tailSuffix)) {
        tailFileMatch = raw;
        break;
      }
    }
    if (tailFileMatch !== null) return tailFileMatch;
    const child = legacyFindDirectChild(allFilePaths, tail);
    if (child !== null) return child;
  }
  return null;
}

/** The no-csproj leg, which is the half #2878 moved onto the index. */
function legacyResolveCsharpNoCsproj(
  targetRaw: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  if (targetRaw === '') return null;
  const pathLike = targetRaw.replace(/\./g, '/');
  if (!csharpSuffixFallbackAllowed(targetRaw, undefined)) return null;
  const direct = legacyResolveDirectMatch(allFilePaths, pathLike);
  if (direct !== null) return direct;
  return legacyResolveByProgressiveStripping(allFilePaths, pathLike);
}

// ─── current implementations, called the way the orchestrator calls them ─────

function csharp(targetRaw: string, allFilePaths: ReadonlySet<string>): string | null {
  const ws: CsharpResolveContext = { fromFile: 'App/Program.cs', allFilePaths };
  const parsedImport: ParsedImport = {
    kind: 'namespace',
    localName: '_',
    importedName: '_',
    targetRaw,
  };
  return resolveCsharpImportTarget(parsedImport, ws as unknown as WorkspaceIndex);
}

// ─── deterministic corpus ────────────────────────────────────────────────────

/** Murmur3 finalizer — a reproducible stand-in for `Math.random()`. */
function mix(n: number): number {
  let x = n >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * Directory shapes, chosen so the corpus contains every case where the naive
 * "does the dir end with the segment" rewrite diverges from the original
 * first-`indexOf` predicate: a directory name nested inside itself
 * (`pkg/pkg`, `a/pkg/b/pkg`), the same leaf under several parents (collision
 * tie-breaks), an absolute-rooted layout, and the repo root.
 */
const DIRS = [
  '',
  'pkg',
  'a/pkg',
  'b/pkg',
  'pkg/pkg',
  'a/pkg/b/pkg',
  'internal/models',
  'x/internal/models',
  'lib',
  'lib/src',
  'vendor/lib',
  '/repo/pkg',
  '/repo/internal/models',
  'Models',
  'App/Models',
  'Models/Models',
];

const STEMS = ['main', 'models', 'util', 'client', 'index', 'pkg', 'lib', 'server'];

function corpus(seed: number, extension: string, fileCount: number): Set<string> {
  const files = new Set<string>();
  for (let i = 0; i < fileCount; i++) {
    const a = mix(seed * 7919 + i);
    const b = mix(a ^ 0x9e3779b9);
    const dir = DIRS[a % DIRS.length];
    const stem = STEMS[b % STEMS.length];
    // A slice of Go files are `_test.go`, which the package leg must exclude.
    const suffix = extension === '.go' && b % 5 === 0 ? '_test.go' : extension;
    const rel = `${stem}${suffix}`;
    files.add(dir === '' ? rel : `${dir}/${rel}`);
  }
  // Windows-shaped paths: the resolvers differ on whether they normalize, and
  // that difference is part of what must not move.
  files.add(`win\\dir\\thing${extension}`);
  return files;
}

const GO_TARGETS = [
  '',
  'fmt',
  'os',
  'pkg',
  'a/pkg',
  'pkg/pkg',
  'b/pkg',
  'internal/models',
  'x/internal/models',
  'example.com/mod',
  'example.com/mod/pkg',
  'example.com/mod/internal/models',
  'example.com/mod/nope',
  'github.com/org/repo/pkg',
  'github.com/org/repo/internal/models',
  'golang.org/x/sync/errgroup',
  'lib/src',
  'win/dir',
];

const DART_TARGETS = [
  '',
  'dart:core',
  'package:app/models.dart',
  'package:app/src/models.dart',
  'package:app',
  'package:other/lib/util.dart',
  'models.dart',
  './models.dart',
  '../models.dart',
  '../../lib/util.dart',
  'src/models.dart',
  'win\\dir\\thing.dart',
  `${DART_HERITAGE_PREFIX}Foo`,
];

const RUBY_TARGETS = [
  '',
  'json',
  'models',
  'util',
  'pkg/models',
  'internal/models',
  './models',
  '../util',
  './index',
  'lib/src/client',
  'Models',
];

const CSHARP_TARGETS = [
  '',
  'System',
  'System.Threading.Tasks',
  'Models',
  'App.Models',
  'Models.Models',
  'App.Models.Client',
  'Internal.Models',
  'X.Internal.Models',
  'Lib.Src',
  'Pkg.Pkg',
];

const DART_FROM_FILES = ['lib/main.dart', 'lib/src/main.dart', '/repo/pkg/main.dart', 'main.dart'];
const RUBY_FROM_FILES = ['lib/main.rb', 'lib/src/main.rb', 'a/pkg/main.rb', 'main.rb'];

// ─── parity ──────────────────────────────────────────────────────────────────

describe('import-target index hoist — output parity with the pre-change scans', () => {
  it('go: resolveGoImportTarget (#2877)', () => {
    let checked = 0;
    for (let repo = 0; repo < 40; repo++) {
      const files = corpus(repo, '.go', 6 + (repo % 25));
      for (const modulePath of [undefined, 'example.com/mod']) {
        const config = modulePath === undefined ? undefined : { modulePath };
        for (const target of GO_TARGETS) {
          const actual = resolveGoImportTarget(target, 'main.go', files, config);
          const expected = legacyResolveGoImportTarget(target, files, modulePath);
          // Array identity AND order: Go returns the whole list as the edge's
          // targets, so a reordering is an observable change.
          expect(actual, `go ${target} module=${modulePath} repo=${repo}`).toEqual(expected);
          checked++;
        }
      }
    }
    expect(checked).toBe(40 * 2 * GO_TARGETS.length);
  });

  it('dart: resolveDartImportTarget (#2879)', () => {
    let checked = 0;
    for (let repo = 0; repo < 40; repo++) {
      const files = corpus(repo, '.dart', 6 + (repo % 25));
      for (const fromFile of DART_FROM_FILES) {
        for (const target of DART_TARGETS) {
          const actual = resolveDartImportTarget(target, fromFile, files);
          const expected = legacyResolveDartImportTarget(target, fromFile, files);
          expect(actual, `dart ${target} from=${fromFile} repo=${repo}`).toEqual(expected);
          checked++;
        }
      }
    }
    expect(checked).toBe(40 * DART_FROM_FILES.length * DART_TARGETS.length);
  });

  it('ruby: resolveRubyImportTarget (#2880)', () => {
    let checked = 0;
    for (let repo = 0; repo < 40; repo++) {
      const files = corpus(repo, '.rb', 6 + (repo % 25));
      for (const fromFile of RUBY_FROM_FILES) {
        for (const target of RUBY_TARGETS) {
          const actual = resolveRubyImportTarget(target, fromFile, files);
          const expected = legacyResolveRubyImportTarget(target, fromFile, files);
          expect(actual, `ruby ${target} from=${fromFile} repo=${repo}`).toEqual(expected);
          checked++;
        }
      }
    }
    expect(checked).toBe(40 * RUBY_FROM_FILES.length * RUBY_TARGETS.length);
  });

  it('csharp: the no-csproj path (#2878)', () => {
    let checked = 0;
    for (let repo = 0; repo < 40; repo++) {
      const files = corpus(repo, '.cs', 6 + (repo % 25));
      for (const target of CSHARP_TARGETS) {
        const actual = csharp(target, files);
        const expected = legacyResolveCsharpNoCsproj(target, files);
        expect(actual, `csharp ${target} repo=${repo}`).toEqual(expected);
        checked++;
      }
    }
    expect(checked).toBe(40 * CSHARP_TARGETS.length);
  });

  /**
   * Hand-built layouts for the tie-breaks the generated corpus cannot reach —
   * every one of these was verified to FAIL against a plausible "simplified"
   * rewrite of the resolver it covers. `new Set([...])` preserves insertion
   * order, which IS the tie-break for most of them.
   */
  const HANDBUILT: {
    lang: 'go' | 'dart' | 'ruby' | 'csharp';
    why: string;
    files: string[];
    target: string;
    fromFile?: string;
    modulePath?: string;
  }[] = [
    {
      lang: 'csharp',
      why: 'whole-path match wins over a suffix match found EARLIER in Set order',
      files: ['a/Models.cs', 'Models.cs'],
      target: 'Models',
    },
    {
      lang: 'csharp',
      why: 'no whole-path file: first suffix match in Set order wins',
      files: ['b/Models.cs', 'a/Models.cs'],
      target: 'Models',
    },
    {
      lang: 'csharp',
      why: 'direct child of a NESTED namespace dir beats the root-level one when it comes first',
      files: ['App/Models/First.cs', 'Models/Second.cs'],
      target: 'Models',
    },
    {
      lang: 'csharp',
      why: 'a namespace dir nested inside itself does not answer the query',
      files: ['Models/Models/User.cs'],
      target: 'Models',
    },
    {
      lang: 'csharp',
      why: 'progressive prefix stripping reaches the tail namespace dir',
      files: ['Models/User.cs'],
      target: 'CrossFile.Models',
    },
    {
      lang: 'go',
      why: 'root package leg is SORTED',
      files: ['b.go', 'a.go', 'c_test.go'],
      target: 'example.com/mod',
      modulePath: 'example.com/mod',
    },
    {
      lang: 'go',
      why: 'package-dir leg is NOT sorted — it keeps Set order',
      files: ['x/pkg/b.go', 'x/pkg/a.go'],
      target: 'example.com/mod/x/pkg',
      modulePath: 'example.com/mod',
    },
    {
      lang: 'go',
      why: 'two directories share the suffix: results interleave back into Set order',
      files: ['a/pkg/one.go', 'b/a/pkg/two.go', 'a/pkg/three.go'],
      target: 'a/pkg',
    },
    {
      lang: 'go',
      why: 'a package dir nested inside itself does not answer the query',
      files: ['a/pkg/b/pkg/x.go'],
      target: 'a/pkg',
    },
    {
      lang: 'go',
      why: '_test.go files are a different package and never match',
      files: ['x/pkg/a_test.go'],
      target: 'x/pkg',
    },
    {
      lang: 'dart',
      why: '`lib/<rel>` beats bare `<rel>` even when the bare hit comes FIRST in Set order',
      files: ['a/models.dart', 'z/lib/models.dart'],
      target: 'package:app/models.dart',
    },
    {
      lang: 'dart',
      why: 'bare `<rel>` is reached only after `lib/<rel>` misses entirely',
      files: ['a/models.dart'],
      target: 'package:app/models.dart',
    },
    {
      lang: 'dart',
      why: 'paths are matched RAW — a backslash path is not normalized into a hit',
      files: ['win\\dir\\thing.dart'],
      target: 'package:app/dir/thing.dart',
    },
    {
      lang: 'dart',
      why: 'relative import prefers the exact path over an earlier suffix hit',
      files: ['z/lib/src/models.dart', 'lib/src/models.dart'],
      target: './models.dart',
      fromFile: 'lib/src/main.dart',
    },
    {
      lang: 'ruby',
      why: 'bare require suffix match keeps its first-in-order winner',
      files: ['a/json.rb', 'json.rb'],
      target: 'json',
    },
    {
      lang: 'ruby',
      why: 'require_relative resolves against the importer dir before any suffix match',
      files: ['z/lib/util.rb', 'lib/util.rb'],
      target: './util',
      fromFile: 'lib/main.rb',
    },
  ];

  it.each(HANDBUILT)('$lang hand-built: $why', ({ lang, files, target, fromFile, modulePath }) => {
    const set = new Set(files);
    if (lang === 'go') {
      const config = modulePath === undefined ? undefined : { modulePath };
      expect(resolveGoImportTarget(target, 'main.go', set, config)).toEqual(
        legacyResolveGoImportTarget(target, set, modulePath),
      );
      return;
    }
    if (lang === 'dart') {
      const from = fromFile ?? 'lib/main.dart';
      expect(resolveDartImportTarget(target, from, set)).toEqual(
        legacyResolveDartImportTarget(target, from, set),
      );
      return;
    }
    if (lang === 'ruby') {
      const from = fromFile ?? 'lib/main.rb';
      expect(resolveRubyImportTarget(target, from, set)).toEqual(
        legacyResolveRubyImportTarget(target, from, set),
      );
      return;
    }
    expect(csharp(target, set)).toEqual(legacyResolveCsharpNoCsproj(target, set));
  });

  it('every hand-built layout resolves to something (they pin a winner, not a null)', () => {
    // `toEqual(null) === toEqual(null)` would make the arm above pass for the
    // wrong reason. Only the three "must NOT match" layouts may be null.
    const mustBeNull = new Set([
      'a namespace dir nested inside itself does not answer the query',
      'a package dir nested inside itself does not answer the query',
      '_test.go files are a different package and never match',
      'paths are matched RAW — a backslash path is not normalized into a hit',
    ]);
    for (const c of HANDBUILT) {
      const set = new Set(c.files);
      const got =
        c.lang === 'go'
          ? legacyResolveGoImportTarget(c.target, set, c.modulePath)
          : c.lang === 'dart'
            ? legacyResolveDartImportTarget(c.target, c.fromFile ?? 'lib/main.dart', set)
            : c.lang === 'ruby'
              ? legacyResolveRubyImportTarget(c.target, c.fromFile ?? 'lib/main.rb', set)
              : legacyResolveCsharpNoCsproj(c.target, set);
      if (mustBeNull.has(c.why)) expect(got, c.why).toBeNull();
      else expect(got, c.why).not.toBeNull();
    }
  });

  it('the corpus actually exercises the resolvers (the parity arms are not vacuous)', () => {
    // A corpus that resolved nothing would make every arm above pass on
    // `null === null`. Pin a floor on real hits per language.
    const hits = { go: 0, dart: 0, ruby: 0, csharp: 0 };
    for (let repo = 0; repo < 40; repo++) {
      const go = corpus(repo, '.go', 6 + (repo % 25));
      for (const t of GO_TARGETS) {
        if (resolveGoImportTarget(t, 'main.go', go, { modulePath: 'example.com/mod' }) !== null) {
          hits.go++;
        }
      }
      const dart = corpus(repo, '.dart', 6 + (repo % 25));
      for (const t of DART_TARGETS) {
        if (resolveDartImportTarget(t, 'lib/src/main.dart', dart) !== null) hits.dart++;
      }
      const ruby = corpus(repo, '.rb', 6 + (repo % 25));
      for (const t of RUBY_TARGETS) {
        if (resolveRubyImportTarget(t, 'lib/src/main.rb', ruby) !== null) hits.ruby++;
      }
      const cs = corpus(repo, '.cs', 6 + (repo % 25));
      for (const t of CSHARP_TARGETS) {
        if (csharp(t, cs) !== null) hits.csharp++;
      }
    }
    // Measured on this corpus: go 364, dart 75, ruby 219, csharp 156.
    expect(hits.go).toBeGreaterThan(300);
    expect(hits.dart).toBeGreaterThan(60);
    expect(hits.ruby).toBeGreaterThan(180);
    expect(hits.csharp).toBeGreaterThan(120);
  });
});

// ─── index reuse ─────────────────────────────────────────────────────────────

/**
 * A `Set` that counts full iterations of itself. Every index build in these
 * resolvers walks the set exactly once (`for…of` / spread); the per-import
 * lookups afterwards only do `Map.get` and `Set.has`. So the scan count IS the
 * number of index builds, measured without instrumenting production code.
 */
class CountingSet extends Set<string> {
  scans = 0;
  override [Symbol.iterator](): SetIterator<string> {
    this.scans++;
    return super[Symbol.iterator]();
  }
}

function countingCorpus(seed: number, extension: string): CountingSet {
  return new CountingSet(corpus(seed, extension, 200));
}

describe('import-target index hoist — built once per file set, not once per import', () => {
  it('go builds one index for many imports (#2877)', () => {
    const files = countingCorpus(1, '.go');
    for (let i = 0; i < 200; i++) {
      resolveGoImportTarget(`github.com/org/repo${i}/pkg`, 'main.go', files, {
        modulePath: 'example.com/mod',
      });
    }
    // One pass: the package-dir index (root files are collected in the same pass).
    expect(files.scans).toBe(1);
  });

  it('dart builds one index for many imports (#2879)', () => {
    const files = countingCorpus(2, '.dart');
    for (let i = 0; i < 200; i++) {
      resolveDartImportTarget(`package:pkg${i}/ghost${i}.dart`, 'lib/main.dart', files);
    }
    expect(files.scans).toBe(1);
  });

  it('ruby builds one index for many requires (#2880)', () => {
    const files = countingCorpus(3, '.rb');
    for (let i = 0; i < 200; i++) {
      resolveRubyImportTarget(`ghost${i}/missing`, 'lib/main.rb', files);
    }
    expect(files.scans).toBe(1);
  });

  it('csharp builds one index per structure for many usings (#2878)', () => {
    const files = countingCorpus(4, '.cs');
    for (let i = 0; i < 200; i++) {
      csharp(`Ghost${i}.Missing.Deep`, files);
    }
    // Two passes: the shared workspace/suffix index and the namespace-dir index.
    expect(files.scans).toBe(2);
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    const a = countingCorpus(5, '.go');
    const b = countingCorpus(6, '.go');
    for (let i = 0; i < 20; i++) {
      resolveGoImportTarget('github.com/org/repo/pkg', 'main.go', a, undefined);
      resolveGoImportTarget('github.com/org/repo/pkg', 'main.go', b, undefined);
    }
    expect(a.scans).toBe(1);
    expect(b.scans).toBe(1);
  });
});
