import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findBrokenKeywordCalls } from '../../src/mcp/local/python-signature-changes.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

let dir: string;
const target = {
  id: 'Class:model.py:Invoice',
  name: 'Invoice',
  type: 'Class',
  filePath: 'model.py',
};
const writeModel = (params: string) =>
  fs.writeFile(
    path.join(dir, 'model.py'),
    `class Invoice:\n    def __init__(self${params}):\n        pass\n`,
  );
const incoming = () =>
  Promise.resolve([
    {
      target: target.id,
      filePath: 'use.py',
    },
  ]);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-keyword-'));
  initGitRepo(dir);
  await writeModel(', *, legacy: bool = True');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import Invoice as Bill\nfrom elsewhere import Invoice\ndef build():\n    Invoice(legacy=True)\n    return Bill(legacy=True)\n',
  );
  commitAll(dir, 'original signature');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

it('reports the removed keyword at the aliased constructor call', async () => {
  await writeModel('');
  expect(await findBrokenKeywordCalls(dir, 'compare', 'HEAD', [target], incoming)).toEqual([
    { target: target.id, name: 'Invoice', filePath: 'use.py', line: 5, keyword: 'legacy' },
  ]);
});

it('checks lexical bindings when the same caller also contains a nested call to a parameter', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import Invoice as Bill\ndef build():\n    Bill(legacy=True)\n    def nested(Bill):\n        Bill(legacy=True)\n',
  );
  expect(
    (await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).map((c) => c.line),
  ).toEqual([3]);
});

it('skips a module alias rebound to another class', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import Invoice as Bill\nfrom elsewhere import Invoice as Bill\ndef build():\n    Bill(legacy=True)\n',
  );
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toEqual([]);
});

it('checks the staged image, including the staged callers', async () => {
  await writeModel('');
  execFileSync('git', ['add', 'model.py'], { cwd: dir });
  await writeModel(', **kwargs');
  await fs.writeFile(path.join(dir, 'use.py'), '');
  expect(await findBrokenKeywordCalls(dir, 'staged', undefined, [target], incoming)).toHaveLength(
    1,
  );
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toEqual([]);
});

it.each(['..', '...'])('reads both endpoints for a %s commit range', async (separator) => {
  await writeModel('');
  commitAll(dir, 'remove keyword');
  await writeModel(', **kwargs');
  await fs.writeFile(path.join(dir, 'use.py'), '');
  const findings = await findBrokenKeywordCalls(
    dir,
    'compare',
    'HEAD^' + separator + 'HEAD',
    [target],
    incoming,
  );
  expect(findings.map((call) => [call.filePath, call.line, call.keyword])).toEqual([
    ['use.py', 5, 'legacy'],
  ]);
});

it('does not query callers when the replacement still accepts the keyword', async () => {
  const calls = vi.fn(incoming);
  await writeModel(', **options: object');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], calls)).toEqual([]);
  expect(calls).not.toHaveBeenCalled();
});
