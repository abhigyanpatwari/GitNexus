/**
 * Run directory and run manifest of the vitest5 runner (KTD16).
 *
 * Stryker runs the dry run in one test-runner process; the other processes, and replacements
 * started after crashes, timeouts or `maxTestRunnerReuse`, only call `init` and `mutantRun`. The
 * dry-run process therefore writes `<runDir>/run-manifest.json` atomically (temporary name, then
 * rename): the test files, each Stryker id (KTD3) with its Vitest task id and location, and the
 * expected test set per file (`tests`, the tests that ran in the dry run; `skipped` lists the rest).
 * Every runner process loads it before its first mutant run and refuses to run without it.
 *
 * Test selection (KTD4) accepts only manifest test ids: a Stryker `testFiles` option would hand
 * static mutants file paths as their filter, and they would become false survivors.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TestLocation } from './test-ids.js';

export const RUN_MANIFEST_FILE = 'run-manifest.json';
export const RUN_MANIFEST_SCHEMA_VERSION = 1;

export interface ManifestTest {
  id: string;
  taskId: string;
  fullName: string;
  location: TestLocation | null;
  notOracleValidated: boolean;
}

export interface ManifestFile {
  /** Package-relative POSIX path. */
  file: string;
  /** The expected test set: tests that ran in the dry run, in collection order. */
  tests: ManifestTest[];
  /** Tests that the dry run collected but skipped; never selectable. */
  skipped: ManifestTest[];
}

export interface RunManifest {
  schemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION;
  /** Vitest project name; task ids depend on it. */
  project: string;
  vitestVersion: string;
  files: ManifestFile[];
}

export interface TestSelection {
  files: { file: string; tests: ManifestTest[] }[];
}

export class RunManifestMissingError extends Error {
  override name = 'RunManifestMissingError';
}

export class TestFilterError extends Error {
  override name = 'TestFilterError';
}

const fail = (source: string, detail: string): never => {
  throw new Error(`run manifest ${source}: ${detail}`);
};

const requireAbsolute = (runDir: string): void => {
  if (!path.isAbsolute(runDir)) {
    throw new Error(`run manifest: the run directory ${JSON.stringify(runDir)} must be absolute`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

const isPackageRelative = (file: string): boolean =>
  !file.includes('\\') &&
  !path.posix.isAbsolute(file) &&
  !file.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');

function parseTest(value: unknown, source: string): ManifestTest {
  if (!isRecord(value)) return fail(source, 'a test entry must be an object');
  const { id, taskId, fullName, location, notOracleValidated } = value;
  if (!nonEmptyString(id)) return fail(source, 'a test entry needs an id');
  if (!nonEmptyString(taskId)) return fail(source, `test ${id} needs a taskId`);
  if (typeof fullName !== 'string') return fail(source, `test ${id} needs a fullName`);
  if (typeof notOracleValidated !== 'boolean') {
    return fail(source, `test ${id} needs notOracleValidated`);
  }
  return {
    id,
    taskId,
    fullName,
    location: parseLocation(location, id, source),
    notOracleValidated,
  };
}

function parseLocation(value: unknown, id: string, source: string): TestLocation | null {
  if (value === null) return null;
  if (isRecord(value)) {
    const { line, column } = value;
    if (typeof line === 'number' && typeof column === 'number') return { line, column };
  }
  return fail(source, `test ${id} has an invalid location`);
}

/** Parses and validates manifest text; `source` names it in errors. */
export function parseRunManifest(text: string, source: string): RunManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return fail(
      source,
      `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!isRecord(data)) return fail(source, 'must be a JSON object');
  if (data.schemaVersion !== RUN_MANIFEST_SCHEMA_VERSION) {
    return fail(source, `unsupported schema version ${JSON.stringify(data.schemaVersion)}`);
  }
  if (!nonEmptyString(data.project)) return fail(source, 'project must be a non-empty string');
  if (!nonEmptyString(data.vitestVersion)) return fail(source, 'vitestVersion is missing');
  if (!Array.isArray(data.files)) return fail(source, 'files must be an array');

  const ids = new Set<string>();
  const taskIds = new Set<string>();
  const files = data.files.map((entry): ManifestFile => {
    if (!isRecord(entry) || !nonEmptyString(entry.file) || !isPackageRelative(entry.file)) {
      return fail(
        source,
        `file ${JSON.stringify(isRecord(entry) ? entry.file : entry)} must be a package-relative POSIX path`,
      );
    }
    if (!Array.isArray(entry.tests) || !Array.isArray(entry.skipped)) {
      return fail(source, `file ${entry.file} needs tests and skipped arrays`);
    }
    const tests = entry.tests.map((test) => parseTest(test, source));
    const skipped = entry.skipped.map((test) => parseTest(test, source));
    for (const test of [...tests, ...skipped]) {
      if (ids.has(test.id)) fail(source, `Stryker id ${JSON.stringify(test.id)} is listed twice`);
      if (taskIds.has(test.taskId)) fail(source, `task id ${test.taskId} is listed twice`);
      ids.add(test.id);
      taskIds.add(test.taskId);
    }
    return { file: entry.file, tests, skipped };
  });
  return {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    project: data.project,
    vitestVersion: data.vitestVersion,
    files,
  };
}

/** Writes the manifest atomically; returns its path. */
export function writeRunManifest(runDir: string, manifest: RunManifest): string {
  requireAbsolute(runDir);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  parseRunManifest(text, 'to write');
  const target = path.join(runDir, RUN_MANIFEST_FILE);
  const temporary = path.join(
    runDir,
    `.${RUN_MANIFEST_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

/** Loads the manifest the dry-run process wrote; refuses when there is none. */
export function readRunManifest(runDir: string): RunManifest {
  requireAbsolute(runDir);
  const target = path.join(runDir, RUN_MANIFEST_FILE);
  if (!existsSync(target)) {
    throw new RunManifestMissingError(
      `vitest5 runner: no run manifest at ${target}. The dry run writes it; a mutant run ` +
        'refuses to start without it (KTD16). Was the dry run skipped or run with another runDir?',
    );
  }
  return parseRunManifest(readFileSync(target, 'utf8'), target);
}

/**
 * The tests to run for one mutant: the filtered tests per file, or the manifest's full test set
 * when there is no filter (a static mutant). Every filter entry must be a manifest test id.
 */
export function selectTests(
  manifest: RunManifest,
  testFilter: readonly string[] | undefined,
): TestSelection {
  if (testFilter === undefined) {
    return {
      files: manifest.files
        .filter((file) => file.tests.length > 0)
        .map((file) => ({ file: file.file, tests: file.tests })),
    };
  }
  const byId = new Map(
    manifest.files.flatMap((file) => file.tests.map((test) => [test.id, file.file] as const)),
  );
  const rejected = testFilter.filter((id) => !byId.has(id));
  if (rejected.length > 0) {
    const looksLikeFile = rejected.some((id) => !id.includes('#'));
    throw new TestFilterError(
      `vitest5 runner: ${JSON.stringify(rejected.slice(0, 5))} ${rejected.length === 1 ? 'is' : 'are'} ` +
        'not a test id of the run manifest' +
        (looksLikeFile
          ? '; test file paths are not accepted (do not set the Stryker testFiles option, KTD4)'
          : ''),
    );
  }
  const wanted = new Set(testFilter);
  return {
    files: manifest.files
      .map((file) => ({ file: file.file, tests: file.tests.filter((test) => wanted.has(test.id)) }))
      .filter((file) => file.tests.length > 0),
  };
}
