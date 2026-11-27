const { execFileSync } = require('node:child_process');

// These are independently reusable checks. An unfamiliar build input takes
// the conservative path. --no-renames gives both packages a vote on a move.
const coverage = 'tests / ubuntu / coverage merge';
const checks = {
  quality: ['quality / format', 'quality / lint'],
  cli: ['quality / typecheck', coverage],
  web: ['quality / typecheck-web', coverage],
  eval: ['tests / eval / locked pytest'],
  docker: [coverage],
  browser: ['e2e / e2e (chromium)'],
  abi: ['ubuntu-latest', 'windows-latest', 'macos-latest'].map(
    (os) => `tests / tree-sitter ABI (${os})`,
  ),
  java: ['tests / Java compiler conformance', coverage],
  workflows: ['quality / Workflow concurrency convention'],
};
const lanes = Object.keys(checks);

function affected(paths) {
  const selected = new Set();
  for (const path of paths) {
    if (path === 'AGENTS.md' || path === 'CLAUDE.md') {
      selected.add('quality');
      selected.add('cli');
      continue;
    }
    // The skill-sync workflow checks changes to the shipped Markdown copies.
    if (
      /^(docs\/|Documentation\/|[^/]+\.md$|LICENSE$|\.github\/PULL_REQUEST_TEMPLATE\.md$)/.test(
        path,
      ) ||
      /(?:^|\/)README\.md$/.test(path) ||
      /^\.claude\/skills\/gitnexus(?:-|\/).*\.md$/.test(path)
    )
      continue;
    selected.add('quality');
    if (path.startsWith('gitnexus-web/')) {
      selected.add('web');
      selected.add('browser');
      if (
        /^gitnexus-web\/(src\/lib\/upload-filter\.ts|vercel\.json|tsconfig[^/]*\.json)$/.test(path)
      )
        selected.add('cli');
    } else if (path.startsWith('gitnexus-shared/')) {
      for (const lane of ['cli', 'web', 'browser', 'java']) selected.add(lane);
    } else if (path.startsWith('eval/')) {
      selected.add('eval');
    } else if (/^(docker-server(?:\.test)?\.mjs|Dockerfile\..+|docker-compose\.yaml)$/.test(path)) {
      selected.add('docker');
      if (path === 'Dockerfile.cli') selected.add('cli');
    } else if (path.startsWith('gitnexus/')) {
      const file = path.slice('gitnexus/'.length);
      selected.add('cli');
      const install = /^package(?:-lock)?\.json$/.test(file);
      if (
        install ||
        /^(src\/|tools\/compiler-conformance\/java\/|test\/.*\bjava(?:\b|[A-Z])|scripts\/|vendor\/)/.test(
          file,
        )
      )
        selected.add('java');
      if (
        install ||
        /^(vendor\/|scripts\/|src\/core\/tree-sitter|.*(?:parser-loader|grpc-extractor))/.test(file)
      )
        selected.add('abi');
      if (file === 'package-lock.json' || file === '.npmrc') selected.add('eval');
      if (install || /^scripts\/(execution-reporter|test-completeness)\.ts$/.test(file))
        selected.add('web');
      if (
        install ||
        /^(src\/(server\/|mcp\/|cli\/(?:index|serve)\.ts$)|test\/fixtures\/mini-repo\/)/.test(file)
      )
        selected.add('browser');
    } else {
      for (const lane of lanes) selected.add(lane);
    }
  }
  return selected;
}

