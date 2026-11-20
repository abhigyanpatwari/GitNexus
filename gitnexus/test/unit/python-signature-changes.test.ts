import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import * as signatureImages from '../../src/core/ingestion/languages/python/signature-images.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

// Pass-through by default; one test replaces a single caller-image read.
vi.mock('../../src/core/ingestion/languages/python/signature-images.js', async (importOriginal) => {
  const actual = await importOriginal<typeof signatureImages>();
  return { ...actual, callerImages: vi.fn(actual.callerImages) };
});

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
  expect(capability.acceptsTarget({ ...target, filePath: 'Mixed.Py' })).toBe(true);
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

it.each(['all', 'staged'])(
  'checks mixed-case declarations and callers in the %s image',
  async (scope) => {
    const filePath = 'Task.PY';
    const local = { type: 'Function', name: 'run', id: 'Function:Task.PY:run', filePath };
    await fs.writeFile(path.join(dir, filePath), 'def run(legacy=None): pass\nrun(legacy=True)\n');
    await fs.writeFile(
      path.join(dir, 'Known.pY'),
      'from model import Invoice\nInvoice(legacy=True)\n',
    );
    commitAll(dir, 'mixed-case sources');
    await writeModel('');
    await fs.writeFile(path.join(dir, filePath), 'def run(): pass\nrun(legacy=True)\n');
    await fs.writeFile(
      path.join(dir, 'Added.Py'),
      'from model import Invoice\nInvoice(legacy=True)\n',
    );
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const result = await findBrokenKeywordCalls(
      dir,
      scope,
      undefined,
      [target, local],
      async () => [{ target: target.id, filePath: 'Known.pY', relationType: 'CALLS' }],
      [{ filePath }, { filePath: 'Added.Py' }],
    );
    expect(result).toMatchObject({
      complete: false,
      skipped: [{ filePath, reason: expect.stringContaining('missing from the index') }],
    });
    expect(result.findings.map((call) => [call.filePath, call.target])).toEqual([
      ['Added.Py', target.id],
      ['Known.pY', target.id],
      [filePath, local.id],
    ]);
  },
);

it.each(['all', 'staged', 'compare'])(
  'uses the exact Git path for a mixed-case target in the %s image',
  async (scope) => {
    const filePath = 'Billing.Py';
    const mixedTarget = {
      type: 'Function',
      name: 'charge',
      id: 'Function:Billing.Py:charge',
      filePath,
    };
    await fs.writeFile(path.join(dir, filePath), 'def charge(legacy=None): pass\n');
    // `use.py` already exists: on a case-insensitive checkout `Use.PY` would
    // overwrite it and Git would keep the lowercase path.
    const caller = 'Pay.PY';
    await fs.writeFile(path.join(dir, caller), 'from Billing import charge\ncharge(legacy=True)\n');
    commitAll(dir, 'original mixed-case target');
    expect(
      execFileSync('git', ['ls-files', '--', caller, filePath], { cwd: dir, encoding: 'utf8' })
        .trim()
        .split('\n')
        .sort(),
    ).toEqual([filePath, caller]);
    await fs.writeFile(path.join(dir, filePath), 'def charge(): pass\n');
    execFileSync('git', ['add', filePath], { cwd: dir });
    if (scope === 'compare') commitAll(dir, 'remove legacy');
    const result = await findBrokenKeywordCalls(
      dir,
      scope,
      scope === 'compare' ? 'HEAD^' : undefined,
      [mixedTarget],
      async () => [{ target: mixedTarget.id, filePath: caller, relationType: 'CALLS' }],
    );
    expect(result).toMatchObject({
      complete: false,
      findings: [{ filePath: caller, target: mixedTarget.id, keyword: 'legacy' }],
      skipped: [{ filePath, reason: expect.stringContaining('missing from the index') }],
    });
    const withoutEdge = await findBrokenKeywordCalls(
      dir,
      scope,
      scope === 'compare' ? 'HEAD^' : undefined,
      [mixedTarget],
      async () => [],
    );
    expect(withoutEdge).toMatchObject({ complete: false, findings: [], skipped: [{ filePath }] });
  },
);

