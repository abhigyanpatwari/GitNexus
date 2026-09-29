/**
 * Swift import capture: import-kind, @_exported, and module path (R5, R6).
 */
import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from '../../../../src/config/supported-languages.js';
import { emitSwiftScopeCaptures } from '../../../../src/core/ingestion/languages/swift/index.js';
import { interpretSwiftImport } from '../../../../src/core/ingestion/languages/swift/interpret.js';
import { isLanguageAvailable } from '../../../../src/core/tree-sitter/parser-loader.js';

function importsOf(src: string) {
  return emitSwiftScopeCaptures(src, 'Probe.swift')
    .map((match) => interpretSwiftImport(match))
    .filter((imp): imp is NonNullable<typeof imp> => imp !== null);
}

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

describe.skipIf(!swiftAvailable)('interpretSwiftImport via emitSwiftScopeCaptures', () => {
  it('import Foundation is a namespace, not exported', () => {
    expect(importsOf('import Foundation')).toEqual([
      {
        kind: 'namespace',
        localName: 'Foundation',
        importedName: 'Foundation',
        targetRaw: 'Foundation',
      },
    ]);
  });

  it('import struct Models.User is a named binding of User', () => {
    expect(importsOf('import struct Models.User')).toEqual([
      {
        kind: 'named',
        localName: 'User',
        importedName: 'User',
        targetRaw: 'Models',
      },
    ]);
  });

  it('allows a block comment between import and its kind', () => {
    expect(importsOf('import /* selected API */ struct Models.User')).toEqual([
      {
        kind: 'named',
        localName: 'User',
        importedName: 'User',
        targetRaw: 'Models',
      },
    ]);
  });

  it('allows a line comment between import and its kind', () => {
    expect(importsOf('import // selected API\nstruct Models.User')).toEqual([
      {
        kind: 'named',
        localName: 'User',
        importedName: 'User',
        targetRaw: 'Models',
      },
    ]);
  });

  it('reads the kind after a long block comment that repeats star-slash-slash-star', () => {
    const noise = '*//*'.repeat(80);
    expect(importsOf(`import /* ${noise} */ struct Models.User`)).toEqual([
      {
        kind: 'named',
        localName: 'User',
        importedName: 'User',
        targetRaw: 'Models',
      },
    ]);
  });

  it('does not take import kind from an @available message string', () => {
    expect(
      importsOf('@available(*, deprecated, message: "import struct") import Foo.Bar'),
    ).toMatchObject([{ kind: 'namespace', targetRaw: 'Foo' }]);
  });

  it('preserves @testable as the same module', () => {
    const [imp] = importsOf('@testable import App');
    expect(imp).toMatchObject({
      kind: 'namespace',
      targetRaw: 'App',
    });
  });

  it('@_exported import Models is a reexport of the module handle', () => {
    expect(importsOf('@_exported import Models')).toEqual([
      {
        kind: 'reexport',
        localName: 'Models',
        importedName: 'Models',
        targetRaw: 'Models',
      },
    ]);
  });

  it('@_exported import struct Models.User is a reexport of User', () => {
    expect(importsOf('@_exported import struct Models.User')).toEqual([
      {
        kind: 'reexport',
        localName: 'User',
        importedName: 'User',
        targetRaw: 'Models',
      },
    ]);
  });

  it('public import Models is not a reexport', () => {
    expect(importsOf('public import Models')).toEqual([
      {
        kind: 'namespace',
        localName: 'Models',
        importedName: 'Models',
        targetRaw: 'Models',
      },
    ]);
  });

  it('does not treat _exported inside an @available message as @_exported', () => {
    expect(importsOf('@available(*, deprecated, message: "_exported") import Models')).toEqual([
      {
        kind: 'namespace',
        localName: 'Models',
        importedName: 'Models',
        targetRaw: 'Models',
      },
    ]);
  });

  it('reads the kind after a comment that itself contains import', () => {
    expect(importsOf('import /* import */ struct Models.User')).toEqual([
      {
        kind: 'named',
        localName: 'User',
        importedName: 'User',
        targetRaw: 'Models',
      },
    ]);
  });

  it('reads the kind after nested block comments', () => {
    expect(importsOf('import /* outer /* inner */ */ struct Models.User')).toEqual([
      {
        kind: 'named',
        localName: 'User',
        importedName: 'User',
        targetRaw: 'Models',
      },
    ]);
  });
});
