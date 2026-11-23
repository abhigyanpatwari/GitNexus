/**
 * Build-free bench for unrestricted MCP `tools/list` with many registered
 * repos (#3259 / #3184 / #1363).
 *
 * Discovery and schema introspection both skip per-repository Git freshness.
 * Compare each operation to the former workload: one concurrent rev-list per
 * fixture repository. Every control read must confirm that its index is at HEAD.
 * Separately check that counting and schema introspection never request a listing.
 *
 * Isolated `GITNEXUS_HOME` — never touches `~/.gitnexus`. Also clears
 * `GITNEXUS_MCP_ALLOWED_REPOS`, `GITNEXUS_MCP_DEFAULT_REPO`, and
 * `GITNEXUS_MCP_READ_ONLY` so the invoking shell cannot shrink the roster.
 * Each fixture row is a real git repo whose `lastCommit` matches HEAD, so
 * the control performs a real revision comparison. The default root is
 * `mkdtempSync`; set `BENCH_ROOT` to reuse a tree across local runs.
 *
 * Usage:
 *   node --import tsx bench/mcp-tools-list/measure.mjs
 *   node --import tsx bench/mcp-tools-list/measure.mjs --check
 *   BENCH_REPOS=3 node --import tsx bench/mcp-tools-list/measure.mjs   # report only
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mock } from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { LocalBackend } from '../../src/mcp/local/local-backend.ts';
import { createMcpRepositoryPolicy } from '../../src/mcp/repository-policy.ts';
import { createMCPServer } from '../../src/mcp/server.ts';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.ts';
import { listRegisteredRepos } from '../../src/storage/repo-manager.ts';

const baselines = JSON.parse(readFileSync(new URL('./baselines.json', import.meta.url), 'utf8'));

const CHECK = process.argv.includes('--check');
const PINNED_REPS = 7;
const execFileAsync = promisify(execFile);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const REPS = CHECK ? PINNED_REPS : positiveInt(process.env.BENCH_REPS, PINNED_REPS);
const N = CHECK ? baselines.n_repos : positiveInt(process.env.BENCH_REPOS, baselines.n_repos);
const ROOT =
  process.env.BENCH_ROOT ?? mkdtempSync(path.join(os.tmpdir(), 'gn-mcp-tools-list-bench-'));
const WORK = path.join(ROOT, `n-${N}`);
const HOME = path.join(WORK, 'home');

process.env.GITNEXUS_HOME = HOME;
delete process.env.GITNEXUS_MCP_ALLOWED_REPOS;
delete process.env.GITNEXUS_MCP_DEFAULT_REPO;
delete process.env.GITNEXUS_MCP_READ_ONLY;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@example.com',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@example.com',
    },
  }).trim();
}

function setupFixture() {
  mkdirSync(HOME, { recursive: true });
  const marker = path.join(WORK, 'ready');
  // Reuse only when the caller pinned BENCH_ROOT. The default root is a
  // mkdtempSync directory, so the ready marker cannot alias a previous run
  // and there is no exists-then-write race on a predictable /tmp name.
  if (
    process.env.BENCH_ROOT &&
    existsSync(marker) &&
    existsSync(path.join(HOME, 'registry.json'))
  ) {
    return;
  }

  const entries = [];
  for (let i = 0; i < N; i++) {
    const repoPath = path.join(WORK, 'repos', `r${i}`);
    const storagePath = path.join(repoPath, '.gitnexus');
    mkdirSync(storagePath, { recursive: true });
    writeFileSync(path.join(repoPath, 'f.txt'), `${i}\n`);
    git(repoPath, ['init', '-b', 'main']);
    git(repoPath, ['add', 'f.txt']);
    git(repoPath, ['commit', '-m', 'init']);
    entries.push({
      name: `r${i}`,
      path: repoPath,
      storagePath,
      indexedAt: '2026-09-11T00:00:00.000Z',
      lastCommit: git(repoPath, ['rev-parse', 'HEAD']),
      stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
    });
    mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
    writeFileSync(
      path.join(storagePath, 'gitnexus.json'),
      `${JSON.stringify({ repoPath, storagePath })}\n`,
    );
  }
  writeFileSync(path.join(HOME, 'registry.json'), `${JSON.stringify(entries, null, 2)}\n`);
  writeFileSync(marker, `${N}\n`);
}

async function fastest(fn, reps) {
  await fn();
  let best = Infinity;
  let last;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    last = await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, last };
}

async function listToolsOnce(backend) {
  const repositoryPolicy = await createMcpRepositoryPolicy(backend);
  const server = createMCPServer(backend, { repositoryPolicy });
  const client = new Client({ name: 'bench', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    return listed.tools.length;
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * A missing budget is a DELETED GATE, not a passing arm: `got > undefined` is
 * false for every measurement. `Number.isFinite` rather than `typeof ===
 * 'number'` — JSON cannot express NaN, and the stricter check is the one whose
 * name says what the gate needs.
 */
