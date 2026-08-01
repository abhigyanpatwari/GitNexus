import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getNodesForFile } from './resolvers/helpers.js';
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

const swiftColumnZeroFixture = `class ColumnZero {
  enum A { case x }
#if os(iOS)
  enum B { case y }
#endif
}
`;

const swiftHeaderSplitFixture = `class NetworkClient {
  #if swift(>=5.5)
  func fetch() async {
  #else
  func fetch() {
  #endif
    perform()
  }
}

struct SessionStore {}
`;

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);
const scratchDirs: string[] = [];

/** Analyze a one-file Swift repo through the real worker pool. */
async function runFixture(prefix: string, source: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(repo);
  fs.writeFileSync(path.join(repo, 'Fixture.swift'), source, 'utf8');

  const result = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
  return getNodesForFile(result, 'Fixture.swift');
}

describe.skipIf(!swiftAvailable)('Swift conditional-directive pipeline regression', () => {
  afterAll(() => {
    for (const scratchDir of scratchDirs) fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('keeps Outer and both nested declarations in the real worker pipeline', async () => {
    const { names } = await runFixture('gitnexus-swift-directive-', swiftFixture);

    expect(names).toEqual(['A', 'B', 'Fixture.swift', 'Outer', 'x', 'y']);
  }, 60000);

  it('keeps a column-zero directive inside a class body from discarding the class', async () => {
    const { names } = await runFixture('gitnexus-swift-column-zero-', swiftColumnZeroFixture);

    expect(names).toEqual(['A', 'B', 'ColumnZero', 'Fixture.swift', 'x', 'y']);
  }, 60000);

  it('keeps later top-level types out of a class whose header is split across branches', async () => {
    // Blanking an unbalanced group re-parents unrelated declarations, which
    // shows up as a fabricated `NetworkClient.` qualified-name prefix.
    expect(preprocessSwiftConditionalDirectives(swiftHeaderSplitFixture)).toBe(
      swiftHeaderSplitFixture,
    );

    const { qualified } = await runFixture('gitnexus-swift-header-split-', swiftHeaderSplitFixture);

    expect(qualified).toEqual([
      'Class:NetworkClient',
      'File:Fixture.swift',
      'Function:fetch',
      'Function:fetch',
      'Struct:SessionStore',
    ]);
  }, 60000);

  it('preserves a multiline string property while blanking a real directive between strings', async () => {
    const rewritten = preprocessSwiftConditionalDirectives(swiftMultilineStringFixture);
    const opening = swiftMultilineStringFixture.indexOf('"""') + 3;
    const closing = swiftMultilineStringFixture.indexOf('"""', opening);
    expect([opening, closing]).toEqual([40, 105]);
    expect(rewritten.slice(opening, closing)).toBe(
      swiftMultilineStringFixture.slice(opening, closing),
    );

    const { labelled } = await runFixture('gitnexus-swift-string-', swiftMultilineStringFixture);

    expect(labelled).toEqual([
      'Class:StringHolder',
      'File:Fixture.swift',
      'Function:afterString',
      'Property:payload',
    ]);
  }, 60000);
});
