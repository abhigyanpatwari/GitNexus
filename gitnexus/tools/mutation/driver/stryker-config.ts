/**
 * Scope file, run layout and generated Stryker config of the scope driver (U10).
 *
 * Driver scope file (JSON, every key required, no other key allowed):
 *   {
 *     "testFiles": ["test/unit/shared-type-extractors.test.ts"],
 *     "mutate": ["gitnexus/src/core/ingestion/type-extractors/shared.ts:545-660",
 *                "gitnexus-shared/src/lbug/schema-constants.ts"]
 *   }
 * `testFiles` are package-relative POSIX paths, validated like the mutation scope file
 * (scope-file.ts) that the driver writes for tools/mutation/vitest.mutation.config.ts. `mutate`
 * entries are repo-relative `.ts` files under `gitnexus/src/` or `gitnexus-shared/src/`, each
 * optionally followed by a Stryker range `:<startLine>-<endLine>` or
 * `:<startLine>:<startColumn>-<endLine>:<endColumn>`. Globs are not accepted: the prepare step must
 * blank the `as` assertions of every mutated file (KTD7), so it needs the concrete files.
 *
 * Fixture projects (gate 2's conformance fixture) pass an extended path map (path-map.ts
 * `buildPathMap`) so their `gitnexus/test/fixtures/mutation-<name>/` files are accepted as mutate
 * entries, and their own Vitest config file and project (`vitest` input). With the default map
 * every other path keeps being rejected.
 *
 * Run layout: every artefact lives under one absolute output directory (see {@link RunLayout}).
 * Stryker runs with its working directory in the prepared `gitnexus/` copy, so mutate patterns are
 * relative to that directory and relocated `gitnexus-shared` files map through the path map (KTD8).
 *
 * The generated config never sets `testFiles` (KTD4): with it, static mutants would receive file
 * paths as their filter and become false survivors. The `command` variant (KTD18) does not load
 * the vitest5 runner plugin, so the oracle shares no runner code, and keeps its instrumented
 * sandbox (`cleanTempDir: false`) for single-test launches. The `vitest5` variant cleans its
 * sandbox after a successful run: its evidence (run manifest, sidecars, report) is written to
 * absolute directories outside the sandbox, and Stryker keeps the sandbox of a failed run for
 * debugging.
 */
import path from 'node:path';
import { parseMutationScope } from '../scope-file.js';
import { PACKAGE_DIR, PATH_MAP, toPreparedPath, type PathMapEntry } from '../prepare/path-map.js';

export const VARIANTS = ['vitest5', 'command'] as const;
export type Variant = (typeof VARIANTS)[number];

/**
 * Package-relative directories kept out of the Stryker sandbox: native binaries and build output
 * (prepare already leaves them out; this is the second line), and directories no pure-JS unit
 * test scope needs. Each becomes an anchored ignore pattern `/<dir>`.
 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = Object.freeze([
  'vendor',
  'prebuilds',
  'dist',
  'coverage',
  'reports',
  'test/fixtures',
  'test/integration',
  'bench',
  'skills',
  'hooks',
]);

/** The runner plugin and Stryker binary, relative to the prepared `gitnexus/` package. */
const PLUGIN_FILE = 'tools/mutation/runner/plugin.ts';
const STRYKER_BIN = 'node_modules/@stryker-mutator/core/bin/stryker.js';
const TSX_NODE_ARGS: readonly string[] = ['--import', 'tsx'];

export interface RunLayout {
  /** Absolute output directory of the run; the driver owns everything inside it. */
  outDir: string;
  /** The prepared root (prepare.ts `--out`). */
  preparedRoot: string;
  /** The prepared `gitnexus/` package: Stryker's working directory. */
  packageDir: string;
  pluginFile: string;
  strykerBin: string;
  /** Mutation scope file (`{testFiles}`) named by `GITNEXUS_MUTATION_SCOPE`. */
  scopeFile: string;
  configFile: string;
  /** Stryker JSON report (`mutation.json`). */
  reportFile: string;
  /** vitest5 run directory (KTD16): holds `run-manifest.json`. */
  runDir: string;
  /** vitest5 sidecar directory (KTD6). */
  sidecarDir: string;
  /** Stryker's stdout and stderr. */
  logFile: string;
  /** Normalised results (normalise-results.ts). */
  resultsFile: string;
  /** Deliberately missing: Stryker then leaves tsconfig files untouched. */
  missingTsconfig: string;
  /** Stryker's temp dir (default `tempDirName`); sandboxes are `sandbox-*` inside it. */
  tempDir: string;
}

const fail = (detail: string): never => {
  throw new Error(`mutation driver: ${detail}`);
};

