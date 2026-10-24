/**
 * Contract between the vitest5 runner (main process, plugin.ts) and its worker setup file
 * (setup.ts): the value the runner provides before each run and the metadata the setup file
 * writes on the file task when the file's run ends. Both sides import this module, so it holds
 * types and constants only.
 */
import type { MutantCoverage } from '@stryker-mutator/api/core';
import type { MutantActivation } from '@stryker-mutator/api/test-runner';

/** `provide`/`inject` key and task-meta key. */
export const PROTOCOL_KEY = 'gitnexusStrykerVitest5'; // gitleaks:allow -- a provide/inject key, not a credential

export type WorkerMode = 'dry-run' | 'mutant';

export interface WorkerContext {
  mode: WorkerMode;
  /** Stryker instrumenter namespace (`__stryker__`). */
  namespace: string;
  /** Environment variable the instrumenter reads as a fallback (`__STRYKER_ACTIVE_MUTANT__`). */
  activeMutantEnv: string;
  activeMutant: string | null;
  mutantActivation: MutantActivation | null;
  hitLimit: number | null;
}

export type HookName = 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach';

export const HOOK_NAMES: readonly HookName[] = ['beforeAll', 'afterAll', 'beforeEach', 'afterEach'];

/** Written on the file task by the setup file after the file's run, hooks included. */
export interface FileMeta {
  /** Summed instrumenter hit count of the active mutant in this file; null in the dry run. */
  hitCount: number | null;
  /** Dry run only: coverage keyed by Vitest task id, hook hits already attributed. */
  coverage: MutantCoverage | null;
  /** Task id to the hooks that started for that test or suite and did not finish. */
  failedHooks: Record<string, HookName[]>;
}

declare module 'vitest' {
  interface ProvidedContext {
    gitnexusStrykerVitest5: WorkerContext;
  }
  interface TaskMeta {
    gitnexusStrykerVitest5?: FileMeta;
  }
}
