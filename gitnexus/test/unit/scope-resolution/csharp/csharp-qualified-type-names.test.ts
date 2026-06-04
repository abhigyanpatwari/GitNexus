import { describe, it, expect } from 'vitest';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { csharpProvider } from '../../../../src/core/ingestion/languages/csharp.js';
import { populateClassOwnedMembers } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { populateCsharpNamespaceQualifiedNames } from '../../../../src/core/ingestion/languages/csharp/qualified-type-names.js';

describe('populateCsharpNamespaceQualifiedNames', () => {
  it('stamps file-scoped namespace types for QualifiedNameIndex lookup', () => {
    const src = `namespace B;\npublic class Foo { public Foo() {} }`;
    const parsed = extractParsedFile(csharpProvider, src, 'B/Foo.cs');
    populateClassOwnedMembers(parsed);
    populateCsharpNamespaceQualifiedNames(parsed);
    const foo = parsed.localDefs.find(
      (d) => d.type === 'Class' && d.qualifiedName?.endsWith('Foo'),
    );
    expect(foo?.qualifiedName).toBe('B.Foo');
  });
});
