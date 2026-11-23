/** Small worker fixture using the production file-result codec and flush protocol. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function writeFileResultWorker(
  workerPath: string,
  markerPath: string,
  options: { uncacheablePaths?: string[]; scopeFailures?: string[]; crashPaths?: string[] } = {},
): void {
  const codec = pathToFileURL(path.resolve('dist/storage/file-result-codec.js')).href;
  fs.writeFileSync(
    workerPath,
    `
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
const options = ${JSON.stringify(options)};
const empty = () => ({ nodes: [], relationships: [], symbols: [], calls: [], assignments: [], routes: [], fetchCalls: [], fetchWrapperDefs: [], decoratorRoutes: [], routerIncludes: [], routerImports: [], toolDefs: [], ormQueries: [], constructorBindings: [], fileScopeBindings: [], parsedFiles: [], skippedLanguages: {}, scopeExtractionFailures: [], fileCount: 0 });
import(${JSON.stringify(codec)}).then(({ encodeFileResultSection }) => {
  fs.writeFileSync(${JSON.stringify(markerPath)}, 'spawned');
  let accumulated = empty();
  parentPort.on('message', msg => {
    if (msg.type === 'sub-batch') {
      for (const file of msg.files) {
        parentPort.postMessage({ type: 'starting-file', path: file.path });
        if (options.crashPaths?.includes(file.path)) process.exit(134);
        const result = empty();
        const name = file.path.split('/').pop().replace(/\\.\\w+$/, '');
        result.nodes.push({ id: 'Function:' + file.path + ':' + name, label: 'Function', properties: { name, filePath: file.path, startLine: 1, endLine: 1, language: 'typescript' } });
        result.parsedFiles.push({ filePath: file.path, moduleScope: '', scopes: [], parsedImports: [], localDefs: [], referenceSites: [] });
        if (options.scopeFailures?.includes(file.path)) result.scopeExtractionFailures.push(file.path);
        result.fileCount = 1;
        const facts = encodeFileResultSection(file.cacheKey, file.path, 'facts', { ...result, parsedFiles: [] });
        const scopes = encodeFileResultSection(file.cacheKey, file.path, 'scopes', result.parsedFiles);
        const entry = { key: file.cacheKey, path: file.path };
        (accumulated.fileResults ??= []).push(facts && scopes
          ? { ...entry, encoded: { ...entry, facts, scopes, cacheable: !options.uncacheablePaths?.includes(file.path) && !result.scopeExtractionFailures.length } }
          : { ...entry, raw: result });
        accumulated.scopeExtractionFailures.push(...result.scopeExtractionFailures);
        accumulated.fileCount++;
      }
      parentPort.postMessage({ type: 'progress', filesProcessed: accumulated.fileCount });
      parentPort.postMessage({ type: 'sub-batch-done' });
    }
    if (msg.type === 'flush') { parentPort.postMessage({ type: 'result', data: accumulated }); accumulated = empty(); }
  });
  parentPort.postMessage({ type: 'ready' });
});
`,
  );
}
