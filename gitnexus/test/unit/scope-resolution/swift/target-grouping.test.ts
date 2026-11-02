/**
 * Unit tests for `groupSwiftFilesByModule` over hand-built `{ targets }`
 * configs (issue #1948 U3, #3355).
 *
 *   1. A multi-subdir single target buckets into ONE group.
 *   2. A file under two nested target dirs joins the DEEPEST only.
 *   3. Target dirs match only at path-segment boundaries, from the repo root.
 *   4. Unmatched files AND the no-targets case route to `__default__`.
 *
 * `coerceSwiftTargets` is also covered: it duck-types `{ targets: Map }`
 * (no `instanceof` on the config object) and returns `null` otherwise.
 */
import { describe, it, expect } from 'vitest';
import {
  groupSwiftFilesByModule,
  coerceSwiftTargets,
  swiftC99ModuleName,
  swiftModuleKeysOf,
} from '../../../../src/core/ingestion/languages/swift/target-grouping.js';

/** A hand-built `{ targets }` config, as the root-only loader produces. */
const cfg = (targets: Map<string, string> | null) => (targets === null ? null : { targets });

const id = (s: string) => s;

describe('groupSwiftFilesByModule — SwiftPM bucketing contract', () => {
  it('buckets a multi-subdir single target into ONE group', () => {
    const files = [
      'Sources/Alpha/Core/User.swift',
      'Sources/Alpha/Entry/App.swift',
      'Sources/Alpha/Util/Helpers.swift',
    ];
    const targets = new Map([['Alpha', 'Sources/Alpha']]);

    const groups = groupSwiftFilesByModule(files, id, cfg(targets));

    expect([...groups.keys()]).toEqual(['Alpha']);
    expect(groups.get('Alpha')).toEqual(files);
    expect(groups.has('__default__')).toBe(false);
  });

  it('assigns a file under two nested target dirs to the DEEPEST target only', () => {
    // SwiftPM rejects overlapping target sources within one package, so this
    // only arises across packages; the more specific directory is the module.
    const files = ['Sources/Alpha/Beta/User.swift'];
    const targets = new Map([
      ['Alpha', 'Sources/Alpha'],
      ['Beta', 'Sources/Alpha/Beta'],
    ]);

    const groups = groupSwiftFilesByModule(files, id, cfg(targets));

    expect(groups.get('Beta')).toEqual(files);
    expect(groups.has('Alpha')).toBe(false);
  });

  it('matches target dirs from the repo root, not further down the path', () => {
    // A target path is relative to its package; the loader rebases nested
    // packages, so a vendored copy of the same layout is not this target.
    const files = ['Vendor/Copy/Sources/Alpha/User.swift'];

    const groups = groupSwiftFilesByModule(files, id, cfg(new Map([['Alpha', 'Sources/Alpha']])));

    expect(groups.get('__default__')).toEqual(files);
  });

  it('assigns root-level files to a path: "." target', () => {
    const files = ['Lib.swift', 'Sources/Other/X.swift'];
    const targets = new Map([['Lib', '.']]);

    const groups = groupSwiftFilesByModule(files, id, cfg(targets));

    expect(groups.get('Lib')).toEqual(files);
    expect(groups.has('__default__')).toBe(false);
  });

  it('matches a target dir only at a `/` boundary, not a substring', () => {
    // "Sources/Alpha" must NOT match "Sources/AlphaBeta/...". The matcher
    // accepts only a path-start or slash-delimited target occurrence.
    const files = ['Sources/AlphaBeta/User.swift'];
    const targets = new Map([['Alpha', 'Sources/Alpha']]);

    const groups = groupSwiftFilesByModule(files, id, cfg(targets));

    expect(groups.has('Alpha')).toBe(false);
    expect(groups.get('__default__')).toEqual(files);
  });

  it('routes unmatched files (with targets present) to __default__', () => {
    const files = ['Sources/Alpha/User.swift', 'Loose/Orphan.swift'];
    const targets = new Map([['Alpha', 'Sources/Alpha']]);

    const groups = groupSwiftFilesByModule(files, id, cfg(targets));

    expect(groups.get('Alpha')).toEqual(['Sources/Alpha/User.swift']);
    expect(groups.get('__default__')).toEqual(['Loose/Orphan.swift']);
  });

  it('routes ALL files to __default__ when targets is null (no source dir found)', () => {
    const files = ['Models/User.swift', 'Services/App.swift'];

    const groups = groupSwiftFilesByModule(files, id, cfg(null));

    expect([...groups.keys()]).toEqual(['__default__']);
    expect(groups.get('__default__')).toEqual(files);
  });

  it('routes ALL files to __default__ when targets is empty', () => {
    const files = ['Models/User.swift', 'Services/App.swift'];

    const groups = groupSwiftFilesByModule(files, id, cfg(new Map()));

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

    const groups = groupSwiftFilesByModule(items, (i) => i.filePath, cfg(targets));

    expect(groups.get('Alpha')).toEqual([items[0]]);
    expect(groups.get('Beta')).toEqual([items[1]]);
  });

  it('keeps inferred Sources/* folders in separate buckets', () => {
    const targets = new Map([
      ['App', 'Sources/App'],
      ['Models', 'Sources/Models'],
      ['Foundation', 'Sources/Foundation'],
    ]);
    const items = [
      'Sources/App/main.swift',
      'Sources/Models/User.swift',
      'Sources/Foundation/Thing.swift',
    ];

    const groups = groupSwiftFilesByModule(items, id, cfg(targets));

    expect(groups.get('App')).toEqual(['Sources/App/main.swift']);
    expect(groups.get('Models')).toEqual(['Sources/Models/User.swift']);
    expect(groups.get('Foundation')).toEqual(['Sources/Foundation/Thing.swift']);
    expect(groups.get('__default__')).toBeUndefined();
  });

  it('normalizes backslash paths to forward-slash before matching', () => {
    const files = ['Sources\\Alpha\\Core\\User.swift'];
    const targets = new Map([['Alpha', 'Sources/Alpha']]);

    const groups = groupSwiftFilesByModule(files, id, cfg(targets));

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

describe('swiftModuleKeysOf — compiler module rules (#3355)', () => {
  const modules = [
    {
      key: 'Pkg/Sources/Lib',
      name: 'Lib',
      dir: 'Pkg/Sources/Lib',
      importable: true,
      sources: ['Pkg/Sources/Lib/Core', 'Pkg/Sources/Lib/Main.swift'],
      excluded: ['Pkg/Sources/Lib/Core/Legacy'],
    },
  ];
  const complete = { targets: new Map(), modules, moduleNamesComplete: true };
  const partial = { targets: new Map(), modules, moduleNamesComplete: false };

  it('makes every package manifest a module of its own', () => {
    for (const manifest of ['Package.swift', 'Pkg/Package.swift', 'Pkg/Package@swift-5.9.swift']) {
      expect(swiftModuleKeysOf(manifest, complete)).toEqual([`file:${manifest}`]);
      expect(swiftModuleKeysOf(manifest, null)).toEqual([`file:${manifest}`]);
    }
  });

  it('applies sources: and exclude:, leaving filtered-out files in no target', () => {
    expect(swiftModuleKeysOf('Pkg/Sources/Lib/Core/A.swift', complete)).toEqual([
      'Pkg/Sources/Lib',
    ]);
    expect(swiftModuleKeysOf('Pkg/Sources/Lib/Main.swift', complete)).toEqual(['Pkg/Sources/Lib']);
    expect(swiftModuleKeysOf('Pkg/Sources/Lib/Other.swift', complete)).toEqual([
      'file:Pkg/Sources/Lib/Other.swift',
    ]);
    expect(swiftModuleKeysOf('Pkg/Sources/Lib/Core/Legacy/Old.swift', complete)).toEqual([
      'file:Pkg/Sources/Lib/Core/Legacy/Old.swift',
    ]);
  });

  it('keeps leftovers apart only when every manifest and project was read', () => {
    expect(swiftModuleKeysOf('Scripts/tool.swift', complete)).toEqual(['file:Scripts/tool.swift']);
    expect(swiftModuleKeysOf('Scripts/tool.swift', partial)).toEqual(['__default__']);
  });
});

describe('swiftC99ModuleName', () => {
  it.each([
    ['Lib', 'Lib'],
    ['my-lib', 'my_lib'],
    ['Widget Extension', 'Widget_Extension'],
    ['3D', '_3D'],
    ['Café.Kit', 'Café_Kit'],
  ])('%s -> %s', (name, expected) => {
    expect(swiftC99ModuleName(name)).toBe(expected);
  });
});

describe('swiftModuleKeysOf — review fixes (#3355)', () => {
  it('keeps both a SwiftPM target and an Xcode target that compile the same file', () => {
    const config = {
      targets: new Map(),
      modules: [
        { key: 'Pkg/Sources/Lib', name: 'Lib', dir: 'Pkg/Sources/Lib', importable: true },
        {
          key: 'xcode:App.xcodeproj:App',
          name: 'App',
          files: ['Pkg/Sources/Lib/Shared.swift'],
          importable: true,
        },
      ],
      moduleNamesComplete: true,
    };
    expect(swiftModuleKeysOf('Pkg/Sources/Lib/Shared.swift', config)).toEqual([
      'Pkg/Sources/Lib',
      'xcode:App.xcodeproj:App',
    ]);
  });
});
