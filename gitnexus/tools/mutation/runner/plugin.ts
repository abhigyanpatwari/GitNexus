/**
 * Stryker test-runner plugin `vitest5`: runs a mutation scope under the repo's own Vitest 5.0.x
 * (KTD1), with per-test coverage keyed by KTD3 ids, task-id test selection (KTD4), the configured
 * forks pool with fresh workers and no shared caches (KTD5), KTD17 outcome classes in sidecar
 * files (KTD6) and a run manifest shared by every runner process (KTD16).
 *
 * Single-test selection (Phase 1 KTD2): with `vitest5.testIds` the dry run first collects the
 * scope's files, assigns KTD3 ids and maps the requested ids to Vitest task ids. An id that no
 * collected test has fails the dry run, naming it, before any mutant run. It then runs one
 * task-id specification per file that holds a requested test and checks that the tests that ran
 * are exactly the requested ones. The run manifest then lists only those tests as the expected
 * test set (the others of a run file as skipped), so mutant runs, static ones included, never
 * run another test. Without `testIds` every test of the scope runs, as before.
 *
 * The dry-run sidecar record also carries the hook marker: per mutant, the tests a suite hook
 * attributed it to (coverage-attribution.ts `hookCoverage`).
 *
 * Load it with `appendPlugins: ['<prepared>/gitnexus/tools/mutation/runner/plugin.ts']`,
 * `testRunner: 'vitest5'`, `testRunnerNodeArgs: ['--import', 'tsx']`, and start Stryker itself
 * under `node --import tsx`. The plugin options live under the `vitest5` key (see
 * {@link strykerValidationSchema}). Do not set the Stryker `testFiles` option.
 *
 * The plugin module is also loaded by Stryker's main process for option validation, so it keeps
 * its top level light and imports `vitest/node` only in `init`.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTRUMENTER_CONSTANTS,
  type MutantCoverage,
  type StrykerOptions,
} from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { PluginKind, commonTokens, declareClassPlugin, tokens } from '@stryker-mutator/api/plugin';
import {
  DryRunStatus,
  MutantRunStatus,
  TestStatus,
  type DryRunOptions,
  type DryRunResult,
  type MutantRunOptions,
  type MutantRunResult,
  type TestResult,
  type TestRunner,
  type TestRunnerCapabilities,
} from '@stryker-mutator/api/test-runner';
import type { TestModule, TestProject, TestSpecification, Vitest } from 'vitest/node';
import {
  classifyRun,
  type ObservedError,
  type ObservedModule,
  type RequestedTest,
  type RunClassification,
  type SuiteHook,
  type TestHook,
} from './classify-outcome.js';
import { hookAttributedTests, mergeCoverage, rekeyCoverage } from './coverage-attribution.js';
import { PROTOCOL_KEY, type FileMeta, type WorkerContext } from './protocol.js';
import {
  readRunManifest,
  selectTests,
  writeRunManifest,
  type ManifestFile,
  type RunManifest,
} from './run-manifest.js';
import { writeSidecar, type SidecarDraft } from './sidecar.js';
import {
  assignPortableTestIds,
  parseTestId,
  selectRequestedTests,
  selectionProblems,
  type CollectedTest,
  type FileTestSelection,
  type IdentifiedTest,
} from './test-ids.js';
import { assertSupportedVitest } from './version-guard.js';

export const PLUGIN_NAME = 'vitest5';
const SETUP_FILE = fileURLToPath(new URL('./setup.ts', import.meta.url));
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENV = 'STRYKER_MUTATOR_WORKER';

export interface Vitest5RunnerOptions {
  /** Absolute run directory (KTD16); holds the run manifest. */
  runDir: string;
  /** Absolute sidecar directory (KTD6). */
  sidecarDir: string;
  /** Vitest config, relative to the Stryker sandbox (the runner's working directory). */
  configFile: string;
  /** The single Vitest project to run; task ids depend on its name. */
  project: string;
  /** Stryker ids (KTD3) of the only tests to run; null runs every test of the scope. */
  testIds: string[] | null;
}

export const DEFAULT_CONFIG_FILE = 'tools/mutation/vitest.mutation.config.ts';
export const DEFAULT_PROJECT = 'mutation';

