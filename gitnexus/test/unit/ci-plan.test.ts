import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { affected, plan } = createRequire(import.meta.url)('../../../.github/scripts/ci-plan.cjs');

it('reserves the release matrix for Publish', () => {
  const workflow = path.resolve(__dirname, '../../../.github/workflows/ci-tests.yml');
  const { jobs } = load(readFileSync(workflow, 'utf8')) as {
    jobs: Record<string, { if?: string }>;
  };
  for (const name of [
    'cross-platform',
    'packaged-install-smoke',
    'java-platform-conformance',
    'benchmarks',
    'file-result-reuse-benchmark',
    'scope-resolution-benchmark',
    'tool-accuracy',
    'eval-containment-linux',
    'eval-containment-windows',
  ]) {
    expect(jobs[name]?.if, name).toBe('fromJSON(inputs.plan).release');
  }
  expect(jobs.tests.if).toBe('fromJSON(inputs.plan).run.cli');
  expect(jobs['eval-tests'].if).toBe('fromJSON(inputs.plan).run.eval');
});

it.each([
  [['README.md', 'docs/guide.md'], []],
  [['gitnexus/src/cli/doctor.ts'], ['quality', 'cli']],
  [['gitnexus-web/src/App.tsx'], ['quality', 'web', 'browser']],
  [['gitnexus-shared/src/types.ts'], ['quality', 'cli', 'web', 'browser', 'java']],
  [['gitnexus/src/server/api.ts'], ['quality', 'cli', 'browser']],
  [['eval/tests/test_release.py'], ['quality', 'eval']],
  [['docker-server.mjs'], ['quality', 'docker']],
  [
    ['gitnexus/a.ts', 'gitnexus-web/b.ts'],
    ['quality', 'cli', 'web', 'browser'],
  ],
  [
    ['.github/workflows/ci.yml'],
    ['quality', 'cli', 'web', 'eval', 'docker', 'browser', 'abi', 'java', 'workflows'],
  ],
])('selects checks for %j', (files, expected) => {
  expect(affected(files)).toEqual(new Set(expected));
});

