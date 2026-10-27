/**
 * Plain Vitest 5 runs of selected tests in a prepared tree (U7, KTD2, KTD8): Layer 3's baselines,
 * and later row deletion (U9) and the trace run (U11), share it.
 *
 * Each call creates a fresh Vitest instance (`createVitest`) and closes it, with the environment
 * `vitest run` sets (as tools/mutation/fidelity/fidelity.ts and the vitest5 runner do: `TEST`,
 * `VITEST`, `NODE_ENV`) plus `GITNEXUS_MUTATION_SCOPE` naming a scope file of the selected tests'
 * files, the working directory in the prepared package, and Vite's cache in the call's work dir.
 * The process environment and working directory are restored afterwards. The config is
 * tools/mutation/vitest.mutation.config.ts (project `mutation`) or, in controls mode, the fixture
 * project's own config ({@link vitestSelectionOf}), the configs the Stryker run uses.
 *
 * Selection is the vitest5 runner's (tools/mutation/runner/plugin.ts, Phase 1 KTD2): every file
 * of the selection is collected, its tests get their Phase 0 ids (runner/test-ids.ts
 * `assignTestIds`), the requested ids map to Vitest task ids, and one task-id specification per
 * file runs. An id that was not collected, or a file that failed to collect, is a problem and
 * nothing runs. The runner's own setup file (runner/setup.ts, in dry-run mode, so it never
 * activates a mutant) records failed hooks on each file task, so the run is classified by
 * runner/classify-outcome.ts exactly as a Stryker run's tests are: every requested test gets its
 * outcome class (`survived` for a pass), plus the run's status and outside-test rows.
 *
 * Extra setup files (U11): `setupFiles` go after the runner's setup file, in list order, and
 * `provide` gives them their context (the value-flow trace hook).
 *
 * Workers: `maxWorkers` caps the instance's worker processes (Vitest's own default is a share of
 * the host's cores); the scenario-map CLI passes its `--concurrency`, the bound it gives Stryker,
 * so a local run never fans out over every core ({@link inProcessVitestOptions}, which
 * path-coverage/run-coverage.ts shares).
 *
 * Load probe (U9): with `probeFiles`, the result's `loadedFiles` lists those the project's Vite
 * module graph transformed before the instance closed. Workers fetch every inlined module through
 * that graph, and a fresh instance with `cache: false` holds nothing else, so row deletion proves
 * with it that its run evaluated the edited file (KTD10), without a V8 hook.
 *
 * Library only: run-group.ts, row-deletion.ts and value-flow/trace.ts call {@link runVitest}.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { INSTRUMENTER_CONSTANTS } from '@stryker-mutator/api/core';
import type { CliOptions, TestModule, TestProject, Vitest } from 'vitest/node';
import type { VitestSelection } from '../../mutation/driver/stryker-config.js';
import {
  classifyRun,
  type ObservedError,
  type ObservedModule,
  type OutcomeClass,
  type OutsideTestOutcome,
  type RequestedTest,
  type RunnerStatus,
  type SuiteHook,
  type TestHook,
} from '../../mutation/runner/classify-outcome.js';
import { PROTOCOL_KEY, type WorkerContext } from '../../mutation/runner/protocol.js';
import {
  assignPortableTestIds,
  parseTestId,
  selectRequestedTests,
  type CollectedTest,
  type IdentifiedTest,
  type TestLocation,
} from '../../mutation/runner/test-ids.js';
import { MUTATION_SCOPE_ENV, parseMutationScope } from '../../mutation/scope-file.js';
import { toPackagePath, type RunMode } from '../types.js';
import { byText, isRecord, sortedUnique, toPosixRelative } from '../util.js';

/** The mutation config and project (the vitest5 runner's defaults). */
export const MUTATION_CONFIG = 'tools/mutation/vitest.mutation.config.ts';
export const MUTATION_PROJECT = 'mutation';
/** The project the scenario-map controls fixture's vitest.config.ts declares. */
export const CONTROLS_PROJECT = 'scenario-map-controls';
/** The vitest5 runner's worker setup file, relative to the (prepared) package. */
export const RUNNER_SETUP_FILE = 'tools/mutation/runner/setup.ts';

/** The Vitest config and project of a run mode. */
export function vitestSelectionOf(mode: RunMode): VitestSelection {
  return mode.kind === 'controls'
    ? {
        configFile: `${toPackagePath(mode.fixtureRoot)}/vitest.config.ts`,
        project: CONTROLS_PROJECT,
      }
    : { configFile: MUTATION_CONFIG, project: MUTATION_PROJECT };
}

