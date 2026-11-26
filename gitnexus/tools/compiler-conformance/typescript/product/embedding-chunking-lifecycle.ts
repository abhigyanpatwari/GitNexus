import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, afterEach, it, mock } from 'node:test';
import { expect } from 'expect';
import { createTestEnvironment } from '../support/environment.js';
import { getStoragePaths } from '../../../../dist/storage/repo-manager.js';
import { EMBEDDING_DIMS } from '../../../../dist/core/lbug/schema.js';
import * as ast from '../../../../dist/core/embeddings/ast-utils.js';
import * as adapter from '../../../../dist/core/lbug/lbug-adapter.js';
import { EmbeddingSourceReader } from '../../../../dist/core/embeddings/source-reader.js';
import { searchFTSFromLbug } from '../../../../dist/core/search/bm25-index.js';
import { createTempDir } from '../../../../test/helpers/test-db.js';

const parse = mock.fn(ast.ensureAndParse);
const astMock = mock.module(
  new URL('../../../../dist/core/embeddings/ast-utils.js', import.meta.url).href,
  {
    namedExports: { ...ast, ensureAndParse: parse },
  },
);
after(() => astMock.restore());
const { runFullAnalysis } = await import('../../../../dist/core/run-analyze.js');
const { semanticSearch } = await import('../../../../dist/core/embeddings/embedding-pipeline.js');
const environment = createTestEnvironment();
afterEach(() => environment.restore());

