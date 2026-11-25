/**
 * #3747: a member edge must never name an owner node the file did not emit.
 * Both fixtures are the reporter's repro; before the fix each produced one
 * HAS_METHOD edge that LadybugDB's COPY rejected with
 * "Unable to find primary key value".
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTempDir } from '../helpers/test-db.js';
import { DIST_WORKER_URL } from '../helpers/worker-parse.js';
import { createWorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import type {
  ParseWorkerInput,
  ParseWorkerResult,
} from '../../src/core/ingestion/workers/parse-worker.js';

const CHAINED_CONST = `import { z } from 'zod';

const KEY = 'BRANCH';
const Branch = z.string();

const Context = z
  .object({
    REF: z.string(),
    [KEY]: Branch,
    REPO: z.string().refine((value) => value.split('/').every((p) => p !== '..')),
  })
  .refine((context) => context.REF === \`refs/heads/\${context[KEY]}\`, {
    message: 'REF must be the branch head',
  });

export function run(env) {
  const context = Context.parse(env);
  return context;
}
`;

describe('#3747 member edges only name emitted owners', () => {
  it('settles the partial file when a real parser provider throws after emitting members', async () => {
    const temp = await createTempDir();
    const bootstrap = path.join(temp.dbPath, 'throwing-provider.mjs');
    const providersUrl = new URL('../languages/index.js', DIST_WORKER_URL).href;
    // Inject the failure in the worker isolate, leaving the production loop and
    // its finally intact. Removing that finally must make this regression fail.
    await fs.writeFile(
      bootstrap,
      `
      const { getProvider } = await import(${JSON.stringify(providersUrl)});
      getProvider('javascript').extractToolDefinitions = () => {
        throw new Error('owner-edge-guard provider fault');
      };
      await import(${JSON.stringify(DIST_WORKER_URL.href)});
    `,
    );
    const pool = createWorkerPool(pathToFileURL(bootstrap), 1);
    try {
      const [result] = await pool.dispatch<ParseWorkerInput, ParseWorkerResult>([
        { path: 'ctx.mjs', content: CHAINED_CONST },
        { path: 'after.mjs', content: 'export function shouldNotParse() {}' },
      ]);
      // The first file is counted before the provider throws; the remaining
      // file is skipped, proving the injected failure reached processBatch.
      expect(result.fileCount).toBe(1);
      expect(result.nodes.some((node) => node.properties.name === 'shouldNotParse')).toBe(false);
      const member = result.nodes.find((node) => node.properties.name === 'REPO');
      expect(member).toBeDefined();
      expect(result.relationships.filter((edge) => edge.targetId === member?.id)).toEqual([
        {
          originFilePath: 'ctx.mjs',
          id: `DEFINES:File:ctx.mjs->${member?.id}`,
          sourceId: 'File:ctx.mjs',
          targetId: member?.id,
          type: 'DEFINES',
          confidence: 1,
          reason: '',
        },
      ]);
    } finally {
      await pool.terminate();
      await temp.cleanup();
    }
  });
});
