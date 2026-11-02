/**
 * In-repo @_exported visibility (R5 / AE4).
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, ParsedImport, ScopeId } from 'gitnexus-shared';
import { resolveSwiftImportTarget } from '../../../../src/core/ingestion/languages/swift/import-target.js';

const DECLARED = {
  origin: 'package.swift' as const,
  targets: new Map([
    ['A', 'Sources/A'],
    ['B', 'Sources/B'],
    ['C', 'Sources/C'],
  ]),
};

function stubFile(filePath: string, parsedImports: ParsedImport[] = []): ParsedFile {
  return {
    filePath,
    moduleScope: `module:${filePath}` as ScopeId,
    scopes: [],
    parsedImports,
    localDefs: [],
    referenceSites: [],
  };
}

function reexport(targetRaw: string, name = targetRaw): ParsedImport {
  return { kind: 'reexport', localName: name, importedName: name, targetRaw };
}

function ns(targetRaw: string): ParsedImport {
  return { kind: 'namespace', localName: targetRaw, importedName: targetRaw, targetRaw };
}

function resolve(
  targetRaw: string,
  files: readonly string[],
  parsedFiles: ParsedFile[],
  fromFile = 'Sources/App/main.swift',
  resolutionConfig: unknown = DECLARED,
): string | readonly string[] | null {
  return resolveSwiftImportTarget(ns(targetRaw), {
    fromFile,
    allFilePaths: new Set(files),
    resolutionConfig,
    parsedFiles,
  });
}

describe('Swift @_exported visibility', () => {
  it('AE4: import A includes B when A @_exported import B', () => {
    const files = ['Sources/A/A.swift', 'Sources/B/B.swift', 'Sources/App/main.swift'];
    const parsed = [
      stubFile('Sources/A/A.swift', [reexport('B')]),
      stubFile('Sources/B/B.swift'),
      stubFile('Sources/App/main.swift'),
    ];
    expect(resolve('A', files, parsed)).toEqual(
      expect.arrayContaining(['Sources/A/A.swift', 'Sources/B/B.swift']),
    );
  });

  it('transitive A → B → C unions C', () => {
    const files = ['Sources/A/A.swift', 'Sources/B/B.swift', 'Sources/C/C.swift'];
    const parsed = [
      stubFile('Sources/A/A.swift', [reexport('B')]),
      stubFile('Sources/B/B.swift', [reexport('C')]),
      stubFile('Sources/C/C.swift'),
    ];
    expect(resolve('A', files, parsed, 'Sources/App/main.swift')).toEqual(
      expect.arrayContaining(['Sources/A/A.swift', 'Sources/B/B.swift', 'Sources/C/C.swift']),
    );
  });

  it('cycle A → B → A terminates', () => {
    const files = ['Sources/A/A.swift', 'Sources/B/B.swift'];
    const parsed = [
      stubFile('Sources/A/A.swift', [reexport('B')]),
      stubFile('Sources/B/B.swift', [reexport('A')]),
    ];
    expect(resolve('A', files, parsed)).toEqual(
      expect.arrayContaining(['Sources/A/A.swift', 'Sources/B/B.swift']),
    );
  });

  it('@_exported import Foundation adds no files', () => {
    const files = ['Sources/A/A.swift', 'Sources/Foundation/Thing.swift', 'Sources/App/main.swift'];
    const parsed = [
      stubFile('Sources/A/A.swift', [reexport('Foundation')]),
      stubFile('Sources/Foundation/Thing.swift'),
    ];
    expect(resolve('A', files, parsed)).toEqual(['Sources/A/A.swift']);
  });

  it('member-only @_exported import does not paint the rest of the module', () => {
    const files = [
      'Sources/A/A.swift',
      'Sources/Models/User.swift',
      'Sources/Models/Other.swift',
      'Sources/App/main.swift',
    ];
    const parsed = [
      stubFile('Sources/A/A.swift', [reexport('Models', 'User')]),
      stubFile('Sources/Models/User.swift'),
      stubFile('Sources/Models/Other.swift'),
    ];
    const declared = {
      origin: 'package.swift' as const,
      targets: new Map([
        ['A', 'Sources/A'],
        ['Models', 'Sources/Models'],
      ]),
    };
    expect(resolve('A', files, parsed, 'Sources/App/main.swift', declared)).toEqual([
      'Sources/A/A.swift',
    ]);
  });

  it('a sibling file that does not write @_exported still contributes the reexport', () => {
    const files = ['Sources/A/A.swift', 'Sources/A/Other.swift', 'Sources/B/B.swift'];
    const parsed = [
      stubFile('Sources/A/A.swift', [reexport('B')]),
      stubFile('Sources/A/Other.swift'),
      stubFile('Sources/B/B.swift'),
    ];
    expect(resolve('A', files, parsed)).toEqual(
      expect.arrayContaining(['Sources/A/A.swift', 'Sources/A/Other.swift', 'Sources/B/B.swift']),
    );
  });
});
