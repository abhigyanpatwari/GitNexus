/**
 * Build-free bench for unrestricted MCP `tools/list` with many registered
 * repos (#3259 / #3184 / #1363).
 *
 * WHY THIS EXISTS. `toolSchemaRepoRequirements` used to call
 * `listAllowedRepos()` → `listRepos()` → one `git rev-list` per registry row
 * (`checkStalenessAsync`). #1363 made that fan-out parallel (~50 s serial →
 * <1 s). #3259 removes it from schema introspection: `countRepos()` reads the
 * validated registry (`fs.access`, no git). Staleness git stays on
 * `list_repos`. Graph output and unit tests cannot see "we stopped spawning
 * git on tools/list" — putting `listRepos()` back still returns the same
 * tool roster and the same required-repo flags.
 *
 * ARMS:
 *
 * - `n_repos` / `count_repos` / `list_repos` — EXACT, and they are the FLOOR.
 *   The ratio arms only mean something while the corpus still pays N parallel
 *   `rev-list`s. Shrink it to three rows and both sides are cheap; the ratio
 *   can still pass while the property the bench claims to guard is gone.
 *
 * - `tools_listed` — EXACT. `listTools` must still return the full
 *   `GITNEXUS_TOOLS` roster. A schema path that errors or filters the set
 *   would otherwise hide behind a "fast" timing arm.
 *
 * - `schema_read_only_requires_repo` / `schema_mutating_requires_repo` —
 *   EXACT. On this unrestricted N-repo fixture there is no cwd default, so
 *   both flags must stay true. Skipping the cwd probe and advertising a
 *   single-repo schema would pass every timing arm.
 *
 * - `count_vs_listRepos_ratio` — UPPER timing arm, a RATIO not a millisecond
 *   ceiling. `countRepos_ms / listRepos_ms`. Putting staleness git back on
 *   `countRepos` collapses this toward 1. Wall-clock is runner-speed-
 *   dependent; this repo has already been bitten by a fixed ms budget.
 *
 * - `listTools_vs_listRepos_ratio` — UPPER timing arm. The user-visible
 *   `tools/list` path over the old `listRepos()` hot path. Restoring
 *   `listRepos()` on schema introspection collapses this toward 1+.
 *
 * Isolated `GITNEXUS_HOME` — never touches `~/.gitnexus`. Each fixture row
 * is a real git repo whose `lastCommit` matches HEAD, so `listRepos()` pays
 * `rev-list` instead of failing open.
 *
 * Usage:
 *   node --import tsx bench/mcp-tools-list/measure.mjs
 *   node --import tsx bench/mcp-tools-list/measure.mjs --check
 *   BENCH_REPOS=3 node --import tsx bench/mcp-tools-list/measure.mjs   # report only
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

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

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const REPS = CHECK ? PINNED_REPS : positiveInt(process.env.BENCH_REPS, PINNED_REPS);
const N = CHECK ? baselines.n_repos : positiveInt(process.env.BENCH_REPOS, baselines.n_repos);
const ROOT = process.env.BENCH_ROOT ?? path.join(os.tmpdir(), 'gn-mcp-tools-list-bench');
const WORK = path.join(ROOT, `n-${N}`);
const HOME = path.join(WORK, 'home');

process.env.GITNEXUS_HOME = HOME;
delete process.env.GITNEXUS_MCP_ALLOWED_REPOS;
delete process.env.GITNEXUS_MCP_DEFAULT_REPO;

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
  if (existsSync(marker) && existsSync(path.join(HOME, 'registry.json'))) return;

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
    writeFileSync(path.join(storagePath, 'gitnexus.json'), '{}\n');
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

const countTimed = await fastest(() => backend.countRepos(), REPS);
const listTimed = await fastest(() => backend.listRepos(), REPS);
const listToolsTimed = await fastest(() => listToolsOnce(backend), REPS);
const schema = await policy.toolSchemaRepoRequirements(backend);
const rawRegistry = await listRegisteredRepos({ validate: false });

const countRepos = countTimed.last;
const listRepos = listTimed.last.length;
const toolsListed = listToolsTimed.last;
const countMs = countTimed.ms;
const listReposMs = listTimed.ms;
const listToolsMs = listToolsTimed.ms;
const countRatio = listReposMs === 0 ? Infinity : countMs / listReposMs;
const listToolsRatio = listReposMs === 0 ? Infinity : listToolsMs / listReposMs;

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
console.log(
  `count_vs_listRepos_ratio     : ${countRatio.toFixed(3)}  (budget <= ${baselines.count_vs_listRepos_budget})`,
);
console.log(
  `listTools_vs_listRepos_ratio : ${listToolsRatio.toFixed(3)}  (budget <= ${baselines.listTools_vs_listRepos_budget})`,
);
console.log(
  `reps                       : ${REPS}   count ${countMs.toFixed(2)}ms / listRepos ${listReposMs.toFixed(2)}ms / listTools ${listToolsMs.toFixed(2)}ms / rawRegistry ${rawRegistry.length}`,
);

if (!CHECK) process.exit(0);

if (process.env.BENCH_REPOS && Number(process.env.BENCH_REPOS) !== baselines.n_repos) {
  console.error(
    `\nFAIL BENCH_REPOS=${process.env.BENCH_REPOS} is ignored under --check.\n` +
      `  n_repos is pinned in baselines.json (${baselines.n_repos}). A smaller\n` +
      `  corpus makes both timing arms cheap and the ratios stop measuring git.`,
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
const countRatioBudget = requireNumeric('count_vs_listRepos_budget');
const listToolsRatioBudget = requireNumeric('listTools_vs_listRepos_budget');
const readOnlyExpect = requireBoolean('schema_read_only_requires_repo');
const mutatingExpect = requireBoolean('schema_mutating_requires_repo');

for (const got of [
  nReposBudget,
  countBudget,
  listBudget,
  toolsBudget,
  countRatioBudget,
  listToolsRatioBudget,
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

if (Number.isFinite(countRatioBudget) && countRatio > countRatioBudget) {
  fail(
    `count_vs_listRepos_ratio: ${countRatio.toFixed(3)} exceeds ${countRatioBudget}.\n` +
      `  countRepos should stay far cheaper than listRepos. A collapse toward 1.0\n` +
      `  usually means staleness git is back on the count path.\n` +
      `  Re-run on an idle machine before investigating, and check \`reps\` first.`,
  );
}

if (Number.isFinite(listToolsRatioBudget) && listToolsRatio > listToolsRatioBudget) {
  fail(
    `listTools_vs_listRepos_ratio: ${listToolsRatio.toFixed(3)} exceeds ${listToolsRatioBudget}.\n` +
      `  tools/list should stay cheaper than the old listRepos() hot path. A\n` +
      `  collapse toward 1.0+ usually means schema introspection calls listRepos\n` +
      `  again. Re-run on an idle machine before investigating, and check \`reps\`.`,
  );
}

if (failed) process.exit(1);
console.log('\nOK — within budget.');