function requireNumeric(key) {
  const value = baselines[key];
  if (Number.isFinite(value)) return value;
  return {
    missing: `no numeric ${key} in baselines.json — a missing budget is a DELETED GATE, not a passing arm: the comparison it gates is false for every possible measurement. Deterministic: a re-run will not change it.`,
  };
}

function requireBoolean(key) {
  const value = baselines[key];
  if (typeof value === 'boolean') return value;
  return {
    missing: `no boolean ${key} in baselines.json — a missing exact floor is a DELETED GATE, not a passing arm. Deterministic: a re-run will not change it.`,
  };
}

setupFixture();

const backend = new LocalBackend();
await backend.init();
const policy = await createMcpRepositoryPolicy(backend);

const rawRegistry = await listRegisteredRepos({ validate: false });
assert.equal(rawRegistry.length, N, 'Git control must cover the entire fixture');
const gitTimed = await fastest(
  () =>
    Promise.all(
      rawRegistry.map(async (entry) => {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--left-right', '--count', `${entry.lastCommit}...HEAD`],
          { cwd: entry.path, timeout: 10_000 },
        );
        assert.equal(
          stdout.trim(),
          '0\t0',
          `Git control expected the indexed HEAD in ${entry.path}`,
        );
      }),
    ),
  REPS,
);
const listTimed = await fastest(() => backend.listRepos(), REPS);
assert.deepEqual(
  listTimed.last.map((repo) => repo.path).sort(),
  rawRegistry.map((repo) => repo.path).sort(),
);
assert.ok(
  listTimed.last.every((repo) => repo.staleness?.status === 'unknown'),
  'discovery must report unknown freshness',
);
const listSpy = mock.method(backend, 'listRepos');
const pageSpy = mock.method(backend, 'listReposPage');
const countTimed = await fastest(() => backend.countRepos(), REPS);
const listToolsTimed = await fastest(() => listToolsOnce(backend), REPS);
const schema = await policy.toolSchemaRepoRequirements(backend);
assert.equal(
  listSpy.mock.callCount() + pageSpy.mock.callCount(),
  0,
  'counting and schema introspection must skip repository listing',
);
mock.restoreAll();

const countRepos = countTimed.last;
const listRepos = listTimed.last.length;
const toolsListed = listToolsTimed.last;
const countMs = countTimed.ms;
const listReposMs = listTimed.ms;
const listToolsMs = listToolsTimed.ms;
const timingArms = [
  ['count_vs_git', countMs],
  ['listRepos_vs_git', listReposMs],
  ['listTools_vs_git', listToolsMs],
];

console.log(`n_repos                      : ${N}  (expect ${baselines.n_repos})`);
console.log(`count_repos                  : ${countRepos}  (expect ${baselines.count_repos})`);
console.log(`list_repos                   : ${listRepos}  (expect ${baselines.list_repos})`);
console.log(
  `tools_listed                 : ${toolsListed}  (expect ${baselines.tools_listed}; GITNEXUS_TOOLS ${GITNEXUS_TOOLS.length})`,
);
console.log(
  `schema_read_only_requires_repo : ${schema.readOnlyRequiresRepo}  (expect ${baselines.schema_read_only_requires_repo})`,
);
console.log(
  `schema_mutating_requires_repo  : ${schema.mutatingRequiresRepo}  (expect ${baselines.schema_mutating_requires_repo})`,
);
for (const [name, ms] of timingArms) {
  console.log(
    `${name}_ratio: ${(ms / gitTimed.ms).toFixed(3)}  (budget <= ${baselines[`${name}_budget`]})`,
  );
}
console.log(
  `reps                       : ${REPS}   count ${countMs.toFixed(2)}ms / listRepos ${listReposMs.toFixed(2)}ms / listTools ${listToolsMs.toFixed(2)}ms / git ${gitTimed.ms.toFixed(2)}ms`,
);

