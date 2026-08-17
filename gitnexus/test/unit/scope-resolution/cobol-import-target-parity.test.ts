/**
 * Differential harness for the COBOL `COPY`-target index hoist (#2908).
 *
 * `cobolScopeResolver.resolveImportTarget` used to answer every `COPY` with TWO
 * full `allFilePaths` scans — copybooks first, then COBOL sources — each calling
 * `path.extname` + `path.basename` + `toUpperCase` on every entry, so resolution
 * cost O(copies × files) and a `COPY` of a member that is not in the repo (the
 * common case) ran both scans to completion. Replacing them with a per-run
 * two-tier index is a pure performance change ONLY if every implicit tie-break
 * survives, and none of them is visible to the type system:
 *
 *   - TIER ORDER: a `.cpy`/`.copybook` hit beats a `.cbl`/`.cob`/`.cobol` hit
 *     even when the source file comes FIRST in Set-iteration order. Collapsing
 *     the two tiers into one first-wins map is the "obvious" rewrite and it
 *     silently inverts this;
 *   - WITHIN A TIER: the first file in Set-iteration order wins, because the
 *     scans returned on first match;
 *   - CASE: the extension is compared LOWER-cased while the basename is
 *     compared UPPER-cased, and `path.basename(fp, ext)` strips the suffix only
 *     on an exact, case-sensitive match — so `Foo.CPY` is indexed under
 *     `FOO.CPY`, not `FOO`, and is unreachable by a `COPY FOO`;
 *   - `path` SEMANTICS: Node's `path.extname`/`path.basename` are what decide
 *     where the stem starts, and on POSIX they do not treat `\` as a separator.
 *     Hand-rolled slicing on `/` would start resolving backslash paths that
 *     previously returned null.
 *
 * So this file keeps a VERBATIM copy of the pre-change resolver body
 * (`git show HEAD~:…/languages/cobol/scope-resolver.ts`) and asserts the new
 * implementation agrees with it on a deterministic generated corpus plus a
 * hand-built layout per tie-break. The copy is the specification; if an arm here
 * fails, the resolver's OUTPUT moved and COBOL's IMPORTS edges move with it.
 *
 * Mutation-tested against the new implementation — each of these was inserted,
 * confirmed RED here, and reverted: tiers collapsed into one map; within-tier
 * first-wins flipped to last-wins; `targetRaw.toUpperCase()` dropped;
 * `path.extname(fp).toLowerCase()` left un-lowercased.
 *
 * This file calls the resolver directly, which for COBOL is also the
 * orchestrator adapter — but the arms below say nothing about the Set being
 * passed THROUGH, and a defensive `new Set(allFilePaths)` would leave them all
 * green while restoring the per-import rebuild. That failure is guarded by
 * `test/integration/cobol-import-index-reuse.test.ts`.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { cobolScopeResolver } from '../../../src/core/ingestion/languages/cobol/scope-resolver.js';

const { resolveImportTarget } = cobolScopeResolver;

/** COBOL takes no `resolutionConfig` and ignores `fromFile`; both are pinned. */
const FROM_FILE = 'src/PROG.cbl';

function resolve(targetRaw: string, files: ReadonlySet<string>): string | readonly string[] | null {
  return resolveImportTarget(targetRaw, FROM_FILE, files, undefined);
}

// ─── verbatim pre-change implementation ──────────────────────────────────────

const LEGACY_COPYBOOK_EXTENSIONS = new Set(['.cpy', '.copybook']);

