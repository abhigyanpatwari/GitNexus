import { beforeAll, describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { javascriptScopeResolver } from '../../src/core/ingestion/languages/javascript/scope-resolver.js';
import { typescriptScopeResolver } from '../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { isCommonJsExportAssignment } from '../../src/core/ingestion/languages/typescript/cjs-export-receiver.js';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

const cases = [
  {
    path: 'common.js',
    content: 'module.exports.value = 1;',
    resolver: javascriptScopeResolver,
    expected: true,
  },
  {
    path: 'esm.js',
    content: 'export {}; module.exports.value = 1;',
    resolver: javascriptScopeResolver,
    expected: false,
  },
  {
    path: 'common.ts',
    content: 'module.exports.value = 1;',
    resolver: typescriptScopeResolver,
    expected: true,
  },
  {
    path: 'esm.ts',
    content: 'export {}; module.exports.value = 1;',
    resolver: typescriptScopeResolver,
    expected: false,
  },
];

describe('CommonJS metadata across extraction paths', () => {
  let fromWorkers: Map<string, ParsedFile>;

  beforeAll(async () => {
    const pool = createWorkerPool(
      new URL('../../dist/core/ingestion/workers/parse-worker.js', import.meta.url),
      1,
    );
    try {
      const results = await pool.dispatch<{ path: string; content: string }, ParseWorkerResult>(
        cases.map(({ path, content }) => ({ path, content })),
      );
      const parsed = results.flatMap((result) => result.parsedFiles);
      expect(parsed).toHaveLength(cases.length);
      fromWorkers = new Map(parsed.map((file) => [file.filePath, file]));
    } finally {
      await pool.terminate();
    }
  }, 120000);

  it.each(cases)(
    '$path agrees for uncached main-thread and worker extraction',
    ({ path, content, resolver, expected }) => {
      for (const mode of ['uncached', 'worker'] as const) {
        let observed = false;
        let channel: unknown;
        let exportAssignment: boolean | undefined;
        runScopeResolution(
          {
            graph: createKnowledgeGraph(),
            model: createSemanticModel(),
            files: [{ path, content }],
            ...(mode === 'worker' ? { preExtractedParsedFiles: fromWorkers } : {}),
            onResolved: ({ parsedFiles, indexes }) => {
              expect(parsedFiles).toHaveLength(1);
              const parsed = parsedFiles[0]!;
              channel = parsed.captureSideChannel;
              const writes = parsed.referenceSites.filter(
                (site) => site.kind === 'write' && site.name === 'value',
              );
              expect(writes).toHaveLength(1);
              exportAssignment = isCommonJsExportAssignment(writes[0]!, indexes, parsed);
              observed = true;
            },
          },
          resolver,
        );
        expect(observed, mode).toBe(true);
        expect(channel, mode).toBe(expected);
        expect(exportAssignment, mode).toBe(expected);
      }
    },
  );
});