/** The layout of a run under an absolute output directory. */
export function runLayout(outDir: string): RunLayout {
  if (!path.isAbsolute(outDir)) {
    fail(`the output directory ${JSON.stringify(outDir)} must be an absolute path`);
  }
  const root = path.resolve(outDir);
  const preparedRoot = path.join(root, 'prepared');
  const packageDir = path.join(preparedRoot, PACKAGE_DIR);
  return {
    outDir: root,
    preparedRoot,
    packageDir,
    pluginFile: path.join(packageDir, PLUGIN_FILE),
    strykerBin: path.join(packageDir, STRYKER_BIN),
    scopeFile: path.join(root, 'scope.json'),
    configFile: path.join(root, 'stryker.config.json'),
    reportFile: path.join(root, 'mutation.json'),
    runDir: path.join(root, 'run'),
    sidecarDir: path.join(root, 'sidecars'),
    logFile: path.join(root, 'stryker.log'),
    resultsFile: path.join(root, 'results.json'),
    missingTsconfig: path.join(root, 'no-such-tsconfig.json'),
    tempDir: path.join(packageDir, '.stryker-tmp'),
  };
}

export function parseVariant(value: string): Variant {
  const variant = VARIANTS.find((known) => known === value);
  return (
    variant ?? fail(`unknown variant ${JSON.stringify(value)} (expected ${VARIANTS.join(' or ')})`)
  );
}

export interface MutateEntry {
  /** Repo-relative POSIX path of the original file. */
  file: string;
  /** Stryker range without the leading colon, e.g. `545-660`; null for the whole file. */
  range: string | null;
}

const MUTATE_ENTRY = /^(.+?\.ts)(?::(\d+(?::\d+)?)-(\d+(?::\d+)?))?$/;

/** Parses `<repo path>[:<range>]` and checks that the path maps into the prepared tree. */
export function parseMutateEntry(
  entry: string,
  pathMap: readonly PathMapEntry[] = PATH_MAP,
): MutateEntry {
  const match = MUTATE_ENTRY.exec(entry);
  if (match === null || match[1].endsWith('.d.ts')) {
    return fail(`mutate entry ${JSON.stringify(entry)} must name a .ts source file`);
  }
  const [, file, start, end] = match;
  toPreparedPath(file, pathMap); // throws for a path outside the mapped roots
  if (start === undefined || end === undefined) return { file, range: null };
  const startLine = Number(start.split(':')[0]);
  const endLine = Number(end.split(':')[0]);
  if (startLine < 1 || endLine < startLine) {
    fail(`mutate entry ${JSON.stringify(entry)} has an invalid line range`);
  }
  return { file, range: `${start}-${end}` };
}

/** The entry as a Stryker mutate pattern, relative to the prepared `gitnexus/` package. */
export function strykerMutatePattern(
  entry: MutateEntry,
  pathMap: readonly PathMapEntry[] = PATH_MAP,
): string {
  const pattern = path.posix.relative(PACKAGE_DIR, toPreparedPath(entry.file, pathMap));
  return entry.range === null ? pattern : `${pattern}:${entry.range}`;
}

export interface DriverScope {
  testFiles: string[];
  mutate: MutateEntry[];
}

const SCOPE_KEYS: ReadonlySet<string> = new Set(['testFiles', 'mutate']);

/** Parses and validates a driver scope file (see the module comment). */
export function parseDriverScope(
  text: string,
  pathMap: readonly PathMapEntry[] = PATH_MAP,
): DriverScope {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return fail(
      `scope file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail('scope file must be a JSON object');
  }
  const unknown = Object.keys(data).filter((key) => !SCOPE_KEYS.has(key));
  if (unknown.length > 0) fail(`scope file has unknown key ${JSON.stringify(unknown[0])}`);
  const { testFiles } = parseMutationScope(
    JSON.stringify({ testFiles: 'testFiles' in data ? data.testFiles : undefined }),
  );
  const mutate: unknown = 'mutate' in data ? data.mutate : undefined;
  if (!Array.isArray(mutate) || mutate.length === 0) {
    return fail('scope file: mutate must be a non-empty array');
  }
  const seen = new Set<string>();
  const entries = mutate.map((entry: unknown): MutateEntry => {
    if (typeof entry !== 'string') return fail('scope file: mutate entries must be strings');
    if (seen.has(entry)) fail(`scope file: mutate entry ${JSON.stringify(entry)} is listed twice`);
    seen.add(entry);
    return parseMutateEntry(entry, pathMap);
  });
  return { testFiles, mutate: entries };
}

/** Throws when a scope test file lies under an ignored directory: the sandbox would lack it. */
export function assertTestFilesInSandbox(
  testFiles: readonly string[],
  ignoredDirs: readonly string[],
): void {
  for (const file of testFiles) {
    const dir = ignoredDirs.find((ignored) => file.startsWith(`${ignored}/`));
    if (dir !== undefined) {
      fail(`test file ${file} lies under the ignored directory ${dir}/, outside the sandbox`);
    }
  }
}

/** A Vitest config of the vitest5 runner other than the default mutation config. */
export interface VitestSelection {
  /** Package-relative POSIX path of the Vitest config file. */
  configFile: string;
  /** The single Vitest project to run. */
  project: string;
}

export interface StrykerConfigInput {
  variant: Variant;
  /** Absolute output directory; see {@link runLayout}. */
  outDir: string;
  mutate: readonly MutateEntry[];
  concurrency: number;
  /** Restart each test-runner process after this many runs; 0 means never. */
  maxTestRunnerReuse: number;
  /** Stryker's absolute timeout deviation per mutant run. */
  timeoutMS: number;
  /** The command variant's `commandRunner.command`; must be absent for vitest5. */
  command?: string;
  /** Defaults to {@link DEFAULT_IGNORED_DIRS}. */
  ignoredDirs?: readonly string[];
  /** Maps mutate entries into the prepared tree; defaults to {@link PATH_MAP}. */
  pathMap?: readonly PathMapEntry[];
  /** vitest5 only: the runner's Vitest config and project; the runner defaults apply without it. */
  vitest?: VitestSelection;
}

/** The Stryker options this driver sets (a `PartialStrykerOptions` subset). */
export interface GeneratedStrykerConfig {
  testRunner: Variant;
  appendPlugins?: string[];
  commandRunner?: { command: string };
  vitest5?: { runDir: string; sidecarDir: string; configFile?: string; project?: string };
  /** vitest5 only: Stryker ignores (and warns about) test-runner node args for `command`. */
  testRunnerNodeArgs?: string[];
  checkerNodeArgs: string[];
  coverageAnalysis: 'perTest' | 'off';
  disableBail: true;
  disableTypeChecks: false;
  tsconfigFile: string;
  mutate: string[];
  ignorePatterns: string[];
  concurrency: number;
  maxTestRunnerReuse: number;
  timeoutMS: number;
  cleanTempDir: boolean;
  reporters: string[];
  jsonReporter: { fileName: string };
  logLevel: 'info';
}

const requireInteger = (value: number, name: string, minimum: number): void => {
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${name} must be a ${minimum === 0 ? 'non-negative' : 'positive'} integer, got ${value}`);
  }
};

