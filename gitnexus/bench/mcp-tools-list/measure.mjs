/**
 * Wall-clock cost of unrestricted MCP `tools/list` with many registered repos
 * (#3259 / #3184 / #1363).
 *
 * `toolSchemaRepoRequirements` used to call `listAllowedRepos()` → `listRepos()`
 * → one `git rev-list` per registry row (`checkStalenessAsync`). #1363 made
 * that fan-out parallel (~50 s serial → <1 s). #3259 removes it from schema
 * introspection: `countRepos()` reads the validated registry (fs.access, no
 * git). Staleness git stays on `list_repos`.
 *
 * This bench rebuilds that comparison on an isolated `GITNEXUS_HOME` so it
 * never touches the machine registry. Each fixture row is a real git repo
 * whose `lastCommit` matches HEAD, so `listRepos()` actually pays the
 * rev-list path instead of failing open.
 *
 *   node --import tsx bench/mcp-tools-list/measure.mjs
 *   BENCH_REPOS=50 BENCH_ROUNDS=3 node --import tsx bench/mcp-tools-list/measure.mjs
 *
 * Not wired into CI: first-run fixture setup is N `git init`s.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { LocalBackend } from '../../src/mcp/local/local-backend.ts';
import { createMcpRepositoryPolicy } from '../../src/mcp/repository-policy.ts';
import { createMCPServer } from '../../src/mcp/server.ts';
import { listRegisteredRepos } from '../../src/storage/repo-manager.ts';

const N = Number(process.env.BENCH_REPOS ?? 200);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 2);
const ROOT = process.env.BENCH_ROOT ?? path.join(os.tmpdir(), 'gn-mcp-tools-list-bench');
const HOME = path.join(ROOT, 'home');

process.env.GITNEXUS_HOME = HOME;
delete process.env.GITNEXUS_MCP_ALLOWED_REPOS;
delete process.env.GITNEXUS_MCP_DEFAULT_REPO;

const here = path.dirname(fileURLToPath(import.meta.url));

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
  const marker = path.join(ROOT, `ready-${N}`);
  if (existsSync(marker) && existsSync(path.join(HOME, 'registry.json'))) return;

  const entries = [];
  for (let i = 0; i < N; i++) {
    const repoPath = path.join(ROOT, 'repos', `r${i}`);
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

async function timeMs(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

async function listToolsOnce(backend) {
  const repositoryPolicy = await createMcpRepositoryPolicy(backend);
  const server = createMCPServer(backend, { repositoryPolicy });
  const client = new Client({ name: 'bench', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await timeMs(() => client.listTools());
  } finally {
    await client.close();
    await server.close();
  }
}

setupFixture();

const backend = new LocalBackend();
await backend.init();
const policy = await createMcpRepositoryPolicy(backend);

const arms = {
  'listRegisteredRepos(validate:false)': () => listRegisteredRepos({ validate: false }),
  'countRepos()': () => backend.countRepos(),
  'listRepos() [old tools/list hot path]': () => backend.listRepos(),
  'toolSchemaRepoRequirements()': () => policy.toolSchemaRepoRequirements(backend),
};

const results = {};
for (const [name, fn] of Object.entries(arms)) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples = [];
  for (let i = 0; i < ROUNDS; i++) samples.push(await timeMs(fn));
  results[name] = summarize(samples);
}

const listToolsSamples = [];
for (let i = 0; i < WARMUP; i++) await listToolsOnce(backend);
for (let i = 0; i < ROUNDS; i++) listToolsSamples.push(await listToolsOnce(backend));
results['client.listTools()'] = summarize(listToolsSamples);

const out = {
  bench: path.relative(path.join(here, '../..'), here) || 'bench/mcp-tools-list',
  nRepos: N,
  rounds: ROUNDS,
  warmup: WARMUP,
  results: Object.fromEntries(
    Object.entries(results).map(([k, v]) => [
      k,
      {
        min_ms: +v.min.toFixed(2),
        median_ms: +v.median.toFixed(2),
        max_ms: +v.max.toFixed(2),
      },
    ]),
  ),
};

console.log(JSON.stringify(out, null, 2));
