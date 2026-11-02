/**
 * Gate 1 config comparison (U6, KTD9): the effective config of the runner's unmutated run against
 * a normal Vitest 5 run of `gitnexus/vitest.config.ts`, project `default`.
 *
 * Both sides are {@link ConfigView}s: the record.ts `ConfigSnapshot` sections (`project`: the run
 * project's resolved test config, `global`: the root resolved config, `vite`: resolution,
 * transform and cache settings) plus `env`, the compared environment variables as the test
 * workers saw them. Absolute paths are normalised first ({@link normalisePaths}): the Stryker
 * sandbox and the checkout's `gitnexus/` both become `<package>`, the sandbox's relocated
 * `gitnexus-shared` and the checkout's `gitnexus-shared` become `<shared>`, and the shared
 * `node_modules` (a symlink in the prepared copy) becomes `<package>/node_modules`. Any other
 * prepared-copy or checkout path in the run keeps a distinct marker, so `root` and every other
 * path value is compared after mapping sandbox paths to checkout paths and a run that points
 * outside its sandbox still differs.
 *
 * Every leaf that differs must match an entry of {@link ALLOWED_CONFIG_DIFFS} (a dotted path
 * pattern matches that path and everything below it) or a {@link VOLATILE_CONFIG_VALUES} entry
 * whose condition holds. Anything else fails gate 1.
 */
import type { JsonValue } from './record.js';

export interface AllowedConfigDiff {
  /** Name used in reports and in the envelope record. */
  name: string;
  /** Dotted snapshot paths (`project.`, `global.`, `vite.`, `env.`); empty: no config key. */
  paths: readonly string[];
  /** Why the runner's run may differ here without changing what the tests execute. */
  reason: string;
}

/**
 * The plan's list (U6 step 4), one entry per item, then the additions this implementation found
 * necessary, each marked as such in its reason.
 */