it(
  'persists policy changes, source ranges and complete replacement rows through analyze (#702)',
  { timeout: 300_000 },
  async (t) => {
    const tmp = await createTempDir();
    const repo = path.join(tmp.dbPath, 'repo');
    await fs.mkdir(repo);
    const requests: string[][] = [];
    const server = createServer(async (request, response) => {
      const pieces: Buffer[] = [];
      for await (const piece of request) pieces.push(Buffer.from(piece));
      const { input } = JSON.parse(Buffer.concat(pieces).toString()) as { input: string[] };
      requests.push(input);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          data: input.map((text, index) => {
            const embedding = Array<number>(EMBEDDING_DIMS).fill(0);
            embedding[text.includes('TAIL_SENTINEL_702') ? 0 : 1] = 1;
            return { index, embedding };
          }),
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected endpoint');
    environment.set('GITNEXUS_HOME', path.join(tmp.dbPath, 'home'));
    environment.set('GITNEXUS_SHARED_STORE', 'off');
    environment.set('GITNEXUS_EMBEDDING_URL', `http://127.0.0.1:${address.port}`);
    environment.set('GITNEXUS_EMBEDDING_MODEL', 'chunk-lifecycle-fixture');
    environment.set('GITNEXUS_EMBEDDING_MAX_ATTEMPTS', '1');
    environment.set('GITNEXUS_EMBEDDING_CHUNK_SIZE', '500');
    environment.set('GITNEXUS_EMBEDDING_CHUNK_OVERLAP', '50');
    environment.set('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    const analyze = (embeddings = true) =>
      runFullAnalysis(
        repo,
        {
          skipGit: true,
          embeddings,
          embeddingsNodeLimit: 0,
          skipSkills: true,
          skipAgentsMd: true,
        },
        { onProgress: () => {} },
      );
    const read = async <T>(action: () => Promise<T>): Promise<T> => {
      await adapter.initLbug(getStoragePaths(repo).lbugPath);
      try {
        return await action();
      } finally {
        await adapter.closeLbug();
      }
    };
    const rows = () =>
      read(() =>
        adapter.executeQuery(
          'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.contentHash AS contentHash ORDER BY nodeId, chunkIndex',
        ),
      );
    const statements = Array.from({ length: 250 }, (_, i) => `  const value${i} = ${i};`).join(
      '\n',
    );
    let functionSource = `export function searchTail() {\n${statements}\n  return "TAIL_SENTINEL_702";\n}\n`;
    const classSource = `export class Sample {\n before: string;\n run() {\n${statements}\n return "CLASS_BODY_702"; }\n after = 42;\n}\n`;
    const pythonSource = `# original indentation\n\ndef search_python_tail():\n${Array.from({ length: 140 }, (_, i) => `    value${i} = ${i}`).join('\n')}\n    return "TAIL_SENTINEL_702"\n`;
    const file = path.join(repo, 'sample.ts');
    const sourceReads = t.mock.method(EmbeddingSourceReader.prototype, 'read');
    try {
      await fs.writeFile(file, functionSource + classSource);
      await fs.writeFile(path.join(repo, 'sample.py'), pythonSource);
      await analyze(false);
      expect(requests).toHaveLength(0);
      expect(parse.mock.callCount()).toBe(0);
      expect(sourceReads.mock.callCount()).toBe(0);
      await analyze();
      const firstRows = await rows();
      const functionRows = firstRows.filter((row) => String(row.nodeId).includes('searchTail'));
      expect(functionRows.length).toBeGreaterThan(1);
      const classInputs = requests.flat().filter((text) => text.startsWith('Class: Sample'));
      expect(classInputs.length).toBeGreaterThan(0);
      expect(classInputs.join('\n')).toContain('before');
      expect(classInputs.join('\n')).toContain('after');
      expect(classInputs.join('\n')).not.toContain('CLASS_BODY_702');
      expect(
        requests
          .flat()
          .some((text) => text.startsWith('Method: run') && text.includes('CLASS_BODY_702')),
      ).toBe(true);
      const hits = await read(() =>
        semanticSearch(adapter.executeQuery, 'TAIL_SENTINEL_702', 10, 0.1),
      );
      const match = hits.find((hit) => hit.name === 'searchTail');
      expect(match).toBeDefined();
      expect(functionSource.indexOf('TAIL_SENTINEL_702')).toBeGreaterThan(5000);
      const tailLine = functionSource
        .split('\n')
        .findIndex((line) => line.includes('TAIL_SENTINEL_702'));
      expect(match?.startLine).toBeLessThanOrEqual(tailLine);
      expect(match?.endLine).toBeGreaterThanOrEqual(tailLine);
      expect(match?.startLine).toBeGreaterThan(1);
      const pythonMatch = hits.find((hit) => hit.name === 'search_python_tail');
      const pythonTail = pythonSource
        .split('\n')
        .findIndex((line) => line.includes('TAIL_SENTINEL_702'));
      expect(pythonMatch).toBeDefined();
      expect(pythonMatch?.startLine).toBeGreaterThan(2);
      expect(pythonMatch?.startLine).toBeLessThanOrEqual(pythonTail);
      expect(pythonMatch?.endLine).toBeGreaterThanOrEqual(pythonTail);
      const pythonRead = sourceReads.mock.calls.findIndex(
        ({ arguments: [node] }) => node.name === 'search_python_tail',
      );
      expect(pythonRead).toBeGreaterThanOrEqual(0);
      expect(await sourceReads.mock.calls[pythonRead].result).toContain('\n    value0 = 0\n');
      const fts = await read(() => searchFTSFromLbug('value40', 5));
      expect(fts.ftsAvailable).toBe(true);
      expect(fts.results.some((hit) => hit.filePath === 'sample.ts')).toBe(true);

      requests.length = 0;
      parse.mock.resetCalls();
      sourceReads.mock.resetCalls();
      await analyze();
      expect(requests).toHaveLength(0);
      expect(parse.mock.callCount()).toBe(0);
      expect(sourceReads.mock.callCount()).toBe(0);

      environment.set('GITNEXUS_EMBEDDING_CHUNK_STRATEGY', 'fixed');
      await analyze();
      const fixedRows = (await rows()).filter((row) => String(row.nodeId).includes('searchTail'));
      expect(fixedRows[0].contentHash).not.toBe(functionRows[0].contentHash);
      environment.set('GITNEXUS_EMBEDDING_CHUNK_STRATEGY', 'ast');
      await analyze();
      expect((await rows()).filter((row) => String(row.nodeId).includes('searchTail'))).toEqual(
        functionRows,
      );

      // Changing a sibling still verifies the file, but reuses identical inputs.
      requests.length = 0;
      await fs.writeFile(file, functionSource + classSource + '// sibling edit\n');
      await analyze();
      expect(requests).toHaveLength(0);
      const reused = (await rows()).filter((row) => String(row.nodeId).includes('searchTail'));
      expect(reused.map(({ contentHash: _hash, ...row }) => row)).toEqual(
        functionRows.map(({ contentHash: _hash, ...row }) => row),
      );
      expect(reused[0].contentHash).not.toBe(functionRows[0].contentHash);
      sourceReads.mock.resetCalls();
      await analyze();
      expect(sourceReads.mock.callCount()).toBe(0);
      expect(requests).toHaveLength(0);

      // Editing only the omitted tail must invalidate the unchanged FTS prefix.
      functionSource = functionSource.replace('value249 = 249', 'value249 = 999');
      requests.length = 0;
      await fs.writeFile(file, functionSource + classSource);
      await analyze();
      expect(requests.flat().join('\n')).toContain('value249 = 999');
      const changedTail = (await rows()).filter((row) => String(row.nodeId).includes('searchTail'));
      expect(changedTail[0].contentHash).not.toBe(functionRows[0].contentHash);

      await fs.writeFile(file, '\n'.repeat(10) + functionSource + classSource);
      await analyze();
      const moved = (await rows()).filter((row) => String(row.nodeId).includes('searchTail'));
      expect(moved.map((row) => [row.startLine, row.endLine])).toEqual(
        functionRows.map((row) => [row.startLine + 10, row.endLine + 10]),
      );

      await fs.writeFile(file, 'export function searchTail() { return "TAIL_SENTINEL_702"; }\n');
      await analyze();
      const shrunk = await rows();
      expect(shrunk.filter((row) => String(row.nodeId).includes('searchTail'))).toHaveLength(1);
      expect(
        shrunk.some(
          (row) => String(row.nodeId).includes('Sample') || String(row.nodeId).includes(':run'),
        ),
      ).toBe(false);
    } finally {
      await adapter.closeLbug();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await tmp.cleanup();
    }
  },
);
