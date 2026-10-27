/**
 * The test files Layer 1 must run for the fingerprint (fingerprint plan E7).
 *
 * Used only for diff-scoped runs. Keep files sharing an assertion/context key or an exact
 * callback-body key, plus files whose test inventory or checks are unknown. Body matches are
 * retrieval hints: setup, inputs, paths and trace evidence still decide the verdict. Whole-suite
 * runs execute every fingerprint file so a unique static context cannot hide a runtime match.
 *
 * Library only; it reads the test files and their snapshot and helper modules.
 */
import { checksContextKey, fsModuleReader, fsSnapshotReader } from '../facet/checks.js';
import { bodyKeyOf } from '../facet/body-key.js';
import { loadStaticInventory } from '../inventory/cases.js';

/** Matchers that read a `.snap` file entry named after the runtime test name. */
const FILE_SNAPSHOT = /\.(?:toMatchSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot)\(/;

export interface Layer1Files {
  /** The files Layer 1 runs, in input order. */
  files: string[];
  /**
   * The others: every test has static retrieval keys no other test shares, or (diff scope) a
   * static key, none of which a changed file's test has.
   */
  skipped: string[];
}

/**
 * Splits package-path test files into those Layer 1 must run and the rest. With `changed` (a
 * diff-scoped run, fingerprint plan E8) only pairs with a changed file's test count: the changed
 * files the whole-suite rule keeps, every file with a test whose key a changed file's test has,
 * and every file with a test of no static key, which can pair with any test.
 */
export function layer1Files(
  repoRoot: string,
  files: readonly string[],
  changed: ReadonlySet<string> | null = null,
): Layer1Files {
  const inventory = loadStaticInventory(repoRoot, files);
  const options = { snapshots: fsSnapshotReader(repoRoot), modules: fsModuleReader(repoRoot) };
  // Files with a test of no static key: it can pair with any test.
  const unknown = new Set([...inventory.skipped, ...inventory.incomplete]);
  const keys: { file: string; key: string }[] = [];
  for (const site of inventory.sites) {
    if (site.instances === null || FILE_SNAPSHOT.test(site.record.body)) {
      unknown.add(site.file);
      continue;
    }
    for (const instance of site.instances) {
      const key = checksContextKey(
        { record: site.record, instance, fullName: site.fullName },
        options,
      );
      if (key === null) unknown.add(site.file);
      else
        keys.push(
          { file: site.file, key: `context:${key}` },
          { file: site.file, key: `body:${bodyKeyOf(site.record)}` },
        );
    }
  }
  const count = new Map<string, number>();
  for (const { key } of keys) count.set(key, (count.get(key) ?? 0) + 1);
  // A key only one test has pairs with nothing.
  const shared = (key: string): boolean => (count.get(key) ?? 0) > 1;
  const keep = new Set([...unknown, ...keys.filter((k) => shared(k.key)).map((k) => k.file)]);
  const changedKeys = new Set(
    keys.filter(({ file, key }) => changed?.has(file) === true && shared(key)).map((k) => k.key),
  );
  const run =
    changed === null
      ? keep
      : new Set([
          ...[...keep].filter((file) => changed.has(file)),
          ...keys.filter(({ key }) => changedKeys.has(key)).map(({ file }) => file),
          ...unknown,
        ]);
  return {
    files: files.filter((file) => run.has(file)),
    skipped: files.filter((file) => !run.has(file)),
  };
}
