import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { preprocessSwiftConditionalDirectives } from '../../src/core/ingestion/languages/swift/conditional-directive-preprocess.js';

const swiftFixture = `class Outer {
  enum A { case x }
  #if os(iOS)
  enum B { case y }
  #endif
}
`;

const swiftMultilineStringFixture = `class StringHolder {
  let payload = """
  #if string-data
  #elseif more-string-data
  #else
  #endif
  """
  #if REAL_DIRECTIVE
  func afterString() {}
  #endif
}
`;

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);
const scratchDirs: string[] = [];

describe.skipIf(!swiftAvailable)('Swift conditional-directive pipeline regression', () => {
  afterAll(() => {
    for (const scratchDir of scratchDirs) fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('keeps Outer and both nested declarations in the real worker pipeline', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-directive-'));
    scratchDirs.push(repo);
    fs.writeFileSync(path.join(repo, 'Fixture.swift'), swiftFixture, 'utf8');

    const result = await runPipelineFromRepo(repo, () => {}, {
      workerPoolSize: 1,
      workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    });
    const names = new Set<string>();
    result.graph.forEachNode((node) => {
      if (node.properties.filePath?.endsWith('Fixture.swift')) names.add(node.properties.name);
    });

    for (const name of ['Outer', 'A', 'B']) expect(names.has(name)).toBe(true);
  }, 60000);

  it('preserves a multiline string property while blanking a real directive between strings', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-string-'));
    scratchDirs.push(repo);
    fs.writeFileSync(path.join(repo, 'Fixture.swift'), swiftMultilineStringFixture, 'utf8');

    const rewritten = preprocessSwiftConditionalDirectives(swiftMultilineStringFixture);
    const opening = swiftMultilineStringFixture.indexOf('"""') + 3;
    const closing = swiftMultilineStringFixture.indexOf('"""', opening);
    expect(opening).toBeGreaterThan(2);
    expect(rewritten.slice(opening, closing)).toBe(
      swiftMultilineStringFixture.slice(opening, closing),
    );

    const result = await runPipelineFromRepo(repo, () => {}, {
      workerPoolSize: 1,
      workerThresholdsForTest: { minFiles: 1, minBytes: 1 },
    });
    const symbols = new Map<string, string>();
    result.graph.forEachNode((node) => {
      if (node.properties.filePath?.endsWith('Fixture.swift')) {
        symbols.set(node.properties.name, node.label);
      }
    });

    expect(symbols.get('StringHolder')).toBe('Class');
    expect(symbols.get('payload')).toBe('Property');
    expect(symbols.get('afterString')).toBe('Function');
  }, 60000);
});
