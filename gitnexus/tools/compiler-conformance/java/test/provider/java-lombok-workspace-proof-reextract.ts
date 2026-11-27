import assert from 'node:assert/strict';
import { describe, it, mock, after } from 'node:test';
import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';

/** Files whose workspace re-extraction is made to fail; first extractions still run. */
const extraction = { refused: new Set<string>() };
const original = await import('../../../../../dist/core/ingestion/scope-extractor-bridge.js');
const bridge = mock.module(
  new URL('../../../../../dist/core/ingestion/scope-extractor-bridge.js', import.meta.url).href,
  {
    namedExports: {
      ...original,
      extractParsedFile: (...args: Parameters<typeof original.extractParsedFile>) =>
        extraction.refused.has(args[2]) ? undefined : original.extractParsedFile(...args),
    },
  },
);
after(() => bridge.restore());

const { javaProvider } = await import('../../../../../dist/core/ingestion/languages/java.js');
const { extractParsedFile } =
  await import('../../../../../dist/core/ingestion/scope-extractor-bridge.js');
const { populateClassOwnedMembers } =
  await import('../../../../../dist/core/ingestion/scope-resolution/scope/walkers.js');
const { reconcileJavaLombokWorkspaceProof } =
  await import('../../../../../dist/core/ingestion/languages/java/lombok-workspace-proof.js');
const { clearJavaClassAnnotationFacts } =
  await import('../../../../../dist/core/ingestion/languages/java/capture-side-channel.js');
const { clearJavaPackageFacts } =
  await import('../../../../../dist/core/ingestion/languages/java/package-facts.js');
const { getJavaParser } =
  await import('../../../../../dist/core/ingestion/languages/java/query.js');

function reconcileRefusing(files: Record<string, string>, refused: string) {
  clearJavaClassAnnotationFacts();
  clearJavaPackageFacts();
  const trees = new Map<string, Parser.Tree>();
  const before = new Map<string, ParsedFile>();
  for (const [filePath, source] of Object.entries(files)) {
    const tree = getJavaParser().parse(source);
    trees.set(filePath, tree);
    const parsed = extractParsedFile(javaProvider, source, filePath, undefined, tree);
    if (parsed === undefined) throw new Error(`Missing Java extraction: ${filePath}`);
    const snapshot = {
      ...parsed,
      captureSideChannel: javaProvider.collectCaptureSideChannel?.(filePath),
    };
    populateClassOwnedMembers(snapshot);
    before.set(filePath, snapshot);
  }
  const after = [...before.values()];
  extraction.refused.add(refused);
  try {
    reconcileJavaLombokWorkspaceProof(after, {
      fileContents: new Map(Object.entries(files)),
      treeCache: trees,
    });
  } finally {
    extraction.refused.clear();
  }
  return { before, after: new Map(after.map((parsed) => [parsed.filePath, parsed])) };
}

const getters = (parsed: ParsedFile | undefined) =>
  parsed?.localDefs
    .filter((def) => def.type === 'Method' && def.isSynthetic && !def.isDeleted)
    .map((def) => def.qualifiedName) ?? [];

describe('Java Lombok workspace proof re-extraction failure', () => {
  it('keeps the original file and continues with the next one instead of throwing', () => {
    const result = reconcileRefusing(
      {
        'A.java': 'package p; import lombok.*; @Value class A { Repo repo; } class Repo {}',
        'B.java': 'package p; import lombok.*; @Value class B { String name; }',
        'Value.java': 'package p; public @interface Value {}',
      },
      'A.java',
    );
    assert.equal(result.after.get('A.java'), result.before.get('A.java'));
    assert.deepEqual(getters(result.before.get('B.java')), ['B.getName']);
    assert.deepEqual(getters(result.after.get('B.java')), []);
  });
});
