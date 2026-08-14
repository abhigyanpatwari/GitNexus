/**
 * TypeScript/JavaScript module resolution — the declared-input rules (#2953).
 *
 * The property under test is one sentence: a specifier resolves when something
 * in the repo DECLARES it, and not otherwise. Each arm names the declaration
 * doing the work — a real path, a tsconfig mapping, a package manifest — and
 * the negative arms are the ones the old suffix matcher got wrong, so they are
 * paired with a positive arm resolving the same specifier to the same file once
 * a declaration exists.
 */
import { describe, it, expect } from 'vitest';
import {
  nodePackageNameOf,
  substituteStar,
  type NodeWorkspacePackages,
} from '../../src/core/ingestion/import-resolvers/node-workspace-packages.js';
import { resolveTsModule } from '../../src/core/ingestion/languages/typescript/module-resolution.js';
import type { TsconfigIndex } from '../../src/core/ingestion/languages/typescript/tsconfig.js';

const FILES = new Set([
  'apps/web/src/main.ts',
  'apps/web/src/utils/foo.ts',
  'packages/inner/src/nest/index.ts',
  'packages/inner/src/secret.ts',
  'packages/utils/src/index.ts',
  'packages/utils/src/deep/thing.ts',
]);

const PACKAGES: NodeWorkspacePackages = {
  byName: new Map([
    [
      '@repo/utils',
      {
        dir: 'packages/utils',
        entries: ['packages/utils/src/index'],
        subpathExports: new Map(),
        subpathImports: new Map(),
      },
    ],
    [
      '@repo/inner',
      {
        dir: 'packages/inner',
        entries: ['packages/inner/src/index'],
        // An `exports` map is a restriction: `nest` is public, `secret` is not.
        subpathExports: new Map([['nest', ['packages/inner/src/nest']]]),
        subpathImports: new Map([['#hidden', ['packages/inner/src/secret']]]),
      },
    ],
  ]),
};

function resolve(
  specifier: string,
  opts: {
    from?: string;
    tsconfigs?: TsconfigIndex | null;
    packages?: NodeWorkspacePackages | null;
  } = {},
): string | null {
  return resolveTsModule(specifier, {
    fromFile: opts.from ?? 'apps/web/src/main.ts',
    allFilePaths: FILES,
    tsconfigs: opts.tsconfigs ?? null,
    workspacePackages: opts.packages === undefined ? PACKAGES : opts.packages,
  });
}

const BASE_URL_SRC: TsconfigIndex = {
  scopes: [{ dir: 'apps/web', baseUrl: 'apps/web/src', paths: [] }],
};

describe('nodePackageNameOf', () => {
  it('takes two segments for a scoped specifier and one otherwise', () => {
    expect(nodePackageNameOf('@acme/telemetry/nest')).toBe('@acme/telemetry');
    expect(nodePackageNameOf('@repo/utils')).toBe('@repo/utils');
    expect(nodePackageNameOf('lodash/fp')).toBe('lodash');
    expect(nodePackageNameOf('utils/foo')).toBe('utils');
  });

  it('returns null for specifiers that name a path or a package-internal import', () => {
    expect(nodePackageNameOf('./sibling')).toBeNull();
    expect(nodePackageNameOf('../up')).toBeNull();
    expect(nodePackageNameOf('/abs')).toBeNull();
    expect(nodePackageNameOf('#hidden')).toBeNull();
    expect(nodePackageNameOf('@scope-only')).toBeNull();
  });
});

describe('relative specifiers', () => {
  it('resolves by exact path, extension and directory index', () => {
    expect(resolve('./utils/foo')).toBe('apps/web/src/utils/foo.ts');
    expect(resolve('../../../packages/utils/src')).toBe('packages/utils/src/index.ts');
  });

  it('resolves the ESM `.js` spelling of a `.ts` source', () => {
    expect(resolve('./utils/foo.js')).toBe('apps/web/src/utils/foo.ts');
  });

  it('resolves to nothing when the path does not exist', () => {
    expect(resolve('./nowhere')).toBeNull();
  });
});

