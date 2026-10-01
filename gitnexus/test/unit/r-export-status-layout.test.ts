import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { refineRExportStatus } from '../../src/core/ingestion/languages/r/post-parse.js';
import type {
  RNamespaceInfo,
  RPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import { SupportedLanguages } from 'gitnexus-shared';

// NAMESPACE export refinement is derived from the discovered package directory: it applies to
// `<packageDir>/R/` only (R loads nothing else into a package namespace), and the longest
// package directory containing a file owns it, whether or not that package has a NAMESPACE.
const info = (over: Partial<RNamespaceInfo> = {}): RNamespaceInfo => ({
  hasNamespaceFile: true,
  namedExports: new Set(),
  exportPatterns: [],
  importFrom: [],
  ...over,
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

const NON_R_DIRS = ['tests/testthat', 'vignettes', 'inst/scripts', 'data-raw', 'scripts', 'demo'];

describe.each([
  { label: 'root-level package', dir: '', prefix: '' },
  { label: 'nested package', dir: 'pkgs/foo', prefix: 'pkgs/foo/' },
])('refineRExportStatus: $label', ({ dir, prefix }) => {
  const config = (): RPackageConfig => ({
    packages: new Map([['foo', dir]]),
    namespaceInfoByPackageDir: new Map([[dir, info({ namedExports: new Set(['pub']) })]]),
  });

  it('flips only unexported R/ symbols; files outside R/ keep their default', () => {
    const defs = [
      { name: 'pub', filePath: `${prefix}R/a.R` },
      { name: 'hidden', filePath: `${prefix}R/a.R` },
      ...NON_R_DIRS.map((d) => ({ name: 'helper', filePath: `${prefix}${d}/x.R` })),
    ];
    const out = run(config(), defs);
    expect(out.get(`${prefix}R/a.R:pub`)).toBe(true);
    expect(out.get(`${prefix}R/a.R:hidden`)).toBe(false);
    for (const d of NON_R_DIRS) expect(out.get(`${prefix}${d}/x.R:helper`)).toBe(true);
  });

  it('treats backslash-separated file paths like slash-separated ones', () => {
    const win = (p: string): string => p.replace(/\//g, '\\');
    const out = run(config(), [
      { name: 'hidden', filePath: win(`${prefix}R/a.R`) },
      { name: 'helper', filePath: win(`${prefix}tests/testthat/x.R`) },
    ]);
    expect(out.get(win(`${prefix}R/a.R`) + ':hidden')).toBe(false);
    expect(out.get(win(`${prefix}tests/testthat/x.R`) + ':helper')).toBe(true);
  });

  it('does not take a sibling directory sharing the package directory name as a prefix', () => {
    if (dir === '') return;
    const out = run(config(), [{ name: 'hidden', filePath: `${dir}-extra/R/a.R` }]);
    expect(out.get(`${dir}-extra/R/a.R:hidden`)).toBe(true);
  });
});

describe('refineRExportStatus: nested packages', () => {
  it('a nested package without NAMESPACE does not inherit the enclosing package NAMESPACE', () => {
    const config: RPackageConfig = {
      packages: new Map([
        ['outer', ''],
        ['inner', 'pkgs/inner'],
      ]),
      namespaceInfoByPackageDir: new Map([['', info({ namedExports: new Set(['outer_pub']) })]]),
    };
    const out = run(config, [
      { name: 'outer_pub', filePath: 'R/o.R' },
      { name: 'outer_hidden', filePath: 'R/o.R' },
      { name: 'inner_fn', filePath: 'pkgs/inner/R/i.R' },
      { name: 'inner_test_helper', filePath: 'pkgs/inner/tests/testthat/t.R' },
    ]);
    expect(out.get('R/o.R:outer_pub')).toBe(true);
    expect(out.get('R/o.R:outer_hidden')).toBe(false);
    expect(out.get('pkgs/inner/R/i.R:inner_fn')).toBe(true);
    expect(out.get('pkgs/inner/tests/testthat/t.R:inner_test_helper')).toBe(true);
  });

  it('a same-name copy of a package that discovery did not register by name still owns its own R/ files', () => {
    const config: RPackageConfig = {
      packages: new Map([['outer', '']]),
      namespaceInfoByPackageDir: new Map([['', info({ namedExports: new Set(['outer_pub']) })]]),
      packageDirs: new Set(['', 'vendor/copy']),
    };
    const out = run(config, [
      { name: 'copy_fn', filePath: 'vendor/copy/R/c.R' },
      { name: 'outer_hidden', filePath: 'R/o.R' },
    ]);
    expect(out.get('vendor/copy/R/c.R:copy_fn')).toBe(true);
    expect(out.get('R/o.R:outer_hidden')).toBe(false);
  });

  it('honours each package NAMESPACE, deepest package first', () => {
    const config: RPackageConfig = {
      packages: new Map([
        ['outer', ''],
        ['inner', 'pkgs/inner'],
      ]),
      namespaceInfoByPackageDir: new Map([
        ['', info({ namedExports: new Set(['shared']) })],
        ['pkgs/inner', info({ namedExports: new Set(['inner_pub']) })],
      ]),
    };
    const out = run(config, [
      { name: 'shared', filePath: 'R/o.R' },
      { name: 'shared', filePath: 'pkgs/inner/R/i.R' },
      { name: 'inner_pub', filePath: 'pkgs/inner/R/i.R' },
    ]);
    expect(out.get('R/o.R:shared')).toBe(true);
    expect(out.get('pkgs/inner/R/i.R:shared')).toBe(false);
    expect(out.get('pkgs/inner/R/i.R:inner_pub')).toBe(true);
  });
});
