import { describe, expect, it } from 'vitest';
import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';
import { javaProvider } from '../../src/core/ingestion/languages/java.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { populateClassOwnedMembers } from '../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { reconcileJavaLombokWorkspaceProof } from '../../src/core/ingestion/languages/java/lombok-workspace-proof.js';
import { clearJavaClassAnnotationFacts } from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { clearJavaPackageFacts } from '../../src/core/ingestion/languages/java/package-facts.js';
import { getJavaParser } from '../../src/core/ingestion/languages/java/query.js';

function reconcile(files: Record<string, string>) {
  clearJavaClassAnnotationFacts();
  clearJavaPackageFacts();
  const trees = new Map<string, Parser.Tree>();
  const before = new Map<string, ParsedFile>();
  for (const [filePath, source] of Object.entries(files)) {
    const tree = getJavaParser().parse(source);
    trees.set(filePath, tree);
    const parsed = extractParsedFile(javaProvider, source, filePath, undefined, tree);
    if (parsed === undefined) throw new Error(`Missing Java extraction: ${filePath}`);
    const captureSideChannel = javaProvider.collectCaptureSideChannel?.(filePath);
    const snapshot = { ...parsed, captureSideChannel };
    populateClassOwnedMembers(snapshot);
    before.set(filePath, snapshot);
  }
  const after = [...before.values()];
  reconcileJavaLombokWorkspaceProof(after, {
    fileContents: new Map(Object.entries(files)),
    treeCache: trees,
  });
  return { before, after: new Map(after.map((parsed) => [parsed.filePath, parsed])) };
}

const getters = (parsed: ParsedFile | undefined) =>
  parsed?.localDefs
    .filter((def) => def.type === 'Method' && def.isSynthetic && !def.isDeleted)
    .map((def) => def.qualifiedName) ?? [];

describe('Java Lombok workspace proof recapture triggers', () => {
  it('does not replace an unchanged file for an unrelated external base and an already-known own-file annotation', () => {
    const result = reconcile({
      'Main.java': `package p;
@lombok.Value class Model { Repo repo; }
@interface AllArgsConstructor {}
@AllArgsConstructor class Custom { Repo repo; }
class Resource implements java.lang.AutoCloseable {
  public void close() {}
}
class Repo {}
`,
    });
    expect(getters(result.before.get('Main.java'))).toContain('Model.getRepo');
    expect(result.after.get('Main.java')).toBe(result.before.get('Main.java'));
  });

  it('still replaces a file for a foreign same-package annotation shadow', () => {
    const result = reconcile({
      'Model.java': 'package p; import lombok.*; @Value class Model { Repo repo; } class Repo {}',
      'Value.java': 'package p; public @interface Value {}',
    });
    expect(getters(result.before.get('Model.java'))).toContain('Model.getRepo');
    expect(result.after.get('Model.java')).not.toBe(result.before.get('Model.java'));
    expect(getters(result.after.get('Model.java'))).not.toContain('Model.getRepo');
  });

  it('still replaces a file for a foreign same-package type-root shadow', () => {
    const result = reconcile({
      'Model.java': 'package p; @lombok.Value class Model { Repo repo; } class Repo {}',
      'lombok.java': 'package p; public class lombok { public @interface Value {} }',
    });
    expect(getters(result.before.get('Model.java'))).toContain('Model.getRepo');
    expect(getters(result.after.get('Model.java'))).not.toContain('Model.getRepo');
  });

  it.each([
    ['marker', '@Getter', '\n'],
    ['normal', '@Getter()', '\n'],
    ['CRLF marker', '@Getter', '\r\n'],
    ['CRLF normal', '@Getter()', '\r\n'],
    ['same-line marker', '@Getter', ' '],
    ['same-line normal', '@Getter()', ' '],
  ])(
    'retains inherited-shadow correction for %s annotations with non-ASCII text',
    (_label, annotation, newline) => {
      const source = [
        '/* café 😀 */ package p; import lombok.*;',
        'class Base { public @interface Getter {} }',
        `class Model extends Base { ${annotation} Repo repo; }`,
        'class Repo {}',
      ].join(newline);
      const result = reconcile({ 'Main.java': source });
      expect(getters(result.before.get('Main.java'))).toContain('Model.getRepo');
      expect(result.after.get('Main.java')).not.toBe(result.before.get('Main.java'));
      expect(getters(result.after.get('Main.java'))).not.toContain('Model.getRepo');
    },
  );

  it('retains the original conservative trigger when an anonymous type fact is not mapped to a scope', () => {
    const result = reconcile({
      'Main.java': `package p;
@lombok.Value class Model { Repo repo; }
class Resource implements java.lang.AutoCloseable { public void close() {} }
class Holder { Object value = new Object() {}; }
class Repo {}
`,
    });
    expect(result.after.get('Main.java')).not.toBe(result.before.get('Main.java'));
    expect(getters(result.after.get('Main.java'))).toContain('Model.getRepo');
  });
});