export const strykerValidationSchema = {
  $schema: 'http://json-schema.org/draft-07/schema',
  title: 'Vitest5RunnerOptions',
  type: 'object',
  properties: {
    vitest5: {
      description: 'Options of the gitnexus vitest5 test runner (tools/mutation/runner).',
      type: 'object',
      properties: {
        runDir: {
          description: 'Absolute run directory; the dry run writes the run manifest here.',
          type: 'string',
        },
        sidecarDir: {
          description: 'Absolute directory for the per-run outcome-class sidecar records.',
          type: 'string',
        },
        configFile: {
          description: 'Vitest config file, relative to the sandbox.',
          type: 'string',
          default: DEFAULT_CONFIG_FILE,
        },
        project: {
          description: 'Name of the single Vitest project to run.',
          type: 'string',
          default: DEFAULT_PROJECT,
        },
        testIds: {
          description:
            'Stryker test ids (<file>#<full name>) of the only tests to run; absent runs every test.',
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          uniqueItems: true,
        },
      },
      required: ['runDir', 'sidecarDir'],
      additionalProperties: false,
    },
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseRunnerOptions(value: unknown): Vitest5RunnerOptions {
  if (!isRecord(value)) {
    throw new Error(`${PLUGIN_NAME} runner: the "vitest5" options object is missing`);
  }
  const text = (key: string, fallback?: string): string => {
    const entry = value[key] ?? fallback;
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`${PLUGIN_NAME} runner: vitest5.${key} must be a non-empty string`);
    }
    return entry;
  };
  const options: Vitest5RunnerOptions = {
    runDir: text('runDir'),
    sidecarDir: text('sidecarDir'),
    configFile: text('configFile', DEFAULT_CONFIG_FILE),
    project: text('project', DEFAULT_PROJECT),
    testIds: parseTestIdsOption(value.testIds),
  };
  for (const key of ['runDir', 'sidecarDir'] as const) {
    if (!path.isAbsolute(options[key])) {
      throw new Error(`${PLUGIN_NAME} runner: vitest5.${key} must be an absolute path`);
    }
  }
  return options;
}

const isTestId = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    parseTestId(value);
    return true;
  } catch {
    return false;
  }
};

function parseTestIdsOption(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isTestId) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `${PLUGIN_NAME} runner: vitest5.testIds must be a non-empty array of distinct test ids ` +
        '(<file>#<full name>)',
    );
  }
  return [...value];
}

const toObservedError = (error: unknown): ObservedError => {
  if (isRecord(error)) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      message: typeof error.message === 'string' ? error.message : String(error),
    };
  }
  return { name: 'Error', message: String(error) };
};

const retryCount = (retry: number | { count?: number } | undefined): number =>
  typeof retry === 'number' ? retry : (retry?.count ?? 0);

const relativeFile = (root: string, moduleId: string): string =>
  path.relative(root, moduleId).split(path.sep).join('/');

const pick = <T extends string>(hooks: readonly string[] | undefined, names: readonly T[]): T[] =>
  names.filter((name) => hooks?.includes(name) ?? false);

/** A module's tests in collection order, as test-ids.ts reads them. */
const collectedTests = (module: TestModule): CollectedTest[] =>
  [...module.children.allTests()].map((test) => ({
    taskId: test.id,
    fullName: test.fullName,
    location: test.location,
  }));

const describeObservedErrors = (errors: readonly ObservedError[]): string =>
  errors.map((error) => `${error.name}: ${error.message}`).join('; ');

const TEST_HOOKS: readonly TestHook[] = ['beforeEach', 'afterEach'];
const SUITE_HOOKS: readonly SuiteHook[] = ['beforeAll', 'afterAll'];

interface ModuleReport {
  module: TestModule;
  file: string;
  meta: FileMeta | undefined;
  observed: ObservedModule;
}