export interface VitestRunOptions {
  /** Absolute prepared `gitnexus/` package directory. */
  packageDir: string;
  /** Phase 0 ids of the tests to run: non-empty and distinct. */
  testIds: readonly string[];
  vitest: VitestSelection;
  /** Absolute scratch directory of this call (scope file, Vite cache); created. */
  workDir: string;
  /**
   * Package paths of files whose loading the caller must prove (row deletion's edited file, U9):
   * the result's `loadedFiles` lists those this run transformed.
   */
  probeFiles?: readonly string[];
  /**
   * Extra worker setup files (package paths) run after the runner's own and before the project's
   * (the value-flow trace hook, U11); with any, setup files run in list order.
   */
  setupFiles?: readonly string[];
  /** Called with the project before the run: provides the extra setup files' context. */
  provide?: (project: Pick<TestProject, 'provide'>) => void;
  /** Upper bound of the instance's worker processes (the CLI's `--concurrency`). */
  maxWorkers?: number;
}

export interface InProcessVitestInput {
  /** Absolute POSIX package root. */
  root: string;
  /** Config file, relative to the root. */
  configFile: string;
  /** The projects to keep; undefined keeps every project of the config. */
  projects?: readonly string[];
  /** Upper bound of the worker processes; undefined leaves Vitest's default. */
  maxWorkers?: number;
  /** Runs of each test (`repeats`); undefined runs each once. */
  repeats?: number;
}

/**
 * The `createVitest` options of an in-process run: no watch, no cache, no reporter, and at most
 * `maxWorkers` worker processes when given (module header).
 */
export function inProcessVitestOptions(input: InProcessVitestInput): CliOptions {
  return {
    root: input.root,
    config: path.join(input.root, input.configFile),
    project: input.projects === undefined ? undefined : [...input.projects],
    watch: false,
    cache: false,
    fsModuleCache: false,
    ...(input.repeats === undefined ? {} : { repeats: input.repeats }),
    ...(input.maxWorkers === undefined ? {} : { maxWorkers: input.maxWorkers }),
    reporters: [],
  };
}

/** What {@link runVitest} uses of a Vitest instance. */
export type VitestSession = Pick<
  Vitest,
  'projects' | 'close' | 'collectTests' | 'runTestSpecifications'
>;
/** `vitest/node`'s `createVitest`, narrowed to {@link VitestSession}; unit tests inject a fake. */
export type CreateVitest = (
  options: CliOptions,
  viteOverrides: { cacheDir: string },
) => Promise<VitestSession>;

const loadCreateVitest = async (): Promise<CreateVitest> =>
  (await import('vitest/node')).createVitest;

export interface VitestTestResult {
  id: string;
  taskId: string | null;
  fullName: string | null;
  location: TestLocation | null;
  /** Vitest's state; `missing` when the test was not collected or not reported. */
  state: 'passed' | 'failed' | 'skipped' | 'pending' | 'missing';
  /** Its outcome class; null when it has no row (it did not run). */
  outcome: OutcomeClass | null;
  message: string | null;
}

export interface VitestRunResult {
  /** The requested tests, in request order. */
  tests: VitestTestResult[];
  status: RunnerStatus;
  outcome: OutcomeClass;
  reason: string | null;
  outsideTest: OutsideTestOutcome[];
  /** Why nothing ran: ids that were not collected, files that failed to collect. */
  problems: string[];
  unhandledErrors: string[];
  wallClockMs: number;
  /**
   * With `probeFiles`: those of them that a Vite environment of the project transformed during
   * this call (a module of the file holds a transform result), in probe order. The instance is
   * fresh and Vite pre-transforms nothing for Node tests, so a transform means a worker fetched
   * the file's current text to evaluate it.
   */
  loadedFiles?: string[];
}

const toObservedError = (error: unknown): ObservedError =>
  isRecord(error)
    ? {
        name: typeof error.name === 'string' ? error.name : 'Error',
        message: typeof error.message === 'string' ? error.message : String(error),
      }
    : { name: 'Error', message: String(error) };

const describeErrors = (errors: readonly unknown[]): string =>
  errors
    .map(toObservedError)
    .map((error) => `${error.name}: ${error.message}`)
    .join('; ');

const retryCount = (retry: number | { count?: number } | undefined): number =>
  typeof retry === 'number' ? retry : (retry?.count ?? 0);

const pick = <T extends string>(hooks: readonly string[] | undefined, names: readonly T[]): T[] =>
  names.filter((name) => hooks?.includes(name) ?? false);