it('prefers an exact module suffix and reports ambiguity between other staged spellings', async () => {
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    input: 'from model import Invoice\n',
    encoding: 'utf8',
  }).trim();
  const stageModule = (name: string) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.ignoreCase=false',
        'update-index',
        '--add',
        '--cacheinfo',
        '100644,' + blob + ',' + name,
      ],
      { cwd: dir },
    );
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from Bridge import Invoice\nInvoice(legacy=True)\n',
  );
  execFileSync('git', ['add', 'use.py', 'model.py'], { cwd: dir });
  stageModule('Bridge.PY');
  const check = () => findBrokenKeywordCalls(dir, 'staged', undefined, [target], incoming);
  expect(await check()).toMatchObject({ complete: true, findings: [{ filePath: 'use.py' }] });
  const unindexed = await findBrokenKeywordCalls(
    dir,
    'staged',
    undefined,
    [target],
    async () => [],
    [{ filePath: 'use.py' }],
  );
  expect(unindexed).toMatchObject({
    complete: false,
    findings: [],
    skipped: [{ filePath: 'use.py', reason: expect.stringContaining('without an indexed call') }],
  });
  stageModule('Bridge.pY');
  expect(await check()).toMatchObject({
    complete: false,
    findings: [],
    skipped: [{ filePath: 'use.py', reason: expect.stringContaining('Multiple Git paths') }],
  });
  stageModule('Bridge.py');
  expect(await check()).toMatchObject({
    complete: true,
    findings: [{ filePath: 'use.py', target: target.id, line: 2 }],
    skipped: [],
  });
});

it.each([
  ['an empty module', ''],
  ['a comment-only module', '# declaration removed\n'],
])('discloses a called declaration removed from %s', async (_, source) => {
  await fs.writeFile(path.join(dir, 'model.py'), source);
  execFileSync('git', ['add', 'model.py'], { cwd: dir });
  for (const scope of ['staged', 'all']) {
    const result = await findBrokenKeywordCalls(dir, scope, undefined, [target], incoming);
    expect(result).toEqual({
      complete: false,
      findings: [],
      skipped: [
        {
          filePath: 'model.py',
          reason: 'Declaration removed; keyword compatibility unavailable for Invoice',
        },
      ],
    });
  }
});

it('keeps a removed declaration clean when every indexed caller in the diff dropped the call', async () => {
  await fs.writeFile(path.join(dir, 'model.py'), '');
  await fs.writeFile(path.join(dir, 'use.py'), 'def build():\n    return None\n');
  expect(
    await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming, [
      { filePath: 'model.py' },
      { filePath: 'use.py' },
    ]),
  ).toEqual({ complete: true, findings: [], skipped: [] });
});

it('does not withhold a clean check for a removed declaration without callers', async () => {
  await fs.writeFile(path.join(dir, 'model.py'), '');
  const calls = vi.fn(async () => []);
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], calls)).toEqual({
    complete: true,
    findings: [],
    skipped: [],
  });
  expect(calls).toHaveBeenCalledWith([target.id]);
});