describe('external packages (#2953 direction 1)', () => {
  it('does not resolve a registry package into the repo', () => {
    // The reported defect: `@acme/telemetry` is a registry dependency, and the
    // repo's only path ending in `nest/index.ts` belongs to an unrelated
    // package. Dropping leading segments found it; declared resolution does not.
    expect(resolve('@acme/telemetry/nest')).toBeNull();
  });

  it('does not resolve a bare specifier that merely matches a path suffix', () => {
    expect(resolve('utils/foo')).toBeNull();
    expect(resolve('src/utils/foo')).toBeNull();
  });

  it('resolves that same specifier once a tsconfig baseUrl declares it', () => {
    expect(resolve('utils/foo', { tsconfigs: BASE_URL_SRC })).toBe('apps/web/src/utils/foo.ts');
  });
});

describe('relative traversal out of the repository', () => {
  it('resolves nothing when a specifier climbs past the root', () => {
    // Popping an empty segment list silently CLAMPS at the root, so
    // `../../../secret` from `apps/web/src/main.ts` became `secret` and could
    // resolve a repo-root file the specifier never named. Outside the repo
    // there is nothing indexed, so the answer is nothing.
    expect(resolve('../../../../../../etc/passwd')).toBeNull();
  });

  it('still resolves a traversal that lands exactly on the root', () => {
    // The paired positive: climbing to the root is legal, only climbing PAST
    // it is not, and the guard must not take the legal case with it.
    expect(resolve('../../../packages/utils/src')).toBe('packages/utils/src/index.ts');
  });
});

describe('tsconfig paths', () => {
  const withPaths: TsconfigIndex = {
    scopes: [
      {
        dir: '',
        baseUrl: null,
        paths: [
          { pattern: '@/*', targets: ['apps/web/src/*'] },
          // A longer literal prefix must win over `@/*` even though it is
          // declared second — tsc ranks by prefix length, not declaration order.
          { pattern: '@/utils/*', targets: ['packages/utils/src/*'] },
          { pattern: 'exact', targets: ['packages/utils/src/index'] },
        ],
      },
    ],
  };

  it('substitutes the wildcard', () => {
    expect(resolve('@/main', { tsconfigs: withPaths })).toBe('apps/web/src/main.ts');
  });

  it('prefers the longest matching pattern, not the first declared', () => {
    expect(resolve('@/utils/deep/thing', { tsconfigs: withPaths })).toBe(
      'packages/utils/src/deep/thing.ts',
    );
  });

  it('supports a starless exact pattern', () => {
    expect(resolve('exact', { tsconfigs: withPaths })).toBe('packages/utils/src/index.ts');
  });

  it('tries every target in order, not just the first', () => {
    const twoTargets: TsconfigIndex = {
      scopes: [
        {
          dir: '',
          baseUrl: null,
          // The first target names nothing; the old loader kept only this one.
          paths: [{ pattern: '~/*', targets: ['generated/*', 'packages/utils/src/*'] }],
        },
      ],
    };
    expect(resolve('~/index', { tsconfigs: twoTargets })).toBe('packages/utils/src/index.ts');
  });

  it('applies the nearest config, not the root one', () => {
    const nested: TsconfigIndex = {
      scopes: [
        { dir: 'apps/web', baseUrl: 'apps/web/src', paths: [] },
        { dir: '', baseUrl: 'packages/utils/src', paths: [] },
      ],
    };
    // `apps/web/src/main.ts` is governed by `apps/web`, whose baseUrl resolves
    // `utils/foo`. The root config would have looked in `packages/utils/src`.
    expect(resolve('utils/foo', { tsconfigs: nested })).toBe('apps/web/src/utils/foo.ts');
  });
});

