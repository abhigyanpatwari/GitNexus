/**
 * The R rename guard for NAMESPACE exports, run on a real graph: `loadRPackageConfig` reads an
 * on-disk package, `refineRExportStatus` stamps `isExported` on real graph nodes (the same pass
 * the indexer runs), and `checkSafety` then reads that graph. A mock graph that never carries
 * `isExported` makes every function look exported, so the converse (a private function renames)
 * is only provable here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { SupportedLanguages } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { loadRPackageConfig } from '../../src/core/ingestion/languages/r/package-config.js';
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

/** The verdict of renaming `name` (defined in `file`) to `newName`, on the refined real graph. */
async function verdict(
  file: string,
  name: string,
  newName: string,
  options: { refine?: boolean } = {},
): Promise<string> {
  const graph = createKnowledgeGraph();
  const all = [
    'pub',
    '`odd name`',
    'hidden',
    'api_run',
    'print.foo',
    'show_summary',
    'summary.foo',
    'lonely',
  ];
  for (const fn of all) {
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
  if (options.refine !== false) {
    refineRExportStatus(graph, await loadRPackageConfig(root));
  }
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: name, filePath: file },
    newName,
    files: new Map([
      [file, { tree: parser.parse(`${name} <- function(x) x`), parsed: { localDefs: [] } }],
    ]),
    graph,
  } as never);
  return issue ? issue.code : 'ok';
}

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
    const issue = rRenameProvider.checkSafety?.({
      target: { type: 'Function', qualifiedName: 'hidden', filePath: 'R/a.R' },
      newName: 'secret',
      files: new Map([
        ['R/a.R', { tree: parser.parse('hidden <- function(x) x'), parsed: { localDefs: [] } }],
      ]),
      graph,
    } as never);
    expect(issue?.code).toBe('unsupported_occurrence');
  });
});
