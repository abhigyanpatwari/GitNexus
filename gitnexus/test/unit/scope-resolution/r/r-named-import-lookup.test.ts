/**
 * Looking up an `importFrom()` name that a provider's NAMESPACE does not export must cost one set
 * lookup, not a pass over every export: a NAMESPACE can carry any number of `export()` entries and
 * a caller any number of `importFrom()` names, so a scan per lookup is quadratic in repository text.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';
import type {
  RNamespaceInfo,
  RPackageConfig,
} from '../../../../src/core/ingestion/languages/r/package-config.js';
import { resolveRNamedImport } from '../../../../src/core/ingestion/import-resolvers/r.js';

/** A set that counts every way of walking all of its entries. */
class CountingSet extends Set<string> {
  walks = 0;
  override [Symbol.iterator](): SetIterator<string> {
    this.walks++;
    return super[Symbol.iterator]();
  }
  override values(): SetIterator<string> {
    this.walks++;
    return super.values();
  }
  override entries(): SetIterator<[string, string]> {
    this.walks++;
    return super.entries();
  }
  override forEach(...args: Parameters<Set<string>['forEach']>): void {
    this.walks++;
    super.forEach(...args);
  }
}

function setup(exportCount: number): {
  cfg: RPackageConfig;
  exports: CountingSet;
  file: ParsedFile;
} {
  const exports = new CountingSet();
  for (let i = 0; i < exportCount; i++) exports.add(`exported_${String(i)}`);
  const info: RNamespaceInfo = {
    hasNamespaceFile: true,
    namedExports: exports,
    exportPatterns: [],
    importFrom: [],
  };
  const cfg: RPackageConfig = {
    packages: new Map([['prov', 'prov']]),
    namespaceInfoByPackageDir: new Map([['prov', info]]),
  };
  const file = extractParsedFile(
    rProvider,
    'exported_5 <- function() 1\nprivate_fn <- function() 2',
    'prov/R/a.R',
  );
  if (file === undefined) throw new Error('no ParsedFile');
  return { cfg, exports, file };
}

describe('resolveRNamedImport: the cost of a name the NAMESPACE does not export', () => {
  it('walks the export set once for any number of lookups of names that are not exported', () => {
    const { cfg, exports, file } = setup(1_000);
    for (let i = 0; i < 100; i++) {
      expect(resolveRNamedImport(cfg, 'prov', `private_fn_${String(i)}`, [file])).toBeNull();
    }
    expect(resolveRNamedImport(cfg, 'prov', 'private_fn', [file])).toBeNull();
    // One pass builds the index of backticked entries; a scan per lookup would be 101 walks.
    expect(exports.walks).toBe(1);
  });

  it('still matches a backticked entry, and reads the set again after it changed', () => {
    const { cfg, exports, file } = setup(10);
    expect(resolveRNamedImport(cfg, 'prov', 'private_fn', [file])).toBeNull();
    exports.add('`private_fn`');
    expect(resolveRNamedImport(cfg, 'prov', 'private_fn', [file])).toEqual(['prov/R/a.R']);
  });

  it('does not walk the export set for an exported name', () => {
    const { cfg, exports, file } = setup(1_000);
    expect(resolveRNamedImport(cfg, 'prov', 'exported_5', [file])).toEqual(['prov/R/a.R']);
    expect(exports.walks).toBe(0);
  });

  it('answers 20,000 lookups against 20,000 exports well inside a generous bound', () => {
    const { cfg, file } = setup(20_000);
    const start = performance.now();
    for (let i = 0; i < 20_000; i++) {
      resolveRNamedImport(cfg, 'prov', `private_fn_${String(i)}`, [file]);
    }
    // One set lookup each: a few milliseconds. The scan this replaced took about two seconds.
    expect(performance.now() - start).toBeLessThan(500);
  });
});
