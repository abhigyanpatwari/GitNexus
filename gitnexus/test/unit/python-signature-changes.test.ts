import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

const capability = getProviderForFile('model.py')?.callCompatibility;
if (!capability) throw new Error('Missing named-argument compatibility provider');
const findBrokenKeywordCalls = capability.check;

const findingsFor = async (...args: Parameters<typeof findBrokenKeywordCalls>) =>
  (await findBrokenKeywordCalls(...args)).findings;

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
      relationType: 'CALLS' as const,
    },
  ]);

it('registers the check for supported declarations in source images', () => {
  expect(capability.acceptsTarget(target)).toBe(true);
  expect(capability.acceptsTarget({ ...target, type: 'Function' })).toBe(true);
  expect(capability.acceptsTarget({ ...target, type: 'Property' })).toBe(false);
  for (const filePath of ['model.ipynb', 'model.pyi']) {
    expect(capability.acceptsTarget({ ...target, filePath })).toBe(false);
  }
  expect(capability.relationTypes).toEqual(['CALLS', 'EXTENDS']);
});

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
  expect(await findingsFor(dir, 'compare', 'HEAD', [target], incoming)).toEqual([
    { target: target.id, name: 'Invoice', filePath: 'use.py', line: 5, keyword: 'legacy' },
  ]);
});

it('keeps observed callers when notebook call sites cannot be checked', async () => {
  await writeModel('');
  const result = await findBrokenKeywordCalls(
    dir,
    'all',
    undefined,
    [target],
    async () => [
      ...(await incoming()),
      { target: target.id, filePath: 'indexed.ipynb', relationType: 'CALLS' },
    ],
    [{ filePath: 'unindexed.ipynb' }],
  );
  expect(result.complete).toBe(false);
  expect(result.findings.map((call) => call.filePath)).toEqual(['use.py']);
  expect(result.skipped.map((skip) => skip.filePath)).toEqual(['indexed.ipynb', 'unindexed.ipynb']);
});

it('pairs batched definition images across missing, renamed and unusual paths', async () => {
  await writeModel('');
  const suffix = process.platform === 'win32' ? ' name.py' : '\nname.py';
  const oldPath = 'before' + suffix;
  const newPath = 'after' + suffix;
  const body = 'def extra(legacy=None): pass\n';
  await fs.writeFile(path.join(dir, oldPath), body);
  execFileSync('git', ['add', oldPath], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'other original definition'], { cwd: dir });
  execFileSync('git', ['mv', oldPath, newPath], { cwd: dir });
  await fs.writeFile(path.join(dir, newPath), 'def extra(): pass\n');
  const extra = {
    id: 'Function:' + oldPath + ':extra',
    name: 'extra',
    type: 'Function',
    filePath: oldPath,
  };
  await fs.writeFile(path.join(dir, 'new.py'), body);
  execFileSync('git', ['add', '.'], { cwd: dir });
  const added = { ...extra, id: 'Function:new.py:extra', filePath: 'new.py' };
  const edges = vi.fn(incoming);
  const result = await findBrokenKeywordCalls(
    dir,
    'staged',
    undefined,
    [added, extra, target],
    edges,
    [{ filePath: newPath, oldFilePath: oldPath }],
  );
  expect(edges).toHaveBeenCalledWith([extra.id, target.id]);
  expect(result).toMatchObject({ complete: true, findings: [{ filePath: 'use.py' }] });
});