it('reads nested re-exports under literal pathspecs and treats an empty module as having no exports', async () => {
  await fs.mkdir(path.join(dir, 'pkg'));
  const bridge = path.join(dir, 'pkg', 'bridge.py');
  await fs.writeFile(bridge, 'from model import Invoice\n');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from pkg.bridge import Invoice\nInvoice(legacy=True)\n',
  );
  await writeModel('');
  vi.stubEnv('GIT_LITERAL_PATHSPECS', '1');
  try {
    const check = () => findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming);
    expect(await check()).toMatchObject({ complete: true, findings: [{ filePath: 'use.py' }] });
    await fs.writeFile(bridge, '');
    expect(await check()).toMatchObject({ complete: true, findings: [], skipped: [] });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('orders caller paths by code unit regardless of the host locale', async () => {
  const paths = ['ä.py', 'z.py', 'a.py', 'B.py'];
  for (const filePath of paths) {
    await fs.writeFile(
      path.join(dir, filePath),
      'from model import Invoice\nInvoice(legacy=True)\n',
    );
  }
  commitAll(dir, 'add callers');
  await writeModel('');
  const calls = await findingsFor(dir, 'all', undefined, [target], async () =>
    paths.map((filePath) => ({ target: target.id, filePath, relationType: 'CALLS' })),
  );
  expect(calls.map((call) => call.filePath)).toEqual(['B.py', 'a.py', 'z.py', 'ä.py']);
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
    'class Invoice:\n    def __init__(self): pass\n    __init__ = replacement\n',
    'class Invoice:\n    def __init__(self): pass\n    if condition:\n        def __init__(self): pass\n',
    'class Invoice:\n    def __init__(self): pass\n    __new__ = factory\n',
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

it('checks literal ** keys and discloses computed ** mappings for a removed named keyword', async () => {
  await fs.writeFile(
    path.join(dir, 'use.py'),
    [
      'from model import Invoice',
      "Invoice(**{'legacy': True})",
      'Invoice(**options)',
      "Invoice(**{'other': True})",
    ].join('\n'),
  );
  commitAll(dir, 'mapping callers');
  await writeModel('');
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming);
  expect(result.findings).toEqual([
    { target: target.id, name: 'Invoice', filePath: 'use.py', line: 2, keyword: 'legacy' },
  ]);
  expect(result).toMatchObject({
    complete: false,
    skipped: [
      { filePath: 'use.py', reason: 'Cannot verify keys supplied by ** at a call to Invoice' },
    ],
  });
});

it('admits a ** caller even when the removed keyword is not written in the file', async () => {
  await fs.writeFile(path.join(dir, 'use.py'), 'from model import Invoice\nInvoice(**options)\n');
  commitAll(dir, 'mapping-only caller');
  await writeModel('');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toMatchObject({
    complete: false,
    findings: [],
    skipped: [{ filePath: 'use.py', reason: expect.stringContaining('**') }],
  });
});

it('discloses computed mappings through a renamed re-export for indexed and new callers', async () => {
  const caller = 'from facade import Bill\nBill(**options)\n';
  await fs.writeFile(path.join(dir, 'facade.py'), 'from model import Invoice as Bill\n');
  await fs.writeFile(path.join(dir, 'use.py'), caller);
  commitAll(dir, 'an indexed caller through a facade');
  await writeModel('');
  await fs.writeFile(path.join(dir, 'new.py'), caller);
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming, [
    { filePath: 'model.py' },
    { filePath: 'new.py' },
  ]);
  expect(result.complete).toBe(false);
  expect(result.skipped).toEqual(
    ['new.py', 'use.py'].map((filePath) => ({
      filePath,
      reason: 'Cannot verify keys supplied by ** at a call to Invoice',
    })),
  );
});

it('attributes parenthesized callees, spaced dotted names and local aliases to the changed target', async () => {
  await fs.writeFile(
    path.join(dir, 'use.py'),
    [
      'import model',
      'from model import Invoice',
      '(Invoice)(legacy=True)',
      'model . Invoice(legacy=True)',
      'Bill = Invoice',
      'Bill(legacy=True)',
      'Qualified = model.Invoice',
      'Qualified(legacy=True)',
      'from elsewhere import Other',
      'Unrelated = Other',
      'Unrelated(legacy=True)',
    ].join('\n'),
  );
  commitAll(dir, 'callee spellings');
  await writeModel('');
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming);
  expect(result).toMatchObject({ complete: true, skipped: [] });
  expect(result.findings.map((call) => call.line)).toEqual([3, 4, 6, 8]);
});

it('discloses an ambiguous alias that may name the changed target and keeps unrelated calls silent', async () => {
  await fs.writeFile(
    path.join(dir, 'use.py'),
    [
      'from model import Invoice',
      'from elsewhere import Other',
      'Maker = Invoice',
      'if flag:',
      '    Maker = Other',
      'Maker(legacy=True)',
      'def build(factory):',
      '    factory(legacy=True)',
      '    return Other(legacy=True)',
    ].join('\n'),
  );
  commitAll(dir, 'ambiguous alias');
  await writeModel('');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toEqual({
    complete: false,
    findings: [],
    skipped: [{ filePath: 'use.py', reason: 'A conditional binding at line 6 may call Invoice' }],
  });
});

