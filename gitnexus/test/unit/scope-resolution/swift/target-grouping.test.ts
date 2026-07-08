/**
 * Drift-guard unit test for `groupSwiftFilesBySpmTarget` (issue #1948 U3,
 * KTD2).
 *
 * `groupSwiftFilesBySpmTarget` (`languages/swift/target-grouping.ts`)
 * DUPLICATES the legacy `groupSwiftFilesByTarget` (`languages/swift.ts`)
 * SPM-subtree semantics so the registry-primary same-module hooks group by
 * the SPM target subtree without touching the legacy pipeline (hard
 * constraint: legacy stays byte-identical). Because the duplication can
 * silently drift if legacy is later changed, this test pins the exact
 * bucketing for representative inputs so a future divergence surfaces
 * loudly:
 *
 *   1. A multi-subdir single target buckets into ONE group.
 *   2. A file matching two overlapping same-named target prefixes is
 *      assigned to the FIRST target only (legacy `break`s — no fan-out).
 *   3. Unmatched files AND the no-targets case route to `__default__` = all.
 *
 * `coerceSwiftTargets` is also covered: it duck-types `{ targets: Map }`
 * (no `instanceof` on the config object) and returns `null` otherwise.
 */
import { describe, it, expect } from 'vitest';
import {
  groupSwiftFilesBySpmTarget,
  coerceSwiftTargets,
} from '../../../../src/core/ingestion/languages/swift/target-grouping.js';

const id = (s: string) => s;

describe('groupSwiftFilesBySpmTarget — legacy SPM-subtree parity (drift guard)', () => {
  it('buckets a multi-subdir single target into ONE group', () => {
    const files = [
      'Sources/Alpha/Core/User.swift',
      'Sources/Alpha/Entry/App.swift',
      'Sources/Alpha/Util/Helpers.swift',
    ];
    const targets = new Map([['Alpha', 'Sources/Alpha']]);

    const groups = groupSwiftFilesBySpmTarget(files, id, targets);

    expect([...groups.keys()]).toEqual(['Alpha']);
    expect(groups.get('Alpha')).toEqual(files);
    expect(groups.has('__default__')).toBe(false);
  });

  it('assigns a file matching two overlapping same-named prefixes to the FIRST target only', () => {
    // Both targets are prefixes of the file's path (Beta dir nested under
    // Alpha). Legacy `break`s on the first match → one bucket per file.
    const files = ['Sources/Alpha/Beta/User.swift'];
    const targets = new Map([
      ['Alpha', 'Sources/Alpha'],
      ['Beta', 'Sources/Alpha/Beta'],
    ]);

    const groups = groupSwiftFilesBySpmTarget(files, id, targets);

    expect(groups.get('Alpha')).toEqual(files);
    expect(groups.has('Beta')).toBe(false);
  });

  it('matches a target dir only at a `/` boundary, not a substring', () => {
    // "Sources/Alpha" must NOT match "Sources/AlphaBeta/..." — the legacy
    // predicate requires idx===0 or a preceding `/`.
    const files = ['Sources/AlphaBeta/User.swift'];
    const targets = new Map([['Alpha', 'Sources/Alpha']]);

    const groups = groupSwiftFilesBySpmTarget(files, id, targets);

    expect(groups.has('Alpha')).toBe(false);
    expect(groups.get('__default__')).toEqual(files);
  });

  it('routes unmatched files (with targets present) to __default__', () => {
    const files = ['Sources/Alpha/User.swift', 'Loose/Orphan.swift'];
    const targets = new Map([['Alpha', 'Sources/Alpha']]);

    const groups = groupSwiftFilesBySpmTarget(files, id, targets);

    expect(groups.get('Alpha')).toEqual(['Sources/Alpha/User.swift']);
    expect(groups.get('__default__')).toEqual(['Loose/Orphan.swift']);
  });

  it('routes ALL files to __default__ when targets is null (no source dir found)', () => {
    const files = ['Models/User.swift', 'Services/App.swift'];

    const groups = groupSwiftFilesBySpmTarget(files, id, null);

    expect([...groups.keys()]).toEqual(['__default__']);
    expect(groups.get('__default__')).toEqual(files);
  });

  it('routes ALL files to __default__ when targets is empty', () => {
    const files = ['Models/User.swift', 'Services/App.swift'];

    const groups = groupSwiftFilesBySpmTarget(files, id, new Map());

    expect([...groups.keys()]).toEqual(['__default__']);
    expect(groups.get('__default__')).toEqual(files);
  });

  it('groups generic items via getPath (not just strings)', () => {
    const items = [
      { filePath: 'Sources/Alpha/Core/User.swift', tag: 1 },
      { filePath: 'Sources/Beta/Core/User.swift', tag: 2 },
    ];
    const targets = new Map([
      ['Alpha', 'Sources/Alpha'],
      ['Beta', 'Sources/Beta'],
    ]);

    const groups = groupSwiftFilesBySpmTarget(items, (i) => i.filePath, targets);

    expect(groups.get('Alpha')).toEqual([items[0]]);
    expect(groups.get('Beta')).toEqual([items[1]]);
  });

  it('normalizes backslash paths to forward-slash before matching', () => {
    const files = ['Sources\\Alpha\\Core\\User.swift'];
    const targets = new Map([['Alpha', 'Sources/Alpha']]);

    const groups = groupSwiftFilesBySpmTarget(files, id, targets);

    expect(groups.get('Alpha')).toEqual(files);
  });
});

describe('coerceSwiftTargets — duck-type the opaque resolutionConfig', () => {
  it('returns the targets map from a SwiftPackageConfig-shaped object', () => {
    const targets = new Map([['Alpha', 'Sources/Alpha']]);
    expect(coerceSwiftTargets({ targets })).toBe(targets);
  });

  it('returns null for null / undefined / non-config values', () => {
    expect(coerceSwiftTargets(null)).toBeNull();
    expect(coerceSwiftTargets(undefined)).toBeNull();
    expect(coerceSwiftTargets({})).toBeNull();
    expect(coerceSwiftTargets({ targets: 'not-a-map' })).toBeNull();
    expect(coerceSwiftTargets({ goModule: { modulePath: 'x' } })).toBeNull();
  });
});
