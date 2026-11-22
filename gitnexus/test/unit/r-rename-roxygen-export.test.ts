/**
 * R rename: a roxygen2 `@export*` tag on the function's block refuses the rename. roxygen2
 * rebuilds NAMESPACE from those tags on the next `document()`, so renaming a tagged function
 * would change the package's public API even though the NAMESPACE on disk (and the persisted
 * `isExported`) say it is private today. The graph and NAMESPACE here say "private" throughout,
 * so every refusal below comes from the tag.
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
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-r-rename-roxygen-'));
  await fs.mkdir(path.join(root, 'pk', 'R'), { recursive: true });
  await fs.writeFile(path.join(root, 'pk', 'DESCRIPTION'), 'Package: pk\nVersion: 0.1.0\n');
  await fs.writeFile(path.join(root, 'pk', 'NAMESPACE'), 'export(pub)\n');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The verdict of renaming `hidden` in `source`, a file of the package `pk`. */
async function verdictFor(source: string, file = 'pk/R/a.R'): Promise<string> {
  const graph = createKnowledgeGraph();
  graph.addNode({
    id: `Function:${file}:hidden`,
    label: 'Function',
    properties: {
      name: 'hidden',
      filePath: file,
      language: SupportedLanguages.R,
      isExported: false,
    },
  });
  const parsed = { localDefs: [] };
  recordRPackageConfig([parsed], await loadRPackageConfig(root));
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: 'hidden', filePath: file },
    newName: 'secret',
    files: new Map([[file, { tree: parser.parse(source), parsed }]]),
    graph,
  } as never);
  return issue ? issue.code : 'ok';
}

describe('R rename: roxygen @export tags', () => {
  it('renames a documented function without an export tag', async () => {
    expect(
      await verdictFor("#' Hidden.\n#' @param x A value.\n#' @noRd\nhidden <- function(x) x\n"),
    ).toBe('ok');
    expect(await verdictFor('hidden <- function(x) x\n')).toBe('ok');
  });

  it.each([
    ['@export', "#' @export\nhidden <- function(x) x\n"],
    [
      '@export after other tags',
      "#' Hidden.\n#' @param x A value.\n#' @export\nhidden <- function(x) x\n",
    ],
    ['@exportMethod', "#' @exportMethod hidden\nhidden <- function(x) x\n"],
    ['@exportS3Method', "#' @exportS3Method print foo\nhidden <- function(x) x\n"],
    ['@export with a plain comment between', "#' @export\n# TODO tidy\nhidden <- function(x) x\n"],
    ["@export written with no space after #'", "#'@export\nhidden <- function(x) x\n"],
    ['an = assignment', "#' @export\nhidden = function(x) x\n"],
  ])('refuses %s', async (_label, source) => {
    expect(await verdictFor(source)).toBe('unsupported_occurrence');
  });

  it('is not triggered by the tag of another function or by prose', async () => {
    expect(await verdictFor("#' @export\nother <- function() 1\n\nhidden <- function(x) x\n")).toBe(
      'ok',
    );
    expect(await verdictFor("#' Mention of @export in prose.\nhidden <- function(x) x\n")).toBe(
      'ok',
    );
    expect(await verdictFor('# @export (plain comment)\nhidden <- function(x) x\n')).toBe('ok');
  });

  it('leaves a script outside R/ alone', async () => {
    expect(await verdictFor("#' @export\nhidden <- function(x) x\n", 'pk/scripts/a.R')).toBe('ok');
  });
});