it('attributes cls, type(self) and self.__class__ inside the changed class only', async () => {
  const model = (params: string) =>
    [
      'class Invoice:',
      `    def __init__(self${params}):`,
      '        pass',
      '    @classmethod',
      '    def make(cls):',
      '        return cls(legacy=True)',
      '    def copy(self):',
      '        return type(self)(legacy=True)',
      '    def clone(self):',
      '        return self.__class__(legacy=True)',
      '    @staticmethod',
      '    def build(cls):',
      '        return cls(legacy=True)',
      'class Other:',
      '    def __init__(self, legacy=True):',
      '        pass',
      '    @classmethod',
      '    def make(cls):',
      '        return cls(legacy=True)',
      '',
    ].join('\n');
  await fs.writeFile(path.join(dir, 'model.py'), model(', legacy=True'));
  commitAll(dir, 'receivers');
  await fs.writeFile(path.join(dir, 'model.py'), model(''));
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], async () => [], [
    { filePath: 'model.py' },
  ]);
  expect(result).toMatchObject({ complete: true, skipped: [] });
  expect(result.findings.map((call) => call.line)).toEqual([6, 8, 10]);
});

it.each([
  ['a decorated dataclass', '@dataclass\nclass Invoice:\n    legacy: bool = False\n'],
  ['a class with a metaclass', 'class Invoice(metaclass=Meta):\n    legacy = None\n'],
  [
    'a conditional initializer',
    'class Invoice:\n    if flag:\n        def __init__(self, legacy=None): pass\n',
  ],
])('keeps a method body edit clean for %s', async (_, header) => {
  const model = (body: string) => header + '    def total(self):\n        return ' + body + '\n';
  await fs.writeFile(path.join(dir, 'model.py'), model('1'));
  commitAll(dir, 'opaque constructor');
  await fs.writeFile(path.join(dir, 'model.py'), '"""Edited module."""\n' + model('2'));
  const calls = vi.fn(incoming);
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], calls)).toEqual({
    complete: true,
    findings: [],
    skipped: [],
  });
  expect(calls).not.toHaveBeenCalled();
});

it('discloses a changed dataclass field instead of reporting the class clean', async () => {
  await fs.writeFile(
    path.join(dir, 'model.py'),
    '@dataclass\nclass Invoice:\n    legacy: bool = False\n',
  );
  commitAll(dir, 'dataclass');
  await fs.writeFile(path.join(dir, 'model.py'), '@dataclass\nclass Invoice:\n    pass\n');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toEqual({
    complete: false,
    findings: [],
    skipped: [{ filePath: 'model.py', reason: 'Signature unavailable or ambiguous for Invoice' }],
  });
});

it.each([
  [
    'a same-file chain of plain and builtin bases',
    'class Root:\n    pass\nclass Base(Root, Exception):\n    pass\n',
    { complete: true, findings: [{ filePath: 'use.py', line: 5 }] },
  ],
  [
    'a same-file base with a metaclass',
    'class Base(metaclass=Meta):\n    pass\n',
    {
      complete: false,
      findings: [],
      skipped: [{ filePath: 'use.py', reason: expect.stringContaining('metaclass') }],
    },
  ],
  [
    'an imported base',
    'from framework import Base\n',
    {
      complete: false,
      findings: [],
      skipped: [{ filePath: 'use.py', reason: expect.stringContaining('metaclass') }],
    },
  ],
])(
  'reports a constructor through %s only when the default metaclass is proven',
  async (_, base, expected) => {
    const model = (params: string) =>
      base + `class Invoice(Base):\n    def __init__(self${params}):\n        pass\n`;
    await fs.writeFile(path.join(dir, 'model.py'), model(', legacy=True'));
    commitAll(dir, 'base chain');
    await fs.writeFile(path.join(dir, 'model.py'), model(''));
    expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toMatchObject(
      expected,
    );
  },
);

it('discloses a changed signature that has no supplied target, but not a body-only edit', async () => {
  const lib = (params: string, body: string) =>
    `def target(amount${params}):\n    return ${body}\n\ndef pad10():\n    return 10\n`;
  await fs.writeFile(path.join(dir, 'lib.py'), lib(', legacy=False', 'amount'));
  commitAll(dir, 'library');
  const pad = { id: 'Function:lib.py:pad10', name: 'pad10', type: 'Function', filePath: 'lib.py' };
  const check = () =>
    findBrokenKeywordCalls(dir, 'all', undefined, [pad], async () => [], [{ filePath: 'lib.py' }]);
  await fs.writeFile(path.join(dir, 'lib.py'), '# moved\n'.repeat(6) + lib(', legacy=False', '0'));
  expect(await check()).toEqual({ complete: true, findings: [], skipped: [] });
  await fs.writeFile(path.join(dir, 'lib.py'), '# moved\n'.repeat(6) + lib('', 'amount'));
  expect(await check()).toEqual({
    complete: false,
    findings: [],
    skipped: [
      {
        filePath: 'lib.py',
        reason: 'Signature changed for target, but no indexed target was supplied',
      },
    ],
  });
});