const isPackageRelative = (file: string): boolean =>
  file !== '' &&
  !file.includes('\\') &&
  !path.posix.isAbsolute(file) &&
  !file.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');

function checkVitestSelection(vitest: VitestSelection): VitestSelection {
  if (!isPackageRelative(vitest.configFile)) {
    fail(
      `the Vitest config file ${JSON.stringify(vitest.configFile)} must be a package-relative ` +
        'POSIX path',
    );
  }
  if (vitest.project === '') fail('the Vitest project name must not be empty');
  return { configFile: vitest.configFile, project: vitest.project };
}

/** The Stryker config of one run; pure. */
export function buildStrykerConfig(input: StrykerConfigInput): GeneratedStrykerConfig {
  const variant = parseVariant(input.variant);
  const layout = runLayout(input.outDir);
  if (input.mutate.length === 0) fail('the config needs at least one mutate entry');
  requireInteger(input.concurrency, 'concurrency', 1);
  requireInteger(input.maxTestRunnerReuse, 'maxTestRunnerReuse', 0);
  requireInteger(input.timeoutMS, 'timeoutMS', 1);
  if (variant === 'vitest5' && input.command !== undefined) {
    fail('a command is only for the command variant');
  }
  if (variant === 'command' && (input.command === undefined || input.command === '')) {
    fail('the command variant needs a command');
  }
  if (variant === 'command' && input.vitest !== undefined) {
    fail('a Vitest config and project are only for the vitest5 variant');
  }
  const ignoredDirs = input.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const mutate = input.mutate.map((entry) => strykerMutatePattern(entry, input.pathMap));
  for (const pattern of mutate) {
    const dir = ignoredDirs.find((ignored) => pattern.startsWith(`${ignored}/`));
    if (dir !== undefined) {
      fail(`mutate file ${pattern} lies under the ignored directory ${dir}/, outside the sandbox`);
    }
  }
  const shared: Omit<
    GeneratedStrykerConfig,
    | 'testRunner'
    | 'appendPlugins'
    | 'commandRunner'
    | 'vitest5'
    | 'coverageAnalysis'
    | 'cleanTempDir'
    | 'testRunnerNodeArgs'
  > = {
    checkerNodeArgs: [...TSX_NODE_ARGS],
    disableBail: true,
    disableTypeChecks: false,
    tsconfigFile: layout.missingTsconfig,
    mutate,
    ignorePatterns: ignoredDirs.map((dir) => `/${dir}`),
    concurrency: input.concurrency,
    maxTestRunnerReuse: input.maxTestRunnerReuse,
    timeoutMS: input.timeoutMS,
    reporters: ['json', 'clear-text'],
    jsonReporter: { fileName: layout.reportFile },
    logLevel: 'info',
  };
  if (variant === 'command') {
    return {
      testRunner: 'command',
      commandRunner: { command: input.command ?? '' },
      coverageAnalysis: 'off',
      cleanTempDir: false,
      ...shared,
    };
  }
  return {
    testRunner: 'vitest5',
    appendPlugins: [layout.pluginFile],
    vitest5: {
      runDir: layout.runDir,
      sidecarDir: layout.sidecarDir,
      ...(input.vitest === undefined ? {} : checkVitestSelection(input.vitest)),
    },
    testRunnerNodeArgs: [...TSX_NODE_ARGS],
    coverageAnalysis: 'perTest',
    cleanTempDir: true,
    ...shared,
  };
}