if (!CHECK) process.exit(0);

if (process.env.BENCH_REPOS && Number(process.env.BENCH_REPOS) !== baselines.n_repos) {
  console.error(
    `\nFAIL BENCH_REPOS=${process.env.BENCH_REPOS} is ignored under --check.\n` +
      `  n_repos is pinned in baselines.json (${baselines.n_repos}). A smaller\n` +
      `  corpus changes the Git control and its timing ratios.`,
  );
  process.exit(1);
}

let failed = false;

function fail(message) {
  failed = true;
  console.error(`\nFAIL ${message}`);
}

const nReposBudget = requireNumeric('n_repos');
const countBudget = requireNumeric('count_repos');
const listBudget = requireNumeric('list_repos');
const toolsBudget = requireNumeric('tools_listed');
const readOnlyExpect = requireBoolean('schema_read_only_requires_repo');
const mutatingExpect = requireBoolean('schema_mutating_requires_repo');

for (const got of [
  nReposBudget,
  countBudget,
  listBudget,
  toolsBudget,
  readOnlyExpect,
  mutatingExpect,
]) {
  if (got && typeof got === 'object' && 'missing' in got) fail(got.missing);
}

if (Number.isFinite(nReposBudget) && N !== nReposBudget) {
  fail(
    `n_repos: ${N}, expected exactly ${nReposBudget}.\n` +
      `  THE FLOOR. Ratio arms only assert something while the corpus still\n` +
      `  pays N parallel rev-list processes.`,
  );
}

if (Number.isFinite(countBudget) && countRepos !== countBudget) {
  fail(`count_repos: ${countRepos}, expected exactly ${countBudget}.`);
}

if (Number.isFinite(listBudget) && listRepos !== listBudget) {
  fail(`list_repos: ${listRepos}, expected exactly ${listBudget}.`);
}

if (Number.isFinite(toolsBudget)) {
  if (GITNEXUS_TOOLS.length !== toolsBudget) {
    fail(
      `GITNEXUS_TOOLS.length: ${GITNEXUS_TOOLS.length}, expected exactly ${toolsBudget}.\n` +
        `  The tool roster moved. Explain it; do not re-baseline tools_listed alone.`,
    );
  }
  if (toolsListed !== toolsBudget) {
    fail(
      `tools_listed: ${toolsListed}, expected exactly ${toolsBudget}.\n` +
        `  listTools dropped or padded the roster. A fast arm that returns [] still\n` +
        `  looks like a win on the ratio.`,
    );
  }
}

if (typeof readOnlyExpect === 'boolean' && schema.readOnlyRequiresRepo !== readOnlyExpect) {
  fail(
    `schema_read_only_requires_repo: ${schema.readOnlyRequiresRepo}, expected ${readOnlyExpect}.\n` +
      `  On this unrestricted N-repo fixture there is no cwd default. Advertising\n` +
      `  a single-repo schema skips the multi-repo arm the timing ratios guard.`,
  );
}

if (typeof mutatingExpect === 'boolean' && schema.mutatingRequiresRepo !== mutatingExpect) {
  fail(
    `schema_mutating_requires_repo: ${schema.mutatingRequiresRepo}, expected ${mutatingExpect}.\n` +
      `  On this unrestricted N-repo fixture there is no cwd default.`,
  );
}

for (const [name, ms] of timingArms) {
  const budget = requireNumeric(`${name}_budget`);
  const ratio = ms / gitTimed.ms;
  if (typeof budget !== 'number') fail(budget.missing);
  else if (!(ratio <= budget)) fail(`${name}_ratio: ${ratio.toFixed(3)} exceeds ${budget}.`);
}

if (failed) process.exit(1);
console.log('\nOK — within budget.');
