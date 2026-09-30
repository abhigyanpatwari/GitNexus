/**
 * Language gating of R's post-parse work.
 *
 * R's package-config walk (`DESCRIPTION`/`NAMESPACE` discovery) and its whole-graph owner attach are
 * language-specific work. Shared pipeline code must not run them for a repo that has no R files:
 * a non-R repo pays nothing (no directory walk, no manifest read).
 *
 * Observation point: `node:fs/promises` `readFile`. `loadRPackageConfig` imports the module's default
 * export, so a spy on that object sees the loader wherever it lives (before or after it moves into
 * `languages/r/`). A depth-3 `DESCRIPTION` decoy makes the walk observable: reading it is impossible
 * without the breadth-first search reaching it.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';
import { rProvider } from '../../src/core/ingestion/languages/r.js';

const MANIFEST = /[\\/](DESCRIPTION|NAMESPACE)$/;

const roots: string[] = [];
const makeRepo = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-r-post-parse-gating-'));
  roots.push(root);
  writeFixtureRepo(root, files);
  return root;
};

const DECOYS = {
  DESCRIPTION: 'Package: decoy\nVersion: 0.0.1\n',
  NAMESPACE: 'export(f)\n',
  'pkg/sub/deep/DESCRIPTION': 'Package: deepdecoy\nVersion: 0.0.1\n',
  'pkg/sub/deep/NAMESPACE': 'export(g)\n',
};

const manifestReads = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls
    .map((args) => String(args[0]))
    .filter((p) => MANIFEST.test(p))
    .map((p) => p.replace(/\\/g, '/'));

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('R post-parse gating', () => {
  // R's package-config walk runs inside `LanguageProvider.postParse`, which the parse phase calls only
  // for languages with parsed files, so a repo with no R files never reads a manifest.
  it('a non-R repo with DESCRIPTION/NAMESPACE decoys never reads a manifest', async () => {
    const root = makeRepo({ 'src/main.py': 'def main():\n    return 1\n', ...DECOYS });
    const readFile = vi.spyOn(fsp, 'readFile');

    await runPipelineFromRepo(root, () => {});

    expect(manifestReads(readFile)).toEqual([]);
  }, 60000);

  it('rProvider.postParse is never invoked for a non-R repo and once for an R repo', async () => {
    const postParse = vi.spyOn(rProvider, 'postParse');

    await runPipelineFromRepo(
      makeRepo({ 'src/main.py': 'def main():\n    return 1\n', ...DECOYS }),
      () => {},
    );
    expect(postParse).toHaveBeenCalledTimes(0);

    await runPipelineFromRepo(makeRepo({ 'R/a.R': 'f <- function() 1\n', ...DECOYS }), () => {});
    expect(postParse).toHaveBeenCalledTimes(1);
  }, 120000);

  it('control: an R repo with the same layout reads the root DESCRIPTION (the spy sees the loader)', async () => {
    const root = makeRepo({ 'R/a.R': 'f <- function() 1\n', ...DECOYS });
    const readFile = vi.spyOn(fsp, 'readFile');

    await runPipelineFromRepo(root, () => {});

    const reads = manifestReads(readFile);
    expect(reads.some((p) => p === path.join(root, 'DESCRIPTION').replace(/\\/g, '/'))).toBe(true);
  }, 60000);
});