it('reports an unmerged index entry as unreadable during a batched definition check', async () => {
  await fs.writeFile(path.join(dir, 'extra.py'), 'def extra(): pass\n');
  commitAll(dir, 'second definition');
  const blob = execFileSync('git', ['rev-parse', 'HEAD:model.py'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['update-index', '--force-remove', 'model.py'], { cwd: dir });
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: dir,
    input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tmodel.py\n`).join(''),
  });
  const extra = {
    id: 'Function:extra.py:extra',
    filePath: 'extra.py',
    name: 'extra',
    type: 'Function',
  };
  for (const scope of ['unstaged', 'staged']) {
    const result = await findBrokenKeywordCalls(dir, scope, undefined, [target, extra], incoming);
    expect(result).toMatchObject({
      complete: false,
      skipped: [{ filePath: 'model.py', reason: expect.stringContaining('unreadable') }],
    });
  }
});

it('checks lexical bindings when the same caller also contains a nested call to a parameter', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import Invoice as Bill\ndef build():\n    Bill(legacy=True)\n    def nested(Bill):\n        Bill(legacy=True)\n',
  );
  expect((await findingsFor(dir, 'all', undefined, [target], incoming)).map((c) => c.line)).toEqual(
    [3],
  );
});

it('skips a module alias rebound to another class', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import Invoice as Bill\nfrom elsewhere import Invoice as Bill\ndef build():\n    Bill(legacy=True)\n',
  );
  expect(await findingsFor(dir, 'all', undefined, [target], incoming)).toEqual([]);
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
  expect((await findingsFor(dir, 'all', undefined, [target], incoming)).map((c) => c.line)).toEqual(
    [4, 9],
  );
});

it('checks the active export when a changed definition is rebound', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'other.py'),
    'class Invoice:\n    def __init__(self, **kwargs): pass\n',
  );
  await fs.appendFile(path.join(dir, 'model.py'), 'from other import Invoice\n');
  expect(await findingsFor(dir, 'all', undefined, [target], incoming)).toEqual([]);
});

it('reads root-relative indexed callers from a subdirectory of the checkout', async () => {
  await writeModel('');
  const nested = path.join(dir, 'nested');
  await fs.mkdir(nested);
  const calls = await findingsFor(nested, 'all', undefined, [target], incoming);
  expect(calls.map((c) => [c.filePath, c.line])).toEqual([['use.py', 5]]);
});

it('checks the staged image, including the staged callers', async () => {
  await writeModel('');
  execFileSync('git', ['add', 'model.py'], { cwd: dir });
  await writeModel(', **kwargs');
  await fs.writeFile(path.join(dir, 'use.py'), '');
  expect(await findingsFor(dir, 'staged', undefined, [target], incoming)).toHaveLength(1);
  expect(await findingsFor(dir, 'all', undefined, [target], incoming)).toEqual([]);
});

it.each(['..', '...'])('reads both endpoints for a %s commit range', async (separator) => {
  await writeModel('');
  commitAll(dir, 'remove keyword');
  await writeModel(', **kwargs');
  await fs.writeFile(path.join(dir, 'use.py'), '');
  const findings = await findingsFor(
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
  expect(await findingsFor(dir, 'all', undefined, [target], calls)).toEqual([]);
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
  expect((await findingsFor(dir, 'all', undefined, [target], incoming)).map((c) => c.line)).toEqual(
    [4],
  );
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
    expect(await findingsFor(dir, 'all', undefined, [target], incoming)).toHaveLength(
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
    (await findingsFor(dir, scope, undefined, targets, incoming)).map((c) => c.line);
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
  expect(await findingsFor(dir, 'all', undefined, [func], incoming)).toHaveLength(broken ? 1 : 0);
});

it('checks new calls from the staged diff without an indexed edge', async () => {
  await writeModel('');
  await fs.writeFile(path.join(dir, 'new.py'), 'from model import Invoice\nInvoice(legacy=True)\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'new.py'), '');
  const result = await findBrokenKeywordCalls(dir, 'staged', undefined, [target], async () => [], [
    { filePath: 'new.py' },
  ]);
  expect(result).toMatchObject({
    complete: true,
    findings: [{ filePath: 'new.py', line: 2 }],
    skipped: [],
  });
});

it('uses the index as the before-image for unstaged changes', async () => {
  await writeModel('');
  execFileSync('git', ['add', 'model.py'], { cwd: dir });
  await writeModel(', **kwargs');
  expect(await findingsFor(dir, 'unstaged', undefined, [target], incoming)).toEqual([]);
  await writeModel(', *, second=False');
  execFileSync('git', ['add', 'model.py'], { cwd: dir });
  await writeModel('');
  await fs.writeFile(path.join(dir, 'use.py'), 'from model import Invoice\nInvoice(second=True)\n');
  expect(await findingsFor(dir, 'unstaged', undefined, [target], incoming)).toMatchObject([
    { keyword: 'second' },
  ]);
});

it('uses the actual merge base of diverged endpoints', async () => {
  execFileSync('git', ['switch', '-c', 'left'], { cwd: dir });
  await writeModel('');
  commitAll(dir, 'left removed keyword');
  execFileSync('git', ['switch', '-c', 'right', 'HEAD^'], { cwd: dir });
  await writeModel('');
  commitAll(dir, 'right independently removed it');
  expect(await findingsFor(dir, 'compare', 'left...right', [target], incoming)).toHaveLength(1);
  expect(await findingsFor(dir, 'compare', 'left..right', [target], incoming)).toEqual([]);
});

it('separates two removed keywords at a single call from two distinct calls on the same line', async () => {
  await writeModel(', a, b');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import Invoice\nInvoice(a=1,b=2); Invoice(a=3)\n',
  );
  commitAll(dir, 'two keywords');
  await writeModel('');
  expect(await findingsFor(dir, 'all', undefined, [target], incoming)).toMatchObject([
    { line: 2, keyword: 'a', keywords: ['a', 'b'] },
    { line: 2, keyword: 'a' },
  ]);
});

it.each(['all', 'staged', 'compare'])(
  'keeps proven calls and reports an oversized caller in %s',
  async (scope) => {
    await writeModel('');
    await fs.writeFile(path.join(dir, 'big.py'), '#' + 'x'.repeat(4 * 1024 * 1024));
    execFileSync('git', ['add', '.'], { cwd: dir });
    const base = scope === 'compare' ? 'HEAD^..HEAD' : undefined;
    if (scope === 'compare') commitAll(dir, 'oversized caller');
    const calls = async () => [
      ...(await incoming()),
      { target: target.id, filePath: 'big.py', relationType: 'CALLS' as const },
    ];
    const result = await findBrokenKeywordCalls(dir, scope, base, [target], calls);
    expect(result).toMatchObject({
      complete: false,
      findings: [{ filePath: 'use.py' }],
      skipped: [{ filePath: 'big.py', reason: expect.stringContaining('4 MiB') }],
    });
  },
);

it('reports syntax-error, wildcard, and dense callers without asserting a clean check', async () => {
  await writeModel('');
  await fs.writeFile(path.join(dir, 'bad.py'), 'Invoice(legacy=\n');
  await fs.writeFile(path.join(dir, 'star.py'), 'from model import *\nInvoice(legacy=True)\n');
  await fs.writeFile(
    path.join(dir, 'dense.py'),
    'from model import Invoice\n' +
      Array.from({ length: 4500 }, (_, i) => 'v' + i + '=0').join('\n') +
      '\nInvoice(legacy=True)\n',
  );
  const files = ['bad.py', 'star.py', 'dense.py'].map((filePath) => ({ filePath }));
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming, files);
  expect(result.complete).toBe(false);
  expect(result.findings).toHaveLength(1);
  expect(result.skipped).toEqual(
    expect.arrayContaining([
      { filePath: 'bad.py', reason: 'Python syntax error' },
      { filePath: 'star.py', reason: expect.stringContaining('Wildcard') },
      { filePath: 'dense.py', reason: expect.stringContaining('budget') },
    ]),
  );
});

it('matches nested and top-level signatures to their lexical declarations, including a same-module caller', async () => {
  const model = (params: string) =>
    'def charge(' +
    params +
    '): pass\ndef outer():\n    def charge(' +
    params +
    '): pass\n    charge(legacy=True)\ncharge(legacy=True)\n';
  await fs.writeFile(path.join(dir, 'model.py'), model('legacy=False'));
  commitAll(dir, 'nested names');
  await fs.writeFile(path.join(dir, 'model.py'), model(''));
  const targets = [
    { ...target, type: 'Function', id: 'Function:model.py:outer.charge@2:4', name: 'charge' },
    { ...target, type: 'Function', id: 'Function:model.py:charge', name: 'charge' },
  ];
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, targets, async () => [], [
    { filePath: 'model.py' },
  ]);
  expect(result.findings).toMatchObject([
    { target: 'Function:model.py:outer.charge@2:4', line: 4 },
    { target: 'Function:model.py:charge', line: 5 },
  ]);
});

it('compares renamed modules with their old paths, and ignores genuinely missing images', async () => {
  await fs.rename(path.join(dir, 'model.py'), path.join(dir, 'invoice.py'));
  await fs.writeFile(path.join(dir, 'invoice.py'), 'class Invoice: pass\n');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from invoice import Invoice\nInvoice(legacy=True)\n',
  );
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming, [
    { filePath: 'invoice.py', oldFilePath: 'model.py' },
    { filePath: 'deleted.py' },
  ]);
  expect(result).toMatchObject({ complete: true, findings: [{ filePath: 'use.py' }] });
});

it('uses the last initializer and withholds dynamic constructor claims', async () => {
  await fs.writeFile(
    path.join(dir, 'model.py'),
    'class Invoice:\n    def __init__(self): pass\n    def __init__(self, legacy=True): pass\n',
  );
  expect(await findingsFor(dir, 'all', undefined, [target], incoming)).toEqual([]);
  for (const model of [
    'class Invoice(metaclass=Meta):\n    def __init__(self): pass\n',
    '@wrap\nclass Invoice:\n    pass\n',
  ]) {
    await fs.writeFile(path.join(dir, 'model.py'), model);
    expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toMatchObject({
      findings: [],
      complete: false,
    });
  }
});

it('resolves a root-package export after importing a submodule', async () => {
  await fs.mkdir(path.join(dir, 'pkg'));
  await fs.writeFile(path.join(dir, 'pkg', 'sub.py'), '');
  await fs.writeFile(path.join(dir, 'pkg', '__init__.py'), 'from model import Invoice\n');
  await fs.writeFile(path.join(dir, 'use.py'), 'import pkg.sub\npkg.Invoice(legacy=True)\n');
  await writeModel('');
  expect(await findingsFor(dir, 'all', undefined, [target], incoming)).toMatchObject([{ line: 2 }]);
});

it('records indexed inheritance as unverified while preserving proven direct calls', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'sub.py'),
    'from model import Invoice\nclass Credit(Invoice): pass\n',
  );
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], async () => [
    ...(await incoming()),
    { filePath: 'sub.py', target: target.id, relationType: 'EXTENDS' as const },
  ]);
  expect(result).toMatchObject({
    complete: false,
    findings: [{ filePath: 'use.py' }],
    skipped: [{ filePath: 'sub.py', reason: expect.stringContaining('super().__init__') }],
  });
});

it('keeps decorated function body-only edits clean and exposes changes to the decorated contract', async () => {
  await fs.writeFile(path.join(dir, 'model.py'), '@wrap\ndef charge(legacy=None):\n    return 1\n');
  commitAll(dir, 'wrapped function');
  const func = { ...target, type: 'Function', name: 'charge' };
  await fs.writeFile(path.join(dir, 'model.py'), '@wrap\ndef charge(legacy=None):\n    return 2\n');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [func], incoming)).toEqual({
    findings: [],
    complete: true,
    skipped: [],
  });
  await fs.writeFile(path.join(dir, 'model.py'), '@wrap\ndef charge():\n    return 2\n');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [func], incoming)).toMatchObject({
    findings: [],
    complete: false,
    skipped: [{ filePath: 'model.py', reason: expect.stringContaining('Decorated') }],
  });
});

it('does not treat newly added definitions in an existing module as an incomplete check', async () => {
  await fs.appendFile(path.join(dir, 'model.py'), '\n@wrap\ndef fresh(legacy=None): pass\n');
  const t = {
    id: 'Function:model.py:fresh',
    name: 'fresh',
    filePath: 'model.py',
    type: 'Function',
  };
  const calls = vi.fn(incoming);
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [t], calls)).toEqual({
    findings: [],
    complete: true,
    skipped: [],
  });
  expect(calls).not.toHaveBeenCalled();
});

it('uses lexical owner across shifted lines, and withholds findings for ambiguous IDs', async () => {
  const source = (first: string, second: string) =>
    'def left():\n    def charge(' +
    first +
    '): pass\n    charge(legacy=True)\ndef right():\n    def charge(' +
    second +
    '): pass\n    charge(legacy=True)\n';
  await fs.writeFile(path.join(dir, 'model.py'), source('legacy=None', 'legacy=None'));
  commitAll(dir, 'both callers');
  await fs.writeFile(path.join(dir, 'model.py'), '\n\n\n' + source('legacy=None', ''));
  const t = {
    type: 'Function',
    name: 'charge',
    filePath: 'model.py',
    id: 'Function:model.py:right.charge@7:4',
  };
  const check = async (id: string) =>
    findBrokenKeywordCalls(dir, 'all', undefined, [{ ...t, id }], async () => [], [
      { filePath: 'model.py' },
    ]);
  expect(await check(t.id)).toMatchObject({
    complete: true,
    findings: [{ target: t.id, line: 9 }],
  });
  expect(await check('opaque-id')).toMatchObject({ complete: false, findings: [] });
});

it('dense comments and assignments using the removed word do not consume a scope extraction', async () => {
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    '# legacy\n' + Array.from({ length: 4500 }, (_, i) => 'v' + i + '=0').join('\n'),
  );
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toEqual({
    complete: true,
    findings: [],
    skipped: [],
  });
});

it('discloses a wildcard re-export instead of silently losing the staged caller', async () => {
  await fs.writeFile(path.join(dir, 'pub.py'), 'from model import *\n');
  await fs.writeFile(path.join(dir, 'use.py'), 'from pub import Invoice\nInvoice(legacy=True)\n');
  await writeModel('');
  execFileSync('git', ['add', '.'], { cwd: dir });
  expect(await findBrokenKeywordCalls(dir, 'staged', undefined, [target], incoming)).toMatchObject({
    complete: false,
    findings: [],
    skipped: [{ filePath: 'pub.py', reason: expect.stringContaining('exported binding') }],
  });
});

it('treats absent blobs for added and deleted files as normal staged changes', async () => {
  await fs.writeFile(path.join(dir, 'new.py'), 'class New: pass\n');
  await fs.unlink(path.join(dir, 'model.py'));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  const added = { type: 'Class', name: 'New', id: 'Class:new.py:New', filePath: 'new.py' };
  expect(await findBrokenKeywordCalls(dir, 'staged', undefined, [target, added], incoming)).toEqual(
    {
      findings: [],
      complete: true,
      skipped: [],
    },
  );
});

it('checks explicit keywords previously captured by **kwargs and keeps uncertainty for dynamic unpacking', async () => {
  await writeModel(', keep=False, legacy=False, **extra');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    [
      'from model import Invoice',
      'Invoice(keep=True)',
      'Invoice(legacy=True, anything=0, keep=True)',
      'Invoice(arbitrary=True, **values)',
      'Invoice(**values)',
      'Invoice(self=True)',
    ].join('\n'),
  );
  commitAll(dir, 'variadic constructor');
  await writeModel(', keep=False');
  const r = await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming);
  expect(r.findings).toMatchObject([
    { line: 3, keywords: ['legacy', 'anything'] },
    { line: 4, keyword: 'arbitrary' },
  ]);
  expect(r).toMatchObject({
    complete: false,
    skipped: [{ filePath: 'use.py', reason: expect.stringContaining('**') }],
  });
});

it('reports a formerly arbitrary keyword even when no named parameter disappeared', async () => {
  await fs.writeFile(path.join(dir, 'model.py'), 'def charge(**kwargs): pass\n');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import charge\ncharge(keep=1, unexpected=2)\ncharge(keep=1)\n',
  );
  commitAll(dir, 'kwargs only');
  await fs.writeFile(path.join(dir, 'model.py'), 'def charge(*, keep): pass\n');
  const func = { ...target, type: 'Function', name: 'charge' };
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [func], incoming)).toMatchObject({
    complete: true,
    findings: [{ line: 2, keyword: 'unexpected' }],
  });
});

it.each([
  ['if enabled:', 'else:'],
  ['try:', 'except ImportError:'],
])('keeps conditional same-qualified definitions ambiguous (%s)', async (first, alternate) => {
  const definitions = (params: string) =>
    first +
    '\n    def charge(' +
    params +
    '): pass\n' +
    alternate +
    '\n    def charge(**kwargs): pass\n';
  await fs.writeFile(path.join(dir, 'model.py'), definitions('legacy=False'));
  commitAll(dir, 'conditional contracts');
  await fs.writeFile(path.join(dir, 'model.py'), definitions(''));
  const func = { ...target, id: 'Function:model.py:charge', type: 'Function', name: 'charge' };
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [func], incoming)).toMatchObject({
    complete: false,
    findings: [],
    skipped: [{ filePath: 'model.py', reason: expect.stringContaining('ambiguous') }],
  });
});

it('checks a 2,000-line caller with few bindings even beyond the small-tree cutoff', async () => {
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import Invoice\ndef work(logger):\n' +
      Array.from({ length: 1999 }, (_, i) => '    logger.info("message", ' + i + ')').join('\n') +
      '\n    Invoice(legacy=True)\n',
  );
  await writeModel('');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toMatchObject({
    complete: true,
    findings: [{ line: 2002, keyword: 'legacy' }],
  });
});
