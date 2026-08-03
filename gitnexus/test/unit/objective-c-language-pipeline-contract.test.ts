import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';

import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import { typescriptScopeResolver } from '../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { partitionSourceFilesByLanguage } from '../../src/core/ingestion/scope-resolution/pipeline/phase.js';

describe('authoritative source-language pipeline contract', () => {
  it('stamps the provider language onto every production ParsedFile', () => {
    const parsed = extractParsedFile(
      typescriptScopeResolver.languageProvider,
      'export function run(): void {}',
      'src/run.ts',
    );

    expect(parsed?.language).toBe(SupportedLanguages.TypeScript);
  });

  it('reports unsupported Objective-C++ in the parse output manifest without spawning workers', async () => {
    const result = await runChunkedParseAndResolve(
      createKnowledgeGraph(),
      [{ path: 'Sources/Bridge.mm', size: 0 }],
      ['Sources/Bridge.mm'],
      1,
      process.cwd(),
      Date.now(),
      () => {},
    );

    expect(result.usedWorkerPool).toBe(false);
    expect(result.sourceClassifications.get('Sources/Bridge.mm')).toMatchObject({
      language: null,
      reason: 'unsupported-objective-cpp',
      classifierVersion: 1,
    });
  });

  it('routes ambiguous extensions in scope resolution by the authoritative manifest', () => {
    const files = [{ path: 'Sources/Service.h', size: 42 }];
    const buckets = partitionSourceFilesByLanguage(
      files,
      new Map([
        [
          'Sources/Service.h',
          {
            language: SupportedLanguages.ObjectiveC,
            confidence: 0.99,
            reason: 'objective-c-syntax' as const,
            classifierVersion: 1 as const,
          },
        ],
      ]),
    );

    expect(buckets.get(SupportedLanguages.ObjectiveC)).toEqual(files);
    expect(buckets.has(SupportedLanguages.CPlusPlus)).toBe(false);
  });
});
