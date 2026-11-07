import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { resolveAnalysisResourceBudget } from '../../src/core/analysis-resource-budget.js';
import { loadMeta } from '../../src/storage/repo-manager.js';
import { EmbeddingGraphSource } from '../../src/core/lbug/embedding-source.js';

let root: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

it('publishes before HTTP work and resumes without parsing or repeating durable requests', async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-embedding-flow-')));
  const repo = path.join(root, 'repo');
  const slot = path.join(repo, '.gitnexus');
  await fs.mkdir(repo);
  vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
  vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  const content = Array.from(
    { length: 130 },
    (_, index) => `export function alpha${String(index).padStart(3, '0')}() { return ${index}; }`,
  ).join('\n');
  await fs.writeFile(path.join(repo, 'a.ts'), content);
  git('add', 'a.ts');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
  // Retrying pending embeddings must also reuse an unchanged dirty graph.
  await fs.writeFile(path.join(repo, 'a.ts'), `${content}\n// dirty snapshot\n`);
  const accepted: string[] = [];
  let fail = true;
  let requests = 0;
  let graphWasReady = false;
  let graphWasVisible = false;
  let dimensions = 4;
  const endpointErrors: unknown[] = [];
  server = createServer(async (request, response) => {
    try {
      requests++;
      expect(graphWasReady).toBe(true);
      expect(graphWasVisible).toBe(true);
      const published = await loadMeta(slot);
      expect(published?.graphGeneration).toBeDefined();
      expect(published?.incrementalInProgress).toBeUndefined();
      expect(published?.embeddingJob).toBeDefined();
      let body = '';
      for await (const chunk of request) body += chunk;
      const { input } = JSON.parse(body) as { input: string[] };
      if (fail && accepted.length >= 64) {
        response.writeHead(503).end('temporarily unavailable');
        return;
      }
      accepted.push(...input);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: input.map((_text, index) => ({
            index,
            embedding: Array.from({ length: dimensions }, (_, dimension) =>
              dimension === 0 ? 1 : 0,
            ),
          })),
        }),
      );
    } catch (error) {
      endpointErrors.push(error);
      response.writeHead(500).end('fixture failure');
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
  vi.stubEnv('GITNEXUS_EMBEDDING_URL', `http://127.0.0.1:${address.port}/v1`);
  vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'durable-fixture');
  vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', '4');
  vi.stubEnv('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '1');
  vi.stubEnv('GITNEXUS_EMBEDDING_SUB_BATCH_SIZE', '8');
  const resources = resolveAnalysisResourceBudget({
    effectiveMemoryBytes: 4 * 1024 ** 3,
    availableCpus: 2,
    totalMb: 2048,
    workers: 1,
    graphPoolBytes: 256 * 1024 ** 2,
    modelMemoryMb: 0,
  });
  const options = {
    graphPublication: 'inline' as const,
    resources,
    skipFts: true,
    skipAgentsMd: true,
    skipSkills: true,
    embeddings: true,
    embeddingsNodeLimit: 0,
  };
  const phases: string[] = [];
  let graphPublished!: () => void;
  const published = new Promise<void>((resolve) => {
    graphPublished = resolve;
  });
  let releasePublication!: () => void;
  const publicationHeld = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  const callbacks = {
    async onGraphPublished() {
      // A serving frontend can finish its asynchronous reader refresh first.
      graphPublished();
      await publicationHeld;
      graphWasVisible = true;
    },
    onProgress(phase: string) {
      phases.push(phase);
      if (phase === 'graph-ready') graphWasReady = true;
    },
  };
  const firstRun = runFullAnalysis(repo, options, callbacks);
  void firstRun.catch(() => {});
  await Promise.race([published, firstRun]);
  expect(requests).toBe(0);
  releasePublication();
  await expect(firstRun).rejects.toThrow(/unfinished|incomplete/);
  expect(endpointErrors).toEqual([]);
  expect(accepted).toHaveLength(64);
  const interrupted = await loadMeta(slot);
  expect(interrupted?.graphGeneration).toBeDefined();
  expect(interrupted?.embeddingJob).toBeDefined();
  const source = await EmbeddingGraphSource.open(
    path.join(slot, interrupted!.graphPath!),
    resources.embedding.graphPoolBytes,
    1,
  );
  try {
    const functions = [];
    for await (const key of source.scan('Function')) functions.push(key.id);
    expect(functions).toHaveLength(130);
  } finally {
    await source.close();
  }

  fail = false;
  // A long-lived caller honors the existing provider cooldown before retrying.
  const now = Date.now;
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 31_000);
  phases.length = 0;
  // Plain analyze resumes the pending job, without requiring --embeddings.
  await runFullAnalysis(repo, { ...options, embeddings: false }, callbacks);
  expect(endpointErrors).toEqual([]);
  expect(phases).not.toContain('extracting');
  expect(new Set(accepted).size).toBe(accepted.length);
  expect(accepted).toHaveLength(130);
  const completed = await loadMeta(slot);
  expect(completed?.graphGeneration).toEqual(interrupted?.graphGeneration);
  expect(completed?.embeddingJob).toBeUndefined();
  expect(completed?.vectorGeneration?.chunks).toBe(130);
  const count = requests;
  phases.length = 0;
  const cached = await runFullAnalysis(repo, options, callbacks);
  expect(cached.alreadyUpToDate).toBe(true);
  expect(phases).not.toContain('extracting');
  expect(await loadMeta(slot)).toEqual(completed);
  expect(requests).toBe(count);

  // A vector-space change regenerates vectors without parsing or republishing
  // the graph. Its legacy CodeEmbedding column is no longer the vector store.
  dimensions = 8;
  vi.stubEnv('GITNEXUS_EMBEDDING_DIMS', String(dimensions));
  phases.length = 0;
  await runFullAnalysis(repo, options, callbacks);
  expect(phases).not.toContain('extracting');
  const resized = await loadMeta(slot);
  expect(resized?.graphGeneration).toEqual(completed?.graphGeneration);
  expect(resized?.vectorGeneration?.dimensions).toBe(dimensions);
  expect(resized?.vectorGeneration?.identity).not.toBe(completed?.vectorGeneration?.identity);
  expect(accepted).toHaveLength(260);

  await fs.writeFile(path.join(repo, 'a.ts'), content.replace('return 0;', 'return 999;'));
  await runFullAnalysis(repo, options, callbacks);
  expect(accepted).toHaveLength(261);
  expect(accepted.at(-1)).toContain('return 999;');
  expect((await loadMeta(slot))?.graphGeneration?.id).not.toBe(completed?.graphGeneration?.id);

  // Explicit dropping retires every model space, including the earlier 4D one.
  const beforeDrop = accepted.length;
  await runFullAnalysis(repo, { ...options, embeddings: false, dropEmbeddings: true }, callbacks);
  const dropped = await loadMeta(slot);
  expect(dropped?.vectorGeneration).toBeUndefined();
  expect(dropped?.embeddingJob).toBeUndefined();
  expect(dropped?.stats?.embeddings ?? 0).toBe(0);
  expect(accepted).toHaveLength(beforeDrop);
  expect(await fs.readdir(path.join(slot, 'embeddings'))).toEqual([]);
  await runFullAnalysis(repo, options, callbacks);
  expect(accepted).toHaveLength(beforeDrop + 130);
  expect(endpointErrors).toEqual([]);
}, 120_000);
