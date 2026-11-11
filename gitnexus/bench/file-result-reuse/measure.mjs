/** Run from gitnexus/: node bench/file-result-reuse/measure.mjs [--dist DIR] [--corpus DIR]
 * Each invocation is one isolated trial (cold -> warm -> edit -> two edits -> repack).
 * Compare at least three invocations for baseline/candidate on the same machine.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { sourceDigest } from './provenance.mjs';
import { graphDigests } from './graph-digests.mjs';
const { values } = parseArgs({
  options: {
    dist: { type: 'string' },
    corpus: { type: 'string' },
    files: { type: 'string' },
    workers: { type: 'string' },
    'baseline-dist': { type: 'string' },
    pairs: { type: 'string' },
    output: { type: 'string' },
    check: { type: 'boolean' },
  },
});
if (values['baseline-dist']) {
  const { compareRuntimes } = await import('./compare.mjs');
  await compareRuntimes(values);
} else {
  if (values.check || values.pairs || values.output)
    throw new Error('Comparison requires --baseline-dist');
  await measure();
}

async function measure() {
  const args = new Map(Object.entries(values).map(([key, value]) => ['--' + key, value]));
  const dist = path.resolve(args.get('--dist') ?? 'dist');
  const { runPipelineFromRepo } = await import(
    pathToFileURL(path.join(dist, 'core/ingestion/pipeline.js'))
  );
  const { emptyParseCache, loadParseCache, saveParseCache } = await import(
    pathToFileURL(path.join(dist, 'storage/parse-cache.js'))
  );
  const { mergeStagedDurableParsedFileStore } = await import(
    pathToFileURL(path.join(dist, 'storage/parsedfile-store.js'))
  );
  const count = Number(args.get('--files') ?? 1024),
    workers = Number(args.get('--workers') ?? 2);
  if (![count, workers].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error('Invalid files/workers');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-file-reuse-bench-'));
  const repo = path.join(root, 'repo'),
    live = path.join(root, 'live');
  const identity = {
    base: 'file-result-reuse-benchmark-v1',
    pdg: 'file-result-reuse-benchmark-pdg-v1',
  };
  async function treeDigest(directory) {
    const hash = createHash('sha256');
    const files = (await fs.readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
      .sort();
    for (const relative of files) {
      const file = path.join(directory, relative);
      const handle = await fs.open(file, 'r');
      try {
        if (!(await handle.stat()).isFile()) continue;
        const bytes = await handle.readFile();
        hash.update(JSON.stringify([relative, bytes.length])).update(bytes);
      } finally {
        await handle.close();
      }
    }
    return hash.digest('hex');
  }
  const runtimeHead = (() => {
    try {
      return execFileSync('git', ['-C', path.dirname(dist), 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  })();
  try {
    await fs.mkdir(repo);
    const corpus = args.get('--corpus');
    if (corpus)
      await fs.cp(path.resolve(corpus), repo, {
        recursive: true,
        filter: (source) =>
          !['node_modules', '.git', '.gitnexus', 'dist'].includes(path.basename(source)),
      });
    else
      for (let i = 0; i < count; i++) {
        const name = `file${String(i).padStart(4, '0')}.ts`;
        const previous = `file${String(i - 1).padStart(4, '0')}`;
        await fs.writeFile(
          path.join(repo, name),
          (i ? `import { entry as prev } from './${previous}';\n` : '') +
            `export function entry(value: number): number { return ${i ? 'prev(value)' : 'value'} + ${i}; }\n` +
            Array.from(
              { length: 20 },
              (_, j) =>
                `export function helper${j}(value: number): number { return entry(value) + ${j}; }\n`,
            ).join(''),
        );
      }
    const sources = (await fs.readdir(repo, { recursive: true }))
      .filter((f) => /\.tsx?$/.test(f))
      .sort();
    console.log(
      JSON.stringify({
        kind: 'provenance',
        sourceDigest: await sourceDigest(repo, sources),
        sourceFiles: sources.length,
        node: process.version,
        workers,
        dist,
        cliDigest: createHash('sha256')
          .update(await fs.readFile(path.join(dist, 'cli/index.js')))
          .digest('hex'),
        buildDigest: await treeDigest(dist),
        driverDigest: createHash('sha256')
          .update(await fs.readFile(new URL(import.meta.url)))
          .update(await fs.readFile(new URL('./provenance.mjs', import.meta.url)))
          .update(await fs.readFile(new URL('./graph-digests.mjs', import.meta.url)))
          .digest('hex'),
        checkoutHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        runtimeHead,
        platform: process.platform,
        arch: process.arch,
      }),
    );
    for (const kind of ['cold', 'warm', 'edit', 'two-edits', 'repack']) {
      if (kind === 'edit' || kind === 'two-edits') {
        for (const file of sources.slice(0, kind === 'edit' ? 1 : 2)) {
          await fs.appendFile(
            path.join(repo, file),
            `\nexport function benchmarkAdded${kind === 'edit' ? 'One' : 'Two'}(value: number) { return value; }\n`,
          );
        }
      }
      const stage = path.join(root, kind);
      const cache =
        kind === 'cold'
          ? emptyParseCache(identity, { storagePath: live, writeStoragePath: stage })
          : await loadParseCache(live, identity, stage);
      const start = performance.now();
      const run = await runPipelineFromRepo(repo, () => {}, {
        workerPoolSize: workers,
        parseWorkerUrl: pathToFileURL(path.join(dist, 'core/ingestion/workers/parse-worker.js')),
        parseCache: cache,
        ...(kind === 'repack' ? { chunkByteBudget: 4096 } : {}),
      });
      const pipelineMs = performance.now() - start;
      const kept = await saveParseCache(live, cache);
      await mergeStagedDurableParsedFileStore(
        live,
        stage,
        identity.base,
        new Set(cache.fileResults ? [] : kept),
      );
      const withSaveMs = performance.now() - start;
      const fingerprints = graphDigests(run.graph);
      let cacheBytes = 0,
        cacheFiles = 0;
      for (const file of await fs.readdir(live, { recursive: true })) {
        const stat = await fs.stat(path.join(live, file));
        if (stat.isFile()) {
          cacheBytes += stat.size;
          cacheFiles++;
        }
      }
      console.log(
        JSON.stringify({
          kind,
          pipelineMs,
          withSaveMs,
          cacheBytes,
          cacheFiles,
          cacheFormat: cache.fileResults ? 'per-file' : 'chunk',
          peakRssKb: process.resourceUsage().maxRSS,
          reparsed: run.reparsedFileCount,
          hits: run.parseCacheHitFileCount,
          workersStarted: run.usedWorkerPool,
          ...fingerprints,
        }),
      );
      await fs.rm(stage, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
