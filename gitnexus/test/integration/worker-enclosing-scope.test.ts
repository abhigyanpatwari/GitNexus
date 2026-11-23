import { describe, expect, it } from 'vitest';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import type { ParseWorkerResult } from '../../src/core/ingestion/workers/parse-worker.js';

describe('worker enclosing scopes', () => {
  it('keeps request owners local to each file and omits unused legacy call records', async () => {
    const pool = createWorkerPool(
      new URL('../../dist/core/ingestion/workers/parse-worker.js', import.meta.url),
      1,
    );
    try {
      // Equal syntax layouts exercise one worker across both files and jobs.
      for (const names of [
        ['first', 'other'],
        ['third', 'final'],
      ]) {
        const files = names.map((name) => ({
          path: `${name}.ts`,
          content: `export function ${name}(client: Client) {
            client.value = 1;
            client.save();
            fetch('/${name}');
          }`,
        }));
        const results = await pool.dispatch<(typeof files)[number], ParseWorkerResult>(files);
        const requests = results.flatMap((result) => result.fetchCalls);
        expect(requests.length).toBe(2);
        for (const name of names) {
          const inFile = requests.filter((call) => call.filePath === `${name}.ts`);
          expect(inFile.length).toBe(1);
          expect(inFile[0].enclosingId).toBe(`Function:${name}.ts:${name}`);
        }
        // These arrays are not consumed or replayed; resolution uses parsedFiles.
        expect(results.flatMap((result) => result.calls).length).toBe(0);
        expect(results.flatMap((result) => result.assignments).length).toBe(0);
        const references = results
          .flatMap((result) => result.parsedFiles)
          .flatMap((file) => file.referenceSites);
        expect(references.filter((reference) => reference.name === 'save').length).toBe(2);
        expect(references.filter((reference) => reference.name === 'value').length).toBe(2);
      }
    } finally {
      await pool.terminate();
    }
  }, 30000);
});
