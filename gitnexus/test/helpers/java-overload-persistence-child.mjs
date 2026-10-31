// Each invocation is a fresh process: no resolver maps or parsed-file objects
// survive between the writer, durable-cache replay, and backend reader.
const request = JSON.parse(process.argv[2]);
const root = new URL('../../dist/', import.meta.url);
const load = (name) => import(new URL(`${name}.js`, root).href);
let receipt;
if (request.action === 'analyze') {
  const { runFullAnalysis } = await load('core/run-analyze');
  const { getStoragePaths, loadMeta } = await load('storage/repo-manager');
  const logs = [];
  const result = await runFullAnalysis(
    request.repo,
    {
      force: true,
      skipAgentsMd: true,
      skipSkills: true,
      skipFts: true,
      workerPoolSize: 1,
    },
    { onLog: (message) => logs.push(message), onProgress: () => {} },
  );
  const paths = getStoragePaths(request.repo);
  receipt = {
    usedWorkerPool: result.pipelineResult?.usedWorkerPool,
    reparsed: result.pipelineResult?.reparsedFileCount,
    hits: result.pipelineResult?.parseCacheHitFileCount,
    storagePath: paths.storagePath,
    meta: await loadMeta(paths.storagePath),
    logs,
  };
} else if (request.action === 'inspect') {
  const { LocalBackend } = await load('mcp/local/local-backend');
  const backend = new LocalBackend();
  try {
    await backend.init();
    receipt = {};
    for (const uid of request.targets) {
      receipt[uid] = await backend.callTool('impact', {
        target_uid: uid,
        repo: request.repo,
        direction: 'upstream',
        maxDepth: 1,
        includeTests: true,
      });
    }
  } finally {
    await backend.dispose();
  }
} else {
  throw new Error(`Unknown persistence action: ${request.action}`);
}
console.log('JAVA_OVERLOAD_RESULT=' + JSON.stringify(receipt));
