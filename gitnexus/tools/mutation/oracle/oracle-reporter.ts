/**
 * The oracle's Vitest reporter (U13, KTD15): records what one Vitest run observed, through the
 * public reporter API only, as an {@link OracleObservedRun} for oracle-classify.ts.
 *
 * Vitest's JSON reporter keeps no error names (only stack text), no hook failures and no
 * unhandled errors, so this reporter adds them:
 * - every error keeps its name (oracle-classify.ts `toOracleError`);
 * - a hook failed when Vitest reported its start without an end: Vitest marks a hook's end only
 *   after every hook of that kind at that level passed, so `onHookStart` without `onHookEnd`
 *   leaves the hook open on its test, suite or module;
 * - unhandled errors and the run's end reason come from `onTestRunEnd`;
 * - each test keeps its configured `retry` and the retries Vitest made.
 *
 * The reporter runs in the wrapper's process (command-wrapper.ts passes an instance), never in a
 * Vitest worker, and imports no runner code.
 */
import path from 'node:path';
import type {
  Reporter,
  ReportedHookContext,
  TestCase,
  TestModule,
  TestRunEndReason,
} from 'vitest/node';
import {
  toOracleError,
  type OracleError,
  type OracleModuleRecord,
  type OracleObservedRun,
  type OracleTestRecord,
  type SuiteHookName,
  type TestHookName,
} from './oracle-classify.js';

type HookName = ReportedHookContext['name'];

const retryCount = (retry: TestCase['options']['retry']): number => {
  if (retry === undefined) return 0;
  return typeof retry === 'number' ? retry : (retry.count ?? 0);
};

const errorsOf = (errors: readonly object[] | undefined): OracleError[] =>
  (errors ?? []).map((error) => toOracleError(error));

export class OracleReporter implements Reporter {
  readonly #root: string;
  /** Hooks started without an end, per reported entity id. */
  readonly #openHooks = new Map<string, Set<HookName>>();
  #run: OracleObservedRun | null = null;

  /** @param root the Vitest root; module paths are recorded relative to it. */
  constructor(root: string) {
    this.#root = root;
  }

  /** The observed run, or null until Vitest reports the end of a run. */
  get run(): OracleObservedRun | null {
    return this.#run;
  }

  onHookStart(hook: ReportedHookContext): void {
    const open = this.#openHooks.get(hook.entity.id) ?? new Set<HookName>();
    open.add(hook.name);
    this.#openHooks.set(hook.entity.id, open);
  }

  onHookEnd(hook: ReportedHookContext): void {
    this.#openHooks.get(hook.entity.id)?.delete(hook.name);
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<object>,
    reason: TestRunEndReason,
  ): void {
    this.#run = {
      reason,
      unhandledErrors: errorsOf(unhandledErrors),
      modules: testModules.map((testModule) => this.#module(testModule)),
    };
  }

  #failed<T extends HookName>(id: string, names: readonly T[]): T[] {
    const open = this.#openHooks.get(id);
    return names.filter((name) => open?.has(name) === true);
  }

  #module(testModule: TestModule): OracleModuleRecord {
    const cases = [...testModule.children.allTests()];
    const indexOf = new Map(cases.map((testCase, index) => [testCase.id, index]));
    const suiteHooks: readonly SuiteHookName[] = ['beforeAll', 'afterAll'];
    return {
      file: path.relative(this.#root, testModule.moduleId).split(path.sep).join('/'),
      state: testModule.state(),
      errors: errorsOf(testModule.errors()),
      failedHooks: this.#failed(testModule.id, suiteHooks),
      suites: [...testModule.children.allSuites()].map((suite) => ({
        fullName: suite.fullName,
        errors: errorsOf(suite.errors()),
        failedHooks: this.#failed(suite.id, suiteHooks),
        tests: [...suite.children.allTests()].flatMap((testCase) => indexOf.get(testCase.id) ?? []),
      })),
      tests: cases.map((testCase) => this.#test(testCase)),
    };
  }

  #test(testCase: TestCase): OracleTestRecord {
    const result = testCase.result();
    const testHooks: readonly TestHookName[] = ['beforeEach', 'afterEach'];
    return {
      fullName: testCase.fullName,
      location:
        testCase.location === undefined
          ? null
          : { line: testCase.location.line, column: testCase.location.column },
      state: result.state,
      errors: errorsOf(result.errors),
      failedHooks: this.#failed(testCase.id, testHooks),
      retry: retryCount(testCase.options.retry),
      retryCount: testCase.diagnostic()?.retryCount ?? 0,
    };
  }
}
