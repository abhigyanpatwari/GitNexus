/**
 * R rename: plans that used to report success and leave the code wrong (fork issue #114,
 * findings T9, T10, T11 and T15). Each case is a refusal at the safety check, so a rename preview
 * (`dry_run: true`) returns the refusal instead of an OK plan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  loadRPackageConfig,
  recordRPackageConfig,
  type RPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import { rRenameProvider } from '../../src/core/ingestion/languages/r/rename.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

interface Verdict {
  code: string;
  message: string;
}

/** The safety verdict for renaming `name` -> `newName`, defined in `file` of the given sources. */
function check(
  sources: Record<string, string>,
  file: string,
  name: string,
  newName: string,
  config?: RPackageConfig,
): Verdict | undefined {
  const files = new Map(
    Object.entries(sources).map(([path, text]) => [
      path,
      {
        tree: parser.parse(text),
        content: text,
        parsed: { localDefs: [{ qualifiedName: name, type: 'Function' }] },
      },
    ]),
  );
  if (config !== undefined)
    recordRPackageConfig(
      [...files.values()].map((f) => f.parsed),
      config,
    );
  const issue = rRenameProvider.checkSafety?.({
    target: { type: 'Function', qualifiedName: name, filePath: file },
    newName,
    files,
    graph: createKnowledgeGraph(),
  } as never);
  return issue as Verdict | undefined;
}

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-r-rename-114-'));
  const pkg = async (dir: string, name: string): Promise<void> => {
    await fs.mkdir(path.join(root, dir, 'R'), { recursive: true });
    await fs.writeFile(path.join(root, dir, 'DESCRIPTION'), `Package: ${name}\nVersion: 0.1\n`);
    await fs.writeFile(path.join(root, dir, 'NAMESPACE'), '');
  };
  await pkg('a/pk', 'pk');
  await pkg('b/pk', 'pk');
  await pkg('solo', 'solo');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('T9: several directories declare the same Package: name', () => {
  const body = 'helper <- function(x) x\n';
  it('refuses a target in either copy, naming the ambiguity', async () => {
    const config = await loadRPackageConfig(root);
    for (const file of ['a/pk/R/a.R', 'b/pk/R/a.R']) {
      expect(check({ [file]: body }, file, 'helper', 'assist', config)).toMatchObject({
        code: 'ambiguous_reference',
        message: expect.stringMatching(/more than one directory.*Package: name/is),
      });
    }
  });

  it('does not refuse a package whose name is declared once', async () => {
    const config = await loadRPackageConfig(root);
    const verdict = check({ 'solo/R/a.R': body }, 'solo/R/a.R', 'helper', 'assist', config);
    // The rename is accepted: no verdict at all, not merely one that avoids the Package: wording.
    expect(verdict).toBeUndefined();
  });
});

describe('T10: a call in a parameter default beside a local definition of the name', () => {
  const file = 'a.R';
  const withDefault = (body: string): string =>
    `helper <- function(x) x\nf <- function(a, b = helper(a)) {\n${body}}\n`;

  it('refuses when the function body defines a local function of the name', () => {
    expect(
      check({ [file]: withDefault('  helper <- function(y) y\n  b\n') }, file, 'helper', 'assist'),
    ).toMatchObject({
      code: 'ambiguous_reference',
      message: expect.stringContaining('before the local definition'),
    });
  });

  // Characterisation, not a regression test of the T10 fix: this refusal held before it (the
  // earlier body call already made the name ambiguous). It pins that the fix did not loosen it.
  it('still refuses when the local definition follows a body call', () => {
    expect(
      check(
        { [file]: withDefault('  helper(a)\n  helper <- function(y) y\n  b\n') },
        file,
        'helper',
        'assist',
      ),
    ).toMatchObject({ code: 'ambiguous_reference' });
  });

  it('accepts a default call when the function has no local definition of the name', () => {
    expect(check({ [file]: withDefault('  b\n') }, file, 'helper', 'assist')).toBeUndefined();
  });

  it('accepts a local definition when no default calls the name', () => {
    const source =
      'helper <- function(x) x\nf <- function(a, b = 1) {\n  helper <- function(y) y\n  helper(a)\n}\n';
    expect(check({ [file]: source }, file, 'helper', 'assist')).toBeUndefined();
  });
});

describe('T11: the string-call, unindexed-file and hook-name guards also test the new name', () => {
  const file = 'a.R';
  const base = 'helper <- function(x) x\n';
  const unindexed = (words: string[], extra: object = {}): RPackageConfig => ({
    packages: new Map(),
    namespaceInfoByPackageDir: new Map(),
    unindexedRSources: [{ path: 'bin/run.R', words, ...extra }],
  });

  it('string call: a string evaluating a call of the new name refuses', () => {
    const source = `${base}y <- parse(text = "abs(1)")\n`;
    expect(check({ [file]: source }, file, 'helper', 'abs')).toMatchObject({
      code: 'unsupported_occurrence',
      message: expect.stringContaining('contains a call of the new name'),
    });
    expect(check({ [file]: source }, file, 'helper', 'assist')).toBeUndefined();
    expect(
      check({ [file]: `${base}y <- "abs is a word"\n` }, file, 'helper', 'abs'),
    ).toBeUndefined();
  });

  it('unindexed file: a file the index omits that uses the new name refuses', () => {
    expect(
      check({ [file]: base }, file, 'helper', 'assist', unindexed(['assist', 'source'])),
    ).toMatchObject({
      code: 'incomplete_semantics',
      message: expect.stringMatching(/bin\/run\.R.*mentions the new name/s),
    });
    expect(check({ [file]: base }, file, 'helper', 'assist', unindexed(['other']))).toBeUndefined();
  });

  it('hook name: renaming to a name R calls by itself refuses', () => {
    for (const hook of ['.onLoad', '.onAttach', '.First']) {
      expect(check({ [file]: base }, file, 'helper', hook)).toMatchObject({
        code: 'unsupported_occurrence',
        message: expect.stringContaining('R calls the new name'),
      });
    }
    expect(check({ [file]: base }, file, 'helper', '.onLoadx')).toBeUndefined();
  });
});

describe('T15: a function defined twice at the top level of its own file', () => {
  const file = 'a.R';
  it('refuses, naming the second definition', () => {
    const source =
      'helper <- function(x) 1\nhelper <- function(x) 2\nrun <- function() helper(1)\n';
    expect(check({ [file]: source }, file, 'helper', 'assist')).toMatchObject({
      code: 'ambiguous_reference',
      message: expect.stringContaining('defined more than once in this file'),
    });
  });

  it('accepts one top-level definition beside definitions in other scopes', () => {
    const source =
      'helper <- function(x) 1\nrun <- function() {\n  other <- 1\n  helper(other)\n}\nlocal({ helper2 <- 3 })\n';
    expect(check({ [file]: source }, file, 'helper', 'assist')).toBeUndefined();
  });
});
