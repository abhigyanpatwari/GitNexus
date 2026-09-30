import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { refineRExportStatus } from '../../src/core/ingestion/languages/r/post-parse.js';
import type {
  RNamespaceInfo,
  RPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import { SupportedLanguages } from 'gitnexus-shared';

// Regression tests for fork #6: refineRExportStatus must treat the empty
// package dir ('' = DESCRIPTION/NAMESPACE at the repo root) as containing every path.
const info = (over: Partial<RNamespaceInfo> = {}): RNamespaceInfo => ({
  hasNamespaceFile: true,
  namedExports: new Set(),
  exportPatterns: [],
  importFrom: [],
  ...over,
});

const configFor = (entries: Record<string, RNamespaceInfo>): RPackageConfig => ({
  packages: new Map(Object.keys(entries).map((dir, i) => [`pkg${i}`, dir])),
  namespaceInfoByPackageDir: new Map(Object.entries(entries)),
});

const run = (
  config: RPackageConfig | null,
  defs: { name: string; filePath: string }[],
): Map<string, unknown> => {
  const graph = createKnowledgeGraph();
  for (const d of defs) {
    graph.addNode({
      id: `Function:${d.filePath}:${d.name}`,
      label: 'Function',
      properties: {
        name: d.name,
        filePath: d.filePath,
        language: SupportedLanguages.R,
        isExported: true,
      },
    });
  }
  refineRExportStatus(graph, config);
  const out = new Map<string, unknown>();
  graph.forEachNode((n) =>
    out.set(`${n.properties.filePath}:${n.properties.name}`, n.properties.isExported),
  );
  return out;
};

describe('refineRExportStatus with a root-level package (pkgDir === "")', () => {
  it('keeps explicit exports public and flips the rest to not exported', () => {
    const out = run(configFor({ '': info({ namedExports: new Set(['pub']) }) }), [
      { name: 'pub', filePath: 'R/a.R' },
      { name: 'helper', filePath: 'R/a.R' },
    ]);
    expect(out.get('R/a.R:pub')).toBe(true);
    expect(out.get('R/a.R:helper')).toBe(false);
  });

  it('honours exportPattern', () => {
    const out = run(configFor({ '': info({ exportPatterns: [/^Pat/] }) }), [
      { name: 'PatOne', filePath: 'R/a.R' },
      { name: 'other', filePath: 'R/a.R' },
    ]);
    expect(out.get('R/a.R:PatOne')).toBe(true);
    expect(out.get('R/a.R:other')).toBe(false);
  });

  it('treats S3method-derived names (in namedExports) as exported', () => {
    const out = run(configFor({ '': info({ namedExports: new Set(['print.Foo']) }) }), [
      { name: 'print.Foo', filePath: 'R/s3.R' },
    ]);
    expect(out.get('R/s3.R:print.Foo')).toBe(true);
  });

  it('leaves everything public when the root package has no NAMESPACE', () => {
    const out = run(configFor({ '': info({ hasNamespaceFile: false }) }), [
      { name: 'helper', filePath: 'R/a.R' },
    ]);
    expect(out.get('R/a.R:helper')).toBe(true);
  });

  it('normalises backslash paths', () => {
    const out = run(configFor({ '': info() }), [{ name: 'helper', filePath: 'R\\a.R' }]);
    expect(out.get('R\\a.R:helper')).toBe(false);
  });
});

describe('refineRExportStatus with a nested package (unchanged)', () => {
  it('applies the nested package NAMESPACE only to files under that dir', () => {
    const out = run(configFor({ pkg: info({ namedExports: new Set(['pub']) }) }), [
      { name: 'pub', filePath: 'pkg/R/a.R' },
      { name: 'helper', filePath: 'pkg/R/a.R' },
      { name: 'outside', filePath: 'scripts/run.R' },
      { name: 'prefixed', filePath: 'pkgextra/R/a.R' },
    ]);
    expect(out.get('pkg/R/a.R:pub')).toBe(true);
    expect(out.get('pkg/R/a.R:helper')).toBe(false);
    expect(out.get('scripts/run.R:outside')).toBe(true);
    expect(out.get('pkgextra/R/a.R:prefixed')).toBe(true);
  });

  it('lets the deepest package win when a root package also exists', () => {
    const out = run(
      configFor({
        '': info({ namedExports: new Set() }),
        sub: info({ namedExports: new Set(['inSub']) }),
      }),
      [
        { name: 'inSub', filePath: 'sub/R/a.R' },
        { name: 'inRoot', filePath: 'R/a.R' },
      ],
    );
    expect(out.get('sub/R/a.R:inSub')).toBe(true);
    expect(out.get('R/a.R:inRoot')).toBe(false);
  });
});
