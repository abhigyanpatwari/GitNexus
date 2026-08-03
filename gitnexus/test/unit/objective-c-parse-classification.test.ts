import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/tree-sitter/parser-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/tree-sitter/parser-loader.js')>();
  return {
    ...actual,
    isLanguageAvailable: vi.fn(
      (language: import('gitnexus-shared').SupportedLanguages) => language !== 'objective-c',
    ),
  };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';

describe('parse phase authoritative Objective-C classification', () => {
  let repoDir = '';

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objc-classification-'));
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const runSource = async (filePath: string, content: string, allPaths = [filePath]) => {
    const absolute = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return runChunkedParseAndResolve(
      createKnowledgeGraph(),
      [{ path: filePath, size: Buffer.byteLength(content) }],
      allPaths,
      1,
      repoDir,
      Date.now(),
      () => {},
    );
  };

  it('classifies Objective-C syntax before grammar availability and does not fall back', async () => {
    const result = await runSource(
      'Sources/Service.m',
      '@implementation Service\n- (void)run {}\n@end\n',
    );

    expect(result.usedWorkerPool).toBe(false);
    expect(result.sourceClassifications.get('Sources/Service.m')).toMatchObject({
      language: SupportedLanguages.ObjectiveC,
      confidence: 0.99,
      reason: 'objective-c-syntax',
    });
  });

  it('rejects MATLAB instead of dispatching it to the Objective-C worker', async () => {
    const result = await runSource(
      'analysis.m',
      'function y = analysis(x)\n  y = x .* x;\nend\n',
    );

    expect(result.usedWorkerPool).toBe(false);
    expect(result.sourceClassifications.get('analysis.m')).toMatchObject({
      language: null,
      reason: 'matlab-syntax',
    });
  });

  it('uses repository-wide Xcode context only when direct syntax is absent', async () => {
    const result = await runSource('Legacy.m', 'void legacy(void) {}\n', [
      'Legacy.m',
      'App.xcodeproj/project.pbxproj',
    ]);

    expect(result.usedWorkerPool).toBe(false);
    expect(result.sourceClassifications.get('Legacy.m')).toMatchObject({
      language: SupportedLanguages.ObjectiveC,
      confidence: 0.9,
      reason: 'xcode-context',
    });
  });
});
