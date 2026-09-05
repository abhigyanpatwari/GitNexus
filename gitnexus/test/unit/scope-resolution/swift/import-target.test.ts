import { describe, expect, it } from 'vitest';
import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { resolveSwiftImportTarget } from '../../../../src/core/ingestion/languages/swift/import-target.js';

const files = new Set([
  'Sources/Foundation/Thing.swift',
  'Sources/Implementation/Nested/Value.swift',
  'Sources/App/main.swift',
]);

function resolve(targetRaw: string, targets?: ReadonlyMap<string, string> | null) {
  const parsedImport: ParsedImport = {
    kind: 'namespace',
    localName: targetRaw,
    importedName: targetRaw,
    targetRaw,
  };
  const workspace = {
    fromFile: 'Sources/App/main.swift',
    allFilePaths: files,
    targets,
  } as unknown as WorkspaceIndex;
  return resolveSwiftImportTarget(parsedImport, workspace);
}

describe('resolveSwiftImportTarget', () => {
  it('rejects modules that are not declared package targets', () => {
    const targets = new Map([['App', 'Sources/App']]);
    expect(resolve('Foundation', targets)).toBeNull();
  });

  it('resolves a declared target through its configured source directory', () => {
    const targets = new Map([['CoreKit', 'Sources/Implementation']]);
    expect(resolve('CoreKit', targets)).toEqual(['Sources/Implementation/Nested/Value.swift']);
  });

  it('uses the first segment for declaration-qualified imports', () => {
    const targets = new Map([['CoreKit', 'Sources/Implementation']]);
    expect(resolve('CoreKit.Value', targets)).toEqual([
      'Sources/Implementation/Nested/Value.swift',
    ]);
  });

  it('keeps directory fallback when no package config is available', () => {
    expect(resolve('Foundation', null)).toEqual(['Sources/Foundation/Thing.swift']);
  });
});