function reportModule(root: string, module: TestModule): ModuleReport {
  const meta = module.meta()[PROTOCOL_KEY];
  const failed = meta?.failedHooks ?? {};
  const file = relativeFile(root, module.moduleId);
  const observed: ObservedModule = {
    file,
    collected: meta !== undefined,
    errors: module.errors().map(toObservedError),
    failedHooks: pick(failed[module.id], SUITE_HOOKS),
    suites: [...module.children.allSuites()].map((suite) => ({
      taskId: suite.id,
      failedHooks: pick(failed[suite.id], SUITE_HOOKS),
      errors: suite.errors().map(toObservedError),
      testTaskIds: [...suite.children.allTests()].map((test) => test.id),
    })),
    tests: [...module.children.allTests()].map((test) => {
      const result = test.result();
      return {
        taskId: test.id,
        fullName: test.fullName,
        state: result.state,
        errors: (result.errors ?? []).map(toObservedError),
        failedHooks: pick(failed[test.id], TEST_HOOKS),
        retry: retryCount(test.options.retry),
      };
    }),
    hitCount: meta?.hitCount ?? undefined,
  };
  return { module, file, meta, observed };
}

function toMutantRunResult(classification: RunClassification): MutantRunResult {
  switch (classification.status) {
    case 'killed':
      return {
        status: MutantRunStatus.Killed,
        killedBy: classification.killedBy,
        failureMessage: classification.failureMessage ?? classification.outcome,
        nrOfTests: classification.nrOfTests,
      };
    case 'survived':
      return { status: MutantRunStatus.Survived, nrOfTests: classification.nrOfTests };
    case 'timeout':
      return { status: MutantRunStatus.Timeout, reason: classification.reason };
    case 'error':
      return {
        status: MutantRunStatus.Error,
        errorMessage: `${classification.outcome}: ${classification.reason ?? ''}`,
      };
  }
}

export class Vitest5TestRunner implements TestRunner {
  static inject = tokens(commonTokens.options, commonTokens.logger);

  readonly #options: Vitest5RunnerOptions;
  readonly #log: Logger;
  readonly #worker: string;
  #root = '';
  #vitest: Vitest | undefined;
  #project: TestProject | undefined;
  #vitestVersion = '';
  #manifest: RunManifest | undefined;
  /** Modules returned by earlier runs: Vitest returns every module in its state, stale ones too. */
  readonly #earlierModules = new WeakSet<TestModule>();

  constructor(options: StrykerOptions, log: Logger) {
    this.#options = parseRunnerOptions(options[PLUGIN_NAME]);
    this.#log = log;
    this.#worker = process.env[WORKER_ENV] ?? '0';
  }

  capabilities(): TestRunnerCapabilities {
    return { reloadEnvironment: true };
  }

