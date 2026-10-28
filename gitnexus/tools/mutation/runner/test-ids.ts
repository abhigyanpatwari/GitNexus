/**
 * Stryker test identity for the vitest5 runner (KTD3).
 *
 * A Stryker test id is `<relative file>#<fullTestName>`: the package-relative POSIX path of the
 * test file, then Vitest's full name (suite and test titles joined with `' > '`). Titles can
 * contain `#` (for example `(#2415)`), so ids are parsed on the first `#` only and a file path
 * may not contain one.
 *
 * Tests that share a full name inside one file get a `:<line>:<column>` suffix (the test's
 * location, 1-based as Vitest reports it). Rows of one `it.each`/`test.for` call share the call
 * site, so a remaining collision adds the row's ordinal within that call:
 * `:<line>:<column>:<row>`, where `<row>` is the 0-based index (Vitest's `$index`) among all tests
 * declared at that location. Rows that needed the ordinal are not oracle-validated (origin §5.4a
 * gate 3). Per-test coverage keys and the run manifest use exactly these ids.
 *
 * Single-test selection (Phase 1 KTD2): a dry run given `vitest5.testIds` first collects the
 * scope's files, assigns these ids, and maps the requested ids to Vitest task ids with
 * {@link selectRequestedTests}; it then runs one task-id specification per file.
 */
import path from 'node:path';

export const TEST_ID_SEPARATOR = '#';

export interface TestLocation {
  line: number;
  column: number;
}

/** A collected Vitest test, in collection order. */
export interface CollectedTest {
  taskId: string;
  fullName: string;
  location: TestLocation | undefined;
}

export interface IdentifiedTest extends CollectedTest {
  id: string;
  /** True when the id needed the `it.each` row ordinal (gate 3 cannot validate the row). */
  notOracleValidated: boolean;
}

export function formatTestId(file: string, name: string): string {
  if (file.includes(TEST_ID_SEPARATOR)) {
    throw new Error(`test id: file ${JSON.stringify(file)} contains "${TEST_ID_SEPARATOR}"`);
  }
  return `${file}${TEST_ID_SEPARATOR}${name}`;
}

/** Splits an id on its first `#`; `name` keeps any location or row suffix. */
export function parseTestId(id: string): { file: string; name: string } {
  const at = id.indexOf(TEST_ID_SEPARATOR);
  if (at < 0) throw new Error(`test id ${JSON.stringify(id)} has no "${TEST_ID_SEPARATOR}"`);
  return { file: id.slice(0, at), name: id.slice(at + 1) };
}

const locationKey = (location: TestLocation): string => `${location.line}:${location.column}`;

const countBy = <T>(items: readonly T[], key: (item: T) => string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
};

/** Assigns KTD3 ids to the tests of one file, given in collection order. */
export function assignTestIds(file: string, tests: readonly CollectedTest[]): IdentifiedTest[] {
  const taskIds = new Set<string>();
  for (const test of tests) {
    if (taskIds.has(test.taskId)) {
      throw new Error(`test ids: ${file} lists task id ${test.taskId} twice`);
    }
    taskIds.add(test.taskId);
  }

  const byName = countBy(tests, (test) => test.fullName);
  const located = (test: CollectedTest): TestLocation => {
    if (test.location === undefined) {
      throw new Error(
        `test ids: ${file} has several tests named ${JSON.stringify(test.fullName)} but no ` +
          'test location; the Vitest config must set includeTaskLocation',
      );
    }
    return test.location;
  };
  const byNameAndLocation = countBy(
    tests.filter((test) => byName.get(test.fullName) > 1),
    (test) => `${test.fullName}\u0000${locationKey(located(test))}`,
  );
  const rowAtLocation = new Map<string, number>();
  const rowOf = new Map<string, number>();
  for (const test of tests) {
    if (test.location === undefined) continue;
    const key = locationKey(test.location);
    const row = rowAtLocation.get(key) ?? 0;
    rowOf.set(test.taskId, row);
    rowAtLocation.set(key, row + 1);
  }

  const identified = tests.map((test): IdentifiedTest => {
    if (byName.get(test.fullName) === 1) {
      return { ...test, id: formatTestId(file, test.fullName), notOracleValidated: false };
    }
    const location = located(test);
    const suffix = `${test.fullName}:${locationKey(location)}`;
    if (byNameAndLocation.get(`${test.fullName}\u0000${locationKey(location)}`) === 1) {
      return { ...test, id: formatTestId(file, suffix), notOracleValidated: false };
    }
    return {
      ...test,
      id: formatTestId(file, `${suffix}:${rowOf.get(test.taskId)}`),
      notOracleValidated: true,
    };
  });

  const seen = new Set<string>();
  for (const test of identified) {
    if (seen.has(test.id)) throw new Error(`test ids: ${JSON.stringify(test.id)} is not unique`);
    seen.add(test.id);
  }
  return identified;
}

/** Remove only the current copy's path prefixes from titles that interpolate fixture paths. */
export function portableTestName(name: string, packageRoot: string): string {
  const root = packageRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefixes = [
    [root, '<package>'],
    [path.posix.dirname(root), '<repo>'],
  ] as const;
  for (const [prefix, replacement] of prefixes) {
    if (prefix === '/' || prefix === '.') continue;
    name = name.replaceAll(`${prefix}/`, `${replacement}/`);
    name = name.replaceAll(`${prefix.replaceAll('/', '\\')}\\`, `${replacement}/`);
  }
  return name;
}

/** Portable ids; keep raw full names for Vitest's collection/execution consistency check. */
export function assignPortableTestIds(
  file: string,
  tests: readonly CollectedTest[],
  packageRoot: string,
): IdentifiedTest[] {
  return assignTestIds(
    file,
    tests.map((test) => ({
      ...test,
      fullName: portableTestName(test.fullName, packageRoot),
    })),
  ).map((test, index) => ({ ...test, fullName: tests[index].fullName }));
}

export interface FileTestSelection {
  /** Package-relative POSIX path of the test file. */
  file: string;
  /** Vitest task ids of the requested tests of the file, in collection order. */
  taskIds: string[];
}

export interface RequestedTestSelection {
  /** Files with at least one requested test, in the order of `identified`. */
  files: FileTestSelection[];
  /** Requested ids that no collected test has, in request order. */
  unknown: string[];
}

/** Maps requested Stryker ids to the task ids of the collected tests, per file; pure. */
export function selectRequestedTests(
  identified: ReadonlyMap<string, readonly IdentifiedTest[]>,
  testIds: readonly string[],
): RequestedTestSelection {
  const wanted = new Set(testIds);
  const found = new Set<string>();
  const files: FileTestSelection[] = [];
  for (const [file, tests] of identified) {
    const selected = tests.filter((test) => wanted.has(test.id));
    for (const test of selected) found.add(test.id);
    if (selected.length > 0) files.push({ file, taskIds: selected.map((test) => test.taskId) });
  }
  return { files, unknown: testIds.filter((id) => !found.has(id)) };
}

/**
 * Problems of a `testIds` dry run whose tests did not run exactly as requested: a requested id
 * that did not run and a test that ran without being requested, each named; pure.
 */
export function selectionProblems(
  requested: readonly string[],
  executed: readonly string[],
): string[] {
  const asked = new Set(requested);
  const ran = new Set(executed);
  return [
    ...requested
      .filter((id) => !ran.has(id))
      .map((id) => `requested test ${JSON.stringify(id)} did not run (vitest5.testIds)`),
    ...executed
      .filter((id) => !asked.has(id))
      .map((id) => `test ${JSON.stringify(id)} ran but vitest5.testIds does not request it`),
  ];
}
