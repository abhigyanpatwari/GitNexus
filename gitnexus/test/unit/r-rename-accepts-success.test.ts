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
    expect(verdict?.message ?? '').not.toMatch(/Package: name/);
  });
});
