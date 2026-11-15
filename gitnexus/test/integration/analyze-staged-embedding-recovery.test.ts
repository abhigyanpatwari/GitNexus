/**
 * Exercise a legacy native staged DB -> durable checkpoint -> SIGKILL ->
 * current CLI recovery -> graph rebuild -> publication chain. The endpoint is
 * local and deterministic; request text is the billing/reuse oracle.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliAnalysisEnv, CLI_SPAWN_PREFIX, tsxLoaderUrl } from '../helpers/cli-entry.js';

const DIMS = 8;
const NODE_COUNT = 5_128;
const DEADLINE = process.env.CI ? 180_000 : 120_000;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nativeUrl = pathToFileURL(path.join(packageRoot, 'src/core/lbug/lbug-config.ts')).href;
const analysisUrl = pathToFileURL(
  path.join(
    packageRoot,
    process.env.GITNEXUS_E2E_CLI === 'dist'
      ? 'dist/core/run-analyze.js'
      : 'src/core/run-analyze.ts',
  ),
).href;

interface CheckpointMeta {
  repoPath: string;
  stats?: { embeddings?: number };
  embeddingJob?: unknown;
  graphPath?: string;
  vectorGeneration?: { identity: string; artifactIdentity?: string };
  embeddingCheckpoint?: {
    nodesProcessed: number;
    chunksProcessed: number;
    pendingNodeIds?: string[];
    recovery?: { stagingFile: string; schemaFingerprint: string; unsafeNodeIds: string[] };
  };
}

interface Run {
  child: ChildProcess;
  output: () => string;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
}

let root: string;
let stoppedRepo: string;
let sourceAwareRepo: string;
let server: http.Server;
let endpoint: string;
let submitted: string[] = [];
let completed: string[] = [];
let durableTexts: string[] = [];
let lastOutput = '';
const activeWindowCompleted: string[] = [];
let held: string[] = [];
let stopAfterCheckpoint = false;
let currentRepo: string;
let gateResolve: (() => void) | undefined;
const running = new Set<ChildProcess>();

function readMeta(repo: string): CheckpointMeta {
  return JSON.parse(fs.readFileSync(path.join(repo, '.gitnexus', 'gitnexus.json'), 'utf8'));
}

function cliEnv(repo: string): NodeJS.ProcessEnv {
  const env = cliAnalysisEnv();
  for (const key of Object.keys(env)) {
    if (key.startsWith('GITNEXUS_EMBEDDING_') || key.startsWith('GITNEXUS_STORAGE_'))
      delete env[key];
  }
  return {
    ...env,
    GITNEXUS_HOME: path.join(root, `home-${path.basename(repo)}`),
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
    GITNEXUS_LBUG_BUFFER_POOL_SIZE: String(256 * 1024 * 1024),
    GITNEXUS_EMBEDDING_URL: endpoint,
    GITNEXUS_EMBEDDING_MODEL: 'staged-recovery-fixture',
    GITNEXUS_EMBEDDING_DIMS: String(DIMS),
    GITNEXUS_EMBEDDING_BATCH_SIZE: '5000',
    GITNEXUS_EMBEDDING_SUB_BATCH_SIZE: '64',
    GITNEXUS_EMBEDDING_MAX_ATTEMPTS: '1',
    GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT: '0',
    // SIGKILL skips process exit hooks; keep orphaned cache/export spills in
    // this suite's owned directory so afterAll can remove them as well.
    TMPDIR: path.join(root, 'tmp'),
    CI: '1',
  };
}

function runAnalyze(
  repo: string,
  flags: string[] = [],
  onOutput?: (output: string) => void,
  legacyFixture = false,
): Run {
  let output = '';
  // Generate the old checkpoint format through the retained legacy core path.
  // Every recovery below still enters through the current public CLI.
  const legacyScript = `
    const { runFullAnalysis } = await import(${JSON.stringify(analysisUrl)});
    await runFullAnalysis(${JSON.stringify(repo)}, {
      force: true, embeddings: true, skipSkills: true, skipAgentsMd: true,
      skipFts: true, workerPoolSize: 1, skipNativeCloseOnExit: true,
    }, { onProgress() {}, onLog: console.log });
    process.exit(0);
  `;
  // A file entry keeps --input-type out of the parser workers' inherited argv.
  const legacyEntry = path.join(root, 'legacy-analyze.mjs');
  if (legacyFixture) fs.writeFileSync(legacyEntry, legacyScript);
  const child = spawn(
    process.execPath,
    legacyFixture
      ? ['--import', tsxLoaderUrl(), legacyEntry]
      : [
          ...CLI_SPAWN_PREFIX,
          'analyze',
          repo,
          '--no-share',
          '--skip-skills',
          '--skip-fts',
          '--workers',
          '1',
          ...flags,
        ],
    { cwd: repo, env: cliEnv(repo), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  running.add(child);
  const timeout = setTimeout(() => child.kill('SIGKILL'), DEADLINE);
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    onOutput?.(output);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        running.delete(child);
        resolve({ code, signal, output });
      });
    },
  );
  return { child, done, output: () => output };
}

async function successfulAnalyze(repo: string, flags: string[] = []): Promise<string[]> {
  submitted = [];
  stopAfterCheckpoint = false;
  currentRepo = repo;
  const result = await runAnalyze(repo, flags).done;
  lastOutput = result.output;
  expect(result.output, `CLI exited ${result.code}, signal ${result.signal}`).not.toContain(
    'SIGABRT',
  );
  expect(result.code, result.output).toBe(0);
  return [...submitted];
}

function cloneStoppedRepo(name: string): string {
  const repo = path.join(root, name);
  fs.cpSync(stoppedRepo, repo, { recursive: true });
  for (const filename of ['gitnexus.json', 'meta.json']) {
    const target = path.join(repo, '.gitnexus', filename);
    const meta = JSON.parse(fs.readFileSync(target, 'utf8'));
    meta.repoPath = repo;
    meta.storagePath = path.join(repo, '.gitnexus');
    fs.writeFileSync(target, JSON.stringify(meta));
  }
  return repo;
}

function readPublishedRows(
  repo: string,
): Array<{ nodeId: string; chunkIndex: number; embedding: number[] }> {
  // Keep native handles out of the vitest fork, and wait for clean teardown
  // before accepting the receipt. Every read opens only a published DB.
  const receiptPath = path.join(root, `rows-${path.basename(repo)}.json`);
  const meta = readMeta(repo);
  const vector = meta.vectorGeneration;
  const database = vector
    ? path.join(
        repo,
        '.gitnexus',
        'embeddings',
        vector.artifactIdentity ?? vector.identity,
        'vectors',
      )
    : path.resolve(repo, '.gitnexus', meta.graphPath ?? 'lbug');
  const script = `
    const native = await import(${JSON.stringify(nativeUrl)});
    const { default: lbug } = await import('@ladybugdb/core');
    const fs = await import('node:fs');
    const handle = await native.openLbugConnection(lbug, ${JSON.stringify(database)}, {
      readOnly: true, bufferPoolBytes: 64 * 1024 ** 2, threads: 1,
    });
    try {
      const result = await handle.conn.query('MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.embedding AS embedding');
      const rows = await result.getAll();
      fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify(rows));
      console.log('ROWS_RECEIPT:' + rows.length);
    } finally { await native.closeLbugConnection(handle); }
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoaderUrl(), '--input-type=module', '-e', script],
    {
      cwd: packageRoot,
      env: cliEnv(repo),
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  try {
    const diagnostic =
      `${result.error ?? ''} ${result.signal ?? ''}\n${result.stderr}\n${result.stdout}`.slice(
        0,
        4096,
      );
    expect(result.status, diagnostic).toBe(0);
    expect(result.stdout).toMatch(/ROWS_RECEIPT:\d+/);
    return JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } finally {
    fs.rmSync(receiptPath, { force: true });
  }
}

function expectPublishedComplete(repo: string, expectedNodes: number): void {
  const meta = readMeta(repo);
  expect(meta.embeddingCheckpoint).toBeUndefined();
  expect(meta.embeddingJob).toBeUndefined();
  const rows = readPublishedRows(repo);
  expect(new Set(rows.map((row) => row.nodeId)).size).toBe(expectedNodes);
  expect(meta.stats?.embeddings).toBe(rows.length);
  const byNode = new Map<string, number[]>();
  for (const row of rows) {
    expect(row.embedding).toHaveLength(DIMS);
    expect(row.embedding.every(Number.isFinite)).toBe(true);
    const indices = byNode.get(row.nodeId) ?? [];
    indices.push(row.chunkIndex);
    byNode.set(row.nodeId, indices);
  }
  for (const indices of byNode.values()) {
    expect(indices.sort((a, b) => a - b)).toEqual(
      Array.from({ length: indices.length }, (_, index) => index),
    );
  }
  expect(
    fs.readdirSync(path.join(repo, '.gitnexus')).filter((name) => name.startsWith('lbug.staging.')),
  ).toEqual([]);
}

function expectLegacyReuse(texts: string[], unfinishedInputs: number): void {
  // Legacy checkpoints record the provider but not chunk size/overlap. The
  // complete single-chunk groups are provably reusable; the long group's
  // historical input boundaries cannot be certified and must be explained.
  const unverified = durableTexts.filter((text) => text.includes('longRecoverable'));
  const reusable = new Set(durableTexts.filter((text) => !text.includes('longRecoverable')));
  expect(texts.filter((text) => reusable.has(text))).toEqual([]);
  expect(unverified.length).toBeGreaterThan(1);
  for (const text of unverified) expect(texts).toContain(text);
  expect(texts).toHaveLength(unfinishedInputs + unverified.length);
  expect(lastOutput).toContain('Legacy multi-chunk input provenance is unknown');
}

function removeLegacyInputProvenance(repo: string): void {
  const stagingFile = readMeta(repo).embeddingCheckpoint?.recovery?.stagingFile;
  if (!stagingFile) throw new Error('fixture has no retained generation');
  // The retained core path now writes source-aware hashes. Downgrade only the
  // long group's input digest to exercise checkpoints predating that receipt.
  const script = `
    const native = await import(${JSON.stringify(nativeUrl)});
    const { default: lbug } = await import('@ladybugdb/core');
    const handle = await native.openLbugConnection(lbug, ${JSON.stringify(path.join(repo, '.gitnexus', stagingFile))}, {
      bufferPoolBytes: 64 * 1024 ** 2, threads: 1,
    });
    try {
      const nodeId = 'Function:functions.ts:longRecoverable';
      const query = await handle.conn.prepare('MATCH (e:CodeEmbedding {nodeId: $nodeId}) RETURN e.contentHash AS contentHash');
      const result = await handle.conn.execute(query, { nodeId });
      const rows = await result.getAll();
      result.close();
      const hash = rows[0]?.contentHash;
      if (rows.length < 2 || !/^[a-f0-9]{40}:[a-f0-9]{40}$/.test(hash) || rows.some(row => row.contentHash !== hash))
        throw new Error('Expected a complete source-aware multi-chunk fixture');
      const update = await handle.conn.prepare('MATCH (e:CodeEmbedding {nodeId: $nodeId}) SET e.contentHash = $contentHash');
      (await handle.conn.execute(update, { nodeId, contentHash: hash.slice(0, 40) })).close();
      console.log('LEGACY_INPUT_PROVENANCE_REMOVED');
    } finally { await native.closeLbugConnection(handle); }
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', tsxLoaderUrl(), '--input-type=module', '-e', script],
    { cwd: packageRoot, env: cliEnv(repo), encoding: 'utf8', timeout: 30_000 },
  );
  expect(result.status, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`).toBe(0);
  expect(result.stdout).toContain('LEGACY_INPUT_PROVENANCE_REMOVED');
}

beforeAll(async () => {
  if (process.platform === 'win32') return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-staged-recovery-e2e-'));
  fs.mkdirSync(path.join(root, 'tmp'));
  stoppedRepo = path.join(root, 'interrupted');
  currentRepo = stoppedRepo;
  fs.mkdirSync(stoppedRepo);
  const shortFunctions = Array.from(
    { length: NODE_COUNT - 1 },
    (_, index) => `export function recoverable${index}() { return ${index}; }`,
  );
  // Missing legacy input provenance must invalidate the whole multi-chunk
  // group, while retaining every provably compatible single-chunk group.
  const longFunction = `export function longRecoverable() {\n${Array.from({ length: 80 }, (_, index) => `  // retained chunk marker ${index} ${'x'.repeat(80)}`).join('\n')}\n  return 42;\n}`;
  fs.writeFileSync(
    path.join(stoppedRepo, 'functions.ts'),
    `${longFunction}\n${shortFunctions.join('\n')}\n`,
  );
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
  };
  for (const args of [['init'], ['add', 'functions.ts'], ['commit', '-m', 'recovery fixture']]) {
    const result = spawnSync('git', args, { cwd: stoppedRepo, env: gitEnv, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const { input } = JSON.parse(body) as { input: string[] };
      submitted.push(...input);
      if (
        stopAfterCheckpoint &&
        (readMeta(currentRepo).embeddingCheckpoint?.nodesProcessed ?? 0) >= 5000
      ) {
        if (activeWindowCompleted.length > 0) {
          held = [...input];
          gateResolve?.();
          // One sub-batch has already inserted rows inside the unsafe window.
          // Awaiting the next real request gates a crash before it completes.
          return;
        }
        durableTexts = [...completed];
        activeWindowCompleted.push(...input);
      }
      completed.push(...input);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: input.map((text, index) => ({
            index,
            embedding: Array.from(
              { length: DIMS },
              (_, dimension) => ((text.length + dimension * 17) % 101) / 101,
            ),
          })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  endpoint = `http://127.0.0.1:${address.port}/v1`;
  await successfulAnalyze(stoppedRepo, ['--index-only']);
  expect(readMeta(stoppedRepo).stats?.embeddings ?? 0).toBe(0);
  completed = [];
  held = [];
  stopAfterCheckpoint = true;
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve;
  });
  const first = runAnalyze(stoppedRepo, [], undefined, true);
  await Promise.race([
    gate,
    first.done.then((result) => {
      throw new Error(`CLI exited before recovery gate: ${result.output}`);
    }),
  ]);
  first.child.kill('SIGKILL');
  expect((await first.done).signal).toBe('SIGKILL');
  const interrupted = readMeta(stoppedRepo);
  expect(interrupted.embeddingCheckpoint?.nodesProcessed).toBe(5000);
  expect(interrupted.embeddingCheckpoint?.recovery?.stagingFile).toMatch(/^lbug\.staging\./);
  expect(interrupted.stats?.embeddings ?? 0).toBe(0);
  expect(completed.length).toBeGreaterThanOrEqual(5000);
  expect(completed.filter((text) => text.includes('longRecoverable')).length).toBeGreaterThan(1);
  expect(activeWindowCompleted).toHaveLength(64);
  expect(held.length).toBeGreaterThan(0);
  sourceAwareRepo = cloneStoppedRepo('source-aware');
  removeLegacyInputProvenance(stoppedRepo);
  gateResolve = undefined;
  stopAfterCheckpoint = false;
}, DEADLINE * 2);

afterAll(async () => {
  for (const child of running) child.kill('SIGKILL');
  await Promise.all(
    [...running].map(
      (child) => new Promise<void>((resolve) => child.once('close', () => resolve())),
    ),
  );
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// Atomic publication is POSIX-specific; Windows uses the in-place path.
describe.skipIf(process.platform === 'win32')(
  'interrupted staged embedding recovery (real CLI and native DB)',
  { concurrent: false },
  () => {
    it(
      'reuses verified source-aware multi-chunk groups without repeat provider work',
      async () => {
        const texts = await successfulAnalyze(sourceAwareRepo);
        expect(texts.filter((text) => durableTexts.includes(text))).toEqual([]);
        expect(texts).toHaveLength(128);
        for (const text of held) expect(texts).toContain(text);
        for (const text of activeWindowCompleted) expect(texts).toContain(text);
        expectPublishedComplete(sourceAwareRepo, NODE_COUNT);
      },
      DEADLINE,
    );

    it.each([
      ['plain', []],
      ['forced', ['--force', '--embeddings']],
    ] as const)(
      '%s retry reuses verified groups and explains unverified legacy input',
      async (name, flags) => {
        const repo = cloneStoppedRepo(name);
        const texts = await successfulAnalyze(repo, [...flags]);
        expectLegacyReuse(texts, 128);
        for (const text of held) expect(texts).toContain(text);
        for (const text of activeWindowCompleted) expect(texts).toContain(text);
        expectPublishedComplete(repo, NODE_COUNT);
      },
      DEADLINE,
    );

    it(
      'manual checkpoint opt-out retains verified staged groups',
      async () => {
        const repo = cloneStoppedRepo('manual-checkpoint-opt-out');
        const previous = process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
        process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = '0';
        try {
          const texts = await successfulAnalyze(repo, ['--force', '--embeddings']);
          expectLegacyReuse(texts, 128);
          expectPublishedComplete(repo, NODE_COUNT);
        } finally {
          if (previous === undefined) delete process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT;
          else process.env.GITNEXUS_WAL_MANUAL_CHECKPOINT = previous;
        }
      },
      DEADLINE,
    );

    it(
      'survives another crash after harvesting but before the replacement is durable',
      async () => {
        const repo = cloneStoppedRepo('crash-again');
        const source = readMeta(repo).embeddingCheckpoint?.recovery?.stagingFile;
        expect(source).toBeDefined();
        if (!source) throw new Error('fixture has no retained generation');
        submitted = [];
        currentRepo = repo;
        let killed = false;
        const retry = runAnalyze(repo, [], (output) => {
          if (!killed && /Recovered \d+ complete staged embedding chunk/.test(output)) {
            killed = true;
            retry.child.kill('SIGKILL');
          }
        });
        const result = await retry.done;
        expect(killed, result.output).toBe(true);
        expect(result.signal).toBe('SIGKILL');
        expect(submitted).toEqual([]);
        expect(readMeta(repo).embeddingCheckpoint?.recovery?.stagingFile).toBe(source);
        expect(fs.existsSync(path.join(repo, '.gitnexus', source))).toBe(true);
        const finalTexts = await successfulAnalyze(repo);
        expectLegacyReuse(finalTexts, 128);
        expectPublishedComplete(repo, NODE_COUNT);
      },
      DEADLINE * 2,
    );

    it(
      'regenerates changed content and removes deleted nodes while reusing the other complete groups',
      async () => {
        const repo = cloneStoppedRepo('changed');
        const source = path.join(repo, 'functions.ts');
        const content = fs
          .readFileSync(source, 'utf8')
          .replace(
            'export function recoverable5() { return 5; }',
            'export function recoverable5() { return 999999; }',
          )
          .replace(
            'export function recoverable6() { return 6; }',
            '// deleted function retains line offsets',
          );
        fs.writeFileSync(source, content);
        const texts = await successfulAnalyze(repo);
        expect(texts.some((text) => text.includes('recoverable5') && text.includes('999999'))).toBe(
          true,
        );
        expect(texts.some((text) => text.includes('recoverable6'))).toBe(false);
        expectLegacyReuse(texts, 129);
        expectPublishedComplete(repo, NODE_COUNT - 1);
      },
      DEADLINE,
    );

    it(
      'a forced retry with a different model does not import the staged cache',
      async () => {
        const repo = cloneStoppedRepo('different-model');
        const texts = await successfulAnalyze(repo, [
          '--force',
          '--embeddings',
          '--embedding-model',
          'different-model',
        ]);
        for (const text of durableTexts) expect(texts).toContain(text);
        expect(texts.length).toBeGreaterThanOrEqual(NODE_COUNT);
        expectPublishedComplete(repo, NODE_COUNT);
      },
      DEADLINE,
    );

    it(
      'explicit drop abandons staged vectors without contacting the provider',
      async () => {
        const repo = cloneStoppedRepo('drop');
        expect(await successfulAnalyze(repo, ['--force', '--drop-embeddings'])).toEqual([]);
        expect(readMeta(repo).embeddingCheckpoint).toBeUndefined();
        expect(readMeta(repo).stats?.embeddings ?? 0).toBe(0);
        expect(readPublishedRows(repo)).toEqual([]);
      },
      DEADLINE,
    );
  },
);