const TEST_HOOKS: readonly TestHook[] = ['beforeEach', 'afterEach'];
const SUITE_HOOKS: readonly SuiteHook[] = ['beforeAll', 'afterAll'];

const collectedTests = (module: TestModule): CollectedTest[] =>
  [...module.children.allTests()].map((test) => ({
    taskId: test.id,
    fullName: test.fullName,
    location: test.location,
  }));

/** One module as classify-outcome.ts reads it; mirrors the vitest5 runner's `reportModule`. */
function observeModule(file: string, module: TestModule): ObservedModule {
  const meta = module.meta()[PROTOCOL_KEY];
  const failed = meta?.failedHooks ?? {};
  return {
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
    hitCount: undefined,
  };
}

/** True when a Vite environment of the project holds a transformed module of `file` (absolute). */
function wasTransformed(project: TestProject, file: string): boolean {
  return Object.values(project.vite.environments).some((environment) =>
    [...(environment.moduleGraph.getModulesByFile(file) ?? [])].some(
      (module) => module.transformResult !== null,
    ),
  );
}

/** The checks the vitest5 runner makes before it adds its setup file; throws on a problem. */
function checkProject(project: TestProject, configFile: string): void {
  const { config } = project;
  const problems = [
    config.pool === 'forks' ? '' : `pool is ${String(config.pool)}, not forks`,
    config.isolate === false ? 'isolate is off' : '',
    config.includeTaskLocation ? '' : 'includeTaskLocation is off; test ids need locations',
    config.setupFiles.length > 0 && config.sequence.setupFiles !== 'list'
      ? 'setup files run in parallel; set sequence.setupFiles: list'
      : '',
  ].filter((problem) => problem !== '');
  if (problems.length > 0) {
    throw new Error(`vitest run: unsupported Vitest config ${configFile}: ${problems.join('; ')}`);
  }
}

const ENV_NAMES = [
  'TEST',
  'VITEST',
  'NODE_ENV',
  MUTATION_SCOPE_ENV,
  INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE,
] as const;

interface Session {
  vitest: VitestSession;
  project: TestProject;
  root: string;
}

/** Collects, selects and runs the requested tests in an open Vitest instance. */
async function runSelected(
  session: Session,
  files: readonly string[],
  testIds: readonly string[],
): Promise<Omit<VitestRunResult, 'wallClockMs'>> {
  const { vitest, project, root } = session;
  const relative = (moduleId: string): string =>
    path.posix.relative(root, toPosixRelative(moduleId));
  const specs = files.map((file) => project.createSpecification(path.join(root, file)));
  const collected = await vitest.collectTests(specs);
  const earlier = new Set<TestModule>(collected.testModules);
  const identified = new Map<string, IdentifiedTest[]>(
    collected.testModules
      .map((module) => ({ module, file: relative(module.moduleId) }))
      .filter(({ file }) => files.includes(file))
      .sort((a, b) => byText(a.file, b.file))
      .map(({ module, file }) => [file, assignPortableTestIds(file, collectedTests(module), root)]),
  );
  const selection = selectRequestedTests(identified, testIds);
  const problems = [
    ...collected.testModules
      .filter((module) => module.errors().length > 0)
      .map(
        (module) =>
          `${relative(module.moduleId)}: collection failed: ${describeErrors(module.errors())}`,
      ),
    ...collected.unhandledErrors.map(
      (error) => `unhandled error while collecting: ${describeErrors([error])}`,
    ),
    ...selection.unknown.map((id) => `requested test ${JSON.stringify(id)} was not collected`),
  ];
  const byId = new Map([...identified.values()].flat().map((test) => [test.id, test]));
  const requested: RequestedTest[] = testIds.flatMap((id) => {
    const test = byId.get(id);
    return test === undefined
      ? []
      : [{ id, taskId: test.taskId, fullName: test.fullName, file: parseTestId(id).file }];
  });
  const missing = (id: string): VitestTestResult => {
    const test = byId.get(id);
    return {
      id,
      taskId: test?.taskId ?? null,
      fullName: test?.fullName ?? null,
      location: test?.location ?? null,
      state: 'missing',
      outcome: null,
      message: null,
    };
  };
  if (problems.length > 0) {
    return {
      tests: testIds.map(missing),
      status: 'error',
      outcome: 'invalid',
      reason: problems.join('; '),
      outsideTest: [],
      problems,
      unhandledErrors: [],
    };
  }

  const runSpecs = selection.files.map((file) =>
    project.createSpecification(path.join(root, file.file), { testIds: file.taskIds }),
  );
  const result = await vitest.runTestSpecifications(runSpecs, false);
  const wanted = new Set(runSpecs.map((spec) => spec.moduleId));
  const modules = result.testModules
    .filter((module) => wanted.has(module.moduleId) && !earlier.has(module))
    .map((module) => ({ module, file: relative(module.moduleId) }))
    .sort((a, b) => byText(a.file, b.file));
  const classification = classifyRun({
    requested,
    modules: modules.map(({ module, file }) => observeModule(file, module)),
    unhandledErrors: result.unhandledErrors.map(toObservedError),
    hitLimit: undefined,
  });
  const rowOf = new Map(classification.tests.map((row) => [row.id, row]));
  const stateOf = new Map(
    modules.flatMap(({ module }) =>
      [...module.children.allTests()].map((test) => [test.id, test.result().state] as const),
    ),
  );
  return {
    tests: testIds.map((id): VitestTestResult => {
      const base = missing(id);
      const row = rowOf.get(id);
      const state = base.taskId === null ? undefined : stateOf.get(base.taskId);
      return {
        ...base,
        state: state ?? 'missing',
        outcome: row?.outcome ?? null,
        message: row?.message ?? null,
      };
    }),
    status: classification.status,
    outcome: classification.outcome,
    reason: classification.reason ?? null,
    outsideTest: classification.outsideTest,
    problems: [],
    unhandledErrors: result.unhandledErrors.map((error) => describeErrors([error])),
  };
}

