/**
 * The R rename guard for NAMESPACE exports, run on a real graph: `loadRPackageConfig` reads an
 * on-disk package, `refineRExportStatus` stamps `isExported` on real graph nodes (the same pass
 * the indexer runs), and `checkSafety` then reads that graph. A mock graph that never carries
 * `isExported` makes every function look exported, so the converse (a private function renames)
 * is only provable here.
 *
 * The planner also records the NAMESPACE it has just read from disk for the plan, and the guard
 * checks that too, so that a persisted `isExported: false` that is stale (NAMESPACE edited since
 * the index, no `R/` file touched) cannot let a rename strand an export. The last suite stages
 * that: an index-time NAMESPACE (the refined graph) and a different one on disk (the plan).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { SupportedLanguages } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  loadRPackageConfig,
  recordRPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import { refineRExportStatus } from '../../src/core/ingestion/languages/r/post-parse.js';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

const NAMESPACE = [
  'export(pub, `odd name`)',
  'exportPattern("^api_")',
  'S3method(print, foo)',
  'S3method(summary, foo, show_summary)',
  '',
].join('\n');

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-r-rename-ns-'));
  await fs.mkdir(path.join(root, 'pk', 'R'), { recursive: true });
  await fs.writeFile(path.join(root, 'pk', 'DESCRIPTION'), 'Package: pk\nVersion: 0.1.0\n');
  await fs.writeFile(path.join(root, 'pk', 'NAMESPACE'), NAMESPACE);
  await fs.mkdir(path.join(root, 'bare', 'R'), { recursive: true });
  await fs.writeFile(path.join(root, 'bare', 'DESCRIPTION'), 'Package: bare\nVersion: 0.1.0\n');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The graph of one file's functions, each carrying the export verdict the indexer stores. */
function graphOf(file: string, names: readonly string[]) {
  const graph = createKnowledgeGraph();
  for (const fn of names) {
    graph.addNode({
      id: `Function:${file}:${fn}`,
      label: 'Function',
      properties: {
        name: fn,
        filePath: file,
        language: SupportedLanguages.R,
        // The indexer stores `!!isExported`, and the R extractor defaults R symbols to public.
        isExported: true,
      },
    });
  }
  return graph;
}

const ALL = [
  'pub',
  '`odd name`',
  'hidden',
  'api_run',
  'print.foo',
  'show_summary',
  'summary.foo',
  'lonely',
];

/**
 * The verdict of renaming `name` (defined in `file`) to `newName`. The graph is refined with the
 * NAMESPACE under `indexRoot` (what the indexer saw); the plan's config is loaded from `planRoot`
 * (what is on disk now) unless `record` is false (the pass recorded none).
 */
async function verdictAt(
  file: string,
  name: string,
  newName: string,
  options: { indexRoot?: string; planRoot?: string; refine?: boolean; record?: boolean } = {},
): Promise<string> {
  const graph = graphOf(file, ALL);
  if (options.refine !== false) {
    refineRExportStatus(graph, await loadRPackageConfig(options.indexRoot ?? root));
  }
  const parsed = { localDefs: [] };
  if (options.record !== false)
    recordRPackageConfig([parsed], await loadRPackageConfig(options.planRoot ?? root));
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: name, filePath: file },
    newName,
    files: new Map([[file, { tree: parser.parse(`${name} <- function(x) x`), parsed }]]),
    graph,
  } as never);
  return issue ? issue.code : 'ok';
}

const verdict = (
  file: string,
  name: string,
  newName: string,
  options: { refine?: boolean } = {},
): Promise<string> => verdictAt(file, name, newName, options);

