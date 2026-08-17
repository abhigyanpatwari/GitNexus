/**
 * Production-path regression guard for the COBOL `COPY`-target index (#2908).
 *
 * The two-tier basename index (`getCobolCopyIndex` in
 * `languages/cobol/scope-resolver.ts`) is memoized on the `allFilePaths` Set
 * identity via a WeakMap, so the file set must be passed THROUGH from the
 * orchestrator, never copied. A defensive `new Set(allFilePaths)` in the
 * adapter hands a fresh WeakMap key per call and rebuilds the index on every
 * `COPY`, restoring the O(copies × files) scans this replaced — the exact bug
 * PR #1918 shipped for Python and had to fix in review (P1).
 *
 * COBOL is the language where that copy costs the most: every `COPY` used to
 * run TWO full scans, and mainframe repos are copybook-dense — one program can
 * carry dozens of `COPY` statements.
 *
 * Unlike the other languages in this family, COBOL has no separate
 * `resolve<Lang>ImportTarget` function; the adapter IS the resolver. The unit
 * parity test (`test/unit/scope-resolution/cobol-import-target-parity.test.ts`)
 * therefore reaches the same entry point — but it says nothing about Set
 * identity, so a copy inserted there leaves every one of its arms green. This
 * file is what notices, by counting traversals of the set.
 *
 * The traversal-count assertions are the perf guard. They are paired with
 * result assertions on purpose: a count of 1 is equally true of an adapter that
 * has stopped resolving anything at all, so counting alone would stay green
 * while every COBOL COPY edge disappeared.
 *
 * Expected count is 1: both tiers are filled in a single pass over the set.
 */
import { describe, it, expect } from 'vitest';
import { cobolScopeResolver } from '../../src/core/ingestion/languages/cobol/scope-resolver.js';
import { CountingSet, expectDistinctFileSetsGetOwnIndex } from '../helpers/counting-file-set.js';

const { resolveImportTarget } = cobolScopeResolver;

const FROM_FILE = 'src/PROG.cbl';

/**
 * A synthetic mainframe checkout: many copybooks under `copybooks/`, plus the
 * three files the arms below address — a copybook, a program reachable only
 * through the SOURCE tier, and a program that a copybook of the same name must
 * beat despite coming first in Set-iteration order.
 */
function buildWorkspace(fileCount: number): CountingSet {
  const files: string[] = [];
  // Inserted before the copybook below so the tier-order arm is a real
  // tie-break rather than an artefact of ordering.
  files.push('src/CUSTREC.cbl');
  for (let i = 0; i < fileCount; i++) {
    files.push(`copybooks/BOOK${String(i).padStart(5, '0')}.cpy`);
  }
  files.push('copybooks/CUSTREC.cpy');
  files.push('src/PAYROLL.cbl');
  files.push('src/PROG.cbl');
  return new CountingSet(files);
}

describe('COBOL COPY resolution — index reuse across imports (#2908)', () => {
  it('builds the file index once for many COPY statements over a stable file set', () => {
    const files = buildWorkspace(300);
    const resolved: (string | readonly string[] | null)[] = [];

    for (let i = 0; i < 200; i++) {
      // Three shapes: a copybook hit, a hit that only the SOURCE tier answers,
      // and a member that is not in the repo at all — the last is the common
      // case in real COBOL (vendor and system copybooks) and the one that used
      // to cost TWO full workspace scans per statement.
      resolved.push(resolveImportTarget('CUSTREC', FROM_FILE, files, undefined));
      resolved.push(resolveImportTarget('PAYROLL', FROM_FILE, files, undefined));
      resolved.push(resolveImportTarget(`VENDOR${i}`, FROM_FILE, files, undefined));
    }

    expect(files.scans).toBe(1);

    // Paired result assertions — a count of 1 must not be the count of an
    // adapter that resolves nothing. The first also pins the tier order: the
    // `.cbl` twin was inserted FIRST.
    expect(resolved[0]).toBe('copybooks/CUSTREC.cpy');
    expect(resolved[1]).toBe('src/PAYROLL.cbl');
    expect(resolved[2]).toBeNull();
  });

  it('a distinct file set gets its own index (no stale cross-run reuse)', () => {
    expectDistinctFileSetsGetOwnIndex({
      resolveImportTarget,
      buildWorkspace: () => buildWorkspace(20),
      targetRaw: 'CUSTREC',
      fromFile: FROM_FILE,
      resolutionConfig: undefined,
      expected: 'copybooks/CUSTREC.cpy',
      expectedScans: 1,
    });
  });

  it('still resolves real COPY statements correctly (the perf test is not vacuous)', () => {
    const files = new CountingSet([
      'src/CUSTREC.cbl',
      'copybooks/CUSTREC.cpy',
      'copybooks/custrec-lower.copybook',
      'copybooks/Mixed.CPY',
      'src/PAYROLL.cob',
      'src/TAXCALC.cobol',
      'docs/CUSTREC.txt',
      'copybooks/NOEXT',
    ]);

    // Tier order: the copybook wins over the `.cbl` inserted before it.
    expect(resolveImportTarget('CUSTREC', FROM_FILE, files, undefined)).toBe(
      'copybooks/CUSTREC.cpy',
    );
    // Case: the COPY operand and the file's stem are both upper-cased.
    expect(resolveImportTarget('custrec', FROM_FILE, files, undefined)).toBe(
      'copybooks/CUSTREC.cpy',
    );
    expect(resolveImportTarget('CUSTREC-LOWER', FROM_FILE, files, undefined)).toBe(
      'copybooks/custrec-lower.copybook',
    );
    // Source tier, reached only after every copybook missed.
    expect(resolveImportTarget('PAYROLL', FROM_FILE, files, undefined)).toBe('src/PAYROLL.cob');
    expect(resolveImportTarget('TAXCALC', FROM_FILE, files, undefined)).toBe('src/TAXCALC.cobol');
    // `path.basename(fp, '.cpy')` will not strip `.CPY`, so the stem keeps it.
    expect(resolveImportTarget('MIXED.CPY', FROM_FILE, files, undefined)).toBe(
      'copybooks/Mixed.CPY',
    );
    expect(resolveImportTarget('MIXED', FROM_FILE, files, undefined)).toBeNull();
    // Neither tier: a `.txt`, a file with no extension, and an absent member.
    expect(resolveImportTarget('NOEXT', FROM_FILE, files, undefined)).toBeNull();
    expect(resolveImportTarget('ABSENT', FROM_FILE, files, undefined)).toBeNull();

    // One traversal covered all of it.
    expect(files.scans).toBe(1);
  });
});
