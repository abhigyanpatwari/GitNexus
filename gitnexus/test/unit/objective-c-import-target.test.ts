import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';

import { resolveObjectiveCImportClosure } from '../../src/core/ingestion/languages/objective-c/import-closure.js';
import { resolveObjectiveCImportTarget } from '../../src/core/ingestion/languages/objective-c/import-target.js';
import { objectiveCScopeResolver } from '../../src/core/ingestion/languages/objective-c/scope-resolver.js';

describe('Objective-C import target resolution', () => {
  it('prefers a quoted same-directory header', () => {
    const files = new Set(['Sources/Feature/Store.m', 'Sources/Feature/Store.h', 'Store.h']);
    expect(resolveObjectiveCImportTarget('Store.h', 'Sources/Feature/Store.m', files)).toBe(
      'Sources/Feature/Store.h',
    );
  });

  it('resolves framework-style headers only when the suffix is unique', () => {
    expect(
      resolveObjectiveCImportTarget(
        'Feature/Store.h',
        'Sources/App.m',
        new Set(['Vendor/Feature/Store.h', 'Sources/App.m']),
      ),
    ).toBe('Vendor/Feature/Store.h');
    expect(
      resolveObjectiveCImportTarget(
        'Feature/Store.h',
        'Sources/App.m',
        new Set(['VendorA/Feature/Store.h', 'VendorB/Feature/Store.h']),
      ),
    ).toBeNull();
  });

  it('does not give angle-bracket imports quoted-header sibling precedence', () => {
    const resolveSystemImport = resolveObjectiveCImportTarget as unknown as (
      targetRaw: string,
      fromFile: string,
      allFilePaths: ReadonlySet<string>,
      options: { readonly isSystem: boolean },
    ) => string | null;

    expect(
      resolveSystemImport(
        'Feature/Store.h',
        'Sources/App.m',
        new Set(['Sources/Feature/Store.h', 'Vendor/Feature/Store.h']),
        { isSystem: true },
      ),
    ).toBeNull();
  });

  it('resolves a unique CocoaPods-style module header below an intermediate Classes directory', () => {
    expect(
      resolveObjectiveCImportTarget(
        'FeatureKit/FeatureKit.h',
        'Sources/App.m',
        new Set(['SDK/FeatureKit/FeatureKit/Classes/FeatureKit.h', 'Sources/App.m']),
        { isSystem: true },
      ),
    ).toBe('SDK/FeatureKit/FeatureKit/Classes/FeatureKit.h');

    expect(
      resolveObjectiveCImportTarget(
        'FeatureKit/FeatureKit.h',
        'Sources/App.m',
        new Set([
          'SDK/FeatureKit/FeatureKit/Classes/FeatureKit.h',
          'Vendor/FeatureKit/Headers/FeatureKit.h',
        ]),
        { isSystem: true },
      ),
    ).toBeNull();
  });

  it('fails closed when literal and CocoaPods-style system header matches cross tiers', () => {
    expect(
      resolveObjectiveCImportTarget(
        'FeatureKit/FeatureKit.h',
        'Sources/App.m',
        new Set(['Vendor/FeatureKit/FeatureKit.h', 'Pods/FeatureKit/Classes/FeatureKit.h']),
        { isSystem: true },
      ),
    ).toBeNull();
  });

  it('does not apply CocoaPods-style module matching to quoted imports', () => {
    expect(
      resolveObjectiveCImportTarget(
        'FeatureKit/FeatureKit.h',
        'Sources/App.m',
        new Set(['Pods/FeatureKit/Classes/FeatureKit.h']),
      ),
    ).toBeNull();
  });

  it('requires the system module name to match complete directory segments', () => {
    expect(
      resolveObjectiveCImportTarget(
        'FeatureKit/FeatureKit.h',
        'Sources/App.m',
        new Set(['Pods/MyFeatureKit/Classes/FeatureKit.h']),
        { isSystem: true },
      ),
    ).toBeNull();
  });

  it('requires the system module header basename to match', () => {
    expect(
      resolveObjectiveCImportTarget(
        'FeatureKit/FeatureKit.h',
        'Sources/App.m',
        new Set(['Pods/FeatureKit/Classes/Other.h']),
        { isSystem: true },
      ),
    ).toBeNull();
  });

  it('maps a project module to its unique umbrella header', () => {
    expect(
      resolveObjectiveCImportTarget(
        'FeatureKit',
        'Sources/App.m',
        new Set(['Packages/FeatureKit/FeatureKit.h', 'Sources/App.m']),
      ),
    ).toBe('Packages/FeatureKit/FeatureKit.h');
  });

  it('fails closed for external modules and paths escaping the workspace', () => {
    const files = new Set(['Sources/App.m', 'Secrets.h']);
    expect(resolveObjectiveCImportTarget('Foundation', 'Sources/App.m', files)).toBeNull();
    expect(resolveObjectiveCImportTarget('../../Secrets.h', 'Sources/App.m', files)).toBeNull();
  });

  it('builds the workspace path index once and reuses cached system misses', () => {
    const backing = new Set(['Sources/App.m', 'Sources/Other.m', 'Vendor/Feature/Store.h']);
    let iterations = 0;
    const files: ReadonlySet<string> = {
      size: backing.size,
      has: (value) => backing.has(value),
      entries: () => backing.entries(),
      keys: () => backing.keys(),
      values: () => backing.values(),
      forEach: (callback, thisArg) => backing.forEach(callback, thisArg),
      [Symbol.iterator]: () => {
        iterations += 1;
        return backing[Symbol.iterator]();
      },
    };

    expect(
      resolveObjectiveCImportTarget('UIKit/UIKit.h', 'Sources/App.m', files, {
        isSystem: true,
      }),
    ).toBeNull();
    expect(
      resolveObjectiveCImportTarget('UIKit/UIKit.h', 'Sources/Other.m', files, {
        isSystem: true,
      }),
    ).toBeNull();
    expect(
      resolveObjectiveCImportTarget('Foundation/Foundation.h', 'Sources/App.m', files, {
        isSystem: true,
      }),
    ).toBeNull();
    expect(iterations).toBe(1);
  });

  it('expands a local umbrella header transitively and terminates header cycles', () => {
    const files = new Set([
      'Sources/App.m',
      'Vendor/FeatureKit/FeatureKit.h',
      'Vendor/FeatureKit/PublicBase.h',
    ]);
    const parsedFiles = [
      {
        filePath: 'Vendor/FeatureKit/FeatureKit.h',
        parsedImports: [{ kind: 'wildcard', targetRaw: 'PublicBase.h' }],
      },
      {
        filePath: 'Vendor/FeatureKit/PublicBase.h',
        parsedImports: [{ kind: 'wildcard', targetRaw: 'FeatureKit.h' }],
      },
    ] as unknown as readonly ParsedFile[];

    expect(
      resolveObjectiveCImportClosure(
        'FeatureKit/FeatureKit.h',
        'Sources/App.m',
        files,
        parsedFiles,
      ),
    ).toEqual(['Vendor/FeatureKit/FeatureKit.h', 'Vendor/FeatureKit/PublicBase.h']);
  });

  it('discovers a header context from primary source when no ParsedFile cache is available', () => {
    const collect = objectiveCScopeResolver.collectScopeContextPaths;
    expect(collect).toBeDefined();

    const paths = collect?.({
      primaryFilePaths: ['Sources/App.m'],
      preExtractedByPath: new Map(),
      entryFileContents: new Map([['Sources/App.m', '#import "Legacy.h"\n@interface App\n@end\n']]),
      allScannedPaths: new Set(['Sources/App.m', 'Sources/Legacy.h']),
      resolutionConfig: undefined,
    });

    expect(paths).toEqual(new Set(['Sources/App.m', 'Sources/Legacy.h']));
  });

  it('resolves imports when the optional parsedImport context is absent', () => {
    const files = new Set(['Sources/App.m', 'Sources/Legacy.h']);

    expect(
      objectiveCScopeResolver.resolveImportTarget?.('Legacy.h', 'Sources/App.m', files, undefined, {
        parsedFiles: [],
      }),
    ).toBe('Sources/Legacy.h');
  });
});
