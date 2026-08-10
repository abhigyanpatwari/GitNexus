/**
 * Gate for the two probe-count defects in Python import resolution: the
 * duplicated tail in `resolvePythonImportTarget`, and the missing O(1) proof of
 * absence in front of `resolvePythonImportInternal`'s bare-import walk.
 *
 * ## What is being counted, and why not `CountingSet`
 *
 * `test/helpers/counting-file-set.ts` counts full TRAVERSALS of the file set.
 * Neither defect here traverses it even once: both are made of `Set.has`
 * probes, so the house instrument reads the same number before and after and
 * cannot see either. This file counts the probes themselves — the one quantity
 * both defects move — with a local `Set` subclass. Deterministic: the count is
 * a function of the corpus and the spelling, never of wall time, and the same
 * run reports the same number on any machine.
 *
 * ## Defect 1 — the duplicated tail (`named` / `alias` paid twice)
 *
 * `resolvePythonImportTarget` probes the package first with
 * `targetIncludesImportedName: true`. That recursion differs from the outer
 * frame in exactly one field, whose only effect is to skip the branch, so it
 * runs the outer frame's whole tail — `resolvePythonImportInternal`, the
 * relative gate, `hasRepoCandidate`, `resolveAbsoluteFromFiles` — on identical
 * inputs. When it returned null the code FELL THROUGH and ran all of it again.
 * Measured at four directory components: 24 probes, of which 12 were
 * byte-identical repeats.
 *
 * The gate is that `from x import y` and `import x as y` issue exactly the
 * probes `import x` issues. Stated as absolute numbers rather than as
 * `named === namespace`, because an equality alone also passes if BOTH kinds
 * start paying twice.
 *
 * ## Defect 2 — no proof of absence in front of the walk
 *
 * The bare walk probed `<ancestor>/<seg>.py` and `<ancestor>/<seg>/__init__.py`
 * at every step from the importer's directory to the workspace root, for every
 * single-segment import — including `import os`, `import sys` and every other
 * distribution the repo does not vendor, where every probe is guaranteed to
 * miss. `pythonSegmentAbsent` answers "no file anywhere can have either shape"
 * in two Map lookups on the index the dotted tiers already build.
 *
 * The gate is that a provably-absent segment costs the SAME at depth 16 as at
 * depth 1, paired with the control that a segment which survives the proof
 * still walks and still costs more with depth — otherwise a resolver that
 * simply stopped working would post a perfect flat line.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import { pythonScopeResolver } from '../../../../src/core/ingestion/languages/python/scope-resolver.js';
import { resolvePythonImportInternal } from '../../../../src/core/ingestion/import-resolvers/python.js';

const { resolveImportTarget } = pythonScopeResolver;

/** Counts `has` probes. `instanceof Set` still holds, which the adapter's
 *  structural narrowing needs. */
class ProbeCountingSet extends Set<string> {
  probes = 0;

  override has(value: string): boolean {
    this.probes++;
    return super.has(value);
  }
}

/** One array for the whole file: `parsedFileByPath` memoizes on its identity,
 *  and it is empty, so the package-export precedence never fires and the walk
 *  is what the numbers measure. */
const NO_PARSED_FILES: readonly ParsedFile[] = [];

const namespaceImport = (targetRaw: string): ParsedImport => ({
  kind: 'namespace',
  localName: '_',
  importedName: '_',
  targetRaw,
});
const namedImport = (targetRaw: string): ParsedImport => ({
  kind: 'named',
  localName: 'Widget',
  importedName: 'Widget',
  targetRaw,
});
const aliasImport = (targetRaw: string): ParsedImport => ({
  kind: 'alias',
  localName: 'w',
  importedName: 'Widget',
  alias: 'w',
  targetRaw,
});

const DEPTHS: readonly number[] = [1, 2, 4, 8, 16];

