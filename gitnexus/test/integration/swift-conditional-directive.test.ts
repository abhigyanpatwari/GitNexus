import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import type { GraphNode } from 'gitnexus-shared';
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

interface FixtureNode {
  name: string;
  label: string;
  qualifiedName: string;
}

/** Every node the fixture file contributed, flattened for exact assertions. */
function collectFixtureNodes(graph: { forEachNode: (fn: (node: GraphNode) => void) => void }) {
  const nodes: (FixtureNode & { filePath: string })[] = [];
  graph.forEachNode((node) =>
    nodes.push({
      name: node.properties.name,
      label: node.label,
      qualifiedName: String(node.properties.qualifiedName ?? node.properties.name),
      filePath: node.properties.filePath ?? '',
    }),
  );
  return nodes.filter((node) => node.filePath.endsWith('Fixture.swift'));
}

describe.skipIf(!swiftAvailable)('Swift conditional-directive pipeline regression', () => {
  afterAll(() => {
    for (const scratchDir of scratchDirs) fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('keeps Outer and both nested declarations in the real worker pipeline', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-directive-'));
    scratchDirs.push(repo);
    fs.writeFileSync(path.join(repo, 'Fixture.swift'), swiftFixture, 'utf8');

    const result = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
    const names = collectFixtureNodes(result.graph)
      .map((node) => node.name)
      .sort();

    expect(names).toEqual(['A', 'B', 'Fixture.swift', 'Outer', 'x', 'y']);
  }, 60000);

  it('keeps a column-zero directive inside a class body from discarding the class', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-column-zero-'));
    scratchDirs.push(repo);
    fs.writeFileSync(path.join(repo, 'Fixture.swift'), swiftColumnZeroFixture, 'utf8');

    const result = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
    const names = collectFixtureNodes(result.graph)
      .map((node) => node.name)
      .sort();

    expect(names).toEqual(['A', 'B', 'ColumnZero', 'Fixture.swift', 'x', 'y']);
  }, 60000);

  it('keeps later top-level types out of a class whose header is split across branches', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-header-split-'));
    scratchDirs.push(repo);
    fs.writeFileSync(path.join(repo, 'Fixture.swift'), swiftHeaderSplitFixture, 'utf8');

    // Blanking an unbalanced group re-parents unrelated declarations, which
    // shows up as a fabricated `NetworkClient.` qualified-name prefix.
    expect(preprocessSwiftConditionalDirectives(swiftHeaderSplitFixture)).toBe(
      swiftHeaderSplitFixture,
    );

    const result = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
    const qualifiedNames = collectFixtureNodes(result.graph)
      .map((node) => `${node.label}:${node.qualifiedName}`)
      .sort();

    // `SessionStore` stays top level — blanking would make it
    // `Struct:NetworkClient.SessionStore` and stretch NetworkClient's span
    // over the whole file.
    expect(qualifiedNames).toEqual([
      'Class:NetworkClient',
      'File:Fixture.swift',
      'Function:fetch',
      'Function:fetch',
      'Struct:SessionStore',
    ]);
  }, 60000);

  it('preserves a multiline string property while blanking a real directive between strings', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-swift-string-'));
    scratchDirs.push(repo);
    fs.writeFileSync(path.join(repo, 'Fixture.swift'), swiftMultilineStringFixture, 'utf8');

    const rewritten = preprocessSwiftConditionalDirectives(swiftMultilineStringFixture);
    const opening = swiftMultilineStringFixture.indexOf('"""') + 3;
    const closing = swiftMultilineStringFixture.indexOf('"""', opening);
    expect([opening, closing]).toEqual([40, 105]);
    expect(rewritten.slice(opening, closing)).toBe(
      swiftMultilineStringFixture.slice(opening, closing),
    );

    const result = await runPipelineFromRepo(repo, () => {}, { workerPoolSize: 1 });
    const symbols = collectFixtureNodes(result.graph)
      .map((node) => `${node.label}:${node.name}`)
      .sort();

    expect(symbols).toEqual([
      'Class:StringHolder',
      'File:Fixture.swift',
      'Function:afterString',
      'Property:payload',
    ]);
  }, 60000);
});
