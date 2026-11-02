/**
 * Records shared by the gate 1 recorder (recorder.setup.ts, in Vitest workers), the Stryker-run
 * config (vitest.fidelity.config.ts, in the runner's Vitest process) and the gate itself
 * (fidelity.ts). Types, constants and pure helpers only: the setup file and the config import it,
 * so it must stay free of side effects and heavy dependencies.
 */
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject, Vitest } from 'vitest/node';

/** Absolute directory both gate 1 runs write their records to; inherited by every process. */
export const FIDELITY_DIR_ENV = 'GITNEXUS_MUTATION_FIDELITY_DIR';
export const RECORD_SCHEMA_VERSION = 1;
export const WORKER_RECORD_PREFIX = 'worker-';
export const CONFIG_RECORD_PREFIX = 'config-';
/** The recorder setup file, next to this module (in the checkout, or in the Stryker sandbox). */
export const RECORDER_SETUP_FILE = fileURLToPath(new URL('./recorder.setup.ts', import.meta.url));
/** Name of the Stryker-run plugin (vitest.fidelity.config.ts); config snapshots leave it out. */
export const FIDELITY_PLUGIN_NAME = 'gitnexus-mutation-fidelity';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** `load`: while the test file is imported and collected; `run`: once its file-level hooks start. */
export type Phase = 'load' | 'run';

/**
 * How a runtime load was seen:
 * - `module-runner`: evaluated by Vitest's module runner (inlined modules and the externals they
 *   import directly), listed when the file ends;
 * - `node-resolve`: resolved by Node after the recorder started (externalized packages and what
 *   their own code imports, builtins);
 * - `dlopen`: a native addon loaded through `process.dlopen`;
 * - `worker`: a `worker_threads` Worker was constructed;
 * - `builtin-getter`: a `process.getBuiltinModule` lookup.
 */
export type LoadSource = 'module-runner' | 'node-resolve' | 'dlopen' | 'worker' | 'builtin-getter';

export interface LoadEvent {
  source: LoadSource;
  /** Absolute path, `file:` URL, `node:` builtin or other module id, as the source reports it. */
  module: string;
  /** The importing module (absolute path or URL), when known. */
  parent: string | null;
  phase: Phase;
  /** Full name of the test that was running, or null outside a test. */
  test: string | null;
}

export interface EnvRead {
  name: string;
  /** The value read, kept for `GITNEXUS_*` names only; null when unset or not kept. */
  value: string | null;
  set: boolean;
  /** First non-harness stack frame of the first read (absolute path), when one exists. */
  reader: string | null;
}

/** One test file's record, written by the recorder in the file's fork. */
export interface WorkerRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  pid: number;
  /** The Vitest process that started the fork (the runner process in the Stryker run). */
  ppid: number;
  /** Absolute test file path. */
  file: string;
  /** Vitest root of the run (the Stryker sandbox in the Stryker run). */
  root: string;
  project: string;
  /** First occurrence of each (source, module) pair, in order of observation. */
  loads: LoadEvent[];
  /** Environment variables read by name while the file loaded and collected, sorted by name. */
  envReadsAtLoad: EnvRead[];
  /** The compared environment variables as the worker saw them at load (see COMPARED_ENV). */
  env: Record<string, string | null>;
}

/** The runner process's resolved Vitest config, captured by vitest.fidelity.config.ts. */
export interface ConfigRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  pid: number;
  /** False for the capture taken when the project was created, true for the one at close. */
  final: boolean;
  snapshot: ConfigSnapshot;
}

export interface ConfigSnapshot {
  /** The run project's resolved test config. */
  project: JsonValue;
  /** The root (global) resolved test config. */
  global: JsonValue;
  /** Vite settings of the project that steer module resolution and caching. */
  vite: JsonValue;
}

/** Environment variables whose worker-side values gate 1 compares between the two runs. */
export const COMPARED_ENV_NAMES: readonly string[] = Object.freeze([
  'CI',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'NODE_OPTIONS',
  'TEST',
  'TZ',
  'VITEST',
]);

/** Whether gate 1 compares (and the recorder snapshots) a variable. */
export const isComparedEnv = (name: string): boolean =>
  name.startsWith('GITNEXUS_') || COMPARED_ENV_NAMES.includes(name);

/** Values kept in env-read records: product settings only, never arbitrary machine values. */
export const keepsEnvValue = (name: string): boolean => name.startsWith('GITNEXUS_');