it('discloses a re-export retargeted to an incompatible definition without indexed targets', async () => {
  await fs.writeFile(path.join(dir, 'old_impl.py'), 'def save(amount, legacy=False): pass\n');
  await fs.writeFile(path.join(dir, 'new_impl.py'), 'def save(amount): pass\n');
  await fs.writeFile(path.join(dir, 'same_impl.py'), 'def save(amount, legacy=True): pass\n');
  await fs.writeFile(path.join(dir, 'api.py'), 'from old_impl import save\n');
  commitAll(dir, 're-export');
  const check = () =>
    findBrokenKeywordCalls(dir, 'all', undefined, [], async () => [], [{ filePath: 'api.py' }]);
  await fs.writeFile(path.join(dir, 'api.py'), 'from same_impl import save\n');
  expect(await check()).toEqual({ complete: true, findings: [], skipped: [] });
  await fs.writeFile(path.join(dir, 'api.py'), 'from new_impl import save\n');
  expect(await check()).toEqual({
    complete: false,
    findings: [],
    skipped: [
      {
        filePath: 'api.py',
        reason:
          'Re-export save now resolves to new_impl.py instead of old_impl.py; keyword calls through this module are not verified',
      },
    ],
  });
  const restricted = await findBrokenKeywordCalls(
    dir,
    'all',
    undefined,
    [],
    async () => [],
    [{ filePath: 'api.py' }],
    'caller source unavailable',
  );
  expect(restricted).toMatchObject({
    complete: false,
    skipped: [{ filePath: 'api.py', reason: expect.stringContaining('Re-export save') }],
  });
});

it('follows a definition that moved behind a re-export to its callers', async () => {
  await fs.writeFile(path.join(dir, 'billing.py'), 'def charge(): pass\n');
  await fs.writeFile(path.join(dir, 'model.py'), 'def charge(legacy=None): pass\n');
  await fs.writeFile(path.join(dir, 'use.py'), 'from model import charge\ncharge(legacy=True)\n');
  commitAll(dir, 'local definition');
  await fs.writeFile(path.join(dir, 'model.py'), 'from billing import charge\n');
  const charge = {
    id: 'Function:model.py:charge',
    name: 'charge',
    type: 'Function',
    filePath: 'model.py',
  };
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [charge], async () => [
    { target: charge.id, filePath: 'use.py', relationType: 'CALLS' },
  ]);
  expect(result).toEqual({
    complete: true,
    findings: [
      { target: charge.id, name: 'charge', filePath: 'use.py', line: 2, keyword: 'legacy' },
    ],
    skipped: [],
  });
});

it('stops before parsing a caller once the extraction budget is spent', async () => {
  const callers = Array.from({ length: 300 }, (_, i) => `c${String(i).padStart(3, '0')}.py`);
  for (const file of callers)
    await fs.writeFile(path.join(dir, file), 'from model import Invoice\nInvoice(legacy=True)\n');
  await fs.writeFile(path.join(dir, 'z.py'), 'from model import Invoice\nInvoice(legacy=\n');
  await writeModel('');
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], async () =>
    [...callers, 'z.py'].map((filePath) => ({
      target: target.id,
      filePath,
      relationType: 'CALLS',
    })),
  );
  expect(result.findings.length).toBeGreaterThan(200);
  expect(result.skipped).toContainEqual({
    filePath: 'z.py',
    reason: 'Python scope extraction budget exceeded',
  });
});

