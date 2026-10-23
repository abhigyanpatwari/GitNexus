/**
 * Locks the scope driver's generated Stryker config (U10, KTD4, KTD6, KTD10, KTD16, KTD18): mutate
 * patterns point inside the prepared tree (relocated gitnexus-shared included), the vitest5 variant
 * carries absolute run and sidecar directories, the command variant keeps its sandbox, and no
 * generated config ever sets `testFiles`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IGNORED_DIRS,
  assertTestFilesInSandbox,
  buildStrykerConfig,
  parseDriverScope,
  parseMutateEntry,
  parseVariant,
  runLayout,
  strykerMutatePattern,
  type StrykerConfigInput,
} from '../../../tools/mutation/driver/stryker-config.js';

const OUT = path.resolve('/tmp/gitnexus-u10-config-test/out');
const SHARED = 'gitnexus-shared/src/lbug/schema-constants.ts';
const LOCAL = 'gitnexus/src/core/ingestion/type-extractors/shared.ts';

const input = (overrides: Partial<StrykerConfigInput> = {}): StrykerConfigInput => ({
  variant: 'vitest5',
  outDir: OUT,
  mutate: [parseMutateEntry(LOCAL), parseMutateEntry(SHARED)],
  concurrency: 3,
  maxTestRunnerReuse: 25,
  timeoutMS: 10000,
  ...overrides,
});

const commandInput = (overrides: Partial<StrykerConfigInput> = {}): StrykerConfigInput =>
  input({ variant: 'command', command: 'node wrapper.mjs', ...overrides });

describe('runLayout', () => {
  it('places every run artefact under the absolute output directory', () => {
    const layout = runLayout(OUT);
    expect(layout).toMatchObject({
      outDir: OUT,
      preparedRoot: path.join(OUT, 'prepared'),
      packageDir: path.join(OUT, 'prepared', 'gitnexus'),
      pluginFile: path.join(OUT, 'prepared', 'gitnexus', 'tools/mutation/runner/plugin.ts'),
      scopeFile: path.join(OUT, 'scope.json'),
      configFile: path.join(OUT, 'stryker.config.json'),
      reportFile: path.join(OUT, 'mutation.json'),
      runDir: path.join(OUT, 'run'),
      sidecarDir: path.join(OUT, 'sidecars'),
      resultsFile: path.join(OUT, 'results.json'),
    });
  });

  it('rejects a relative output directory', () => {
    expect(() => runLayout('tmp/out')).toThrow(/must be an absolute path/);
  });
});

describe('parseMutateEntry and strykerMutatePattern', () => {
  it('maps a relocated gitnexus-shared path to a pattern inside the prepared tree', () => {
    const layout = runLayout(OUT);
    const pattern = strykerMutatePattern(parseMutateEntry(SHARED));
    expect(pattern).toBe('relocated/gitnexus-shared/src/lbug/schema-constants.ts');
    expect(path.resolve(layout.packageDir, pattern)).toBe(
      path.join(
        layout.preparedRoot,
        'gitnexus/relocated/gitnexus-shared/src/lbug/schema-constants.ts',
      ),
    );
  });

  it.each([
    [`${LOCAL}`, 'src/core/ingestion/type-extractors/shared.ts'],
    [`${LOCAL}:545-660`, 'src/core/ingestion/type-extractors/shared.ts:545-660'],
    [`${SHARED}:3:5-9:1`, 'relocated/gitnexus-shared/src/lbug/schema-constants.ts:3:5-9:1'],
  ])('keeps a Stryker line range: %s', (entry, pattern) => {
    expect(strykerMutatePattern(parseMutateEntry(entry))).toBe(pattern);
  });

  it('splits the file from its range', () => {
    expect(parseMutateEntry(`${LOCAL}:545-660`)).toEqual({ file: LOCAL, range: '545-660' });
  });

  it.each([
    ['README.md', /\.ts source file/],
    ['gitnexus/src/types.d.ts', /\.ts source file/],
    ['gitnexus/test/unit/schema.test.ts', /outside the mapped roots/],
    ['/abs/gitnexus/src/a.ts', /not a relative path inside the root/],
    [`${LOCAL}:0-4`, /line range/],
    [`${LOCAL}:9-4`, /line range/],
    [`${LOCAL}:4-`, /\.ts source file/],
  ])('rejects %s', (entry, message) => {
    expect(() => parseMutateEntry(entry)).toThrow(message);
  });
});

describe('parseDriverScope', () => {
  it('parses package-relative test files and repo-relative mutate entries', () => {
    const scope = parseDriverScope(
      JSON.stringify({ testFiles: ['test/unit/schema.test.ts'], mutate: [`${SHARED}:1-40`] }),
    );
    expect(scope).toEqual({
      testFiles: ['test/unit/schema.test.ts'],
      mutate: [{ file: SHARED, range: '1-40' }],
    });
  });

  it.each([
    ['missing testFiles', { mutate: [LOCAL] }, /testFiles must be a non-empty array/],
    ['missing mutate', { testFiles: ['test/unit/a.test.ts'] }, /mutate must be a non-empty array/],
    ['empty mutate', { testFiles: ['test/unit/a.test.ts'], mutate: [] }, /mutate must be/],
    [
      'a non-string mutate entry',
      { testFiles: ['test/unit/a.test.ts'], mutate: [3] },
      /mutate entries must be strings/,
    ],
    [
      'a repeated mutate entry',
      { testFiles: ['test/unit/a.test.ts'], mutate: [LOCAL, LOCAL] },
      /listed twice/,
    ],
    [
      'an unknown key',
      { testFiles: ['test/unit/a.test.ts'], mutate: [LOCAL], testFile: [] },
      /unknown key "testFile"/,
    ],
    ['a non-object', [LOCAL], /must be a JSON object/],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseDriverScope(JSON.stringify(value))).toThrow(message);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseDriverScope('{')).toThrow(/not valid JSON/);
  });
});

describe('parseVariant', () => {
  it.each(['vitest5', 'command'] as const)('accepts %s', (variant) => {
    expect(parseVariant(variant)).toBe(variant);
  });

  it('rejects an unknown variant', () => {
    expect(() => parseVariant('jest')).toThrow(/unknown variant "jest"/);
  });
});

describe('buildStrykerConfig: vitest5 variant', () => {
  const layout = runLayout(OUT);
  const config = buildStrykerConfig(input());

  it('loads the runner plugin from the prepared copy and runs it under tsx', () => {
    expect(config).toMatchObject({
      testRunner: 'vitest5',
      appendPlugins: [layout.pluginFile],
      testRunnerNodeArgs: ['--import', 'tsx'],
      checkerNodeArgs: ['--import', 'tsx'],
      coverageAnalysis: 'perTest',
      disableBail: true,
      disableTypeChecks: false,
    });
  });

  it('sets the run and sidecar directories as absolute paths', () => {
    expect(config.vitest5).toEqual({ runDir: layout.runDir, sidecarDir: layout.sidecarDir });
    expect([config.vitest5?.runDir, config.vitest5?.sidecarDir].map(path.isAbsolute)).toEqual([
      true,
      true,
    ]);
  });

  it('points tsconfigFile at a file that does not exist', () => {
    expect(path.isAbsolute(config.tsconfigFile)).toBe(true);
    expect(existsSync(config.tsconfigFile)).toBe(false);
  });

  it('passes the scheduling profile through', () => {
    expect(config).toMatchObject({ concurrency: 3, maxTestRunnerReuse: 25, timeoutMS: 10000 });
  });

  it('writes the JSON report to the layout report file', () => {
    expect(config.reporters).toContain('json');
    expect(config.jsonReporter).toEqual({ fileName: layout.reportFile });
  });

  it('maps every mutate entry inside the prepared tree', () => {
    expect(config.mutate).toEqual([
      'src/core/ingestion/type-extractors/shared.ts',
      'relocated/gitnexus-shared/src/lbug/schema-constants.ts',
    ]);
  });

  it('keeps vendor, native and build output out of the sandbox, but not the relocated tree', () => {
    expect(config.ignorePatterns).toEqual(
      expect.arrayContaining(['/vendor', '/prebuilds', '/dist']),
    );
    expect(config.ignorePatterns).toEqual(DEFAULT_IGNORED_DIRS.map((dir) => `/${dir}`));
    expect(config.ignorePatterns.some((pattern) => pattern.includes('relocated'))).toBe(false);
  });

  it('cleans the sandbox after a successful run', () => {
    expect(config.cleanTempDir).toBe(true);
  });
});

describe('buildStrykerConfig: command variant', () => {
  const config = buildStrykerConfig(commandInput());

  it('keeps the sandbox: cleanTempDir is false', () => {
    expect(config.cleanTempDir).toBe(false);
  });

  it('runs the given command with coverage analysis off and without the runner plugin', () => {
    expect(config).toMatchObject({
      testRunner: 'command',
      commandRunner: { command: 'node wrapper.mjs' },
      coverageAnalysis: 'off',
    });
    expect(config.appendPlugins).toBeUndefined();
    expect(config.vitest5).toBeUndefined();
  });

  it('sets no test-runner node args, which the command runner ignores, but keeps the checker args', () => {
    expect(config.testRunnerNodeArgs).toBeUndefined();
    expect(config.checkerNodeArgs).toEqual(['--import', 'tsx']);
  });
});

describe('buildStrykerConfig: never sets testFiles', () => {
  it.each([
    ['vitest5', input()],
    ['command', commandInput()],
  ])('%s', (_variant, configInput) => {
    const config = buildStrykerConfig(configInput);
    expect(Object.keys(config)).not.toContain('testFiles');
    expect(JSON.stringify(config)).not.toContain('testFiles');
  });
});

describe('buildStrykerConfig: input errors', () => {
  it.each([
    ['a relative output directory', input({ outDir: 'relative/out' }), /absolute path/],
    ['no mutate entry', input({ mutate: [] }), /at least one mutate entry/],
    ['concurrency 0', input({ concurrency: 0 }), /concurrency must be a positive integer/],
    ['a fractional concurrency', input({ concurrency: 1.5 }), /concurrency must be/],
    [
      'a negative maxTestRunnerReuse',
      input({ maxTestRunnerReuse: -1 }),
      /maxTestRunnerReuse must be a non-negative integer/,
    ],
    ['timeoutMS 0', input({ timeoutMS: 0 }), /timeoutMS must be a positive integer/],
    ['a command for vitest5', input({ command: 'true' }), /only for the command variant/],
    ['no command for the command variant', commandInput({ command: undefined }), /needs a command/],
    ['an empty command', commandInput({ command: '' }), /needs a command/],
  ])('rejects %s', (_label, configInput, message) => {
    expect(() => buildStrykerConfig(configInput)).toThrow(message);
  });

  it('rejects an unknown variant that bypassed the type', () => {
    const variant = parseVariantUnchecked('karma');
    expect(() => buildStrykerConfig({ ...input(), variant })).toThrow(/unknown variant "karma"/);
  });
});

describe('assertTestFilesInSandbox', () => {
  it('accepts test files outside the ignored directories', () => {
    expect(() =>
      assertTestFilesInSandbox(['test/unit/schema.test.ts'], DEFAULT_IGNORED_DIRS),
    ).not.toThrow();
  });

  it.each(['test/fixtures/mutation-x/a.case.ts', 'test/integration/b.test.ts', 'bench/c.test.ts'])(
    'rejects %s, which the sandbox would not contain',
    (file) => {
      expect(() => assertTestFilesInSandbox([file], DEFAULT_IGNORED_DIRS)).toThrow(
        /lies under the ignored directory/,
      );
    },
  );
});

/** Simulates an unvalidated CLI value reaching the generator. */
function parseVariantUnchecked(value: string): StrykerConfigInput['variant'] {
  return value as StrykerConfigInput['variant'];
}