describe('workspace packages (#2953 direction 2)', () => {
  it('resolves a package name to its manifest entry point', () => {
    // The name appears in no file path, so nothing but the manifest can find it.
    expect(resolve('@repo/utils')).toBe('packages/utils/src/index.ts');
  });

  it('resolves a subpath a package exports', () => {
    expect(resolve('@repo/inner/nest')).toBe('packages/inner/src/nest/index.ts');
  });

  it('honours the restriction an `exports` map imposes', () => {
    // `secret.ts` exists and its path would satisfy any suffix match, but the
    // package does not export it. Node would refuse, and so does this.
    expect(resolve('@repo/inner/secret')).toBeNull();
  });

  it('resolves a package-internal `#` import against the importing package', () => {
    expect(resolve('#hidden', { from: 'packages/inner/src/nest/index.ts' })).toBe(
      'packages/inner/src/secret.ts',
    );
  });

  it('does not honour another package’s `#` imports', () => {
    expect(resolve('#hidden', { from: 'apps/web/src/main.ts' })).toBeNull();
  });

  it('does not fall back into `src/` for an unexported subpath', () => {
    // `@repo/utils` declares no `exports`, so Node resolves a subpath against
    // the package DIRECTORY and only against it. An earlier draft also tried
    // `<dir>/src/<subpath>` on the theory that a workspace package is consumed
    // from source — but nothing declares that mapping, so it is the same kind
    // of guess this module exists to remove, and the import it "resolves" is
    // broken in the real project too.
    expect(resolve('@repo/utils/deep/thing')).toBeNull();
  });

  it('resolves a `#imports` PATTERN key, not just an exact one', () => {
    const patterned: NodeWorkspacePackages = {
      byName: new Map([
        [
          '@repo/inner',
          {
            dir: 'packages/inner',
            entries: ['packages/inner/src/index'],
            subpathExports: new Map(),
            subpathImports: new Map([['#internal/*', ['packages/inner/src/*']]]),
          },
        ],
      ]),
    };

    expect(
      resolveTsModule('#internal/secret', {
        fromFile: 'packages/inner/src/nest/index.ts',
        allFilePaths: FILES,
        tsconfigs: null,
        workspacePackages: patterned,
      }),
    ).toBe('packages/inner/src/secret.ts');
  });

  it('honours an `exports` ARRAY as an ordered fallback list', () => {
    // `["./dist/x.js", "./src/x.ts"]` is what a workspace package publishes to
    // say "built output, or source". For a static analyser the source arm is
    // the one that matters, because `dist/` is build output and is not indexed
    // — and a build need not have run at all for the repo to be analysable.
    const withArray: NodeWorkspacePackages = {
      byName: new Map([
        [
          '@repo/inner',
          {
            dir: 'packages/inner',
            entries: ['packages/inner/src/index'],
            subpathExports: new Map([
              ['nest', ['packages/inner/dist/nest', 'packages/inner/src/nest']],
            ]),
            subpathImports: new Map(),
          },
        ],
      ]),
    };

    expect(
      resolveTsModule('@repo/inner/nest', {
        fromFile: 'apps/web/src/main.ts',
        allFilePaths: FILES,
        tsconfigs: null,
        workspacePackages: withArray,
      }),
    ).toBe('packages/inner/src/nest/index.ts');
  });

  it('refuses the package root when `exports` omits it', () => {
    // `exports` is the package's ENTIRE public interface when present: Node
    // ignores `main` and refuses anything the map does not list. The root is
    // the same rule as a subpath, so a manifest exporting only `./nest` must
    // not answer a bare `@repo/inner` — that import does not resolve in the
    // real project, and an edge for it is a fabricated one.
    const subpathOnly: NodeWorkspacePackages = {
      byName: new Map([
        [
          '@repo/inner',
          {
            dir: 'packages/inner',
            // What `readManifest` produces for `{"exports": {"./nest": …}}`:
            // no root entry, and no legacy/conventional fallbacks.
            entries: [],
            subpathExports: new Map([['nest', ['packages/inner/src/nest']]]),
            subpathImports: new Map(),
          },
        ],
      ]),
    };
    const ctx = {
      fromFile: 'apps/web/src/main.ts',
      allFilePaths: FILES,
      tsconfigs: null,
      workspacePackages: subpathOnly,
    };

    expect(resolveTsModule('@repo/inner', ctx)).toBeNull();
    // The paired positive: what the map DOES list still resolves.
    expect(resolveTsModule('@repo/inner/nest', ctx)).toBe('packages/inner/src/nest/index.ts');
  });

  it('resolves nothing when the repo declares no packages at all', () => {
    expect(resolve('@repo/utils', { packages: null })).toBeNull();
  });
});

describe('subpath pattern substitution', () => {
  it('substitutes the single `*` a pattern is allowed to contain', () => {
    // Node subpath patterns and tsconfig `paths` both allow AT MOST one `*`, so
    // substituting the first occurrence is the specified behaviour. Pinned
    // because the obvious spelling — `String.replace` with a string needle —
    // states that only by accident and reads as the replace-all footgun.
    expect(substituteStar('packages/utils/src/*.ts', 'deep/thing')).toBe(
      'packages/utils/src/deep/thing.ts',
    );
  });

  it('leaves a starless target alone', () => {
    expect(substituteStar('packages/utils/src/index', 'ignored')).toBe('packages/utils/src/index');
  });
});
