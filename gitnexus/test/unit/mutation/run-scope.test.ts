/**
 * Locks the scope driver's pure helpers (U10): CLI parsing, the Stryker command line, and the
 * child environment, which must name the scope file and must not inherit Stryker's own worker and
 * active-mutant variables (KTD5, KTD10).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLayout } from '../../../tools/mutation/driver/stryker-config.js';
import {
  findSandboxes,
  parseCliArgs,
  strykerChildEnv,
  strykerCommand,
} from '../../../tools/mutation/driver/run-scope.js';

const CWD = path.resolve('/work/gitnexus');

describe('parseCliArgs', () => {
  it('applies the defaults and resolves paths against the working directory', () => {
    expect(parseCliArgs(['--scope', 'scope.json', '--out', '/tmp/run'], CWD)).toEqual({
      scopeFile: path.join(CWD, 'scope.json'),
      outDir: path.resolve('/tmp/run'),
      variant: 'vitest5',
      concurrency: 2,
      maxTestRunnerReuse: 0,
      timeoutMS: 10000,
      command: undefined,
    });
  });

  it('reads the command variant and the scheduling profile', () => {
    const args = [
      '--scope=/s.json',
      '--out=/o',
      '--variant=command',
      '--command=true',
      '--concurrency=4',
      '--max-test-runner-reuse=10',
      '--timeout-ms=20000',
    ];
    expect(parseCliArgs(args, CWD)).toMatchObject({
      variant: 'command',
      command: 'true',
      concurrency: 4,
      maxTestRunnerReuse: 10,
      timeoutMS: 20000,
    });
  });

  it.each([
    ['no --scope', ['--out', '/o'], /--scope is required/],
    ['no --out', ['--scope', '/s.json'], /--out is required/],
    ['an unknown variant', ['--scope=/s', '--out=/o', '--variant=jest'], /unknown variant "jest"/],
    ['a non-numeric concurrency', ['--scope=/s', '--out=/o', '--concurrency=two'], /integer/],
    ['an unknown flag', ['--scope=/s', '--out=/o', '--testFiles=a'], /Unknown option/],
  ])('rejects %s', (_label, args, message) => {
    expect(() => parseCliArgs(args, CWD)).toThrow(message);
  });
});

describe('strykerChildEnv', () => {
  const env = strykerChildEnv(
    {
      PATH: '/bin',
      __STRYKER_ACTIVE_MUTANT__: '12',
      STRYKER_MUTATOR_WORKER: '3',
      GITNEXUS_MUTATION_SCOPE: 'stale.json',
    },
    '/out/scope.json',
  );

  it('names the run scope file', () => {
    expect(env.GITNEXUS_MUTATION_SCOPE).toBe('/out/scope.json');
  });

  it('scrubs inherited Stryker worker and active-mutant variables', () => {
    expect(Object.keys(env).sort()).toEqual(['GITNEXUS_MUTATION_SCOPE', 'PATH']);
  });
});

describe('strykerCommand', () => {
  it('runs the prepared copy Stryker binary under tsx from the prepared package', () => {
    const layout = runLayout(path.resolve('/out'));
    expect(strykerCommand(layout, '/usr/bin/node')).toEqual({
      command: '/usr/bin/node',
      args: [
        '--import',
        'tsx',
        path.join(layout.packageDir, 'node_modules/@stryker-mutator/core/bin/stryker.js'),
        'run',
        layout.configFile,
      ],
      cwd: layout.packageDir,
    });
  });
});

describe('findSandboxes', () => {
  it('keeps sandbox directories only, sorted', () => {
    expect(findSandboxes('/t', ['sandbox-b', 'other', 'sandbox-a', '.lock'])).toEqual([
      path.join('/t', 'sandbox-a'),
      path.join('/t', 'sandbox-b'),
    ]);
  });
});
