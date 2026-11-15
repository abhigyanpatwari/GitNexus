import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadMeta } from '../../src/storage/repo-manager.js';

it('serves the published graph during an HTTP outage and resumes through /api/embed without repeating paid work', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-http-phases-')));
  const repo = path.join(root, 'repo');
  const slot = path.join(repo, '.gitnexus');
  await fs.mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  await fs.writeFile(
    path.join(repo, 'a.ts'),
    Array.from(
      { length: 130 },
      (_, i) => `export function alpha${String(i).padStart(3, '0')}() { return ${i}; }`,
    ).join('\n'),
  );
  git('add', 'a.ts');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
  let fail = true;
  let releaseOutage!: () => void;
  const outage = new Promise<void>((resolve) => {
    releaseOutage = resolve;
  });
  const accepted: string[] = [];
  const provider = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input: string[] = JSON.parse(body).input;
    if (fail && accepted.length >= 64) {
      await outage;
      response.writeHead(503).end('outage');
      return;
    }
    accepted.push(...input);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })) }),
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('No provider port');
  const child = fork(
    fileURLToPath(new URL('../helpers/analysis-http-server.mjs', import.meta.url)),
    [],
    {
      execArgv: ['--max-old-space-size=1024'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        GITNEXUS_HOME: path.join(root, 'home'),
        GITNEXUS_SHARED_STORE: 'off',
        GITNEXUS_SERVER_ANALYZE_HEAP_MB: '512',
        GITNEXUS_WORKER_POOL_SIZE: '1',
        GITNEXUS_LBUG_BUFFER_POOL_SIZE: String(256 * 1024 ** 2),
        GITNEXUS_EMBEDDING_URL: `http://127.0.0.1:${providerAddress.port}/v1`,
        GITNEXUS_EMBEDDING_MODEL: 'http-phase-fixture',
        GITNEXUS_EMBEDDING_DIMS: '4',
        GITNEXUS_EMBEDDING_MAX_ATTEMPTS: '1',
        GITNEXUS_EMBEDDING_SUB_BATCH_SIZE: '8',
      },
    },
  );
  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-32768);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.once('message', (message) => resolve((message as { port: number }).port));
      child.once('error', reject);
      void exited.then((code) => reject(new Error(`Server exited ${code}: ${output}`)));
    });
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = (await response.json()) as Record<string, any>;
      expect(response.ok, JSON.stringify(value) + '\n' + output).toBe(true);
      return value;
    };
    const until = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 90_000;
      while (!(await check())) {
        if (Date.now() > end) throw new Error(`Timed out: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const started = await request('/api/analyze', { path: repo, embeddings: true });
    const poll = () => request(`/api/analyze/${started.jobId}`);
    await until(async () => (await poll()).status === 'analyzing');
    const graphQuery = request('/api/query?repo=repo', {
      cypher: 'MATCH (n:Function) RETURN count(n) AS count',
    });
    await until(async () => accepted.length === 64);
    expect((await graphQuery).error).toBeUndefined();
    expect((await poll()).status).toBe('analyzing');
    expect((await loadMeta(slot))?.graphGeneration).toBeDefined();
    const keyword = await request('/api/search?repo=repo', {
      query: 'alpha000',
      mode: 'bm25',
      enrich: false,
    });
    expect(JSON.stringify(keyword)).toContain('alpha000');
    releaseOutage();
    await until(async () => (await poll()).status === 'failed');
    expect(accepted).toHaveLength(64);
    fail = false;
    const retry = await request('/api/embed?repo=repo', {});
    await until(async () => {
      const job = await request(`/api/embed/${retry.jobId}`);
      if (job.status === 'failed') throw new Error(JSON.stringify(job) + '\n' + output);
      return job.status === 'complete';
    });
    expect(accepted).toHaveLength(130);
    expect(new Set(accepted).size).toBe(130);
    expect((await loadMeta(slot))?.embeddingJob).toBeUndefined();
    const semantic = await request('/api/search?repo=repo', {
      query: 'function returns a number',
      mode: 'semantic',
      enrich: false,
    });
    expect(JSON.stringify(semantic)).toContain('alpha');
    const paidInputs = accepted.length;
    const generation = (await loadMeta(slot))?.graphGeneration;
    const cached = await request('/api/analyze', { path: repo, embeddings: true });
    await until(async () => {
      const job = await request(`/api/analyze/${cached.jobId}`);
      if (job.status === 'failed') throw new Error(JSON.stringify(job) + '\n' + output);
      return job.status === 'complete';
    });
    expect(accepted).toHaveLength(paidInputs);
    expect((await loadMeta(slot))?.graphGeneration).toEqual(generation);
  } finally {
    releaseOutage();
    try {
      if (child.connected) child.send('shutdown');
      expect(await exited, output).toBe(0);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 180_000);
