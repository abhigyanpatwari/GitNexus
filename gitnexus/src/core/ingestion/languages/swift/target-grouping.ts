/**
 * Swift module membership for the registry-primary same-module hooks
 * (`implicit-imports.ts`, `target-siblings.ts`, `sibling-type-bindings.ts`,
 * extension-owner stamping) and for `import` resolution and the
 * global-name-fallback veto.
 *
 * A Swift module is a compiler unit: a SwiftPM target (a directory subtree)
 * or an Xcode native target (a file list and synchronized folders). Every
 * file of a module sees every other file's `internal` declarations with no
 * `import`; nothing crosses a module boundary without one.
 *
 * The module list comes from `loadSwiftWorkspaceConfig` through the
 * `resolutionConfig` channel (`modules`). A hand-built `{ targets }` config
 * (tests, the root-only loader) is read as SwiftPM targets keyed by name.
 *
 * Matching:
 *   - SwiftPM: the deepest target directory that is a path-prefix of the file,
 *     anchored at the repo root. A target path is relative to its package, and
 *     the loader has already rebased it to the repo root, so a directory
 *     further down the path (a vendored copy of the same layout) is not the
 *     target. One module per file: SwiftPM rejects overlapping target sources.
 *     A target's `sources:` / `exclude:` narrow it; a file they leave out
 *     belongs to no target.
 *   - Xcode: exact file membership plus synchronized folders, minus the
 *     folder's exceptions for that target. A file compiled into several
 *     targets belongs to all of them, including a SwiftPM target whose
 *     directory it also lies under.
 *   - A package manifest (`Package.swift`, `Package@swift-X.Y.swift`) is
 *     compiled on its own against `PackageDescription`: a module of one file.
 *   - Anything else: a module of one file when discovery read every manifest
 *     and project (`moduleNamesComplete`), since no module compiles it;
 *     otherwise the single `__default__` module, because an unread manifest
 *     or project may be what owns it.
 */

import type { SwiftModuleSpec, SwiftPackageConfig } from '../../language-config.js';
export { coerceDeclaredSwiftTargets } from '../../language-config.js';

export const DEFAULT_SWIFT_MODULE = '__default__';

const SWIFT_MANIFEST_RE = /(^|\/)Package(@swift-[\d.]+)?\.swift$/;

/**
 * The module name the compiler derives from a target or product name: every
 * character that cannot appear in an identifier becomes `_`, and a leading
 * digit gets a `_` prefix. SwiftPM (`c99name`) and Xcode
 * (`$(PRODUCT_NAME:c99extidentifier)`) both apply it, so `my-lib` is
 * `import my_lib`.
 */
export function swiftC99ModuleName(name: string): string {
  const mangled = name.replace(/[^\p{L}\p{M}\p{N}_]/gu, '_');
  return /^\p{N}/u.test(mangled) ? `_${mangled}` : mangled;
}

/** True when `filePath` is `dir` or lies below it. */
function isUnder(filePath: string, dir: string): boolean {
  return dir === '' || filePath === dir || filePath.startsWith(`${dir}/`);
}

interface SwiftModuleMatcher {
  readonly spmByDir: ReadonlyMap<string, string>;
  readonly xcodeByFile: ReadonlyMap<string, readonly string[]>;
  readonly xcodeByFolder: ReadonlyMap<
    string,
    readonly { key: string; excluded: readonly string[] }[]
  >;
  readonly specByKey: ReadonlyMap<string, SwiftModuleSpec>;
  readonly order: ReadonlyMap<string, number>;
  /** Leftover files are one-file modules (see the file header). */
  readonly leftoversStandalone: boolean;
}

const MATCHERS = new WeakMap<object, SwiftModuleMatcher>();

/**
 * The modules a config declares, or null when it carries none. `modules` wins;
 * a bare `{ targets }` map is read as SwiftPM targets keyed by name.
 */
export function swiftModuleSpecs(resolutionConfig: unknown): readonly SwiftModuleSpec[] | null {
  const config = resolutionConfig as Partial<SwiftPackageConfig> | null | undefined;
  if (config == null) return null;
  if (Array.isArray(config.modules)) return config.modules;
  const targets = coerceSwiftTargets(config);
  if (targets === null || targets.size === 0) return null;
  return [...targets].map(([name, dir]) => ({
    key: name,
    name,
    dir: normalizeDir(dir),
    importable: true,
  }));
}

/** Module keys `filePath` belongs to, in declaration order; `[__default__]` when none. */
export function swiftModuleKeysOf(filePath: string, resolutionConfig: unknown): readonly string[] {
  const norm = filePath.includes('\\') ? filePath.replace(/\\/g, '/') : filePath;
  const standalone = [`file:${norm}`];
  if (SWIFT_MANIFEST_RE.test(norm)) return standalone;
  const matcher = matcherFor(resolutionConfig);
  if (matcher === null) return DEFAULT_KEYS;
  const ancestors = ancestorDirs(norm);
  const keys = new Set<string>();

  for (const dir of ancestors) {
    const key = matcher.spmByDir.get(dir);
    if (key === undefined) continue;
    if (isFilteredIn(norm, matcher.specByKey.get(key)!)) keys.add(key);
    break; // The deepest target owns the directory; its filters may leave this file out.
  }

  for (const key of matcher.xcodeByFile.get(norm) ?? []) keys.add(key);
  for (const dir of ancestors) {
    for (const folder of matcher.xcodeByFolder.get(dir) ?? []) {
      if (!folder.excluded.some((path) => isUnder(norm, path))) keys.add(folder.key);
    }
  }
  if (keys.size > 0) {
    return [...keys].sort((a, b) => matcher.order.get(a)! - matcher.order.get(b)!);
  }
  return matcher.leftoversStandalone ? standalone : DEFAULT_KEYS;
}

