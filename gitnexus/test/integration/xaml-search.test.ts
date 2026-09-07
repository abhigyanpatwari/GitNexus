import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import {
  closeLbug,
  dropFTSIndex,
  executePrepared,
  initLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import * as bm25 from '../../src/core/search/bm25-index.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import * as ftsIndexes from '../../src/core/search/fts-indexes.js';
import * as checkpoints from '../../src/core/lbug/wal-checkpoint-driver.js';
import { batchInsertEmbeddings } from '../../src/core/embeddings/embedding-pipeline.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';

const fixtures: Array<{ cleanup(): Promise<void> }> = [];
afterEach(async () => {
  await closeLbug();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

describe('persisted XAML declarations (#3202)', () => {
  it.each(['node-id', 'file-path'])(
    'preserves existing code symbol types through %s lookup',
    async (lookup) => {
      const repo = await setupMiniRepo();
      const home = await createTempDir();
      fixtures.push(repo, home);
      vi.stubEnv('GITNEXUS_HOME', home.dbPath);
      // Both symbols fit the existing file-path fallback's LIMIT 3.
      await fs.writeFile(
        path.join(repo.dbPath, 'src/search-shape.ts'),
        'export interface SearchShape {}\nexport function createSearchShape(): SearchShape { return {}; }\n',
      );
      const registryName = 'xaml-code-search-fixture';
      await runFullAnalysis(repo.dbPath, { skipAgentsMd: true, registryName }, { onProgress() {} });
      if (lookup === 'file-path') {
        const originalSearch = bm25.searchFTSFromLbug;
        // Exercise the legacy file-only response using real FTS and graph queries.
        vi.spyOn(bm25, 'searchFTSFromLbug').mockImplementation(async (...args) => {
          const result = await originalSearch(...args);
          return {
            ...result,
            results: result.results.map((hit) => ({ ...hit, nodeIds: undefined })),
          };
        });
      }
      const backend = new LocalBackend();
      const queries = vi.spyOn(pool, 'executeParameterized');
      try {
        expect(await backend.init()).toBe(true);
        for (const [name, type] of [
          ['createSearchShape', 'Function'],
          ['SearchShape', 'Interface'],
        ]) {
          const result = await backend.callTool('query', {
            repo: registryName,
            search_query: name,
          });
          expect(result.error).toBeUndefined();
          expect([...result.definitions, ...result.process_symbols]).toContainEqual(
            expect.objectContaining({ name, type, filePath: 'src/search-shape.ts' }),
          );
        }
        const predicate =
          lookup === 'node-id' ? 'WHERE n.id IN $nodeIds' : 'WHERE n.filePath = $filePath';
        expect(
          queries.mock.calls.some(
            ([, statement]) =>
              statement.includes(predicate) && statement.includes('labels(n) AS type'),
          ),
        ).toBe(true);
      } finally {
        await backend.dispose();
      }
    },
    180_000,
  );

  it('keeps graph and embedding rows intact when the post-drop checkpoint fails', async () => {
    const repo = await setupMiniRepo();
    const home = await createTempDir();
    fixtures.push(repo, home);
    vi.stubEnv('GITNEXUS_HOME', home.dbPath);
    const file = path.join(repo.dbPath, 'Checkpoint.xaml');
    await fs.writeFile(
      file,
      '<Grid xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Name="OriginalView" />',
    );
    const options = { skipAgentsMd: true, registryName: 'document-checkpoint-fixture' };
    await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
    await initLbug(lbugPath);
    const originalSections = await executePrepared(
      'MATCH (n:Section) WHERE n.filePath = $file RETURN n.id AS id, n.name AS name',
      { file: 'Checkpoint.xaml' },
    );
    expect(originalSections).toEqual([{ id: expect.any(String), name: 'OriginalView' }]);
    const functions = await adapter.executeQuery(
      'MATCH (n:Function) RETURN n.id AS id ORDER BY id',
    );
    expect(functions.length).toBeGreaterThan(0);
    const embedding = {
      nodeId: String(functions[0].id),
      chunkIndex: 0,
      startLine: 0,
      endLine: 1,
      embedding: Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i === 0 ? 1 : 0)),
      contentHash: 'checkpoint-preserved',
    };
    await batchInsertEmbeddings(adapter.executeWithReusedStatement, [embedding]);
    await adapter.flushWAL();
    await closeLbug();
    const meta = await loadMeta(storagePath);
    if (!meta) throw new Error('Initial analysis did not persist metadata');
    await saveMeta(storagePath, {
      ...meta,
      stats: { ...meta.stats, embeddings: 1 },
      embeddingDims: EMBEDDING_DIMS,
    });

    const originalDrop = ftsIndexes.dropSearchFTSIndexes;
    let dropped = false;
    vi.spyOn(ftsIndexes, 'dropSearchFTSIndexes').mockImplementation(async (...args) => {
      await originalDrop(...args);
      dropped = true;
    });
    const failure = new Error('Injected post-drop checkpoint failure');
    const originalCheckpoint = checkpoints.checkpointOnce;
    vi.spyOn(checkpoints, 'checkpointOnce').mockImplementation(async () => {
      if (dropped) throw failure;
      await originalCheckpoint();
    });
    const deletes = vi.spyOn(adapter, 'deleteNodesForFiles');
    const copies = vi.spyOn(adapter, 'loadGraphToLbug');
    await fs.writeFile(
      file,
      '<Grid xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Name="ChangedView" />',
    );
    await expect(runFullAnalysis(repo.dbPath, options, { onProgress() {} })).rejects.toBe(failure);
    expect(dropped).toBe(true);
    expect(deletes).not.toHaveBeenCalled();
    expect(copies).not.toHaveBeenCalled();
    expect(await loadMeta(storagePath)).toMatchObject({
      incrementalInProgress: {
        phase: 'effective-write-set',
        toWriteCount: 1,
        startedAt: expect.any(Number),
      },
      indexedAt: meta.indexedAt,
      fileHashes: meta.fileHashes,
      stats: { embeddings: 1 },
    });
    await initLbug(lbugPath);
    expect(
      await executePrepared(
        'MATCH (n:Section) WHERE n.filePath = $file RETURN n.id AS id, n.name AS name',
        { file: 'Checkpoint.xaml' },
      ),
    ).toEqual(originalSections);
    expect(await adapter.executeQuery('MATCH (n:Function) RETURN n.id AS id ORDER BY id')).toEqual(
      functions,
    );
    expect((await adapter.loadCachedEmbeddings()).embeddings).toEqual([embedding]);
  }, 180_000);

  it('repairs a missing Section index and reconciles Markdown headings sharing that index', async () => {
    const repo = await setupMiniRepo();
    const home = await createTempDir();
    fixtures.push(repo, home);
    vi.stubEnv('GITNEXUS_HOME', home.dbPath);
    const file = path.join(repo.dbPath, 'Guide.md');
    await fs.writeFile(file, '# InvoiceRecoveryGuide\n\nRecover invoices.\n');
    const options = { skipAgentsMd: true, registryName: 'document-repair-fixture' };
    await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    const { lbugPath } = getStoragePaths(repo.dbPath);
    await initLbug(lbugPath);
    const before = await executePrepared(
      'MATCH (n:Section) WHERE n.filePath = $file RETURN n.id AS id, n.name AS name',
      { file: 'Guide.md' },
    );
    expect(before).toEqual([{ id: expect.any(String), name: 'InvoiceRecoveryGuide' }]);
    await dropFTSIndex('Section', 'section_fts');
    await closeLbug();
    const repaired = await runFullAnalysis(
      repo.dbPath,
      { ...options, repairFts: true },
      { onProgress() {} },
    );
    expect(repaired.ftsRepairedOnly).toBe(true);
    await initLbug(lbugPath);
    expect(
      await executePrepared(
        'MATCH (n:Section) WHERE n.filePath = $file RETURN n.id AS id, n.name AS name',
        { file: 'Guide.md' },
      ),
    ).toEqual(before);
    expect(
      (await searchFTSFromLbug('InvoiceRecoveryGuide')).results.flatMap(
        (result) => result.nodeIds ?? [],
      ),
    ).toContain(before[0].id);
    await closeLbug();
    await fs.writeFile(file, '# PaymentRecoveryGuide\n\nRecover payments.\n');
    await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    await initLbug(lbugPath);
    expect((await searchFTSFromLbug('InvoiceRecoveryGuide')).results).toEqual([]);
    const renamed = await executePrepared(
      'MATCH (n:Section) WHERE n.filePath = $file RETURN n.id AS id, n.name AS name',
      { file: 'Guide.md' },
    );
    expect(renamed).toEqual([{ id: expect.any(String), name: 'PaymentRecoveryGuide' }]);
    expect(
      (await searchFTSFromLbug('PaymentRecoveryGuide')).results.flatMap(
        (result) => result.nodeIds ?? [],
      ),
    ).toContain(renamed[0].id);
    await closeLbug();
    await fs.unlink(file);
    await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    await initLbug(lbugPath);
    expect((await searchFTSFromLbug('PaymentRecoveryGuide')).results).toEqual([]);
    expect(
      await executePrepared('MATCH (n:Section) WHERE n.filePath = $file RETURN n.id AS id', {
        file: 'Guide.md',
      }),
    ).toEqual([]);
    await closeLbug();
    expect((await runFullAnalysis(repo.dbPath, options, { onProgress() {} })).alreadyUpToDate).toBe(
      true,
    );
  }, 180_000);

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'hashes %s candidates without repeatedly reanalyzing unchanged content',
    async (flag) => {
      const repo = await setupMiniRepo();
      const home = await createTempDir();
      fixtures.push(repo, home);
      vi.stubEnv('GITNEXUS_HOME', home.dbPath);
      const file = path.join(repo.dbPath, 'Flagged.xaml');
      const original =
        '<Grid xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Name="FlaggedView" />';
      await fs.writeFile(file, original);
      execFileSync('git', ['add', 'Flagged.xaml'], { cwd: repo.dbPath });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=test',
          '-c',
          'user.email=t@t',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          'Add view',
        ],
        { cwd: repo.dbPath },
      );
      execFileSync('git', ['update-index', flag, 'Flagged.xaml'], { cwd: repo.dbPath });
      const options = { skipAgentsMd: true, registryName: 'flagged-xaml-fixture' };
      await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
      const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
      expect((await loadMeta(storagePath))?.indexCoverage?.dirtyPaths).toContain('Flagged.xaml');
      expect(
        (await runFullAnalysis(repo.dbPath, options, { onProgress() {} })).alreadyUpToDate,
      ).toBe(true);
      await fs.writeFile(file, original.replace('FlaggedView', 'ChangedView'));
      expect(
        (await runFullAnalysis(repo.dbPath, options, { onProgress() {} })).alreadyUpToDate,
      ).not.toBe(true);
      await initLbug(lbugPath);
      try {
        expect(
          await executePrepared(
            'MATCH (n:Section) WHERE n.filePath = $file RETURN n.name AS name',
            { file: 'Flagged.xaml' },
          ),
        ).toEqual([{ name: 'ChangedView' }]);
      } finally {
        await closeLbug();
      }
      expect(
        (await runFullAnalysis(repo.dbPath, options, { onProgress() {} })).alreadyUpToDate,
      ).toBe(true);
    },
    180_000,
  );

  it('reconciles an indexed edit restored to HEAD and keeps legacy clean metadata eligible for the fast path', async () => {
    const repo = await setupMiniRepo();
    const home = await createTempDir();
    fixtures.push(repo, home);
    vi.stubEnv('GITNEXUS_HOME', home.dbPath);
    const file = path.join(repo.dbPath, 'Tracked.xaml');
    const original =
      '<Grid xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:Name="OriginalView" />';
    await fs.writeFile(file, original);
    execFileSync('git', ['add', 'Tracked.xaml'], { cwd: repo.dbPath });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'Add view',
      ],
      { cwd: repo.dbPath },
    );
    const options = { skipAgentsMd: true, registryName: 'tracked-xaml-fixture' };
    await fs.writeFile(file, original.replace('OriginalView', 'EditedView'));
    await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
    expect((await loadMeta(storagePath))?.indexCoverage?.dirtyPaths).toContain('Tracked.xaml');
    await fs.writeFile(file, original);
    const restored = await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    expect(restored.alreadyUpToDate).not.toBe(true);
    await initLbug(lbugPath);
    try {
      expect(
        await executePrepared('MATCH (n:Section) WHERE n.filePath = $file RETURN n.name AS name', {
          file: 'Tracked.xaml',
        }),
      ).toEqual([{ name: 'OriginalView' }]);
    } finally {
      await closeLbug();
    }
    const meta = await loadMeta(storagePath);
    expect(meta?.indexCoverage?.dirtyPaths).toEqual([]);
    // Older snapshots did not record dirtyPaths. Their clean fast path is unchanged.
    if (!meta?.indexCoverage) throw new Error('Expected coverage metadata');
    delete meta.indexCoverage.dirtyPaths;
    await saveMeta(storagePath, meta);
    expect((await runFullAnalysis(repo.dbPath, options, { onProgress() {} })).alreadyUpToDate).toBe(
      true,
    );
  }, 180_000);

  it('supports FTS and MCP context, then removes stale declarations on incremental change and delete', async () => {
    const repo = await setupMiniRepo();
    const home = await createTempDir();
    fixtures.push(repo, home);
    vi.stubEnv('GITNEXUS_HOME', home.dbPath);
    const file = path.join(repo.dbPath, 'View.xaml');
    const document = (name: string) =>
      `<Grid xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Button x:Name="${name}" /></Grid>`;
    await fs.writeFile(file, document('SubmitInvoiceButton'));
    const options = { skipAgentsMd: true, registryName: 'xaml-fixture' };
    const first = await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    expect(first.ftsSkipped).toBe(false);
    const { lbugPath } = getStoragePaths(repo.dbPath);
    const readSections = async () => {
      await initLbug(lbugPath);
      try {
        return await executePrepared(
          'MATCH (n:Section) WHERE n.filePath = $file RETURN n.id AS id, n.name AS name, n.startLine AS startLine',
          { file: 'View.xaml' },
        );
      } finally {
        await closeLbug();
      }
    };
    const sections = await readSections();
    expect(sections).toEqual([
      { id: expect.any(String), name: 'SubmitInvoiceButton', startLine: 0 },
    ]);
    await initLbug(lbugPath);
    const search = await searchFTSFromLbug('SubmitInvoiceButton');
    expect(search.ftsAvailable).toBe(true);
    expect(search.results.some((result) => result.filePath === 'View.xaml')).toBe(true);
    expect(search.results.flatMap((result) => result.nodeIds ?? [])).toContain(sections[0].id);
    await closeLbug();
    const backend = new LocalBackend();
    try {
      expect(await backend.init()).toBe(true);
      const query = await backend.callTool('query', {
        repo: options.registryName,
        search_query: 'SubmitInvoiceButton',
      });
      expect(query.error).toBeUndefined();
      expect(query.definitions).toContainEqual(
        expect.objectContaining({
          id: sections[0].id,
          name: 'SubmitInvoiceButton',
          type: 'Section',
          filePath: 'View.xaml',
          startLine: 1,
          endLine: 1,
        }),
      );
      const declaration = query.definitions.find(
        (definition: { name: string }) => definition.name === 'SubmitInvoiceButton',
      );
      const context = await backend.callTool('context', {
        repo: options.registryName,
        uid: declaration.id,
      });
      expect(context.error).toBeUndefined();
      expect(JSON.stringify(context)).toContain('SubmitInvoiceButton');
    } finally {
      await backend.dispose();
    }

    await fs.writeFile(file, document('CancelInvoiceButton'));
    await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    expect(await readSections()).toEqual([
      { id: expect.any(String), name: 'CancelInvoiceButton', startLine: 0 },
    ]);
    await initLbug(lbugPath);
    expect((await searchFTSFromLbug('SubmitInvoiceButton')).results).toEqual([]);
    expect(
      (await searchFTSFromLbug('CancelInvoiceButton')).results.flatMap(
        (result) => result.nodeIds ?? [],
      ),
    ).toContain(sections[0].id);
    await closeLbug();
    await fs.unlink(file);
    await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    expect(await readSections()).toEqual([]);
    await initLbug(lbugPath);
    expect((await searchFTSFromLbug('CancelInvoiceButton')).results).toEqual([]);
    await closeLbug();
    const clean = await runFullAnalysis(repo.dbPath, options, { onProgress() {} });
    expect(clean.alreadyUpToDate).toBe(true);
  }, 180_000);
});
