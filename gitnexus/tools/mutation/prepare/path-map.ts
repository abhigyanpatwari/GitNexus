/**
 * Prepared-copy layout, path map and `gitnexus-shared` aliases (KTD8).
 *
 * Stryker cannot mutate files outside its working directory, so the prepare step copies
 * `gitnexus-shared/src` into the prepared `gitnexus/` tree at {@link RELOCATED_SHARED_DIR}.
 * The relocation path never contains `node_modules`. Paths in this module are POSIX paths
 * relative to the prepared root, which mirrors the repo root: `gitnexus/src/...` is the
 * identity and the relocated shared tree translates back to `gitnexus-shared/src/...`.
 * Any other path is rejected rather than passed through.
 *
 * Fixture projects of the mutation tooling (the gate 2 conformance fixture) mutate their own
 * production modules where they live, under `gitnexus/test/fixtures/mutation-<name>/`. A caller
 * that needs one builds an extended map with {@link buildPathMap} and passes it explicitly; the
 * translation functions default to {@link PATH_MAP}, which never maps a fixture path.
 *
 * This module is imported by tools/mutation/vitest.mutation.config.ts, so it must stay free
 * of heavy dependencies.
 */
import path from 'node:path';

/** The prepared root's copy of the repo's `gitnexus/` package. */
export const PACKAGE_DIR = 'gitnexus';

/** Where `gitnexus-shared` (its `src/` and `package.json`) lives, relative to the package dir. */
export const RELOCATED_SHARED_DIR = 'relocated/gitnexus-shared';

export interface PathMapEntry {
  /** Directory prefix under the prepared root, with a trailing `/`. */
  prepared: string;
  /** The same directory in the repo, with a trailing `/`. */
  repo: string;
}

export const PATH_MAP: readonly PathMapEntry[] = Object.freeze([
  { prepared: `${PACKAGE_DIR}/${RELOCATED_SHARED_DIR}/src/`, repo: 'gitnexus-shared/src/' },
  { prepared: `${PACKAGE_DIR}/src/`, repo: `${PACKAGE_DIR}/src/` },
]);

/** The only directories {@link buildPathMap} accepts as extra roots. */
const EXTRA_ROOT = /^gitnexus\/test\/fixtures\/mutation-[a-z0-9]+(?:-[a-z0-9]+)*\/$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Normalises to a relative POSIX path, rejecting absolute paths and `..` escapes. */
function normalizeRelative(input: string): string {
  const posix = input.replace(/\\/g, '/');
  const normalized = path.posix.normalize(posix);
  const escapes = normalized === '..' || normalized.startsWith('../');
  if (path.posix.isAbsolute(posix) || /^[A-Za-z]:\//.test(posix) || escapes) {
    throw new Error(`path map: ${JSON.stringify(input)} is not a relative path inside the root`);
  }
  return normalized;
}

/**
 * {@link PATH_MAP} plus one identity entry per extra root. An extra root is a mutation fixture
 * project directory, `gitnexus/test/fixtures/mutation-<name>` (repo-relative, `/` or `\`
 * separators, trailing slash optional); its files keep their path in the prepared copy, which
 * mirrors the package. Anything else throws. A root listed twice is mapped once.
 */
export function buildPathMap(extraRoots: readonly string[] = []): readonly PathMapEntry[] {
  const roots = new Set<string>();
  for (const root of extraRoots) {
    const directory = `${normalizeRelative(root).replace(/\/+$/, '')}/`;
    if (!EXTRA_ROOT.test(directory)) {
      throw new Error(
        `path map: extra root ${JSON.stringify(root)} is not a mutation fixture directory ` +
          '(gitnexus/test/fixtures/mutation-<name>)',
      );
    }
    roots.add(directory);
  }
  if (roots.size === 0) return PATH_MAP;
  return Object.freeze([
    ...PATH_MAP,
    ...[...roots].map((root): PathMapEntry => ({ prepared: root, repo: root })),
  ]);
}

