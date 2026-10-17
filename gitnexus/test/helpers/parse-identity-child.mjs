import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.join(request.runtime, request.source ? 'src' : 'dist');
const extension = request.source ? 'ts' : 'js';
const load = (name) => import(pathToFileURL(path.join(root, `${name}.${extension}`)).href);
const { runFullAnalysis } = await load('core/run-analyze');
const { getStoragePaths, loadMeta } = await load('storage/repo-manager');
const { resolveSharedStore } = await load('storage/shared-store');
let paths = getStoragePaths(request.repo);
const logs = [];
let mutated = false;
try {
  const result = await runFullAnalysis(
    request.repo,
    { skipAgentsMd: true, skipSkills: true, skipFts: true, workerPoolSize: 1, ...request.options },
    {
      onLog: (message) => logs.push(message),
      onProgress: (phase) => {
        if (mutated || phase !== 'lbug') return;
        mutated = true;
        if (request.barrier) {
          const layout = resolveSharedStore(request.repo);
          const storagePath = layout?.checkoutSlot ?? paths.storagePath;
          const cacheRoot = layout?.cachesDir ?? storagePath;
          const stagingPaths = [...new Set([storagePath, cacheRoot])].flatMap((root) =>
            (fs.existsSync(root) ? fs.readdirSync(root) : [])
              .filter((name) => name.startsWith('parse-rebuild'))
              .map((name) => path.join(root, name)),
          );
          fs.writeFileSync(
            `${request.barrier}.ready`,
            JSON.stringify({ storagePath, cacheRoot, stagingPaths }),
          );
          if (request.interruptAfterParse) {
            // Deliberate process exit at a JS-visible safe point bypasses the
            // orchestrator's finally, like an interrupted analysis.
            console.log(
              'PARSE_IDENTITY_RESULT=' +
                JSON.stringify({ interrupted: true, storagePath, meta: null, logs }),
            );
            process.exit(0);
          }
          const deadline = Date.now() + 120_000;
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(`${request.barrier}.release`)) {
            if (Date.now() > deadline) throw new Error('Analysis barrier timed out');
            Atomics.wait(wait, 0, 0, 20);
          }
        }
        if (request.mutate) fs.appendFileSync(request.mutate, '\n// changed during analysis\n');
        if (request.failCacheSave) {
          const index = path.join(paths.storagePath, 'parsedfile-cache/index.json');
          fs.rmSync(index, { force: true });
          fs.mkdirSync(index, { recursive: true });
        }
      },
    },
  );
  paths = getStoragePaths(request.repo);
  const adapter = await load('core/lbug/lbug-adapter');
  await adapter.initLbug(paths.lbugPath);
  let facts;
  try {
    facts = await adapter.executeQuery(
      "MATCH (n) WHERE n.name = 'parserProbe' RETURN label(n) AS kind, n.name AS name ORDER BY kind",
    );
  } finally {
    await adapter.closeLbug();
  }
  console.log(
    'PARSE_IDENTITY_RESULT=' +
      JSON.stringify({
        alreadyUpToDate: result.alreadyUpToDate === true,
        rebuildReasons: result.rebuildReasons,
        reparsed: result.pipelineResult?.reparsedFileCount,
        hits: result.pipelineResult?.parseCacheHitFileCount,
        meta: await loadMeta(paths.storagePath),
        storagePath: paths.storagePath,
        facts,
        logs,
      }),
  );
} catch (error) {
  console.log(
    'PARSE_IDENTITY_RESULT=' +
      JSON.stringify({
        error: String(error),
        meta: await loadMeta(paths.storagePath),
        storagePath: paths.storagePath,
        logs,
      }),
  );
}