/**
 * Runs the requested tests with a fresh Vitest instance; see the module comment. `createVitest`
 * defaults to `vitest/node`'s.
 */
export async function runVitest(
  options: VitestRunOptions,
  createVitest?: CreateVitest,
): Promise<VitestRunResult> {
  const started = performance.now();
  const testIds = [...options.testIds];
  if (testIds.length === 0 || new Set(testIds).size !== testIds.length) {
    throw new Error('vitest run: the test ids must be non-empty and distinct');
  }
  const files = sortedUnique(testIds.map((id) => parseTestId(id).file));
  mkdirSync(options.workDir, { recursive: true });
  const scopeFile = path.join(options.workDir, 'scope.json');
  const scopeText = `${JSON.stringify({ testFiles: files }, null, 2)}\n`;
  parseMutationScope(scopeText);
  writeFileSync(scopeFile, scopeText);
  const root = toPosixRelative(realpathSync(options.packageDir));
  const { configFile, project: projectName } = options.vitest;

  const savedEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  const savedCwd = process.cwd();
  // The environment startVitest/prepareVitest sets before creating Vitest, plus the scope file.
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
  process.env[MUTATION_SCOPE_ENV] = scopeFile;
  delete process.env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE];
  process.chdir(root);
  try {
    const create = createVitest ?? (await loadCreateVitest());
    const vitest = await create(
      inProcessVitestOptions({
        root,
        configFile,
        projects: [projectName],
        maxWorkers: options.maxWorkers,
      }),
      { cacheDir: path.join(options.workDir, 'vite-cache') },
    );
    try {
      const projects = vitest.projects.filter((candidate) => candidate.name === projectName);
      if (projects.length !== 1) {
        throw new Error(
          `vitest run: expected one Vitest project named ${projectName} in ${configFile}, found ` +
            JSON.stringify(vitest.projects.map((candidate) => candidate.name)),
        );
      }
      const [project] = projects;
      checkProject(project, configFile);
      const extraSetupFiles = (options.setupFiles ?? []).map((file) => path.join(root, file));
      project.config.setupFiles = [
        path.join(root, RUNNER_SETUP_FILE),
        ...extraSetupFiles,
        ...project.config.setupFiles,
      ];
      if (extraSetupFiles.length > 0) project.config.sequence.setupFiles = 'list';
      const context: WorkerContext = {
        mode: 'dry-run',
        namespace: INSTRUMENTER_CONSTANTS.NAMESPACE,
        activeMutantEnv: INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE,
        activeMutant: null,
        mutantActivation: null,
        hitLimit: null,
      };
      project.provide(PROTOCOL_KEY, context);
      options.provide?.(project);
      const run = await runSelected({ vitest, project, root }, files, testIds);
      const probed =
        options.probeFiles === undefined
          ? {}
          : {
              loadedFiles: options.probeFiles.filter((file) =>
                wasTransformed(project, path.posix.join(root, file)),
              ),
            };
      return { ...run, wallClockMs: Math.round(performance.now() - started), ...probed };
    } finally {
      await vitest.close();
    }
  } finally {
    process.chdir(savedCwd);
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
