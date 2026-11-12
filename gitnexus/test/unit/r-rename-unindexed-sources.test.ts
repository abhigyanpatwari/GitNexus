/**
 * R rename: R files the index does not cover. The rename preview's config reload
 * (`refreshResolutionConfig`) records every R file of the repository that is not an indexed
 * source, with its identifier tokens, and the guard refuses a rename whose old name one of them
 * uses (`incomplete_semantics`). Each fixture is a temporary repository; nothing is indexed, so
 * the indexed file list is passed in directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  recordRPackageConfig,
  type RPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';
import { rScopeResolver } from '../../src/core/ingestion/languages/r/scope-resolver.js';
import {
  collectRUnindexedSources,
  MAX_UNINDEXED_R_SOURCE_BYTES,
  type RUnindexedSource,
} from '../../src/core/ingestion/languages/r/unindexed-sources.js';
import {
  renameResolutionVersion,
  validateRenameResolution,
} from '../../src/mcp/local/rename/resolution-version.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

let root: string;

async function write(files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  }
}

const paths = (sources: readonly RUnindexedSource[]): string[] => sources.map((s) => s.path);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-r-unindexed-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('collectRUnindexedSources', () => {
  it('lists the R files the index omits, with their tokens, and none it indexes', async () => {
    await write({
      'a.R': 'helper <- function(x) x + 1\n',
      'bin/run.R': 'source("a.R")\nhelper(1)\n`odd name`(2)\n',
      'tmp/t.r': 'x <- 1\n',
    });
    const sources = await collectRUnindexedSources(root, ['a.R']);
    expect(paths(sources)).toEqual(['bin/run.R', 'tmp/t.r']);
    expect(sources[0].words).toContain('helper');
    expect(sources[0].words).toContain('odd name');
    expect(sources[0].words).toEqual([...sources[0].words].sort());
  });

  it('reads .Rprofile and the .S/.q/.s code files under R/, not other files', async () => {
    await write({
      '.Rprofile': 'helper(0)\n',
      'R/legacy.S': 'helper(1)\n',
      'R/sub/old.q': 'helper(2)\n',
      'pkg/R/x.s': 'helper(3)\n',
      'top.S': 'helper(4)\n',
      'notes.txt': 'helper(5)\n',
      'doc.Rmd': 'helper(6)\n',
    });
    expect(paths(await collectRUnindexedSources(root, []))).toEqual([
      '.Rprofile',
      'R/legacy.S',
      'R/sub/old.q',
      'pkg/R/x.s',
    ]);
  });

  it('normalises indexed paths written with backslashes or ./ (no spurious entry)', async () => {
    await write({ 'sub/dir/b.R': 'helper(1)\n', 'a.R': 'helper(2)\n' });
    expect(await collectRUnindexedSources(root, ['sub\\dir\\b.R', './a.R'])).toEqual([]);
  });

  it('skips .git, the index store, installed packages and R CMD check output', async () => {
    await write({
      '.git/x.R': 'helper(1)\n',
      '.gitnexus/x.R': 'helper(1)\n',
      'node_modules/m/x.R': 'helper(1)\n',
      'renv/library/R-4.4/pkg/R/x.R': 'helper(1)\n',
      'packrat/lib/x86/pkg/x.R': 'helper(1)\n',
      'pk.Rcheck/00_pkg_src/pk/R/a.R': 'helper(1)\n',
      'renv/activate.R': 'helper(1)\n',
    });
    expect(paths(await collectRUnindexedSources(root, []))).toEqual(['renv/activate.R']);
  });

  it('honours .gitnexusignore, but not .gitignore (which is what hides callers)', async () => {
    await write({
      '.gitnexusignore': 'scratch/\nsingle.R\n',
      '.gitignore': 'ignored/\n',
      'scratch/try.R': 'helper(1)\n',
      'single.R': 'helper(2)\n',
      'ignored/x.R': 'helper(3)\n',
    });
    expect(paths(await collectRUnindexedSources(root, []))).toEqual(['ignored/x.R']);
  });

  it('marks a file over the size cap unreadable instead of reading it', async () => {
    await write({ 'big.R': 'x'.repeat(MAX_UNINDEXED_R_SOURCE_BYTES + 1) });
    expect(await collectRUnindexedSources(root, [])).toEqual([
      { path: 'big.R', words: [], unreadable: true },
    ]);
  });

  it('does not follow a symbolic link', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-r-unindexed-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'x.R'), 'helper(1)\n');
      await fs.symlink(outside, path.join(root, 'linked'));
      await fs.symlink(path.join(outside, 'x.R'), path.join(root, 'link.R'));
      expect(await collectRUnindexedSources(root, [])).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('refreshResolutionConfig and the rename plan', () => {
  it('adds the unindexed sources to a fresh package config', async () => {
    await write({ 'a.R': 'helper <- function(x) x\n', 'bin/run.R': 'helper(1)\n' });
    const config = (await rScopeResolver.refreshResolutionConfig?.(root, [
      'a.R',
    ])) as RPackageConfig;
    expect(config.namespaceInfoByPackageDir).toBeInstanceOf(Map);
    expect(paths(config.unindexedRSources ?? [])).toEqual(['bin/run.R']);
  });

  it('reports resolution_changed when an unindexed file changes between preview and apply', async () => {
    await write({ 'a.R': 'helper <- function(x) x\n', 'bin/run.R': 'message("ok")\n' });
    const refresh = async () => rScopeResolver.refreshResolutionConfig?.(root, ['a.R']);
    const version = renameResolutionVersion(await refresh(), refresh);
    await expect(validateRenameResolution(version)).resolves.toBeUndefined();
    await write({ 'bin/run.R': 'helper(1)\n' });
    await expect(validateRenameResolution(version)).rejects.toMatchObject({
      code: 'resolution_changed',
    });
  });
});

describe('the rename guard', () => {
  const issue = (unindexed: readonly RUnindexedSource[]) => {
    const parsed = { localDefs: [{ qualifiedName: 'helper', type: 'Function' }] };
    recordRPackageConfig([parsed], {
      packages: new Map(),
      namespaceInfoByPackageDir: new Map(),
      unindexedRSources: unindexed,
    } satisfies RPackageConfig);
    return rRenameProvider.checkSafety?.({
      target: { type: 'Function', qualifiedName: 'helper', filePath: 'a.R' },
      newName: 'assist',
      files: new Map([['a.R', { tree: parser.parse('helper <- function(x) x\n'), parsed }]]),
      graph: createKnowledgeGraph(),
    } as never);
  };

  it('refuses when an unindexed file mentions the name, and names the file', () => {
    expect(issue([{ path: 'bin/run.R', words: ['helper', 'source'] }])).toMatchObject({
      code: 'incomplete_semantics',
      message: expect.stringContaining('bin/run.R'),
    });
  });

  it('refuses when an unindexed file could not be read', () => {
    expect(issue([{ path: 'big.R', words: [], unreadable: true }])).toMatchObject({
      code: 'incomplete_semantics',
      message: expect.stringContaining('big.R'),
    });
  });

  it('accepts when no unindexed file mentions the name', () => {
    expect(issue([{ path: 'bin/run.R', words: ['helper2', 'message', 'my.helper'] }])).toBe(
      undefined,
    );
  });
});
