/**
 * Registry-primary Swift import resolve (PR 3105 / #2964).
 */
import { describe, expect, it } from 'vitest';
import type { ParsedImport } from 'gitnexus-shared';
import { resolveSwiftImportTarget } from '../../../../src/core/ingestion/languages/swift/import-target.js';

const AE1_FILES = [
  'Sources/Foundation/Thing.swift',
  'Sources/Models/User.swift',
  'Sources/App/main.swift',
] as const;

function ns(targetRaw: string): ParsedImport {
  return { kind: 'namespace', localName: targetRaw, importedName: targetRaw, targetRaw };
}

function resolve(
  targetRaw: string,
  files: readonly string[] = AE1_FILES,
  fromFile = 'Sources/App/main.swift',
  resolutionConfig?: unknown,
): string | readonly string[] | null {
  return resolveSwiftImportTarget(ns(targetRaw), {
    fromFile,
    allFilePaths: new Set(files),
    resolutionConfig,
  });
}

describe('resolveSwiftImportTarget — inferred / no config (R7)', () => {
  it('AE1: Foundation is null; Models reaches User.swift', () => {
    expect(resolve('Foundation')).toBeNull();
    expect(resolve('Models')).toEqual(['Sources/Models/User.swift']);
  });

  it('AE6: UIKit / CoreData / CoreGraphics are null on inferred decoys', () => {
    const files = [
      ...AE1_FILES,
      'Sources/UIKit/Thing.swift',
      'Sources/CoreData/Thing.swift',
      'Sources/CoreGraphics/Thing.swift',
    ];
    const inferred = {
      origin: 'directories' as const,
      targets: new Map([
        ['App', 'Sources/App'],
        ['Models', 'Sources/Models'],
        ['Foundation', 'Sources/Foundation'],
        ['UIKit', 'Sources/UIKit'],
        ['CoreData', 'Sources/CoreData'],
        ['CoreGraphics', 'Sources/CoreGraphics'],
      ]),
    };
    expect(resolve('UIKit', files, 'Sources/App/main.swift', inferred)).toBeNull();
    expect(resolve('CoreData', files, 'Sources/App/main.swift', inferred)).toBeNull();
    expect(resolve('CoreGraphics', files, 'Sources/App/main.swift', inferred)).toBeNull();
    expect(resolve('Models', files, 'Sources/App/main.swift', inferred)).toEqual([
      'Sources/Models/User.swift',
    ]);
  });
});

describe('resolveSwiftImportTarget — declared Package.swift (R3, R4)', () => {
  const declared = {
    origin: 'package.swift' as const,
    targets: new Map([
      ['Models', 'Sources/Models'],
      ['App', 'Sources/App'],
    ]),
  };

  it('AE2: Models reaches files; Foundation is null', () => {
    expect(resolve('Models', AE1_FILES, 'Sources/App/main.swift', declared)).toEqual([
      'Sources/Models/User.swift',
    ]);
    expect(resolve('Foundation', AE1_FILES, 'Sources/App/main.swift', declared)).toBeNull();
  });

  it('empty declared map makes every name external, including Foundation', () => {
    const empty = { origin: 'package.swift' as const, targets: new Map<string, string>() };
    expect(resolve('Foundation', AE1_FILES, 'Sources/App/main.swift', empty)).toBeNull();
    expect(resolve('Models', AE1_FILES, 'Sources/App/main.swift', empty)).toBeNull();
  });

  it('empty declaredTargets with inferred grouping folders stays external', () => {
    const loadedShape = {
      origin: 'package.swift' as const,
      targets: new Map([
        ['Foundation', 'Sources/Foundation'],
        ['App', 'Sources/App'],
        ['Models', 'Sources/Models'],
      ]),
      declaredTargets: new Map<string, string>(),
    };
    expect(resolve('Foundation', AE1_FILES, 'Sources/App/main.swift', loadedShape)).toBeNull();
    expect(resolve('Models', AE1_FILES, 'Sources/App/main.swift', loadedShape)).toBeNull();
  });

  it('a declared target literally named Foundation still resolves', () => {
    const namedFoundation = {
      origin: 'package.swift' as const,
      targets: new Map([['Foundation', 'Sources/Foundation']]),
    };
    expect(resolve('Foundation', AE1_FILES, 'Sources/App/main.swift', namedFoundation)).toEqual([
      'Sources/Foundation/Thing.swift',
    ]);
  });

  it('a declared path: "." target reaches root-level Swift files', () => {
    const files = ['Lib.swift', 'Sources/Other/X.swift'];
    expect(
      resolve('Lib', files, 'Sources/App/main.swift', {
        origin: 'package.swift',
        targets: new Map([['Lib', '.']]),
      }),
    ).toEqual(['Lib.swift', 'Sources/Other/X.swift']);
  });

  it('excludes the importer from its own module file list', () => {
    const files = ['Sources/Models/User.swift', 'Sources/Models/Other.swift'];
    expect(
      resolve('Models', files, 'Sources/Models/User.swift', {
        origin: 'package.swift',
        targets: new Map([['Models', 'Sources/Models']]),
      }),
    ).toEqual(['Sources/Models/Other.swift']);
  });
});

describe('resolveSwiftImportTarget — workspace modules (#3355)', () => {
  const files = [
    'Core/Net/Sources/Net/Client.swift',
    'Core/Net/Tests/NetTests/ClientTests.swift',
    'Features/Other/Sources/Net/Config.swift',
    'Features/Login/Sources/Login/Flow.swift',
    'Features/Login/Plugins/Gen/main.swift',
    'Docs/Net/Snippet.swift',
    'App/Main.swift',
  ];
  const modules = [
    { key: 'Core/Net/Sources/Net', name: 'Net', dir: 'Core/Net/Sources/Net', importable: true },
    {
      key: 'Core/Net/Tests/NetTests',
      name: 'NetTests',
      dir: 'Core/Net/Tests/NetTests',
      importable: true,
    },
    {
      key: 'Features/Other/Sources/Net',
      name: 'Net',
      dir: 'Features/Other/Sources/Net',
      importable: true,
    },
    {
      key: 'Features/Login/Sources/Login',
      name: 'Login',
      dir: 'Features/Login/Sources/Login',
      importable: true,
    },
    {
      key: 'Features/Login/Plugins/Gen',
      name: 'Gen',
      dir: 'Features/Login/Plugins/Gen',
      importable: false,
    },
    { key: 'xcode:App.xcodeproj:App', name: 'App', files: ['App/Main.swift'], importable: true },
  ];
  const config = (complete: boolean) => ({
    targets: new Map(),
    modules,
    moduleNamesComplete: complete,
  });
  const from = 'Features/Login/Sources/Login/Flow.swift';

  it('resolves a name to every module carrying it, not to folders named alike', () => {
    expect(resolve('Net', files, from, config(true))).toEqual([
      'Core/Net/Sources/Net/Client.swift',
      'Features/Other/Sources/Net/Config.swift',
    ]);
  });

  it('resolves an Xcode target by name', () => {
    expect(resolve('App', files, from, config(true))).toEqual(['App/Main.swift']);
  });

  it('never resolves a plugin, which is not importable', () => {
    expect(resolve('Gen', files, from, config(true))).toBeNull();
    expect(resolve('Gen', files, from, config(false))).toBeNull();
  });

  it('treats an unknown name as external when every manifest was read', () => {
    expect(resolve('Docs', files, from, config(true))).toBeNull();
  });

  it('falls back to the folder index for an unknown name when some manifest was not read', () => {
    expect(resolve('Docs', files, from, config(false))).toEqual(['Docs/Net/Snippet.swift']);
  });
});
