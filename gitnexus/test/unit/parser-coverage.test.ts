/**
 * Parser coverage stats from runChunkedParseAndResolve (#1076).
 *
 * Counts files whose extension has no bundled grammar (e.g. .md, .csv) in
 * parserCoverage.unsupportedFiles, and recognized languages whose parser is
 * unavailable in parserCoverage.unavailableParserFiles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

vi.mock('../../src/core/tree-sitter/parser-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/tree-sitter/parser-loader.js')>();
  return { ...actual, isLanguageAvailable: vi.fn(() => true) };
});

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import * as parserLoader from '../../src/core/tree-sitter/parser-loader.js';

function makeTempRepo(baseDir: string, files: Record<string, string>): string {
  const dir = path.join(baseDir, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function scanned(repo: string, files: string[]) {
  return files.map((rel) => ({
    path: rel,
    size: fs.statSync(path.join(repo, rel)).size,
  }));
}

const writeResultWorker = (workerPath: string): void => {
  fs.writeFileSync(
    workerPath,
    `
const { parentPort } = require('node:worker_threads');
const decoder = new TextDecoder('utf-8');
parentPort.postMessage({ type: 'ready' });
const accumulated = {
  nodes: [], relationships: [], symbols: [], imports: [], calls: [], assignments: [], heritage: [],
  routes: [], fetchCalls: [], fetchWrapperDefs: [], decoratorRoutes: [], routerIncludes: [], routerImports: [], toolDefs: [], ormQueries: [], constructorBindings: [],
  fileScopeBindings: [], parsedFiles: [], skippedLanguages: {}, fileCount: 0,
};
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'sub-batch') {
    for (const file of msg.files) {
      const filePath = file.path;
      const name = filePath.split('/').pop().replace(/\\.ts$/, '');
      accumulated.nodes.push({
        id: 'Function:' + filePath + ':' + name,
        label: 'Function',
        properties: { name, filePath, startLine: 1, endLine: 1, language: 'typescript' },
      });
      accumulated.fileCount++;
      if (file.content && typeof file.content !== 'string') decoder.decode(file.content);
    }
    parentPort.postMessage({ type: 'progress', filesProcessed: accumulated.fileCount });
    parentPort.postMessage({ type: 'sub-batch-done' });
    return;
  }
  if (msg && msg.type === 'flush') parentPort.postMessage({ type: 'result', data: accumulated });
});
`,
  );
};

describe('parser coverage stats (#1076)', () => {
  let tempDir = '';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(true);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parser-coverage-run-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('counts unsupported extensions when no parseable files exist (no worker pool)', async () => {
    const repoPath = makeTempRepo(tempDir, {
      'readme.md': `# hello\n`,
      'data.csv': `a,b,c\n`,
    });
    const files = ['readme.md', 'data.csv'];
    const graph = createKnowledgeGraph();
    const result = await runChunkedParseAndResolve(
      graph,
      scanned(repoPath, files),
      files,
      files.length,
      repoPath,
      Date.now(),
      () => {},
    );

    expect(result.parserCoverage.totalFiles).toBe(2);
    expect(result.parserCoverage.supportedFiles).toBe(0);
    expect(result.parserCoverage.unsupportedFiles).toBe(2);
    expect(result.parserCoverage.unavailableParserFiles).toBe(0);
    expect(result.parserCoverage.unsupportedByExtension).toEqual(
      expect.arrayContaining([
        { extension: '.md', count: 1 },
        { extension: '.csv', count: 1 },
      ]),
    );
    expect(result.usedWorkerPool).toBe(false);
  });

  it('splits supported vs unsupported when both are present', async () => {
    const repoPath = makeTempRepo(tempDir, {
      'a.ts': `export function foo() {}\n`,
      'readme.md': `# hello\n`,
      'data.csv': `a,b,c\n`,
    });
    const workerPath = path.join(tempDir, 'result-worker.js');
    writeResultWorker(workerPath);

    const files = ['a.ts', 'readme.md', 'data.csv'];
    const graph = createKnowledgeGraph();
    const result = await runChunkedParseAndResolve(
      graph,
      scanned(repoPath, files),
      files,
      files.length,
      repoPath,
      Date.now(),
      () => {},
      {
        workerUrlForTest: pathToFileURL(workerPath),
        workerPoolSize: 1,
      },
    );

    expect(result.parserCoverage.totalFiles).toBe(3);
    expect(result.parserCoverage.supportedFiles).toBe(1);
    expect(result.parserCoverage.unsupportedFiles).toBe(2);
    expect(result.parserCoverage.unavailableParserFiles).toBe(0);
    expect(result.parserCoverage.unsupportedByExtension.length).toBeGreaterThan(0);
    expect(
      result.parserCoverage.supportedFiles +
        result.parserCoverage.unsupportedFiles +
        result.parserCoverage.unavailableParserFiles,
    ).toBe(result.parserCoverage.totalFiles);
  });

  it('counts unavailable parsers for recognized languages', async () => {
    vi.mocked(parserLoader.isLanguageAvailable).mockReturnValue(false);
    const repoPath = makeTempRepo(tempDir, {
      'App.swift': `class AppViewController {}\n`,
    });
    const files = ['App.swift'];
    const graph = createKnowledgeGraph();
    const result = await runChunkedParseAndResolve(
      graph,
      scanned(repoPath, files),
      files,
      files.length,
      repoPath,
      Date.now(),
      () => {},
    );

    expect(result.parserCoverage.totalFiles).toBe(1);
    expect(result.parserCoverage.supportedFiles).toBe(0);
    expect(result.parserCoverage.unsupportedFiles).toBe(0);
    expect(result.parserCoverage.unavailableParserFiles).toBe(1);
    expect(result.parserCoverage.unavailableByLanguage).toEqual([{ language: 'swift', count: 1 }]);
    expect(result.usedWorkerPool).toBe(false);
  });
});