function legacyResolveCobolImportTarget(
  targetRaw: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const upper = targetRaw.toUpperCase();
  // Check copybook files first
  for (const fp of allFilePaths) {
    const ext = path.extname(fp).toLowerCase();
    if (!LEGACY_COPYBOOK_EXTENSIONS.has(ext)) continue;
    const basename = path.basename(fp, ext).toUpperCase();
    if (basename === upper) return fp;
  }
  // Also search COBOL source files (.cbl, .cob, .cobol)
  const COBOL_SOURCE_EXTS = new Set(['.cbl', '.cob', '.cobol']);
  for (const fp of allFilePaths) {
    const ext = path.extname(fp).toLowerCase();
    if (!COBOL_SOURCE_EXTS.has(ext)) continue;
    const basename = path.basename(fp, ext).toUpperCase();
    if (basename === upper) return fp;
  }
  return null;
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
 * Directory shapes of a typical mainframe checkout, including one whose
 * segments are separated by BACKSLASHES — on POSIX that is one long filename,
 * which is precisely the `path` semantic the index must not "simplify" away.
 */
const DIRS = [
  '',
  'copybooks',
  'COPYBOOKS',
  'src',
  'src/copy',
  'legacy/cpy',
  'jcl/proclib',
  'win\\dir',
];

/** Member names in the case mixture a real repo has. */
const STEMS = ['CUSTREC', 'custrec', 'AcctRec', 'PAYROLL', 'BOOK', 'COMMON', 'TAXCALC', 'ERRDEMO'];

/**
 * Both tiers, both cases, plus two extensions in NEITHER tier: `.txt` (a
 * non-COBOL file that must never answer a `COPY`) and `''` (a file with no
 * extension at all, which `path.extname` reports as the empty string and which
 * therefore falls out of both extension sets).
 */
const EXTS = ['.cpy', '.copybook', '.CPY', '.cbl', '.cob', '.cobol', '.CBL', '.txt', ''];

function corpus(seed: number, fileCount: number): Set<string> {
  const files = new Set<string>();
  for (let i = 0; i < fileCount; i++) {
    const a = mix(seed * 7919 + i);
    const b = mix(a ^ 0x9e3779b9);
    const c = mix(b ^ 0x85ebca6b);
    const dir = DIRS[a % DIRS.length];
    const stem = STEMS[b % STEMS.length];
    const rel = `${stem}${EXTS[c % EXTS.length]}`;
    files.add(dir === '' ? rel : `${dir}/${rel}`);
  }
  // Backslash-separated paths, which `path` reads differently per platform and
  // a `/`-slicing rewrite would read differently from `path` on POSIX.
  files.add('win\\dir\\BOOK.cpy');
  files.add('win\\dir\\PAYROLL.cbl');
  return files;
}

/**
 * `COPY` operands as they appear in source, plus the spellings that reach the
 * corpus's awkward files. Lower-case entries are what breaks if the target
 * stops being upper-cased; the `.CPY`/`.CBL` suffixed entries are what reaches
 * a file whose mixed-case extension `path.basename` refused to strip.
 */
const TARGETS = [
  '',
  'CUSTREC',
  'custrec',
  'CustRec',
  'ACCTREC',
  'PAYROLL',
  'payroll',
  'BOOK',
  'COMMON',
  'TAXCALC',
  'ERRDEMO',
  'MISSING',
  'BOOK.CPY',
  'CUSTREC.CPY',
  'PAYROLL.CBL',
  'win\\dir\\BOOK',
  'WIN\\DIR\\BOOK',
  'win/dir/BOOK',
];

const REPOS = 40;

describe('COBOL COPY-target index hoist — output parity with the pre-change scans (#2908)', () => {
  it('agrees with the verbatim pre-change resolver over the generated corpus', () => {
    let checked = 0;
    for (let repo = 0; repo < REPOS; repo++) {
      const files = corpus(repo, 6 + (repo % 25));
      for (const target of TARGETS) {
        expect(resolve(target, files), `cobol "${target}" repo=${repo}`).toEqual(
          legacyResolveCobolImportTarget(target, files),
        );
        checked++;
      }
    }
    expect(checked).toBe(REPOS * TARGETS.length);
  });

  it('the corpus actually resolves things (the parity arm is not vacuous)', () => {
    // A corpus that resolved nothing would make the arm above pass on
    // `null === null` forever. Measured on this corpus: 390 hits.
    let hits = 0;
    for (let repo = 0; repo < REPOS; repo++) {
      const files = corpus(repo, 6 + (repo % 25));
      for (const target of TARGETS) {
        hits += legacyResolveCobolImportTarget(target, files) === null ? 0 : 1;
      }
    }
    expect(hits).toBeGreaterThan(300);
  });
});

// ─── hand-built tie-breaks ───────────────────────────────────────────────────

/**
 * `path` decides where the stem of a backslash path starts: on POSIX the whole
 * `dir\sub\BOOK` is the stem, on Windows only `BOOK`. Deriving the target
 * through the SAME call keeps the two arms below a hit and a miss respectively
 * on both platforms, so what they pin is the `path` semantics rather than the
 * host — and a rewrite that replaces `path` with slicing on `/` changes what
 * they resolve to on Windows.
 */
const BACKSLASH_FILE = 'dir\\sub\\BOOK.cpy';
const BACKSLASH_STEM = path.basename(BACKSLASH_FILE, '.cpy').toUpperCase();
/** The stem's last backslash-delimited segment — a HIT only where `path` splits on `\`. */
const BACKSLASH_LEAF = 'BOOK';
const BACKSLASH_LEAF_EXPECTED = BACKSLASH_STEM === BACKSLASH_LEAF ? BACKSLASH_FILE : null;

interface HandBuilt {
  readonly why: string;
  /** Insertion order IS the Set-iteration order, and for most arms it IS the tie-break. */
  readonly files: readonly string[];
  readonly target: string;
  /** The one path (or `null`) both implementations must return. */
  readonly expected: string | null;
}

const HANDBUILT: readonly HandBuilt[] = [
  {
    why: 'a copybook beats a COBOL source that comes FIRST in Set order (tier order)',
    files: ['src/BOOK.cbl', 'copybooks/BOOK.cpy'],
    target: 'BOOK',
    expected: 'copybooks/BOOK.cpy',
  },
  {
    why: '.copybook is tier 1 too, and beats an earlier .cob',
    files: ['src/BOOK.cob', 'copybooks/BOOK.copybook'],
    target: 'BOOK',
    expected: 'copybooks/BOOK.copybook',
  },
  {
    why: 'the source tier answers only when every copybook has missed',
    files: ['copybooks/OTHER.cpy', 'src/BOOK.cbl'],
    target: 'BOOK',
    expected: 'src/BOOK.cbl',
  },
  {
    why: 'within the copybook tier, first in Set order wins',
    files: ['a/BOOK.cpy', 'b/BOOK.cpy'],
    target: 'BOOK',
    expected: 'a/BOOK.cpy',
  },
  {
    why: 'within the source tier, first in Set order wins',
    files: ['b/BOOK.cbl', 'a/BOOK.cob', 'c/BOOK.cobol'],
    target: 'BOOK',
    expected: 'b/BOOK.cbl',
  },
  {
    why: 'the basename is compared UPPER-cased, so a lower-case file answers an upper-case COPY',
    files: ['copybooks/custrec.cpy'],
    target: 'CUSTREC',
    expected: 'copybooks/custrec.cpy',
  },
  {
    why: 'the TARGET is upper-cased too, so a lower-case COPY reaches an upper-case file',
    files: ['copybooks/CUSTREC.cpy'],
    target: 'custrec',
    expected: 'copybooks/CUSTREC.cpy',
  },
  {
    why: 'the extension is matched LOWER-cased, so `Foo.CPY` is a copybook at all',
    files: ['copybooks/Foo.CPY'],
    target: 'FOO.CPY',
    expected: 'copybooks/Foo.CPY',
  },
  {
    why: '`path.basename(fp, ext)` strips case-SENSITIVELY, so `Foo.CPY` is NOT reachable as FOO',
    files: ['copybooks/Foo.CPY'],
    target: 'FOO',
    expected: null,
  },
  {
    why: 'a `.CPY` file keyed with its suffix loses `BOOK` to a `.cbl` in the later tier',
    files: ['x/BOOK.cbl', 'y/BOOK.CPY'],
    target: 'BOOK',
    expected: 'x/BOOK.cbl',
  },
  {
    why: 'an uppercase source extension is a source file (`.CBL` → tier 2, keyed with its suffix)',
    files: ['src/Pay.CBL'],
    target: 'PAY.CBL',
    expected: 'src/Pay.CBL',
  },
  {
    why: 'a file with NO extension never answers a COPY',
    files: ['copybooks/BOOK'],
    target: 'BOOK',
    expected: null,
  },
  {
    why: 'a non-COBOL extension never answers a COPY',
    files: ['copybooks/BOOK.txt', 'docs/BOOK.md'],
    target: 'BOOK',
    expected: null,
  },
  {
    why: 'a target matching nothing resolves to null',
    files: ['copybooks/BOOK.cpy', 'src/PROG.cbl'],
    target: 'NOSUCHBOOK',
    expected: null,
  },
  {
    why: 'an empty target matches nothing (no file has an empty stem)',
    files: ['copybooks/BOOK.cpy', 'src/PROG.cbl'],
    target: '',
    expected: null,
  },
  {
    why: 'a backslash path is addressed by the stem `path` reports for it',
    files: [BACKSLASH_FILE],
    target: BACKSLASH_STEM,
    expected: BACKSLASH_FILE,
  },
  {
    why: 'its trailing segment is a hit only where `path` treats `\\` as a separator',
    files: [BACKSLASH_FILE],
    target: BACKSLASH_LEAF,
    expected: BACKSLASH_LEAF_EXPECTED,
  },
];

describe('COBOL COPY-target index hoist — hand-built tie-breaks (#2908)', () => {
  it.each(HANDBUILT)('$why', ({ files, target, expected }) => {
    const set = new Set(files);
    // Two assertions, not one: agreeing with the legacy copy proves the hoist
    // preserved the behaviour, and pinning the literal proves the behaviour
    // being preserved is the one the case is named for — `toEqual(null)` on
    // both sides would otherwise satisfy an arm that stopped resolving.
    expect(legacyResolveCobolImportTarget(target, set), `legacy: ${target}`).toBe(expected);
    expect(resolve(target, set), `new: ${target}`).toBe(expected);
  });
});
