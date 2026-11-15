import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Select the parse worker without evaluating it or loading native bindings. */
export function resolveParseWorkerUrl(parseImplModuleUrl: string, workerUrlForTest?: URL): URL {
  if (workerUrlForTest) return workerUrlForTest;
  const adjacentWorker = new URL('../workers/parse-worker.js', parseImplModuleUrl);
  if (existsSync(fileURLToPath(adjacentWorker))) return adjacentWorker;

  // Source execution uses the compiled worker because worker threads cannot
  // inherit the source transform used by Vitest/the parent entry point.
  const distWorker = path.resolve(
    fileURLToPath(new URL('.', parseImplModuleUrl)),
    '../../../../dist/core/ingestion/workers/parse-worker.js',
  );
  return existsSync(distWorker) ? pathToFileURL(distWorker) : adjacentWorker;
}