function translate(
  input: string,
  from: 'prepared' | 'repo',
  to: 'prepared' | 'repo',
  map: readonly PathMapEntry[],
): string {
  const relative = normalizeRelative(input);
  for (const entry of map) {
    const prefix = entry[from];
    if (relative.startsWith(prefix) && relative.length > prefix.length) {
      return entry[to] + relative.slice(prefix.length);
    }
  }
  throw new Error(
    `path map: ${JSON.stringify(input)} is outside the mapped roots (${map.map((e) => e[from]).join(', ')})`,
  );
}

/** A path relative to the prepared root, translated to its repo-relative source path. */
export function toRepoPath(preparedPath: string, map: readonly PathMapEntry[] = PATH_MAP): string {
  return translate(preparedPath, 'prepared', 'repo', map);
}

/** A repo-relative source path, translated to its location under the prepared root. */
export function toPreparedPath(repoPath: string, map: readonly PathMapEntry[] = PATH_MAP): string {
  return translate(repoPath, 'repo', 'prepared', map);
}

/**
 * An absolute path under a directory that plays the role of the prepared `gitnexus/` package
 * (the prepared copy itself or a Stryker sandbox of it), translated to its repo path.
 */
export function toRepoPathFromPackageDir(
  packageDir: string,
  absolutePath: string,
  map: readonly PathMapEntry[] = PATH_MAP,
): string {
  const relative = path.relative(packageDir, absolutePath);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(
      `path map: ${JSON.stringify(absolutePath)} is not a relative path inside the root`,
    );
  }
  return toRepoPath(`${PACKAGE_DIR}/${relative}`, map);
}

export interface SharedPackageJson {
  name: string;
  exports: unknown;
}

/** Parses the `gitnexus-shared` package.json fields the aliases need. */
export function parseSharedPackageJson(text: string): SharedPackageJson {
  const data: unknown = JSON.parse(text);
  if (!isPlainObject(data) || typeof data.name !== 'string' || data.name === '') {
    throw new Error('gitnexus-shared exports: package.json has no package name');
  }
  return { name: data.name, exports: data.exports };
}

export interface SharedAlias {
  /** The bare import specifier, e.g. `gitnexus-shared/test-helpers`. */
  specifier: string;
  /** Anchored regex for Vite's `resolve.alias`. */
  find: RegExp;
  /** Absolute path of the source file inside the relocated copy. */
  replacement: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** The export target a runtime import resolves to: a string, or the `default`/`import` condition. */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return undefined;
  const target = value.default ?? value.import;
  return typeof target === 'string' ? target : undefined;
}

/**
 * One regex alias per key of the package `exports` map, pointing at the relocated source file
 * the built `dist/<name>.js` comes from (`src/<name>.ts`). A shape this cannot map exactly
 * (wildcards, targets outside `dist/`, no runtime condition) throws instead of being skipped,
 * so a new export cannot silently fall back to the unrelocated package.
 */
export function deriveSharedAliases(pkg: SharedPackageJson, sharedDir: string): SharedAlias[] {
  const fail = (detail: string): never => {
    throw new Error(`gitnexus-shared exports: ${detail}`);
  };
  const exportsMap = pkg.exports;
  if (!isPlainObject(exportsMap)) return fail('expected an object of subpath exports');
  return Object.entries(exportsMap).map(([key, value]): SharedAlias => {
    if (key !== '.' && !/^\.\/[^*]+$/.test(key)) {
      return fail(`unsupported key ${JSON.stringify(key)}`);
    }
    const target = exportTarget(value);
    const match = target === undefined ? null : /^\.\/dist\/([^*]+)\.js$/.exec(target);
    if (match === null) {
      return fail(`cannot map the target of ${JSON.stringify(key)} to a source file`);
    }
    const specifier = key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
    return {
      specifier,
      find: new RegExp(`^${escapeRegExp(specifier)}$`),
      replacement: path.join(sharedDir, 'src', `${match[1]}.ts`),
    };
  });
}