/**
 * An importer `depth` directory components down.
 *
 * `far/away/probe.py` is out of the importer's ancestry, so a `probe` walk runs
 * to the end and misses — and it makes `probe` a known basename, so the absence
 * proof passes it through. `vendor/thing.py` makes `vendor/` a root directory
 * prefix, so `hasRepoCandidate('vendor')` passes on its check (2) and the
 * dotted target below reaches `resolveAbsoluteFromFiles` instead of being
 * gated out.
 */
function corpus(depth: number): { files: readonly string[]; fromFile: string } {
  const fromFile = `${Array.from({ length: depth }, (_, i) => `d${i}`).join('/')}/mod.py`;
  return {
    files: [fromFile, 'zz/keep.py', 'far/away/probe.py', 'vendor/thing.py'],
    fromFile,
  };
}

function probeCount(
  mkImport: (targetRaw: string) => ParsedImport,
  depth: number,
  targetRaw: string,
): { probes: number; result: string | readonly string[] | null } {
  const { files, fromFile } = corpus(depth);
  const set = new ProbeCountingSet(files);
  const result = resolveImportTarget(targetRaw, fromFile, set, undefined, {
    parsedFiles: NO_PARSED_FILES,
    parsedImport: mkImport(targetRaw),
  });
  return { probes: set.probes, result };
}

/** Exists as a basename, so the absence proof passes it through to the walk. */
const PRESENT_TARGET = 'probe';
const PRESENT_RESULT = 'far/away/probe.py';
/** No file has basename `ghostmod.py` and no directory is named `ghostmod`. */
const ABSENT_TARGET = 'ghostmod';

/**
 * `2 + 2 x depth` probes in the bare walk (proximity, then two per ancestor
 * step including the workspace root), then `2 + depth` in the dotted tier below
 * it (two direct root probes, then one per ancestor — only the module form,
 * because no `probe/__init__.py` exists anywhere). `4 + 3 x depth`.
 */
const PRESENT_PROBES: readonly number[] = [7, 10, 16, 28, 52];
/** Two: the dotted tier's direct workspace-root probes. The bare walk issues
 *  NONE — it is retired before the proximity check. */
const ABSENT_PROBES = 2;

/**
 * A DOTTED target that passes `hasRepoCandidate` (its leading segment `vendor`
 * is a root directory prefix), reaches `resolveAbsoluteFromFiles`, walks the
 * whole ancestor chain and still resolves to nothing — because the only
 * `probe.py` in the workspace does not end with `/vendor/probe.py`.
 *
 * This is the shape the duplicated tail actually costs on, and the reason the
 * single-segment arm above cannot see it: a single-segment target that survives
 * the absence proof is always answered by the suffix fallback, so its
 * `packageTarget` is never null and the fallthrough never fires. A dotted one
 * can miss, and missing is precisely when the old code ran the tail again.
 */
const DOTTED_TARGET = 'vendor.probe';
/** `2 + depth`: two direct root probes, then one module probe per ancestor. */
const DOTTED_NAMESPACE_PROBES: readonly number[] = [3, 4, 6, 10, 18];
/**
 * `named`/`alias` legitimately add TWO — the submodule probe for
 * `vendor.probe.Widget`, a different target with its own direct root checks.
 * What they must NOT add is a third component: another whole copy of the
 * package tail. With the fallthrough restored these read [8, 10, 14, 22, 38].
 */
const DOTTED_SUBMODULE_PROBES: readonly number[] = [5, 6, 8, 12, 20];