export const ALLOWED_CONFIG_DIFFS: readonly AllowedConfigDiff[] = Object.freeze([
  {
    name: 'setupFiles',
    paths: ['project.setupFiles', 'global.setupFiles'],
    reason:
      'The runner prepends its own setup file (tools/mutation/runner/setup.ts, loaded from the ' +
      'prepared copy next to the plugin) for coverage and mutant activation (KTD4). The gate 1 ' +
      'recorder is installed in both runs the same way.',
  },
  {
    name: 'maxWorkers',
    paths: ['project.maxWorkers', 'global.maxWorkers', 'global.cliOptions.maxWorkers'],
    reason:
      'Worker count changes scheduling only: with forks and default isolation every test file ' +
      'runs in a fresh process whatever the pool size.',
  },
  {
    name: 'maxConcurrency',
    paths: ['project.maxConcurrency', 'global.maxConcurrency', 'global.cliOptions.maxConcurrency'],
    reason: 'Only `.concurrent` tests are affected; it limits how many run at once, not what runs.',
  },
  {
    name: 'bail',
    paths: ['project.bail', 'global.bail', 'global.cliOptions.bail'],
    reason:
      'Stops a failing run early; gate 1 compares passing runs, and Stryker sets its own bail ' +
      'policy (`disableBail`).',
  },
  {
    name: 'coverage',
    paths: ['project.coverage', 'global.coverage', 'global.cliOptions.coverage'],
    reason:
      'Vitest coverage is off in both runs; its resolved exclude list names the config file. ' +
      'Stryker records its own per-test coverage through the runner setup file.',
  },
  {
    name: 'KTD8 aliases',
    paths: ['vite.resolve.alias', 'project.alias', 'global.alias'],
    reason:
      'The mutation config resolves `gitnexus-shared` imports to the relocated sources inside ' +
      'the sandbox (KTD8); the base run resolves the package to its built `dist`. The module ' +
      'comparison checks both resolve to the same modules.',
  },
  {
    name: 'dangerouslyIgnoreUnhandledErrors',
    paths: [
      'project.dangerouslyIgnoreUnhandledErrors',
      'global.dangerouslyIgnoreUnhandledErrors',
      'global._rawTestConfig.dangerouslyIgnoreUnhandledErrors',
    ],
    reason:
      'Off in the mutation config so an unhandled error fails the run (KTD9); gate 1 reports ' +
      'any unhandled error of the base run separately.',
  },
  {
    name: 'cacheDir',
    paths: [
      'vite.cacheDir',
      'project.cache',
      'global.cache',
      'global.cliOptions.cache',
      'project.fsModuleCache',
      'global.fsModuleCache',
      'global.cliOptions.fsModuleCache',
      'global.providedOptions.fsModuleCache',
      'project.fsModuleCachePath',
      'global.fsModuleCachePath',
      'global.viteOverrides.cacheDir',
    ],
    reason:
      'The runner uses a per-process Vite cache directory inside the sandbox and turns the ' +
      'results and fs module caches off (KTD5), so no run reuses another run’s transforms.',
  },
  {
    name: 'NODE_ENV/VITEST',
    paths: ['env.NODE_ENV', 'env.VITEST'],
    reason:
      'Both runs set them the way `vitest run` does (`VITEST=true`, `NODE_ENV ??= test`); an ' +
      'inherited NODE_ENV may still differ between the gate process and Stryker’s.',
  },
  {
    name: 'disableTypeChecks',
    paths: [],
    reason:
      'A Stryker option, not a Vitest key. It is false, so Stryker prepends nothing to test ' +
      'files; the identity comparison (lines and columns) confirms it.',
  },
  {
    name: 'project name',
    paths: ['project.name', 'global.project', 'global.cliOptions.project'],
    reason:
      'The runner runs the single `mutation` project; Vitest task ids depend on the name, which ' +
      'is why tests are compared by file, titles and location instead.',
  },
  {
    name: 'include and exclude lists',
    paths: ['project.include', 'project.exclude', 'env.GITNEXUS_MUTATION_SCOPE'],
    reason:
      'The mutation project includes exactly the scope file’s test files (named by ' +
      'GITNEXUS_MUTATION_SCOPE); gate 1 runs the same file list on both sides.',
  },
  {
    name: 'projects array',
    paths: ['global.projects', 'global.resolvedProjects', 'global._rawTestConfig.projects'],
    reason:
      'The mutation config replaces the three repo projects with one (KTD9); the resolved ' +
      'project list follows it. The run project’s own config is compared key by key.',
  },
  {
    name: 'sequence.groupOrder',
    paths: ['project.sequence.groupOrder', 'global.sequence.groupOrder'],
    reason: 'Orders projects against each other; a single-project run has nothing to order.',
  },
  {
    name: 'root (after mapping sandbox paths to checkout paths)',
    paths: [],
    reason:
      'Not a raw difference: every path value, `root` included, is compared after the sandbox ' +
      'is mapped to the checkout, so a root outside the sandbox still fails.',
  },
  {
    name: 'config file (addition)',
    paths: ['global.config', 'global.cliOptions.config'],
    reason:
      'Addition to the plan’s list: the name of the config file. The Stryker run loads ' +
      'tools/mutation/vitest.mutation.config.ts (KTD9) through the gate 1 wrapper ' +
      'tools/mutation/fidelity/vitest.fidelity.config.ts; their settings are compared key by key.',
  },
]);

export interface VolatileConfigValue {
  name: string;
  paths: readonly string[];
  /** The value is ignored only when this holds for both runs. */
  appliesTo: (view: ConfigView) => boolean;
  reason: string;
}

const lookup = (value: JsonValue | undefined, dotted: string): JsonValue | undefined => {
  let current: JsonValue | undefined = value;
  for (const key of dotted.split('.')) {
    current = isJsonObject(current) ? current[key] : undefined;
  }
  return current;
};

/** `sequence.shuffle` is `false`, absent, or `{ files: false, tests: false }`. */
const shuffleOff = (value: JsonValue | undefined): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  (isJsonObject(value) && value.files !== true && value.tests !== true);

/** Values that differ between any two runs of one config, so they are not config differences. */
export const VOLATILE_CONFIG_VALUES: readonly VolatileConfigValue[] = Object.freeze([
  {
    name: 'sequence.seed',
    paths: ['project.sequence.seed', 'global.sequence.seed'],
    appliesTo: (view: ConfigView) =>
      shuffleOff(lookup(view.project, 'sequence.shuffle')) &&
      shuffleOff(lookup(view.global, 'sequence.shuffle')),
    reason:
      'Defaults to the start time when unset and only drives shuffling; ignored only while ' +
      'shuffling is off in both runs.',
  },
]);

export interface ConfigView {
  project: JsonValue;
  global: JsonValue;
  vite: JsonValue;
  env: Record<string, string | null>;
}

