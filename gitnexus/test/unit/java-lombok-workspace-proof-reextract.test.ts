import { describe, expect, it, vi } from 'vitest';
import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';

/** Files whose workspace re-extraction is made to fail; first extractions still run. */
const extraction = vi.hoisted(() => ({ refused: new Set<string>() }));

vi.mock('../../src/core/ingestion/scope-extractor-bridge.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/core/ingestion/scope-extractor-bridge.js')>();
  return {
    ...actual,
    extractParsedFile: (...args: Parameters<typeof actual.extractParsedFile>) =>
      extraction.refused.has(args[2]) ? undefined : actual.extractParsedFile(...args),
  };
});

const { javaProvider } = await import('../../src/core/ingestion/languages/java.js');
const { extractParsedFile } = await import('../../src/core/ingestion/scope-extractor-bridge.js');
const { populateClassOwnedMembers } =
  await import('../../src/core/ingestion/scope-resolution/scope/walkers.js');
const { reconcileJavaLombokWorkspaceProof } =
  await import('../../src/core/ingestion/languages/java/lombok-workspace-proof.js');
const { clearJavaClassAnnotationFacts } =
  await import('../../src/core/ingestion/languages/java/capture-side-channel.js');
const { clearJavaPackageFacts } =
  await import('../../src/core/ingestion/languages/java/package-facts.js');
const { getJavaParser } = await import('../../src/core/ingestion/languages/java/query.js');

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
    expect(result.after.get('A.java')).toBe(result.before.get('A.java'));
    expect(getters(result.before.get('B.java'))).toEqual(['B.getName']);
    expect(getters(result.after.get('B.java'))).toEqual([]);
  });
});
