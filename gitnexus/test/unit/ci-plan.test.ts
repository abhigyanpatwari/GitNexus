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
  coverage: boolean;
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
  [['gitnexus/src/cli/doctor.ts'], ['quality', 'cli', 'java']],
  [['gitnexus/src/storage/repo-manager.ts'], ['quality', 'cli', 'java']],
  [['gitnexus/src/core/lbug/db.ts'], ['quality', 'cli', 'java']],
  [['gitnexus/src/core/run-analyze.ts'], ['quality', 'cli', 'java']],
  [['gitnexus/src/mcp/local/local-backend.ts'], ['quality', 'cli', 'java', 'browser']],
  [['gitnexus/src/cli/index.ts'], ['quality', 'cli', 'java', 'browser']],
  [['gitnexus/src/cli/serve.ts'], ['quality', 'cli', 'java', 'browser']],
  [['gitnexus/src/core/group/extractors/grpc-extractor.ts'], ['quality', 'cli', 'java', 'abi']],
  [['gitnexus/test/fixtures/javascript/example.js'], ['quality', 'cli']],
  [['gitnexus/test/fixtures/java/Example.java'], ['quality', 'cli', 'java']],
  [['Dockerfile.cli'], ['quality', 'cli', 'docker']],
  [['gitnexus-web/src/lib/upload-filter.ts'], ['quality', 'cli', 'web', 'browser']],
  [['gitnexus-web/tsconfig.app.json'], ['quality', 'cli', 'web', 'browser']],
  [['gitnexus-web/vercel.json'], ['quality', 'cli', 'web', 'browser']],
  [['gitnexus/package-lock.json'], ['quality', 'cli', 'java', 'abi', 'web', 'browser', 'eval']],
  [['gitnexus/.npmrc'], ['quality', 'cli', 'eval']],
  [
    ['AGENTS.md', 'CLAUDE.md'],
    ['quality', 'cli'],
  ],
  [
    [
      'gitnexus/README.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.claude/skills/gitnexus-cli/SKILL.md',
    ],
    [],
  ],
  [['gitnexus-web/src/App.tsx'], ['quality', 'web', 'browser']],
  [['gitnexus-shared/src/types.ts'], ['quality', 'cli', 'web', 'browser', 'java']],
  [['gitnexus/src/server/api.ts'], ['quality', 'cli', 'java', 'browser']],
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
      updated_at: '2026-01-01T00:00:00Z',
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
    const artifact: { name: string; expired: boolean; expires_at?: string } = {
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
    type RequestOptions = { request?: { signal?: AbortSignal; retries?: number } };
    const before = vi.fn<(event: string, hook: (options: RequestOptions) => void) => void>();
    return {
      core,
      before,
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
            hook: { before },
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
    expect(result.coverage).toBe(true);
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

  it('omits package coverage for a documentation-only PR', async () => {
    writeFileSync(path.join(cwd, 'README.md'), 'documentation');
    git('add', 'README.md');
    git('commit', '-qm', 'docs', '--no-gpg-sign');
    const result = await fixture().select('pull_request');
    expect(result.coverage).toBe(false);
    expect(result.packages).toEqual([]);
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
        status: 'completed',
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

  it('reruns after a newer failure on the same tested merge', async () => {
    const api = fixture();
    api.rest.actions.listWorkflowRuns.mockResolvedValue({
      data: {
        workflow_runs: [
          api.run,
          { ...api.run, id: 122, updated_at: '2026-01-02T00:00:00Z', conclusion: 'failure' },
        ],
      },
    });
    const result = await api.select();
    expect(result.reused).toEqual([]);
    expect(Object.values(result.run).every(Boolean)).toBe(true);
  });

  it('ignores unrelated PRs, runs and workflow references before a valid match', async () => {
    const api = fixture();
    api.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue([
      { ...api.pr, merged_at: '' },
      api.pr,
    ]);
    api.run.referenced_workflows.unshift({ ...api.ref, path: 'unrelated' });
    api.rest.actions.listWorkflowRuns.mockResolvedValue({
      data: { workflow_runs: [{ ...api.run, id: 124, referenced_workflows: [] }, api.run] },
    });
    const result = await api.select();
    expect(result.source).toBe('123');
    expect(result.reused).toContain('web');
  });

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
    ['merged fork PR', (api) => Object.assign(api.pr.head.repo, { full_name: 'fork/repo' })],
    ['failed CI', (api) => Object.assign(api.run, { conclusion: 'failure' })],
    ['missing gate', (api) => Object.assign(api.jobs[0], { conclusion: 'skipped' })],
  ];
  it.each(invalidEvidence)('falls back on %s', async (_reason, invalidate) => {
    const api = fixture();
    invalidate(api);
    const result = await api.select();
    expect(result.reused).toEqual([]);
    expect(Object.values(result.run).every(Boolean)).toBe(true);
  });

  it('gives each API request the same deadline, including paginated requests', async () => {
    const api = fixture();
    await api.select();
    expect(api.before).toHaveBeenCalledExactlyOnceWith('request', expect.any(Function));
    const applyDeadline = api.before.mock.calls[0][1];
    const first = { request: { retries: 2, signal: undefined } };
    const nextPage = { request: { signal: undefined } };
    applyDeadline(first);
    applyDeadline(nextPage);
    expect(first.request.signal).toBeInstanceOf(AbortSignal);
    expect(nextPage.request.signal).toBe(first.request.signal);
    expect(first.request.retries).toBe(2);
  });

  it('reports GitHub lookup failures and runs all checks', async () => {
    const api = fixture();
    api.rest.git.getCommit.mockRejectedValue(
      Object.assign(new Error('unavailable'), { status: 503 }),
    );
    const result = await api.select();
    expect(result.reused).toEqual([]);
    expect(Object.values(result.run).every(Boolean)).toBe(true);
    expect(api.core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'), true);
  });

  it('stops looking for evidence when the shared deadline expires', async () => {
    const api = fixture();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const expired = AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
    try {
      timeout.mockReturnValueOnce(expired);
      api.rest.repos.listPullRequestsAssociatedWithCommit.mockImplementation(async () => {
        api.before.mock.calls[0][1]({});
        return [];
      });
      const result = await api.select();
      expect(result.reused).toEqual([]);
      expect(Object.values(result.run).every(Boolean)).toBe(true);
      expect(api.core.summary.addRaw).toHaveBeenCalledWith(
        expect.stringContaining('timed out'),
        true,
      );
    } finally {
      timeout.mockRestore();
    }
  });

  it('falls back when Git cannot read the checked-out revision', async () => {
    const api = fixture();
    vi.stubEnv('GITHUB_WORKSPACE', path.join(cwd, 'absent'));
    const result = await api.select('pull_request');
    expect(Object.values(result.run).every(Boolean)).toBe(true);
    expect(api.core.summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining('Git could not read'),
      true,
    );
  });

  it('fails the planner on unexpected errors before exposing any skip decisions', async () => {
    const api = fixture();
    api.rest.git.getCommit.mockRejectedValue(new TypeError('invalid evidence handling'));
    await expect(api.select()).rejects.toThrow('invalid evidence handling');
    expect(api.core.setOutput).not.toHaveBeenCalled();
  });

  it('keeps a valid plan if the Actions summary cannot be written', async () => {
    const api = fixture();
    api.core.summary.write.mockRejectedValue(new Error('disk full'));
    const result = await api.select('pull_request');
    expect(result.packages).toEqual(['web']);
    expect(api.core.warning).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  const hoursFromNow = (hours: number) =>
    new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  it.each([
    ['coverage-reports', undefined, true, false],
    ['coverage-reports', 'invalid', true, false],
    ['coverage-reports', hoursFromNow(23), true, false],
    ['execution-pytest-locked', hoursFromNow(23), false, true],
    ['execution-preflight', hoursFromNow(23), false, true],
    ['execution-preflight', hoursFromNow(25), false, false],
  ] as const)(
    'checks expiry of %s (%s) before reusing its suite',
    async (target, expires_at, web, evalSuite) => {
      writeFileSync(path.join(cwd, 'ci-input'), '');
      git('add', '.');
      git('commit', '-qm', 'select package and eval suites', '--no-gpg-sign');
      const api = fixture();
      api.jobs.push({ name: 'tests / eval / locked pytest', conclusion: 'success' });
      api.rest.actions.listWorkflowRunArtifacts.mockResolvedValue(
        ['coverage-reports', 'execution-pytest-locked', 'execution-preflight'].map((name) => ({
          ...api.artifact,
          name,
          expires_at: name === target ? expires_at : api.artifact.expires_at,
        })),
      );
      expect((await api.select()).run).toMatchObject({ web, eval: evalSuite });
    },
  );

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

const cliLcov = 'gitnexus/coverage/lcov.info';
const webLcov = 'gitnexus-web/coverage/lcov.info';
const cliResults = 'gitnexus/test-results.json';
const webResults = 'gitnexus-web/web-test-results.json';

it.skipIf(process.platform !== 'linux').each([
  ['evidence', true, false, [cliLcov, cliResults]],
  ['evidence', false, true, [webLcov, webResults]],
  ['evidence', true, true, [cliLcov, cliResults, webLcov, webResults]],
  ['lcov', true, false, [cliLcov]],
  ['lcov', false, true, [webLcov]],
  ['lcov', true, true, [cliLcov, webLcov]],
] as const)(
  'round-trips %s reports (CLI %s, web %s) and rejects missing inputs',
  (mode, cli, web, expected) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ci-package-evidence-'));
    try {
      const source = path.join(dir, 'source');
      const artifact = path.join(dir, 'artifact');
      const restored = path.join(dir, 'restored');
      const script = path.resolve(__dirname, '../../../.github/scripts/copy-ci-reports.sh');
      const checkedFiles = [
        cliLcov,
        webLcov,
        cliResults,
        webResults,
        'unrelated.txt',
        'gitnexus/.vitest/timings/coverage.json',
      ];
      for (const file of checkedFiles) {
        mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        writeFileSync(path.join(source, file), file);
      }
      const copy = (src: string, dest: string) =>
        execFileSync('bash', [script, src, dest, mode], {
          env: { ...process.env, CLI: String(cli), WEB: String(web) },
        });
      copy(source, artifact);
      copy(artifact, restored);
      expect(checkedFiles.filter((file) => existsSync(path.join(restored, file))).sort()).toEqual(
        [...expected].sort(),
      );
      for (const file of expected)
        expect(readFileSync(path.join(restored, file), 'utf8')).toBe(file);
      rmSync(path.join(artifact, expected[0]));
      expect(() => copy(artifact, restored)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
