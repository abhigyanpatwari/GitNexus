import { describe, it, expect } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { csharpProvider } from '../../../../src/core/ingestion/languages/csharp.js';
import { populateClassOwnedMembers } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { populateCsharpNamespacePrefixes } from '../../../../src/core/ingestion/languages/csharp/qualified-type-names.js';

function parse(src: string, filePath: string): ParsedFile {
  const parsed = extractParsedFile(csharpProvider, src, filePath);
  if (parsed === undefined) throw new Error(`extractParsedFile returned undefined for ${filePath}`);
  populateClassOwnedMembers(parsed);
  populateCsharpNamespacePrefixes(parsed);
  return parsed;
}

describe('populateCsharpNamespacePrefixes', () => {
  it('stamps a file-scoped namespace on the sidecar without touching qualifiedName', () => {
    const parsed = parse(`namespace B;\npublic class Foo { public Foo() {} }`, 'B/Foo.cs');
    const foo = parsed.localDefs.find(
      (d) => d.type === 'Class' && d.qualifiedName?.endsWith('Foo'),
    );
    expect(foo?.namespacePrefix).toBe('B');
    expect(foo?.qualifiedName).toBe('Foo');
  });

  it('stamps a block-scoped nested namespace path', () => {
    const parsed = parse(`namespace A.B { public class Foo { public Foo() {} } }`, 'A/B/Foo.cs');
    const foo = parsed.localDefs.find(
      (d) => d.type === 'Class' && d.qualifiedName?.endsWith('Foo'),
    );
    expect(foo?.namespacePrefix).toBe('A.B');
    expect(foo?.qualifiedName).toBe('Foo');
  });

  it('leaves a namespace-free type untagged', () => {
    const parsed = parse(`public class Foo { public Foo() {} }`, 'Foo.cs');
    const foo = parsed.localDefs.find((d) => d.type === 'Class');
    expect(foo?.namespacePrefix).toBeUndefined();
  });
});
