import { describe, expect, it } from 'vitest';

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
});
