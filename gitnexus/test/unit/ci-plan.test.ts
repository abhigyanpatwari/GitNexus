import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Lane =
  | 'quality'
  | 'cli'
  | 'web'
  | 'eval'
  | 'docker'
  | 'browser'
  | 'abi'
  | 'java'
  | 'workflows';
type Plan = {
  release: boolean;
  source: string;
  reused: Lane[];
  packages: string[];
  run: Record<Lane, boolean>;
};
const { affected, plan } = createRequire(import.meta.url)(
  '../../../.github/scripts/ci-plan.cjs',
) as {
  affected(paths: string[]): Set<Lane>;
  plan(args: { github: object; context: object; core: object }): Promise<void>;
};

type WorkflowJob = {
  name?: string;
  if?: string;
  steps?: { name?: string; with?: { name?: string } }[];
  strategy?: { matrix?: { os?: string[] } };
};
function jobsFor(workflow: string) {
  const file = path.resolve(__dirname, '../../../.github/workflows', workflow + '.yml');
  return (load(readFileSync(file, 'utf8')) as { jobs: Record<string, WorkflowJob> }).jobs;
}

it('reserves the release matrix for Publish', () => {
  const jobs = jobsFor('ci-tests');
  for (const name of [
    'cross-platform',
    'packaged-install-smoke',
    'java-platform-conformance',
    'benchmarks',
    'file-result-reuse-benchmark',
    'analyze-resume-benchmark',
    'lexical-lookup-benchmark',
    'mcp-query-benchmark',
    'embedding-chunking-benchmark',
    'embedding-identity-benchmark',
    'node-floor-compat',
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
    // Git hooks and callers may set GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE.
    // Both the fixture commits and the planner's child processes must use this repo.
    for (const name of Object.keys(process.env).filter((name) => name.startsWith('GIT_'))) {
      vi.stubEnv(name, undefined);
    }
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
      head: { sha: 'pr-head', repo: { id: 2, full_name: 'org/repo' } },
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
    const artifact = {
      name: 'coverage-reports',
      expired: false,
      expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    };
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
      setOutput: vi.fn<(key: string, value: string) => void>(),
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
          github: {
            rest,
            paginate: (fn: (params: object) => Promise<unknown>, params: object) => fn(params),
          },
          context: { eventName, repo: { owner: 'org', repo: 'repo' } },
          core,
        });
        expect(core.setOutput).toHaveBeenCalledExactlyOnceWith('plan', expect.any(String));
        return JSON.parse(core.setOutput.mock.calls[0][1]) as Plan;
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

  it('detects every affected package when a changed file moves into docs', async () => {
    mkdirSync(path.join(cwd, 'docs'));
    git('mv', 'gitnexus-web/file with spaces.ts', 'docs/example.md');
    mkdirSync(path.join(cwd, 'gitnexus'));
    writeFileSync(path.join(cwd, 'gitnexus', 'cli.ts'), 'export const x = 0;');
    git('add', '.');
    git('commit', '-qm', 'move from web and update CLI', '--no-gpg-sign');
    const result = await fixture().select('pull_request');
    expect(result.run).toMatchObject({ cli: true, web: true });
  });

  it('reuses successful web checks and runs the missing release suites', async () => {
    const api = fixture();
    const result = await api.select();
    expect(result.release).toBe(true);
    expect(result.source).toBe('123');
    expect(result.reused.sort()).toEqual(['browser', 'quality', 'web']);
    expect(result.run).toMatchObject({ cli: true, web: false, browser: false, eval: true });
    expect(result.packages).toEqual(['cli', 'web']);
    const repo = { owner: 'org', repo: 'repo' };
    expect(api.rest.repos.listPullRequestsAssociatedWithCommit).toHaveBeenCalledWith(
      expect.objectContaining({ ...repo, commit_sha: api.pr.merge_commit_sha }),
    );
    expect(api.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        ...repo,
        workflow_id: 'ci.yml',
        event: 'pull_request',
        head_sha: api.pr.head.sha,
      }),
    );
    expect(api.rest.git.getCommit).toHaveBeenCalledWith({ ...repo, commit_sha: api.ref.sha });
    expect(api.rest.actions.listWorkflowRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ ...repo, run_id: 123 }),
    );
    expect(api.rest.actions.listJobsForWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ ...repo, run_id: 123, filter: 'latest' }),
    );
  });

  type Fixture = ReturnType<typeof fixture>;
  const invalidEvidence: [string, (api: Fixture) => void][] = [
    [
      'direct push',
      (api) => api.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue([]),
    ],
    ['unmerged PR', (api) => Object.assign(api.pr, { merged_at: '' })],
    ['different merge revision', (api) => Object.assign(api.pr, { merge_commit_sha: 'other' })],
    [
      'different base repository',
      (api) => Object.assign(api.pr.base.repo, { full_name: 'org/other' }),
    ],
    [
      'different workflow',
      (api) => Object.assign(api.run, { path: '.github/workflows/other.yml' }),
    ],
    ['different event', (api) => Object.assign(api.run, { event: 'push' })],
    ['different run head', (api) => Object.assign(api.run, { head_sha: 'other' })],
    ['different tree', (api) => Object.assign(api.tested.tree, { sha: 'other' })],
    ['different base', (api) => Object.assign(api.tested.parents[0], { sha: 'other' })],
    ['different head', (api) => Object.assign(api.tested.parents[1], { sha: 'other' })],
    ['different PR', (api) => Object.assign(api.ref, { ref: 'refs/pull/8/merge' })],
    [
      'different referenced repository',
      (api) =>
        Object.assign(api.ref, { path: 'org/other/.github/workflows/ci-tests.yml@tested-merge' }),
    ],
    [
      'different referenced revision',
      (api) => Object.assign(api.ref, { path: 'org/repo/.github/workflows/ci-tests.yml@other' }),
    ],
    [
      'different referenced workflow',
      (api) =>
        Object.assign(api.ref, { path: 'org/repo/.github/workflows/ci-quality.yml@tested-merge' }),
    ],
    ['different fork', (api) => Object.assign(api.run.head_repository, { id: 10 })],
    ['failed CI', (api) => Object.assign(api.run, { conclusion: 'failure' })],
    ['missing gate', (api) => Object.assign(api.jobs[0], { conclusion: 'skipped' })],
    ['API failure', (api) => api.rest.git.getCommit.mockRejectedValue(new Error('unavailable'))],
  ];
  it.each(invalidEvidence)('falls back on %s', async (_reason, invalidate) => {
    const api = fixture();
    invalidate(api);
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

  it.each([
    [[], [], []],
    [['quality / typecheck'], [], ['cli', 'java']],
    [['tests / Java compiler conformance'], [], ['cli', 'java']],
    [[], ['coverage-reports'], ['cli', 'java', 'web']],
    [['quality / lint'], [], ['quality']],
  ] as const)(
    'schedules fresh checks with missing jobs %j and artifacts %j',
    async (missingJobs, missingArtifacts, fresh) => {
      writeFileSync(path.join(cwd, 'ci-input'), 'unknown build input');
      git('add', '.');
      git('commit', '-qm', 'select all suites', '--no-gpg-sign');
      const api = fixture();
      const tests = jobsFor('ci-tests');
      const quality = jobsFor('ci-quality');
      // Match the check names Actions emits, including the current ABI host matrix.
      const checkNames = [
        jobsFor('ci')['ci-status'].name!,
        ...['format', 'lint', 'typecheck', 'typecheck-web', 'workflow-convention'].map(
          (id) => 'quality / ' + (quality[id].name ?? id),
        ),
        ...['coverage-merge', 'java-compiler-conformance', 'eval-tests'].map(
          (id) => 'tests / ' + tests[id].name,
        ),
        ...tests['abi-assert'].strategy!.matrix!.os!.map(
          (os) => 'tests / ' + tests['abi-assert'].name!.replace('${{ matrix.os }}', os),
        ),
        'e2e / ' + jobsFor('ci-e2e').e2e.name,
      ];
      api.rest.actions.listJobsForWorkflowRun.mockResolvedValue(
        checkNames
          .filter((name) => !(missingJobs as readonly string[]).includes(name))
          .map((name) => ({ name, conclusion: 'success' })),
      );
      const uploads = [...tests['coverage-merge'].steps!, ...tests['eval-tests'].steps!].filter(
        (step) => step.name?.startsWith('Upload'),
      );
      api.rest.actions.listWorkflowRunArtifacts.mockResolvedValue(
        uploads
          .flatMap((step) => step.with?.name ?? [])
          .filter((name) => !(missingArtifacts as readonly string[]).includes(name))
          .map((name) => ({ ...api.artifact, name })),
      );
      const result = await api.select();
      expect(
        Object.keys(result.run)
          .filter((lane) => result.run[lane as Lane])
          .sort(),
      ).toEqual([...fresh].sort());
    },
  );

  it.each([
    [['execution-pytest-locked', 'execution-preflight'], true],
    [['execution-pytest-locked'], false],
    [['execution-preflight'], false],
  ] as const)('reuses eval with receipts %j: %s', async (receipts, complete) => {
    mkdirSync(path.join(cwd, 'eval'));
    writeFileSync(path.join(cwd, 'eval', 'change.py'), '');
    git('add', 'eval');
    git('commit', '-qm', 'update eval', '--no-gpg-sign');
    const api = fixture();
    api.jobs.push({ name: 'tests / eval / locked pytest', conclusion: 'success' });
    api.rest.actions.listWorkflowRunArtifacts.mockResolvedValue(
      receipts.map((name) => ({ ...api.artifact, name })),
    );
    const result = await api.select('workflow_dispatch');
    expect(result.run.eval).toBe(!complete);
    expect(result.reused.includes('eval')).toBe(complete);
  });
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