/**
 * Test-harness code wherever it is loaded from: Vitest and the packages of its runtime, Stryker,
 * the TypeScript loader, Node internals, and this recorder (recorder.setup.ts and this module).
 * The runner's own setup file is harness only where the plugin loads it, the prepared copy
 * outside the sandbox; fidelity.ts `locateModule` adds that rule, because accepted tests import
 * runner modules too. A load whose importer is harness code is attributed to the harness.
 */
const HARNESS =
  /(?:^node:internal|\/node_modules\/(?:vitest|@vitest\/[^/]+|vite|tinypool|tinyspy|tinyrainbow|tinybench|chai|pathe|magic-string|es-module-lexer|@stryker-mutator\/[^/]+|tsx|esbuild|get-tsconfig)\/|\/tools\/mutation\/fidelity\/(?:recorder\.setup|record)\.ts$)/;

/** Whether a module path or URL belongs to the test harness (see {@link HARNESS}). */
export const isHarnessModule = (pathOrUrl: string): boolean =>
  HARNESS.test(pathOrUrl.replace(/\\/g, '/'));

const FRAME_LOCATION = /\(?((?:file:\/\/|node:|\/|[A-Za-z]:[\\/])[^()]*?):\d+:\d+\)?$/;

/** The location (path or URL, without line and column) of the first non-harness stack frame. */
export function firstForeignFrame(stack: string | undefined): string | null {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const match = FRAME_LOCATION.exec(line.trim());
    if (match !== null && !isHarnessModule(match[1])) return match[1];
  }
  return null;
}

const MAX_DEPTH = 12;

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * A JSON form of a resolved config value: functions become `[function <name>]`, regular
 * expressions `/<source>/<flags>`, maps and sets plain objects and arrays, other class instances
 * `[<Class>]` with their own enumerable data, `undefined` entries are dropped, and cycles become
 * `[circular]`. Object keys are sorted, so equal configs give equal text.
 */
export function toJsonValue(value: unknown, seen: Set<object> = new Set(), depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[too deep]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, seen, depth + 1));
    if (value instanceof Set) {
      return [...value].map((entry) => toJsonValue(entry, seen, depth + 1));
    }
    const entries: [string, unknown][] =
      value instanceof Map
        ? [...value.entries()].map(([key, entry]): [string, unknown] => [String(key), entry])
        : Object.entries(value);
    const out: { [key: string]: JsonValue } = {};
    if (!(value instanceof Map) && !isPlainObject(value)) {
      out['[class]'] = value.constructor?.name ?? 'anonymous';
    }
    for (const [key, entry] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (entry !== undefined) out[key] = toJsonValue(entry, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Writes JSON atomically (temporary dot-file, then rename) into a directory. */
export function writeRecordFile(dir: string, name: string, value: unknown): void {
  const target = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, target);
}

/**
 * Puts the recorder first among a project's setup files, after the config is resolved. Both runs
 * do it the same way (the base run after `createVitest`, the Stryker run from its config plugin),
 * so it adds no config difference beyond `setupFiles` itself. `sequence.setupFiles: 'list'` makes
 * the setup files run one after another, which the runner requires once a project has any.
 */
export function installRecorder(project: TestProject): void {
  const { config } = project;
  if (!config.setupFiles.includes(RECORDER_SETUP_FILE)) {
    config.setupFiles = [RECORDER_SETUP_FILE, ...config.setupFiles];
  }
  config.sequence.setupFiles = 'list';
}

/**
 * The effective config of a project as JSON (see {@link toJsonValue}): the project's and the root
 * resolved test config, and the Vite settings that steer module resolution, transforms and
 * caching. The gate 1 plugin is left out of the plugin list.
 */
export function snapshotConfig(project: TestProject, vitest: Vitest): ConfigSnapshot {
  const vite = project.vite.config;
  return {
    project: toJsonValue(project.config),
    global: toJsonValue(vitest.config),
    vite: toJsonValue({
      root: vite.root,
      mode: vite.mode,
      cacheDir: vite.cacheDir,
      define: vite.define,
      resolve: vite.resolve,
      ssr: vite.ssr,
      plugins: vite.plugins
        .map((plugin) => plugin.name)
        .filter((name) => name !== FIDELITY_PLUGIN_NAME),
    }),
  };
}