export interface ConfigDifference {
  path: string;
  /** Undefined when the key is absent on that side. */
  base: JsonValue | undefined;
  run: JsonValue | undefined;
}

export interface ConfigComparison {
  /** Differences outside the allowed list: each fails gate 1. */
  failures: ConfigDifference[];
  /** Allowed entries that matched at least one difference, with the paths they matched. */
  allowed: { name: string; paths: string[] }[];
  /** Volatile values that differed and were ignored. */
  volatile: { name: string; paths: string[] }[];
}

export function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => jsonEqual(entry, b[index]))
    );
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => jsonEqual(a[key], b[key]));
  }
  return false;
}

/** Leaf differences between two JSON values; arrays are compared as whole values. */
export function diffJson(
  base: JsonValue | undefined,
  run: JsonValue | undefined,
  at: string,
): ConfigDifference[] {
  if (isJsonObject(base) && isJsonObject(run)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(run)])].sort();
    return keys.flatMap((key) => diffJson(base[key], run[key], at === '' ? key : `${at}.${key}`));
  }
  return jsonEqual(base, run) ? [] : [{ path: at, base, run }];
}

/** Whether a dotted pattern covers a path: the path itself or anything below it. */
export const patternCovers = (pattern: string, dotted: string): boolean =>
  dotted === pattern || dotted.startsWith(`${pattern}.`);

/** A path root replacement: `from` (absolute) becomes `to` wherever it starts a path. */
export interface PathRoot {
  from: string;
  to: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces each root (longest first) wherever it appears as a whole path prefix inside a string:
 * followed by `/`, `\`, the end of the string or a character that cannot continue a path segment.
 */
export function normalisePaths(value: JsonValue, roots: readonly PathRoot[]): JsonValue {
  const ordered = [...roots].sort((a, b) => b.from.length - a.from.length);
  const patterns = ordered.map(({ from, to }) => ({
    regex: new RegExp(`${escapeRegExp(from)}(?=[/\\\\]|$|[^\\w.@~-])`, 'g'),
    to,
  }));
  const visit = (entry: JsonValue): JsonValue => {
    if (typeof entry === 'string') {
      return patterns.reduce((text, { regex, to }) => text.replace(regex, to), entry);
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (isJsonObject(entry)) {
      return Object.fromEntries(Object.entries(entry).map(([key, inner]) => [key, visit(inner)]));
    }
    return entry;
  };
  return visit(value);
}

const asJson = (env: Record<string, string | null>): JsonValue => ({ ...env });

/** Compares two path-normalised config views against the allowed list. */
export function compareConfigs(
  base: ConfigView,
  run: ConfigView,
  allowedList: readonly AllowedConfigDiff[] = ALLOWED_CONFIG_DIFFS,
  volatileList: readonly VolatileConfigValue[] = VOLATILE_CONFIG_VALUES,
): ConfigComparison {
  const differences = (['project', 'global', 'vite'] as const)
    .flatMap((section) => diffJson(base[section], run[section], section))
    .concat(diffJson(asJson(base.env), asJson(run.env), 'env'));
  const allowedHits = new Map<string, string[]>();
  const volatileHits = new Map<string, string[]>();
  const failures: ConfigDifference[] = [];
  const add = (hits: Map<string, string[]>, name: string, dotted: string): void => {
    hits.set(name, [...(hits.get(name) ?? []), dotted]);
  };
  for (const difference of differences) {
    const allowed = allowedList.find((entry) =>
      entry.paths.some((pattern) => patternCovers(pattern, difference.path)),
    );
    const volatile = volatileList.find(
      (entry) =>
        entry.paths.some((pattern) => patternCovers(pattern, difference.path)) &&
        entry.appliesTo(base) &&
        entry.appliesTo(run),
    );
    if (allowed !== undefined) add(allowedHits, allowed.name, difference.path);
    else if (volatile !== undefined) add(volatileHits, volatile.name, difference.path);
    else failures.push(difference);
  }
  const listed = (hits: Map<string, string[]>, order: readonly { name: string }[]) =>
    order.flatMap(({ name }) => {
      const paths = hits.get(name);
      return paths === undefined ? [] : [{ name, paths }];
    });
  return {
    failures,
    allowed: listed(allowedHits, allowedList),
    volatile: listed(volatileHits, volatileList),
  };
}
