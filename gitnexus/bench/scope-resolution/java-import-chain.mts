/**
 * Reproduce #3695's Java return-type amplification with real worker parsing.
 * From gitnexus/: npm run build, then
 * node --max-old-space-size=512 --import tsx bench/scope-resolution/java-import-chain.mts
 * Optional positional arguments: file count (1000), methods per file (20).
 */
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { parseFilesWithWorkers } from '../../test/helpers/worker-parse.js';
import { javaScopeResolver } from '../../src/core/ingestion/languages/java/scope-resolver.js';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.js';

const fileCount = Number(process.argv[2] ?? 1000);
const methodsPerFile = Number(process.argv[3] ?? 20);
if (![fileCount, methodsPerFile].every((n) => Number.isSafeInteger(n) && n > 0)) {
  throw new Error('File and method counts must be positive integers');
}

const files = Array.from({ length: fileCount }, (_, i) => ({
  path: `src/p${i}/C${i}.java`,
  content: `package p${i};
${i > 0 ? `import p${i - 1}.C${i - 1};` : ''}
public class C${i} {
${Array.from(
  { length: methodsPerFile },
  (_, j) => `public C${i} make${i}_${j}() { return this; }`,
).join('\n')}
}`,
}));

javaScopeResolver.loadResolutionConfig?.('');
const { graph, model, data } = await parseFilesWithWorkers(files);
const heapAfterParse = process.memoryUsage().heapUsed;
let moduleTypeBindings = 0;
const started = performance.now();
runScopeResolution(
  {
    graph,
    model,
    files,
    preExtractedParsedFiles: new Map(data.parsedFiles.map((parsed) => [parsed.filePath, parsed])),
    onResolved: ({ parsedFiles }) => {
      for (const parsed of parsedFiles) {
        moduleTypeBindings +=
          parsed.scopes.find((scope) => scope.id === parsed.moduleScope)?.typeBindings.size ?? 0;
      }
    },
  },
  javaScopeResolver,
);
console.log(
  JSON.stringify({
    fileCount,
    methodsPerFile,
    moduleTypeBindings,
    resolveMs: Math.round(performance.now() - started),
    heapLimit: getHeapStatistics().heap_size_limit,
    heapAfterParse,
    heapAfterResolve: process.memoryUsage().heapUsed,
    nodes: graph.nodeCount,
    edges: graph.relationshipCount,
  }),
);