describe('release reuse', () => {
  let cwd: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ci-plan-'));
    vi.stubEnv('GITHUB_WORKSPACE', cwd);
    git('init', '-q');
    git('config', 'user.name', 'CI');
    git('config', 'user.email', 'ci@example.invalid');
    git('commit', '-qm', 'base', '--allow-empty', '--no-gpg-sign');
    mkdirSync(path.join(cwd, 'gitnexus-web'));
    writeFileSync(path.join(cwd, 'gitnexus-web', 'file with spaces.ts'), 'export {}');
    git('add', '.');
    git('commit', '-qm', 'candidate', '--no-gpg-sign');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { force: true, recursive: true });
  });

  function fixture() {
    const pr = {
      merged_at: 'today',
      number: 9,
      merge_commit_sha: git('rev-parse', 'HEAD'),
      head: { sha: 'pr-head', repo: { id: 2 } },
      base: { repo: { full_name: 'org/repo' } },
    };
    const ref = {
      sha: 'tested-merge',
      ref: 'refs/pull/9/merge',
      path: 'org/repo/.github/workflows/ci-tests.yml@tested-merge',
    };
    const run = {
      path: '.github/workflows/ci.yml',
      id: 123,
      conclusion: 'success',
      event: 'pull_request',
      head_sha: 'pr-head',
      head_repository: { id: 2 },
      referenced_workflows: [ref],
    };
    const tested = {
      tree: { sha: git('rev-parse', 'HEAD^{tree}') },
      parents: [{ sha: git('rev-parse', 'HEAD^1') }, { sha: 'pr-head' }],
    };
    const artifact = { name: 'coverage-reports', expired: false };
    const jobs = [
      'CI Gate',
      'quality / format',
      'quality / lint',
      'quality / typecheck-web',
      'tests / ubuntu / coverage merge',
      'e2e / e2e (chromium)',
    ].map((name) => ({ name, conclusion: 'success' }));
    const rest = {
      repos: { listPullRequestsAssociatedWithCommit: vi.fn(async () => [pr]) },
      actions: {
        listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: [run] } })),
        listWorkflowRunArtifacts: vi.fn(async () => [artifact]),
        listJobsForWorkflowRun: vi.fn(async () => jobs),
      },
      git: { getCommit: vi.fn(async () => ({ data: tested })) },
    };
    const core = {
      setOutput: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      summary: { addHeading: vi.fn(), addRaw: vi.fn(), addLink: vi.fn(), write: vi.fn() },
    };
    return {
      pr,
      ref,
      run,
      tested,
      artifact,
      jobs,
      rest,
      async select(eventName = 'push') {
        await plan({
          github: { rest, paginate: (fn: () => Promise<unknown>) => fn() },
          context: { eventName, repo: { owner: 'org', repo: 'repo' } },
          core,
        });
        expect(core.setOutput).toHaveBeenCalledExactlyOnceWith('plan', expect.any(String));
        return JSON.parse(core.setOutput.mock.calls[0][1]);
      },
    };
  }

  it('diffs the checked-out PR without consulting release history', async () => {
    const api = fixture();
    const result = await api.select('pull_request');
    expect(result.release).toBe(false);
    expect(result.packages).toEqual(['web']);
    expect(result.run).toMatchObject({ cli: false, web: true, browser: true, eval: false });
    expect(api.rest.repos.listPullRequestsAssociatedWithCommit).not.toHaveBeenCalled();
  });

  it('reuses successful web checks and runs the missing release suites', async () => {
    const api = fixture();
    const result = await api.select();
    expect(result.release).toBe(true);
    expect(result.source).toBe('123');
    expect(result.reused.sort()).toEqual(['browser', 'quality', 'web']);
    expect(result.run).toMatchObject({ cli: true, web: false, browser: false, eval: true });
    expect(result.packages).toEqual(['cli', 'web']);
  });

  it.each([
    'direct push',
    'different tree',
    'different base',
    'different head',
    'different PR',
    'different fork',
    'failed CI',
    'missing gate',
    'API failure',
  ])('falls back on %s', async (reason) => {
    const api = fixture();
    if (reason === 'direct push')
      api.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue([]);
    if (reason === 'different tree') api.tested.tree.sha = 'other';
    if (reason === 'different base') api.tested.parents[0].sha = 'other';
    if (reason === 'different head') api.tested.parents[1].sha = 'other';
    if (reason === 'different PR') api.ref.ref = 'refs/pull/8/merge';
    if (reason === 'different fork') api.run.head_repository.id = 10;
    if (reason === 'failed CI') api.run.conclusion = 'failure';
    if (reason === 'missing gate') api.jobs[0].conclusion = 'skipped';
    if (reason === 'API failure')
      api.rest.git.getCommit.mockRejectedValue(new Error('unavailable'));
    const result = await api.select();
    expect(result.reused).toEqual([]);
    expect(Object.values(result.run).every(Boolean)).toBe(true);
  });

  it('reruns suites with expired evidence or a skipped job', async () => {
    const api = fixture();
    api.artifact.expired = true;
    api.jobs.splice(
      api.jobs.findIndex((job) => job.name === 'e2e / e2e (chromium)'),
      1,
    );
    const result = await api.select();
    expect(result.reused).toEqual(['quality']);
    expect(result.run).toMatchObject({ web: true, browser: true });
  });

  it.each([true, false])(
    'reuses eval only with both execution receipts (complete: %s)',
    async (complete) => {
      mkdirSync(path.join(cwd, 'eval'));
      writeFileSync(path.join(cwd, 'eval', 'change.py'), '');
      git('add', 'eval');
      git('commit', '-qm', 'update eval', '--no-gpg-sign');
      const api = fixture();
      api.jobs.push({ name: 'tests / eval / locked pytest', conclusion: 'success' });
      const receipts = ['execution-pytest-locked'];
      if (complete) receipts.push('execution-preflight');
      api.rest.actions.listWorkflowRunArtifacts.mockResolvedValue(
        receipts.map((name) => ({ name, expired: false })),
      );
      const result = await api.select('workflow_dispatch');
      expect(result.run.eval).toBe(!complete);
      expect(result.reused.includes('eval')).toBe(complete);
    },
  );
});

it.skipIf(process.platform !== 'linux')(
  'round-trips only selected reports and rejects missing evidence',
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ci-package-evidence-'));
    try {
      const source = path.join(dir, 'source');
      const artifact = path.join(dir, 'artifact');
      const restored = path.join(dir, 'restored');
      const script = path.resolve(__dirname, '../../../.github/scripts/copy-ci-reports.sh');
      const web = ['gitnexus-web/coverage/lcov.info', 'gitnexus-web/web-test-results.json'];
      const files = [...web, 'gitnexus/test-results.json', 'unrelated.txt'];
      for (const file of files) {
        mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        writeFileSync(path.join(source, file), file);
      }
      const copy = (src: string, dest: string) =>
        execFileSync('bash', [script, src, dest, 'evidence'], {
          env: { ...process.env, CLI: 'false', WEB: 'true' },
        });
      copy(source, artifact);
      copy(artifact, restored);
      for (const file of web) expect(readFileSync(path.join(restored, file), 'utf8')).toBe(file);
      expect(existsSync(path.join(restored, 'gitnexus'))).toBe(false);
      expect(existsSync(path.join(restored, 'unrelated.txt'))).toBe(false);
      rmSync(path.join(artifact, web[1]));
      expect(() => copy(artifact, restored)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
