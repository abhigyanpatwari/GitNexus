/**
 * Swift import capture: import-kind, @_exported, and module path (R5, R6).
 */
import { describe, expect, it } from 'vitest';
import { emitSwiftScopeCaptures } from '../../../../src/core/ingestion/languages/swift/index.js';
import { interpretSwiftImport } from '../../../../src/core/ingestion/languages/swift/interpret.js';

function importsOf(src: string) {
  return emitSwiftScopeCaptures(src, 'Probe.swift')
    .map((match) => interpretSwiftImport(match))
    .filter((imp): imp is NonNullable<typeof imp> => imp !== null);
}

describe('interpretSwiftImport via emitSwiftScopeCaptures', () => {
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
});
