import { execSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '../../src/types/pipeline.js';

const fixture = vi.hoisted(() => ({
  result: undefined as PipelineResult | undefined,
  saveMeta: vi.fn(),
  initLbug: vi.fn(),
  wipeLbugDbFiles: vi.fn(),
  loadGraphToLbug: vi.fn(),
}));

vi.mock('../../src/core/ingestion/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/ingestion/pipeline.js')>();
  return {
    ...actual,
    runPipelineFromRepo: vi.fn(async () => {
      if (!fixture.result) throw new Error('pipeline fixture not initialized');
      return fixture.result;
    }),
  };
});

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    saveMeta: async (...args: Parameters<typeof actual.saveMeta>) => {
      fixture.saveMeta(...args);
      return actual.saveMeta(...args);
    },
  };
});

vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/lbug-adapter.js')>();
  return {
    ...actual,
    initLbug: fixture.initLbug,
    wipeLbugDbFiles: fixture.wipeLbugDbFiles,
    loadGraphToLbug: fixture.loadGraphToLbug,
  };
});

import {
  StreamedIncrementalWritebackError,
  analyzeFailureMayHaveMutatedLiveIndex,
  runFullAnalysis,
} from '../../src/core/run-analyze.js';
import { CLASS_FRAMEWORK_ANNOTATIONS_FEATURE } from '../../src/core/analysis-features.js';
import { resolveAnalyzerRunnerIdentity } from '../../src/core/analyzer-identity.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { SCHEMA_FINGERPRINT } from '../../src/core/lbug/schema.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

beforeEach(() => {
  fixture.result = undefined;
  fixture.saveMeta.mockClear();
  fixture.initLbug.mockClear();
  fixture.wipeLbugDbFiles.mockClear();
  fixture.loadGraphToLbug.mockClear();
});

describe('streamed incremental writeback orchestration', () => {
  it('rejects at the final incremental seam before write preparation', async () => {
    const repo = await createTempDir('gitnexus-streamed-incremental-');
    try {
      const filePath = path.join(repo.dbPath, 'a.txt');
      await writeFile(filePath, 'changed\n', 'utf8');
      execSync('git init', { cwd: repo.dbPath, stdio: 'pipe' });
      execSync(
        'git -c user.name=test -c user.email=t@t -c commit.gpgsign=false add -A && ' +
          'git -c user.name=test -c user.email=t@t -c commit.gpgsign=false commit -q -m initial',
        { cwd: repo.dbPath, stdio: 'pipe' },
      );

      const graph = createKnowledgeGraph();
      graph.addNode({
        id: 'File:a.txt',
        label: 'File',
        properties: { name: 'a.txt', filePath: 'a.txt' },
      });
      fixture.result = {
        graph,
        repoPath: repo.dbPath,
        totalFileCount: 1,
        resolutionOutcomes: [],
        usedWorkerPool: false,
        reparsedFileCount: 1,
        scopeExtractionFailures: [],
        unavailableScopeLanguageFiles: 0,
        graphEmitManifest: {
          relsByPair: new Map(),
          totalRows: 0,
          structuralRows: 0,
        },
      };

      const runnerIdentity = resolveAnalyzerRunnerIdentity(
        pathToFileURL(path.resolve('src/core/run-analyze.ts')).href,
      );
      const { lbugPath, metaPath, storagePath } = getStoragePaths(repo.dbPath);
      await saveMeta(storagePath, {
        repoPath: repo.dbPath,
        lastCommit: '',
        indexedAt: new Date(0).toISOString(),
        runnerIdentity,
        schemaFingerprint: SCHEMA_FINGERPRINT,
        analysisFeatures: {
          [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
        },
        fileHashes: { 'a.txt': 'stale-hash' },
      });
      await writeFile(lbugPath, 'existing-index-bytes', 'utf8');

      const before = {
        metadata: await readFile(metaPath, 'utf8'),
        legacyMetadata: await readFile(path.join(storagePath, 'meta.json'), 'utf8'),
        lbug: await readFile(lbugPath, 'utf8'),
        files: (await readdir(storagePath)).sort(),
      };
      fixture.saveMeta.mockClear();

      let thrown: unknown;
      const logs: string[] = [];
      try {
        await runFullAnalysis(
          repo.dbPath,
          { skipAgentsMd: true, skipSkills: true },
          { onProgress: () => {}, onLog: (message) => logs.push(message) },
          runnerIdentity,
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown, `${(thrown as Error)?.stack ?? String(thrown)}\n${logs.join('\n')}`).toBeInstanceOf(
        StreamedIncrementalWritebackError,
      );
      expect(analyzeFailureMayHaveMutatedLiveIndex(thrown)).toBe(false);
      expect(fixture.saveMeta).not.toHaveBeenCalled();
      expect(fixture.initLbug).not.toHaveBeenCalled();
      expect(fixture.wipeLbugDbFiles).not.toHaveBeenCalled();
      expect(fixture.loadGraphToLbug).not.toHaveBeenCalled();
      expect(await loadMeta(storagePath)).not.toHaveProperty('incrementalInProgress');
      expect({
        metadata: await readFile(metaPath, 'utf8'),
        legacyMetadata: await readFile(path.join(storagePath, 'meta.json'), 'utf8'),
        lbug: await readFile(lbugPath, 'utf8'),
        files: (await readdir(storagePath)).sort(),
      }).toEqual(before);
    } finally {
      await repo.cleanup();
    }
  }, 120_000);
});