  async init(): Promise<void> {
    // Vitest workers inherit this environment: Stryker's worker id and a stale active mutant
    // must not reach them (KTD5). The worker id was read in the constructor.
    delete process.env[WORKER_ENV];
    delete process.env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE];
    this.#root = process.cwd();
    mkdirSync(this.#options.runDir, { recursive: true });
    mkdirSync(this.#options.sidecarDir, { recursive: true });
    this.#vitestVersion = assertSupportedVitest(this.#root, PLUGIN_DIR).version;
    // Same environment as `vitest run` (startVitest) before it creates Vitest.
    process.env.TEST = 'true';
    process.env.VITEST = 'true';
    process.env.NODE_ENV ??= 'test';

    const { createVitest } = await import('vitest/node');
    const cacheDir = path.join(this.#root, '.vitest5-runner', `cache-${process.pid}`);
    const vitest = await createVitest(
      {
        root: this.#root,
        config: path.resolve(this.#root, this.#options.configFile),
        project: [this.#options.project],
        watch: false,
        cache: false,
        fsModuleCache: false,
        reporters: [],
      },
      { cacheDir },
    );
    this.#vitest = vitest;
    const projects = vitest.projects.filter((project) => project.name === this.#options.project);
    if (projects.length !== 1) {
      throw new Error(
        `${PLUGIN_NAME} runner: expected one Vitest project named ${this.#options.project}, ` +
          `found ${JSON.stringify(vitest.projects.map((project) => project.name))}`,
      );
    }
    const [project] = projects;
    const { config } = project;
    const problems = [
      config.pool === 'forks' ? '' : `pool is ${String(config.pool)}, the runner needs forks`,
      config.isolate === false ? 'isolate is off; static mutants need a fresh module graph' : '',
      config.includeTaskLocation ? '' : 'includeTaskLocation is off; KTD3 ids need locations',
      config.setupFiles.length > 0 && config.sequence.setupFiles !== 'list'
        ? 'other setup files run in parallel with the runner setup file; set sequence.setupFiles: list'
        : '',
    ].filter((problem) => problem !== '');
    if (problems.length > 0) {
      throw new Error(`${PLUGIN_NAME} runner: unsupported Vitest config: ${problems.join('; ')}`);
    }
    config.setupFiles = [SETUP_FILE, ...config.setupFiles];
    this.#project = project;
    this.#log.debug(
      `${PLUGIN_NAME} runner: Vitest ${this.#vitestVersion}, project ${project.name}, worker ` +
        `${this.#worker}, root ${this.#root}`,
    );
  }

  #ready(): { vitest: Vitest; project: TestProject } {
    if (this.#vitest === undefined || this.#project === undefined) {
      throw new Error(`${PLUGIN_NAME} runner: init() has not run`);
    }
    return { vitest: this.#vitest, project: this.#project };
  }

  /**
   * Runs the specifications and returns this run's modules only: one per specification, never a
   * module object an earlier run returned (a file that did not run this time is absent).
   */
  async #run(
    vitest: Vitest,
    specs: readonly TestSpecification[],
    allTestsRun: boolean,
  ): Promise<{ modules: TestModule[]; unhandledErrors: unknown[] }> {
    if (specs.length === 0) return { modules: [], unhandledErrors: [] };
    const result = await vitest.runTestSpecifications([...specs], allTestsRun);
    const wanted = new Set(specs.map((spec) => spec.moduleId));
    const modules = result.testModules.filter(
      (module) => wanted.has(module.moduleId) && !this.#earlierModules.has(module),
    );
    for (const module of result.testModules) this.#earlierModules.add(module);
    return { modules, unhandledErrors: result.unhandledErrors };
  }

  #provide(project: TestProject, context: Omit<WorkerContext, 'namespace' | 'activeMutantEnv'>) {
    project.provide(PROTOCOL_KEY, {
      namespace: INSTRUMENTER_CONSTANTS.NAMESPACE,
      activeMutantEnv: INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE,
      ...context,
    });
  }

  /**
   * The `testIds` dry run's first step: collects every scope file, assigns KTD3 ids and maps the
   * requested ids to task ids per file. Unknown ids and collection failures are problems.
   */
  async #collectSelection(
    vitest: Vitest,
    specs: readonly TestSpecification[],
    testIds: readonly string[],
  ): Promise<{ files: FileTestSelection[]; problems: string[] }> {
    const collected = await vitest.collectTests([...specs]);
    const wanted = new Set(specs.map((spec) => spec.moduleId));
    const modules = collected.testModules.filter(
      (module) => wanted.has(module.moduleId) && !this.#earlierModules.has(module),
    );
    for (const module of collected.testModules) this.#earlierModules.add(module);
    const identified = new Map(
      modules
        .map((module) => ({ module, file: relativeFile(this.#root, module.moduleId) }))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
        .map(
          ({ module, file }) =>
            [file, assignPortableTestIds(file, collectedTests(module), this.#root)] as const,
        ),
    );
    const selection = selectRequestedTests(identified, testIds);
    const problems = [
      ...modules
        .filter((module) => module.errors().length > 0)
        .map(
          (module) =>
            `${relativeFile(this.#root, module.moduleId)}: collection failed: ` +
            describeObservedErrors(module.errors().map(toObservedError)),
        ),
      ...collected.unhandledErrors.map(
        (error) =>
          `unhandled error while collecting: ${describeObservedErrors([toObservedError(error)])}`,
      ),
      ...selection.unknown.map(
        (id) => `requested test ${JSON.stringify(id)} was not collected (vitest5.testIds)`,
      ),
    ];
    return { files: selection.files, problems };
  }

  async dryRun(options: DryRunOptions): Promise<DryRunResult> {
    if (options.testFiles !== undefined && options.testFiles.length > 0) {
      throw new Error(
        `${PLUGIN_NAME} runner: the Stryker testFiles option is not supported (KTD4)`,
      );
    }
    const { vitest, project } = this.#ready();
    this.#provide(project, {
      mode: 'dry-run',
      activeMutant: null,
      mutantActivation: null,
      hitLimit: null,
    });
    const specs = (await vitest.globTestSpecifications()).filter(
      (spec) => spec.project.name === project.name,
    );
    const testIds = this.#options.testIds;
    let runSpecs: readonly TestSpecification[] = specs;
    if (testIds !== null) {
      const selection = await this.#collectSelection(vitest, specs, testIds);
      if (selection.problems.length > 0) {
        return { status: DryRunStatus.Error, errorMessage: selection.problems.join('\n') };
      }
      runSpecs = selection.files.map((file) =>
        project.createSpecification(path.resolve(this.#root, file.file), {
          testIds: file.taskIds,
        }),
      );
    }
    const result = await this.#run(vitest, runSpecs, testIds === null);
    const reports = result.modules
      .map((module) => reportModule(this.#root, module))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

    const identified = new Map<string, IdentifiedTest[]>();
    for (const report of reports) {
      identified.set(
        report.file,
        assignPortableTestIds(report.file, collectedTests(report.module), this.#root),
      );
    }
    const stateOf = new Map(
      reports.flatMap((report) => report.observed.tests.map((test) => [test.taskId, test.state])),
    );
    const ran = (test: IdentifiedTest): boolean =>
      stateOf.get(test.taskId) === 'passed' || stateOf.get(test.taskId) === 'failed';
    // Without testIds the tests that ran are the request; with them, the selection is.
    const wanted = testIds === null ? null : new Set(testIds);
    const requested: RequestedTest[] = reports.flatMap((report) =>
      (identified.get(report.file) ?? [])
        .filter((test) => (wanted === null ? ran(test) : wanted.has(test.id)))
        .map((test) => ({
          id: test.id,
          taskId: test.taskId,
          fullName: test.fullName,
          file: report.file,
        })),
    );
    const classification = classifyRun({
      requested,
      modules: reports.map((report) => report.observed),
      unhandledErrors: result.unhandledErrors.map(toObservedError),
      hitLimit: undefined,
    });
    const idByTaskId = new Map(requested.map((test) => [test.taskId, test.id]));
    const hookCoverage: MutantCoverage = { static: {}, perTest: {} };
    for (const report of reports) {
      if (report.meta?.hookCoverage) {
        mergeCoverage(
          hookCoverage,
          rekeyCoverage({ static: {}, perTest: report.meta.hookCoverage }, idByTaskId),
        );
      }
    }
    this.#writeSidecar({
      kind: 'dry-run',
      mutantId: null,
      mutantActivation: null,
      hitLimit: null,
      requestedTestIds: requested.map((test) => test.id),
      hookAttributedTests: hookAttributedTests(hookCoverage.perTest),
      result: classification,
    });

    const missingSetup = reports.filter(
      (report) => report.meta === undefined && report.observed.errors.length === 0,
    );
    const executed = [...identified.values()].flat().filter(ran);
    const problems = [
      specs.length === 0 ? 'the scope has no test files' : '',
      requested.length === 0 ? 'no test ran' : '',
      ...(testIds === null
        ? []
        : selectionProblems(
            testIds,
            executed.map((test) => test.id),
          )),
      ...missingSetup.map((report) => `the runner setup file did not finish in ${report.file}`),
      ...classification.outsideTest.map((row) => `${row.file}: ${row.outcome}: ${row.message}`),
      classification.outcome === 'infrastructure' || classification.outcome === 'invalid'
        ? `${classification.outcome}: ${classification.reason ?? ''}`
        : '',
    ].filter((problem) => problem !== '');
    if (problems.length > 0) {
      return { status: DryRunStatus.Error, errorMessage: problems.join('\n') };
    }

    const files: ManifestFile[] = reports.map((report) => {
      const tests = (identified.get(report.file) ?? []).map((test) => ({
        id: test.id,
        taskId: test.taskId,
        fullName: test.fullName,
        location: test.location ?? null,
        notOracleValidated: test.notOracleValidated,
        ran: ran(test),
      }));
      const strip = ({ ran: _ran, ...test }: (typeof tests)[number]) => test;
      return {
        file: report.file,
        tests: tests.filter((test) => test.ran).map(strip),
        skipped: tests.filter((test) => !test.ran).map(strip),
      };
    });
    const manifest: RunManifest = {
      schemaVersion: 1,
      project: project.name,
      vitestVersion: this.#vitestVersion,
      files,
    };
    writeRunManifest(this.#options.runDir, manifest);
    this.#manifest = manifest;

    const mutantCoverage: MutantCoverage = { static: {}, perTest: {} };
    for (const report of reports) {
      if (report.meta?.coverage) {
        mergeCoverage(mutantCoverage, rekeyCoverage(report.meta.coverage, idByTaskId));
      }
    }
    const testById = new Map(
      reports.flatMap((report) =>
        [...report.module.children.allTests()].map((test) => [test.id, { test, report }] as const),
      ),
    );
    const tests: TestResult[] = [...identified.values()].flat().map((identity) => {
      const entry = testById.get(identity.taskId);
      const result = entry?.test.result();
      const base = {
        id: identity.id,
        name: identity.fullName,
        timeSpentMs: Math.round(entry?.test.diagnostic()?.duration ?? 0),
        fileName: entry?.report.module.moduleId,
      };
      if (result?.state === 'passed') return { ...base, status: TestStatus.Success };
      if (result?.state === 'failed') {
        return {
          ...base,
          status: TestStatus.Failed,
          failureMessage: result.errors[0]?.message ?? 'failed without an error',
        };
      }
      return { ...base, status: TestStatus.Skipped };
    });
    return { status: DryRunStatus.Complete, tests, mutantCoverage };
  }

  async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
    const { vitest, project } = this.#ready();
    const manifest = (this.#manifest ??= readRunManifest(this.#options.runDir));
    if (manifest.project !== project.name) {
      throw new Error(
        `${PLUGIN_NAME} runner: the run manifest is for project ${manifest.project}, this ` +
          `runner runs ${project.name}`,
      );
    }
    if (options.mutantActivation === 'static' && options.testFilter !== undefined) {
      throw new Error(
        `${PLUGIN_NAME} runner: static mutant ${options.activeMutant.id} came with a test ` +
          'filter; static mutants run the manifest full test set (KTD4)',
      );
    }
    const selection = selectTests(manifest, options.testFilter);
    const requested: RequestedTest[] = selection.files.flatMap((file) =>
      file.tests.map((test) => ({
        id: test.id,
        taskId: test.taskId,
        fullName: test.fullName,
        file: file.file,
      })),
    );
    this.#provide(project, {
      mode: 'mutant',
      activeMutant: options.activeMutant.id,
      mutantActivation: options.mutantActivation,
      hitLimit: options.hitLimit ?? null,
    });
    const specs: TestSpecification[] = selection.files.map((file) =>
      project.createSpecification(path.resolve(this.#root, file.file), {
        testIds: file.tests.map((test) => test.taskId),
      }),
    );
    const result = await this.#run(vitest, specs, false);
    const classification = classifyRun({
      requested,
      modules: result.modules.map((module) => reportModule(this.#root, module).observed),
      unhandledErrors: result.unhandledErrors.map(toObservedError),
      hitLimit: options.hitLimit,
    });
    this.#writeSidecar({
      kind: 'mutant',
      mutantId: options.activeMutant.id,
      mutantActivation: options.mutantActivation,
      hitLimit: options.hitLimit ?? null,
      requestedTestIds: requested.map((test) => test.id),
      hookAttributedTests: null,
      result: classification,
    });
    return toMutantRunResult(classification);
  }

  #writeSidecar(draft: Omit<SidecarDraft, 'worker'>): void {
    writeSidecar(this.#options.sidecarDir, { ...draft, worker: this.#worker });
  }

  async dispose(): Promise<void> {
    await this.#vitest?.close();
    this.#vitest = undefined;
    this.#project = undefined;
  }
}

export const strykerPlugins = [
  declareClassPlugin(PluginKind.TestRunner, PLUGIN_NAME, Vitest5TestRunner),
];
