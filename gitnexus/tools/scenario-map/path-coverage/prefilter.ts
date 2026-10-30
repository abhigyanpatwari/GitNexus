/**
 * The test files Layer 1 must run for the fingerprint (fingerprint plan E7).
 *
 * Past the path rule, a pair is a duplicate, a possible duplicate or a table row only when both
 * tests have the same checks-and-context key or a key is unknown: `checks-differ` makes every other
 * pair Distinct unless its inputs are equal (verdict/fingerprint.ts). The key is static (KTD5,
 * facet/checks.ts over the static inventory), so a file whose every test has a key no other test
 * shares needs no run. A file stays when one of its tests has a key another test shares or no key,
 * when a call's instance count is not static, when a body reads a file snapshot (the runtime full
 * name picks the entry, and the static one may differ), when it may register tests the inventory
 * cannot see (inventory/cases.ts `incomplete`: a helper such as
 * test/helpers/rename-integration-cases.ts `defineRenameFixtureTests`), or when it did not parse.
 *
 * Given up: `different-checks` (the same path and input, other checks) between a test of a skipped
 * file and any other test; the last full run over the unit tests had none in 6,264 candidate pairs.
 * The plan and coverage stages apply it unless mutation scope is `all` or the run is the controls.
 *
 * Library only; it reads the test files and their snapshot and helper modules.
 */
import { checksContextKey, fsModuleReader, fsSnapshotReader } from '../facet/checks.js';
import { loadStaticInventory } from '../inventory/cases.js';

/** Matchers that read a `.snap` file entry named after the runtime test name. */
const FILE_SNAPSHOT = /\.(?:toMatchSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot)\(/;

export interface Layer1Files {
  /** The files Layer 1 runs, in input order. */
  files: string[];
  /**
   * The others: every test has a checks-and-context key no other test shares, or (diff scope) a
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
      else keys.push({ file: site.file, key });
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