describe('R rename: NAMESPACE export guard on a refined graph', () => {
  it('renames a package function that NAMESPACE does not export', async () => {
    expect(await verdict('pk/R/a.R', 'hidden', 'secret')).toBe('ok');
    expect(await verdict('pk/R/a.R', 'lonely', 'single')).toBe('ok');
  });

  it('refuses every way NAMESPACE can export a function', async () => {
    const code = 'unsupported_occurrence';
    // export(), including a backticked operator name
    expect(await verdict('pk/R/a.R', 'pub', 'public')).toBe(code);
    expect(await verdict('pk/R/a.R', '`odd name`', 'odd_name')).toBe(code);
    // exportPattern()
    expect(await verdict('pk/R/a.R', 'api_run', 'run_api')).toBe(code);
    // S3method(generic, class): the registered name is generic.class
    expect(await verdict('pk/R/a.R', 'print.foo', 'print_foo')).toBe(code);
    // S3method(generic, class, method): the registered function is the third argument
    expect(await verdict('pk/R/a.R', 'show_summary', 'summary_text')).toBe(code);
  });

  it('refuses a function the index could not prove private', async () => {
    // A package without a NAMESPACE file keeps the default public verdict.
    expect(await verdict('bare/R/a.R', 'hidden', 'secret')).toBe('unsupported_occurrence');
    // So does an R/ directory that belongs to no package (no DESCRIPTION or NAMESPACE at all),
    // as in a targets or drake project.
    expect(await verdict('analysis/R/utils.R', 'hidden', 'secret')).toBe('unsupported_occurrence');
    // So does a graph that carries no refinement at all.
    expect(await verdict('pk/R/a.R', 'hidden', 'secret', { refine: false })).toBe(
      'unsupported_occurrence',
    );
  });

  it('does not apply the guard outside an R/ directory', async () => {
    expect(await verdict('pk/scripts/a.R', 'pub', 'public')).toBe('ok');
  });

  it('refuses a node with no export verdict at all', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:R/a.R:hidden',
      label: 'Function',
      properties: { name: 'hidden', filePath: 'R/a.R', language: SupportedLanguages.R },
    });
    const parsed = { localDefs: [] };
    recordRPackageConfig([parsed], { packages: new Map(), namespaceInfoByPackageDir: new Map() });
    const issue = rRenameProvider.checkSafety?.({
      target: { type: 'Function', qualifiedName: 'hidden', filePath: 'R/a.R' },
      newName: 'secret',
      files: new Map([['R/a.R', { tree: parser.parse('hidden <- function(x) x'), parsed }]]),
      graph,
    } as never);
    expect(issue ? issue.code : 'ok').toBe('unsupported_occurrence');
  });
});