/** SwiftPM `sources:` / `exclude:` for a file already under the target directory. */
function isFilteredIn(filePath: string, spec: SwiftModuleSpec): boolean {
  if (spec.sources !== undefined && !spec.sources.some((path) => isUnder(filePath, path))) {
    return false;
  }
  return !(spec.excluded ?? []).some((path) => isUnder(filePath, path));
}

/** The module a key names; undefined for `__default__` or an unknown key. */
export function swiftModuleSpecOf(
  key: string,
  resolutionConfig: unknown,
): SwiftModuleSpec | undefined {
  return matcherFor(resolutionConfig)?.specByKey.get(key);
}

/**
 * Group `items` by module. By default each item joins only its FIRST module,
 * for passes that must see a file once (extension-owner stamping). With
 * `allMemberships`, an item compiled into several Xcode targets joins each.
 */
export function groupSwiftFilesByModule<T>(
  items: readonly T[],
  getPath: (item: T) => string,
  resolutionConfig: unknown,
  options: { readonly allMemberships?: boolean } = {},
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const keys = swiftModuleKeysOf(getPath(item), resolutionConfig);
    for (const key of options.allMemberships === true ? keys : keys.slice(0, 1)) {
      let group = groups.get(key);
      if (group === undefined) {
        group = [];
        groups.set(key, group);
      }
      group.push(item);
    }
  }
  return groups;
}

/**
 * Duck-type the opaque `resolutionConfig` into the SwiftPM `targets` map, or
 * `null` when no Swift package config is present.
 */
export function coerceSwiftTargets(resolutionConfig: unknown): ReadonlyMap<string, string> | null {
  const config = resolutionConfig as Partial<SwiftPackageConfig> | null | undefined;
  if (config != null && config.targets instanceof Map) {
    return config.targets;
  }
  return null;
}

const DEFAULT_KEYS: readonly string[] = Object.freeze([DEFAULT_SWIFT_MODULE]);

function matcherFor(resolutionConfig: unknown): SwiftModuleMatcher | null {
  if (typeof resolutionConfig !== 'object' || resolutionConfig === null) return null;
  const cached = MATCHERS.get(resolutionConfig);
  if (cached !== undefined) return cached;
  const specs = swiftModuleSpecs(resolutionConfig);
  if (specs === null) return null;

  const spmByDir = new Map<string, string>();
  const xcodeByFile = new Map<string, string[]>();
  const xcodeByFolder = new Map<string, { key: string; excluded: readonly string[] }[]>();
  const specByKey = new Map<string, SwiftModuleSpec>();
  const order = new Map<string, number>();
  for (const spec of specs) {
    if (specByKey.has(spec.key)) continue;
    specByKey.set(spec.key, spec);
    order.set(spec.key, order.size);
    if (spec.dir !== undefined) {
      // First target wins a shared directory; SwiftPM rejects that layout.
      if (!spmByDir.has(spec.dir)) spmByDir.set(spec.dir, spec.key);
      continue;
    }
    for (const file of spec.files ?? []) {
      const keys = xcodeByFile.get(file);
      if (keys === undefined) xcodeByFile.set(file, [spec.key]);
      else keys.push(spec.key);
    }
    const excluded = spec.excluded ?? [];
    for (const folder of spec.folders ?? []) {
      const entries = xcodeByFolder.get(folder);
      const entry = { key: spec.key, excluded };
      if (entries === undefined) xcodeByFolder.set(folder, [entry]);
      else entries.push(entry);
    }
  }

  const leftoversStandalone =
    (resolutionConfig as Partial<SwiftPackageConfig>).moduleNamesComplete === true;
  const matcher = { spmByDir, xcodeByFile, xcodeByFolder, specByKey, order, leftoversStandalone };
  MATCHERS.set(resolutionConfig, matcher);
  return matcher;
}

/** Ancestor directories of a file path, deepest first, ending with '' (the root). */
function ancestorDirs(filePath: string): string[] {
  const out: string[] = [];
  let i = filePath.lastIndexOf('/');
  while (i > 0) {
    out.push(filePath.slice(0, i));
    i = filePath.lastIndexOf('/', i - 1);
  }
  out.push('');
  return out;
}

/** `./Sources/App/` → `Sources/App`; `.` → ''. */
function normalizeDir(dir: string): string {
  let norm = dir.replace(/\\/g, '/');
  while (norm.startsWith('./')) norm = norm.slice(2);
  norm = norm.replace(/\/+$/, '');
  return norm === '.' ? '' : norm;
}