describe('Python import probe count', () => {
  it.each([
    { kind: 'import x (namespace)', mkImport: namespaceImport },
    { kind: 'from x import y (named)', mkImport: namedImport },
    { kind: 'import x as y (alias)', mkImport: aliasImport },
  ])('costs the same for every import KIND — single-segment, resolving — $kind', ({ mkImport }) => {
    const counted = DEPTHS.map((depth) => probeCount(mkImport, depth, PRESENT_TARGET));
    expect(counted.map((c) => c.probes)).toEqual(PRESENT_PROBES);

    // Non-vacuity: a probe count is equally flattering to a resolver that
    // resolves nothing.
    expect(counted.map((c) => c.result)).toEqual(DEPTHS.map(() => PRESENT_RESULT));
  });

  it.each([
    { kind: 'import x (namespace)', mkImport: namespaceImport, expected: DOTTED_NAMESPACE_PROBES },
    { kind: 'from x import y (named)', mkImport: namedImport, expected: DOTTED_SUBMODULE_PROBES },
    { kind: 'import x as y (alias)', mkImport: aliasImport, expected: DOTTED_SUBMODULE_PROBES },
  ])(
    'runs the package tail ONCE for a dotted target that misses — $kind',
    ({ mkImport, expected }) => {
      const counted = DEPTHS.map((depth) => probeCount(mkImport, depth, DOTTED_TARGET));

      // The duplicated-tail gate. Restoring the fallthrough adds a second copy of
      // the namespace column to the two submodule rows.
      expect(counted.map((c) => c.probes)).toEqual(expected);
      expect(counted.map((c) => c.result)).toEqual(DEPTHS.map(() => null));
    },
  );

  it.each([
    { kind: 'import x (namespace)', mkImport: namespaceImport },
    { kind: 'from x import y (named)', mkImport: namedImport },
    { kind: 'import x as y (alias)', mkImport: aliasImport },
  ])('retires a provably absent segment in a CONSTANT probe count — $kind', ({ mkImport }) => {
    const counted = DEPTHS.map((depth) => probeCount(mkImport, depth, ABSENT_TARGET));

    // The gate: flat in depth. Without the proof of absence this is
    // `4 + 4 x depth` for a miss, i.e. 8 at depth 1 and 68 at depth 16.
    expect(counted.map((c) => c.probes)).toEqual(DEPTHS.map(() => ABSENT_PROBES));
    expect(counted.map((c) => c.result)).toEqual(DEPTHS.map(() => null));
  });

  it('the counter can see depth — the flat line above is the proof, not the instrument', () => {
    // Control for the arm above: the same instrument, the same corpus, the same
    // depths, one different spelling — and the count triples across the range.
    // So a flat line means the walk was skipped, not that nothing is counted.
    const present = DEPTHS.map((depth) => probeCount(namedImport, depth, PRESENT_TARGET).probes);
    expect(present).toEqual(PRESENT_PROBES);
    expect(new Set(present).size).toBe(DEPTHS.length);
  });

  /**
   * The two inputs `pythonSegmentAbsent` refuses to answer for. Both must keep
   * probing exactly as before; a proof of absence that fires on either would
   * silently stop resolving real files.
   */
  it.each([
    {
      why: 'the EMPTY segment, module form — basename `.py` is indexed normally',
      files: ['a/b/.py', 'a/b/mod.py'],
      fromFile: 'a/b/mod.py',
      importPath: '',
      expected: 'a/b/.py',
    },
    {
      // THE reason the empty-segment carve-out exists. The probe for an empty
      // segment is `<prefix>/__init__.py`, whose parent directory name is empty
      // — exactly the case the `byInitParent` build skips. So the bucket cannot
      // witness this file, and its absence is not proof of the file's absence.
      why: 'the EMPTY segment, package form under a doubled separator — `byInitParent` skips it',
      files: ['a//__init__.py', 'a/b/mod.py'],
      fromFile: 'a/b/mod.py',
      importPath: '',
      expected: 'a//__init__.py',
    },
    {
      why: 'the EMPTY segment, package form at the filesystem root',
      files: ['/__init__.py', 'a/b/mod.py'],
      fromFile: 'a/b/mod.py',
      importPath: '',
      expected: '/__init__.py',
    },
    {
      why: 'a segment carrying a BACKSLASH — the buckets are keyed on normalized paths',
      files: ['a\\b.py', 'x/mod.py'],
      fromFile: 'x/mod.py',
      importPath: 'a\\b',
      expected: 'a\\b.py',
    },
  ])('still resolves what the proof of absence cannot rule out — $why', (row) => {
    expect(resolvePythonImportInternal(row.fromFile, row.importPath, new Set(row.files))).toBe(
      row.expected,
    );
  });
});
