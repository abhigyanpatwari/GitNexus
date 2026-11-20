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

it('resolves global and nonlocal imports to their Python owner', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    [
      'from model import Invoice as Bill',
      'def use_global():',
      '    global Bill',
      '    return Bill(legacy=True)',
      'def outer():',
      '    from model import Invoice as Imported',
      '    def inner():',
      '        nonlocal Imported',
      '        return Imported(legacy=True)',
      'def other():',
      '    Imported = object',
      '    def inner():',
      '        nonlocal Imported',
      '        return Imported(legacy=True)',
    ].join('\n'),
  );
  expect(
    (await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).map((c) => c.line),
  ).toEqual([4, 9]);
});

it('checks the active export when a changed definition is rebound', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'other.py'),
    'class Invoice:\n    def __init__(self, **kwargs): pass\n',
  );
  await fs.appendFile(path.join(dir, 'model.py'), 'from other import Invoice\n');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toEqual([]);
});

it('reads root-relative indexed callers from a subdirectory of the checkout', async () => {
  await writeModel('');
  const nested = path.join(dir, 'nested');
  await fs.mkdir(nested);
  const calls = await findBrokenKeywordCalls(nested, 'all', undefined, [target], incoming);
  expect(calls.map((c) => [c.filePath, c.line])).toEqual([['use.py', 5]]);
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

it('distinguishes a function-local import from a sibling import, a parameter and a use before binding', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    [
      'def build():',
      '    Bill(legacy=True)',
      '    from model import Invoice as Bill',
      '    return Bill(legacy=True)',
      'def other():',
      '    from elsewhere import Invoice as Bill',
      '    return Bill(legacy=True)',
      'def via_parameter(Bill):',
      '    return Bill(legacy=True)',
    ].join('\n'),
  );
  expect(
    (await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).map((c) => c.line),
  ).toEqual([4]);
});

it.each([
  ['class Invoice:\n    pass\n', true],
  ['class Invoice:\n    def total(self): return 1\n', true],
  ['class Invoice(Base):\n    pass\n', false],
  ['class Invoice:\n    def __new__(cls, **kwargs): pass\n', false],
  ['@replace_constructor\nclass Invoice:\n    pass\n', false],
])(
  'checks initializer deletion only for a known default constructor: %s',
  async (replacement, broken) => {
    await fs.writeFile(path.join(dir, 'model.py'), replacement);
    expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toHaveLength(
      broken ? 1 : 0,
    );
  },
);

it('follows the staged package export and distinguishes compatible dotted imports', async () => {
  const pkg = path.join(dir, 'pkg');
  await fs.mkdir(pkg);
  await fs.rename(path.join(dir, 'model.py'), path.join(pkg, 'model.py'));
  await fs.writeFile(path.join(pkg, '__init__.py'), 'from .model import Invoice as Order\n');
  await fs.writeFile(path.join(pkg, 'other.py'), 'class Invoice: pass\n');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    [
      'from pkg import Order',
      'import pkg.model',
      'import pkg.other',
      'from pkg import model as m',
      'def build():',
      '    Order(legacy=True)',
      '    pkg.model.Invoice(legacy=True)',
      '    pkg.other.Invoice(legacy=True)',
      '    m.Invoice(legacy=True)',
    ].join('\n'),
  );
  commitAll(dir, 'move class to package');
  await fs.writeFile(path.join(pkg, 'model.py'), 'class Invoice: pass\n');
  execFileSync('git', ['add', 'pkg/model.py'], { cwd: dir });
  await fs.writeFile(path.join(pkg, '__init__.py'), 'from .other import Invoice as Order\n');
  const targets = [{ ...target, filePath: 'pkg/model.py' }];
  const lines = async (scope: string) =>
    (await findBrokenKeywordCalls(dir, scope, undefined, targets, incoming)).map((c) => c.line);
  expect(await lines('staged')).toEqual([6, 7, 9]);
  expect(await lines('all')).toEqual([7, 9]);
  await fs.writeFile(path.join(pkg, '__init__.py'), 'from . import Order\n');
  expect(await lines('all')).toEqual([7, 9]);
});

it.each([
  ['a, *, b', true],
  ['a, /, *, b', false],
])('honors Python keyword eligibility before * and /: %s', async (params, broken) => {
  await fs.writeFile(path.join(dir, 'model.py'), `def f(${params}): pass\n`);
  await fs.writeFile(path.join(dir, 'use.py'), 'from model import f\nf(a=1, b=2)\n');
  commitAll(dir, 'original function');
  await fs.writeFile(path.join(dir, 'model.py'), 'def f(*, b): pass\n');
  const func = { ...target, name: 'f', type: 'Function' };
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [func], incoming)).toHaveLength(
    broken ? 1 : 0,
  );
});
