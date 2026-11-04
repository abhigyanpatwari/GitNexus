import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each([
  ['directory', 'ENOENT'],
  ['fixture-write', 'fixture write failed'],
  ['init', 'init failed'],
  ['sample', 'sample failed'],
  ['dispose', 'dispose failed'],
])('cleans up after benchmark %s failure', async (failure, message) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitnexus-bench-cleanup-'));
  temporaryRoots.push(root);
  const repo = path.join(root, 'repo');
  const modules = path.join(repo, 'gitnexus/dist/core/embeddings');
  const scratch = path.join(root, 'scratch');
  const events = path.join(root, 'events');
  await mkdir(modules, { recursive: true });
  await mkdir(scratch);
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const name of [
    'text-generator',
    'structural-extractor',
    'embedding-pipeline',
    'exact-search',
    'ast-utils',
  ])
    await writeFile(path.join(modules, `${name}.js`), 'export {};');
  await writeFile(
    path.join(modules, 'chunker.js'),
    'export function chunkNode() { throw new Error("sample failed"); }',
  );
  await writeFile(
    path.join(modules, 'embedder.js'),
    `
    import { appendFile } from 'node:fs/promises';
    export async function initEmbedder() {
      await appendFile(${JSON.stringify(events)}, 'init\\n');
      if (process.env.BENCH_CLEANUP_CASE === 'init') throw new Error('init failed');
    }
    export async function disposeEmbedder() {
      await appendFile(${JSON.stringify(events)}, 'dispose\\n');
      if (process.env.BENCH_CLEANUP_CASE === 'dispose') throw new Error('dispose failed');
    }
  `,
  );
  const preload = path.join(root, 'preload.mjs');
  await writeFile(
    preload,
    `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const writeFile = fs.writeFile;
    fs.writeFile = async (file, ...args) => {
      if (process.env.BENCH_CLEANUP_CASE === 'fixture-write' && String(file).endsWith('flat.ts'))
        throw new Error('fixture write failed');
      return writeFile(file, ...args);
    };
    syncBuiltinESMExports();
  `,
  );
  const scratchEnv = failure === 'directory' ? path.join(scratch, 'missing') : scratch;
  await expect(
    promisify(execFile)(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        fileURLToPath(new URL('../../bench/embedding-chunking/measure.mjs', import.meta.url)),
        repo,
        repo,
        path.join(root, 'result.json'),
        '--source',
      ],
      {
        env: {
          ...process.env,
          BENCH_CLEANUP_CASE: failure,
          TMPDIR: scratchEnv,
          TMP: scratchEnv,
          TEMP: scratchEnv,
        },
      },
    ),
  ).rejects.toThrow(message);
  expect((await readFile(events, 'utf8').catch(() => '')).trim().split('\n')).toEqual(
    ['directory', 'fixture-write'].includes(failure) ? ['dispose'] : ['init', 'dispose'],
  );
  expect(await readdir(scratch)).toEqual([]);
});