// GitHub records the revision of a local reusable workflow, including the
// synthetic PR merge SHA. run.head_sha alone identifies only the PR branch.
async function successfulPR({ github, context, revision, tree, parent }) {
  const repo = context.repo;
  const fullName = repo.owner + '/' + repo.repo;
  const prs = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    ...repo,
    commit_sha: revision,
    per_page: 100,
  });
  for (const pr of prs) {
    if (
      !pr.merged_at ||
      pr.merge_commit_sha !== revision ||
      pr.base.repo.full_name !== fullName ||
      pr.head.repo?.full_name !== fullName
    )
      continue;
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repo,
      workflow_id: 'ci.yml',
      event: 'pull_request',
      head_sha: pr.head.sha,
      status: 'completed',
      per_page: 100,
    });
    // A rerun of an older workflow can finish after a newer workflow.
    // With a truncated history we cannot establish which completion is latest.
    if (data.total_count > data.workflow_runs.length) return;
    for (const run of data.workflow_runs.sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
      if (
        run.path !== '.github/workflows/ci.yml' ||
        run.event !== 'pull_request' ||
        run.head_sha !== pr.head.sha ||
        run.head_repository?.id !== pr.head.repo.id
      )
        continue;
      // A failure can precede the reusable workflow and lack a merge reference.
      if (run.conclusion !== 'success') return;
      const ref = run.referenced_workflows?.find(
        (w) =>
          w.ref === 'refs/pull/' + pr.number + '/merge' &&
          w.path === fullName + '/.github/workflows/ci-tests.yml@' + w.sha,
      );
      if (!ref) continue;
      const { data: tested } = await github.rest.git.getCommit({ ...repo, commit_sha: ref.sha });
      if (
        tested.tree.sha === tree &&
        tested.parents[0]?.sha === parent &&
        tested.parents[1]?.sha === pr.head.sha
      )
        return run.id;
    }
  }
}

async function plan({ github, context, core }) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: process.env.GITHUB_WORKSPACE,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  const release = context.eventName !== 'pull_request';
  let changed = new Set(lanes);
  let source = '';
  const reused = new Set();
  try {
    const parent = git('rev-parse', '--verify', 'HEAD^1').trim();
    changed = affected(
      git('diff', '--name-only', '--no-renames', '-z', parent, 'HEAD').split('\0').filter(Boolean),
    );
    if (release) {
      const run = await successfulPR({
        github,
        context,
        revision: git('rev-parse', 'HEAD').trim(),
        tree: git('rev-parse', 'HEAD^{tree}').trim(),
        parent,
      });
      if (run) {
        const params = { ...context.repo, run_id: run, per_page: 100 };
        const [artifacts, jobs] = await Promise.all([
          github.paginate(github.rest.actions.listWorkflowRunArtifacts, params),
          github.paginate(github.rest.actions.listJobsForWorkflowRun, {
            ...params,
            filter: 'latest',
          }),
        ]);
        const available = new Set(artifacts.filter((a) => !a.expired).map((a) => a.name));
        const passed = new Set(jobs.filter((j) => j.conclusion === 'success').map((j) => j.name));
        for (const lane of changed) {
          if (!passed.has('CI Gate') || !checks[lane].every((name) => passed.has(name))) continue;
          if (['cli', 'web', 'java'].includes(lane) && !available.has('coverage-reports')) continue;
          if (
            lane === 'eval' &&
            !['execution-pytest-locked', 'execution-preflight'].every((a) => available.has(a))
          )
            continue;
          reused.add(lane);
        }
        // Java LCOV travels inside the CLI report. If that report must be
        // regenerated, so must the conformance coverage appended to it.
        if (!reused.has('cli')) reused.delete('java');
        if (changed.has('java') && !reused.has('java')) reused.delete('cli');
        source = String(run);
      }
    }
  } catch (error) {
    changed = new Set(lanes);
    reused.clear();
    source = '';
    core.warning('Running all checks in this CI run: ' + error.message);
  }
  const run = Object.fromEntries(
    lanes.map((lane) => [lane, release ? !reused.has(lane) : changed.has(lane)]),
  );
  const packages = ['cli', 'web'].filter((lane) => release || changed.has(lane));
  const result = { run, reused: [...reused], source, packages, release };
  core.info(JSON.stringify(result));
  core.setOutput('plan', JSON.stringify(result));
  const selected = lanes.filter((lane) => run[lane]);
  core.summary.addHeading(release ? 'Release checks' : 'PR checks', 2);
  core.summary.addRaw('Selected suites: ' + (selected.join(', ') || 'none') + '.', true);
  if (release) core.summary.addRaw('The full release matrix and execution audit also run.', true);
  if (reused.size) {
    core.summary.addRaw('Reused ' + [...reused].join(', ') + ' from ');
    core.summary.addLink(
      'CI run ' + source,
      `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${source}`,
    );
  }
  await core.summary.write();
}

module.exports = { affected, plan };