it('keeps findings already proven when a later caller image cannot be read', async () => {
  const actual = await vi.importActual<typeof signatureImages>(
    '../../src/core/ingestion/languages/python/signature-images.js',
  );
  vi.mocked(signatureImages.callerImages).mockImplementationOnce(async function* (cwd, rev, files) {
    yield* actual.callerImages(cwd, rev, files.slice(0, 1));
    throw new Error('git cat-file failed');
  });
  for (const file of ['a.py', 'b.py'])
    await fs.writeFile(path.join(dir, file), 'from model import Invoice\nInvoice(legacy=True)\n');
  await writeModel('');
  const result = await findBrokenKeywordCalls(dir, 'all', undefined, [target], async () =>
    ['a.py', 'b.py'].map((filePath) => ({ target: target.id, filePath, relationType: 'CALLS' })),
  );
  expect(result).toEqual({
    complete: false,
    findings: [
      { target: target.id, name: 'Invoice', filePath: 'a.py', line: 2, keyword: 'legacy' },
    ],
    skipped: [
      {
        filePath: 'b.py',
        reason:
          'Caller images could not be read from Git; later files were not checked (git cat-file failed)',
      },
    ],
  });
});

it('discloses a call whose name a conditional import may bind to the changed target', async () => {
  await fs.writeFile(
    path.join(dir, 'use.py'),
    [
      'try:',
      '    from model import Invoice',
      'except ImportError:',
      '    from elsewhere import Invoice',
      'Invoice(legacy=True)',
    ].join('\n'),
  );
  commitAll(dir, 'conditional import');
  await writeModel('');
  expect(await findBrokenKeywordCalls(dir, 'all', undefined, [target], incoming)).toEqual({
    complete: false,
    findings: [],
    skipped: [{ filePath: 'use.py', reason: 'A conditional binding at line 5 may call Invoice' }],
  });
});

it('checks calls inside the diff without reading indexed callers or other modules when caller source is unavailable', async () => {
  await fs.writeFile(path.join(dir, 'bridge.py'), 'from model import Invoice\n');
  commitAll(dir, 'bridge');
  await writeModel('');
  await fs.writeFile(
    path.join(dir, 'use.py'),
    'from model import Invoice\nfrom bridge import Invoice as Bridged\nInvoice(legacy=True)\nBridged(legacy=True)\n',
  );
  const calls = vi.fn(incoming);
  const result = await findBrokenKeywordCalls(
    dir,
    'all',
    undefined,
    [target],
    calls,
    [{ filePath: 'model.py' }, { filePath: 'use.py' }],
    'caller source unavailable',
  );
  expect(calls).not.toHaveBeenCalled();
  expect(result).toEqual({
    complete: false,
    findings: [
      { target: target.id, name: 'Invoice', filePath: 'use.py', line: 3, keyword: 'legacy' },
    ],
    skipped: [
      { filePath: 'model.py', reason: 'caller source unavailable' },
      { filePath: 'bridge.py', reason: 'caller source unavailable' },
    ],
  });
});

it('does not spend scope extractions on unrelated ** calls in a large diff', async () => {
  const files = Array.from({ length: 40 }, (_, i) => `helpers${i}.py`);
  for (const file of files)
    await fs.writeFile(
      path.join(dir, file),
      'from helpers import helper\n' +
        Array.from({ length: 400 }, (_, i) => `helper(x${i}, **options)`).join('\n'),
    );
  await writeModel('');
  const result = await findBrokenKeywordCalls(
    dir,
    'all',
    undefined,
    [target],
    incoming,
    [...files, 'model.py'].map((filePath) => ({ filePath })),
  );
  expect(result).toEqual({
    complete: true,
    findings: [
      { target: target.id, name: 'Invoice', filePath: 'use.py', line: 5, keyword: 'legacy' },
    ],
    skipped: [],
  });
});

it('anchors a moved definition on a multi-name re-export statement', async () => {
  await fs.writeFile(path.join(dir, 'billing.py'), 'def charge(): pass\ndef other(): pass\n');
  await fs.writeFile(path.join(dir, 'model.py'), 'def charge(legacy=None): pass\n');
  await fs.writeFile(path.join(dir, 'use.py'), 'from model import charge\ncharge(legacy=True)\n');
  commitAll(dir, 'local definition');
  await fs.writeFile(path.join(dir, 'model.py'), 'from billing import other, charge\n');
  const charge = {
    id: 'Function:model.py:charge',
    name: 'charge',
    type: 'Function',
    filePath: 'model.py',
  };
  expect(
    await findBrokenKeywordCalls(dir, 'all', undefined, [charge], async () => [
      { target: charge.id, filePath: 'use.py', relationType: 'CALLS' },
    ]),
  ).toMatchObject({ complete: true, findings: [{ filePath: 'use.py', line: 2 }] });
});