describe('R rename: the NAMESPACE on disk decides, not the persisted flag', () => {
  const roots: string[] = [];
  /** A package `pk` whose NAMESPACE says `namespace` (`null`: no NAMESPACE file at all). */
  async function packageWith(namespace: string | null): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-r-rename-ns-stale-'));
    roots.push(dir);
    await fs.mkdir(path.join(dir, 'pk', 'R'), { recursive: true });
    await fs.writeFile(path.join(dir, 'pk', 'DESCRIPTION'), 'Package: pk\nVersion: 0.1.0\n');
    if (namespace !== null) await fs.writeFile(path.join(dir, 'pk', 'NAMESPACE'), namespace);
    return dir;
  }
  afterAll(async () => {
    for (const dir of roots) await fs.rm(dir, { recursive: true, force: true });
  });
  const stale = async (
    now: string | null,
    name = 'hidden',
    indexed = 'export(pub)\n',
  ): Promise<string> =>
    verdictAt('pk/R/a.R', name, `${name}_x`, {
      indexRoot: await packageWith(indexed),
      planRoot: await packageWith(now),
    });

  it('renames a function that is private in the index and in the NAMESPACE now', async () => {
    expect(await stale('export(pub)\n')).toBe('ok');
  });

  it('refuses a function that an export() added to NAMESPACE alone has exported', async () => {
    expect(await stale('export(pub)\nexport(hidden)\n')).toBe('unsupported_occurrence');
  });

  it('refuses a function that an added exportPattern() covers', async () => {
    expect(await stale('export(pub)\nexportPattern("^hid")\n')).toBe('unsupported_occurrence');
  });

  it('refuses a function that an added S3method() registers', async () => {
    // S3method(generic, class, method): the registered function is the third argument.
    expect(await stale('export(pub)\nS3method(summary, foo, hidden)\n')).toBe(
      'unsupported_occurrence',
    );
  });

  it('refuses when NAMESPACE has been deleted since the index', async () => {
    expect(await stale(null)).toBe('incomplete_semantics');
  });

  it('refuses when NAMESPACE cannot be read', async () => {
    const planRoot = await packageWith(null);
    // A directory where the file should be: reading it fails.
    await fs.mkdir(path.join(planRoot, 'pk', 'NAMESPACE'));
    const verdictOf = await verdictAt('pk/R/a.R', 'hidden', 'secret', {
      indexRoot: await packageWith('export(pub)\n'),
      planRoot,
    });
    expect(verdictOf).toBe('incomplete_semantics');
  });

  it('refuses when the pass recorded no NAMESPACE for the plan', async () => {
    expect(await verdictAt('pk/R/a.R', 'hidden', 'secret', { record: false })).toBe(
      'incomplete_semantics',
    );
  });

  it('refuses when an exportPattern() of the NAMESPACE cannot be applied', async () => {
    // An unbalanced group does not compile: it exports nothing, which is not proof of privacy.
    expect(await stale('export(pub)\nexportPattern("(")\n')).toBe('incomplete_semantics');
  });

  it.each([
    ['a conditional export', 'export(pub)\nif (getRversion() >= "4.1.0") export(hidden)\n'],
    ['a conditional export in a block', 'export(pub)\nif (TRUE) {\n  export(hidden)\n}\n'],
    ['an else export', 'export(pub)\nif (FALSE) export(a) else export(hidden)\n'],
    ['a raw-string export', 'export(pub)\nexport(r"(hidden)")\n'],
    ['a raw-string exportPattern', 'export(pub)\nexportPattern(r"(^hid)")\n'],
    ['an export spanning lines in a string', 'export(pub)\nexport("hid\nden")\n'],
    ['an export given as an expression', 'export(pub)\nexport(paste0("hid", "den"))\n'],
    [
      'a malformed directive that swallows an export',
      'export(pub\n  export(hidden)\nexport(pub)\n',
    ],
    ['an unreadable S3method()', 'export(pub)\nS3method(print, foo, method = hidden)\n'],
  ])('refuses, as unreadable, a NAMESPACE with %s', async (_label, namespace) => {
    expect(await stale(namespace)).toBe('incomplete_semantics');
  });

  it('does not treat an ordinary NAMESPACE as unreadable', async () => {
    const ordinary = [
      '# Generated by roxygen2: do not edit by hand',
      '',
      'S3method(print, foo)',
      'export(pub)',
      'export(',
      '  other,',
      '  another',
      ')',
      'exportPattern("^api_")',
      'importFrom(stats, sd)',
      'import(utils)',
      'useDynLib(pk, .registration = TRUE)',
      'if (getRversion() >= "4.1.0") importFrom(stats, setNames)',
      '',
    ].join('\n');
    expect(await stale(ordinary)).toBe('ok');
  });

  it('still refuses a function the index records as exported when NAMESPACE no longer does', async () => {
    // The index is stale the other way round; the persisted half of the proof fails.
    expect(await stale('export(pub)\n', 'hidden', 'export(pub)\nexport(hidden)\n')).toBe(
      'unsupported_occurrence',
    );
  });

  it('leaves a script outside any R/ directory alone, with or without a NAMESPACE', async () => {
    const withNone = await packageWith(null);
    expect(
      await verdictAt('scripts/run.R', 'hidden', 'secret', {
        indexRoot: withNone,
        planRoot: withNone,
      }),
    ).toBe('ok');
    expect(
      await verdictAt('pk/scripts/a.R', 'pub', 'public', {
        indexRoot: await packageWith('export(pub)\n'),
        planRoot: await packageWith('export(pub)\n'),
      }),
    ).toBe('ok');
  });
});
