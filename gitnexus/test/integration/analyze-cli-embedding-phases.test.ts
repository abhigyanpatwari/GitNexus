import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { execFileSync, fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadMeta } from '../../src/storage/repo-manager.js';
import { createAutoSyncAnalysisRunner } from '../../src/core/auto-sync/analysis-worker-launch.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';

it.each(['CLI', 'CLI pinned heap', 'auto-sync', 'embeddings sync'] as const)(
  '%s publishes after writer exit and resumes only unfinished HTTP embeddings',
  async (frontend) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-cli-phases-')));
    const repo = path.join(root, 'repo');
    const slot = path.join(repo, '.gitnexus');
    await fs.mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    const content = Array.from(
      { length: 130 },
      (_, i) => `export function alpha${String(i).padStart(3, '0')}() { return ${i}; }`,
    ).join('\n');
    await fs.writeFile(path.join(repo, 'a.ts'), content);
    git('add', 'a.ts');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
    let fail = true;
    const accepted: string[] = [];
    const observations: unknown[] = [];
    const errors: unknown[] = [];
    const server = createServer(async (request, response) => {
      try {
        const meta = await loadMeta(slot);
        expect(meta?.graphGeneration).toBeDefined();
        expect(meta?.incrementalInProgress).toBeUndefined();
        expect(meta?.embeddingJob).toBeDefined();
        await expect(fs.stat(path.join(slot, 'analysis-publication.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        observations.push(meta?.graphGeneration?.id);
        let body = '';
        for await (const chunk of request) body += chunk;
        const input: string[] = JSON.parse(body).input;
        if (fail && accepted.length >= 64) {
          response.writeHead(503).end('outage');
          return;
        }
        accepted.push(...input);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0] })),
          }),
        );
      } catch (error) {
        errors.push(error);
        response.writeHead(500).end('fixture failure');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const env = {
      ...process.env,
      // This fixture exercises automatic process-family admission and respawning.
      GITNEXUS_MEMORY: '',
      GITNEXUS_HOME: path.join(root, 'home'),
      GITNEXUS_SHARED_STORE: 'off',
      GITNEXUS_EMBEDDING_URL: `http://127.0.0.1:${address.port}/v1`,
      GITNEXUS_EMBEDDING_MODEL: 'cli-phase-fixture',
      GITNEXUS_EMBEDDING_DIMS: '4',
      GITNEXUS_EMBEDDING_MAX_ATTEMPTS: '1',
      GITNEXUS_EMBEDDING_SUB_BATCH_SIZE: '8',
    };
    const runCli = (embeddings: boolean, sync = false) =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            ...(sync ? ['--max-old-space-size=1024'] : []),
            ...(frontend === 'CLI pinned heap' && !sync
              ? ['--max-old-space-size=512', '--max-semi-space-size=16']
              : []),
            fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url)),
            ...(sync
              ? ['embeddings', 'sync', repo]
              : [
                  'analyze',
                  repo,
                  '--index-only',
                  '--skip-fts',
                  '--workers',
                  '1',
                  '--resource-budget',
                  '2048',
                  ...(embeddings ? ['--embeddings', '0'] : []),
                ]),
          ],
          { env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '';
        const collect = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-32_768);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, output }));
      });
    const runWorker = async (embeddings: boolean) => {
      const run = createAutoSyncAnalysisRunner({
        forkWorker: (_workerPath, execArgv) =>
          fork(fileURLToPath(new URL('../../dist/server/analyze-worker.js', import.meta.url)), [], {
            execArgv,
            env,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          }),
      });
      try {
        await run(
          repo,
          {
            embeddings,
            embeddingsNodeLimit: 0,
            skipFts: true,
            skipAgentsMd: true,
            skipSkills: true,
            workerPoolSize: 1,
            resources: resolveAnalysisResourceBudget({
              effectiveMemoryBytes: 2048 * 1024 ** 2,
              totalMb: 2048,
              availableCpus: 2,
              workers: 1,
              modelMemoryMb: 0,
            }),
          },
          120_000,
        );
        return { code: 0, output: '' };
      } catch (error) {
        return { code: 1, output: (error as Error).message };
      }
    };
    const run = frontend === 'auto-sync' ? runWorker : runCli;
    const resume = frontend === 'embeddings sync' ? () => runCli(false, true) : run;
    try {
      const first = await run(true);
      expect(first.code, first.output).toBe(1);
      expect(errors).toEqual([]);
      expect(accepted, first.output).toHaveLength(64);
      expect(first.output).not.toContain('Repository indexed successfully');
      const graph = await loadMeta(slot);
      expect(graph?.embeddingJob).toBeDefined();
      if (!graph?.graphPath) throw new Error('Expected owned graph');
      const inode = (await fs.stat(path.join(slot, graph.graphPath))).ino;
      fail = false;
      const retry = await resume(false);
      expect(retry.code, retry.output).toBe(0);
      if (frontend === 'CLI')
        expect(retry.output.match(/Repository indexed successfully/g)).toHaveLength(1);
      expect(accepted).toHaveLength(130);
      expect(new Set(accepted).size).toBe(130);
      expect(new Set(observations)).toEqual(new Set([graph.graphGeneration?.id]));
      expect((await loadMeta(slot))?.embeddingJob).toBeUndefined();
      const repeat = await resume(true);
      expect(repeat.code, repeat.output).toBe(0);
      expect(accepted).toHaveLength(130);
      await fs.writeFile(path.join(repo, 'a.ts'), content.replace('return 0;', 'return 999;'));
      const changed = await run(true);
      expect(changed.code, changed.output).toBe(0);
      expect(accepted).toHaveLength(131);
      const updated = await loadMeta(slot);
      expect(updated?.graphGeneration?.id).not.toBe(graph.graphGeneration?.id);
      expect(updated?.graphPath).toBe(graph.graphPath);
      expect((await fs.stat(path.join(slot, graph.graphPath))).ino).toBe(inode);
      expect(errors).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
