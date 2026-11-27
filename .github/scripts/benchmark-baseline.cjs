const { execFileSync } = require('node:child_process');

const benchmarkJobs = [
  'parse cache / speed and memory (synthetic)',
  'parse cache / speed and memory (real)',
  'analyze / resumable performance (explicit)',
  'analyze / resumable performance (default)',
  'indexing / lexical lookup and cache interning',
  'MCP query performance',
  'embedding chunking benchmark',
].map((name) => 'ci / tests / ' + name);

async function benchmarkBaseline({ github, repo, cwd = process.cwd() }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim().split('\n');
  // Publish writes a lightweight rc/<main SHA> marker after its CI gate passes.
  // Walk from the parent so tag releases and reruns cannot benchmark themselves.
  const markers = new Set(git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags/rc'));
  for (const sha of git('rev-list', '--first-parent', 'HEAD^1')) {
    if (!markers.has(sha + ' refs/tags/rc/' + sha)) continue;
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      ...repo,
      workflow_id: 'publish.yml',
      branch: 'main',
      head_sha: sha,
      status: 'success',
      per_page: 100,
    });
    for (const run of runs) {
      if (run.event !== 'push' && run.event !== 'workflow_dispatch') continue;
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...repo,
        run_id: run.id,
        filter: 'latest',
        per_page: 100,
      });
      const passed = new Set(jobs.filter((job) => job.conclusion === 'success').map((j) => j.name));
      if (benchmarkJobs.every((name) => passed.has(name))) return sha;
    }
  }
  throw new Error('No ancestor has a successful main Publish run with every paired benchmark.');
}

module.exports = { benchmarkBaseline };
