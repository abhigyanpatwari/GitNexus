import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeUnresolvedReceivers } from '../../../src/core/ingestion/scope-resolution/unresolved-receivers.js';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

describe('Python module accessor receivers', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-module-accessors-'));
    writeFixtureRepo(repoDir, {
      'pkg/__init__.py': '',
      'pkg/facade.py': 'def target(): return 1\n',
      'pkg/decoy.py': 'def target(): return 2\n',
      'pkg/values.py': 'facade = object()\n',
      'pkg/user.py': `def _pc():
    from pkg import facade
    return facade
def caller():
    _pc().target()
def caller_via_local():
    m = _pc()
    m.target()
def spaced_caller():
    _pc (
    ).target()
`,
      'pkg/control.py': 'from pkg import facade\ndef direct_caller():\n    facade.target()\n',
      'pkg/accessors.py': `def lazy():
    from . import facade as module
    return module
`,
      'pkg/imported.py': `from pkg.accessors import lazy as renamed
from pkg import decoy as facade
def imported_direct():
    renamed().target()
def imported_local():
    m = renamed()
    m.target()
`,
      'pkg/shadows.py': `from pkg.user import _pc
def parameter(_pc):
    _pc().target()
def before_assignment():
    m.target()
    m = _pc()
def reassigned():
    m = _pc()
    m = object()
    m.target()
def deleted():
    m = _pc()
    del m
    m.target()
def sibling():
    m.target()
def local_name():
    def _pc():
        from pkg import decoy
        return decoy
    _pc().target()
def later_local():
    _pc().target()
    _pc = object()
def two_assignments():
    m = _pc()
    m.target()
    m = object()
    m.target()
def only_sibling_accessor():
    def unrelated():
        def missing():
            from pkg import facade
            return facade
    missing().target()
`,
      'pkg/rejected.py': `def rebound():
    from pkg import facade
    facade = object()
    return facade
def ordinary_export():
    from pkg.values import facade
    return facade
def parameterized(facade):
    from pkg import facade
    return facade
def asynchronous():
    async def lazy():
        from pkg import facade
        return facade
    lazy().target()
def rejected_callers():
    rebound().target()
    ordinary_export().target()
    parameterized().target()
    m = rebound()
    m.target()
def positive_external():
    m = list()
    m.target()
`,
      'pkg/unsupported.py': `def mixed():
    from pkg import facade
    if flag:
        return facade
    return None
def unsupported_direct():
    mixed().target()
def unsupported_local():
    m = mixed()
    m.target()
def property_only():
    m = mixed()
    value = m.target
    m.target = value
`,
      'pkg/conditional.py': `def first():
    from pkg import facade
    return facade
def second():
    from pkg import decoy
    return decoy
def conditional_modules(flag):
    if flag:
        m = first()
    else:
        m = second()
    m.target()
def conditional_builtin(flag):
    if flag:
        m = first()
    else:
        m = list()
    m.target()
def suppressed_assignment():
    from contextlib import suppress
    m = first()
    with suppress(Exception):
        raise RuntimeError()
        m = second()
    m.target()
def sequential():
    m = first()
    m = second()
    m.target()
`,
      'pkg/classes.py': `class Service:
    def work(self): return 1
def factory() -> Service:
    return Service()
def existing():
    Service().work()
    factory().work()
    item = factory()
    item.work()
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, { skipGraphPhases: true });
  }, 120_000);

  afterAll(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const calls = () => getRelationships(result, 'CALLS');
  const targetCalls = () => calls().filter((edge) => edge.target === 'target');

  it('resolves direct, assigned, imported and aliased module accessors by lexical identity', () => {
    expect(
      targetCalls()
        .map((edge) => `${edge.source} -> ${edge.targetFilePath}`)
        .sort(),
    ).toEqual([
      'caller -> pkg/facade.py',
      'caller_via_local -> pkg/facade.py',
      'direct_caller -> pkg/facade.py',
      'imported_direct -> pkg/facade.py',
      'imported_local -> pkg/facade.py',
      'local_name -> pkg/decoy.py',
      'sequential -> pkg/decoy.py',
      'spaced_caller -> pkg/facade.py',
      'two_assignments -> pkg/facade.py',
    ]);
    expect(
      calls()
        .filter((edge) => edge.target === '_pc' && edge.sourceFilePath === 'pkg/user.py')
        .map((edge) => edge.source)
        .sort(),
    ).toEqual(['caller', 'caller_via_local', 'spaced_caller']);
  });

  it('records each unsupported direct and assigned call once, excluding property accesses', () => {
    const outcomes = result.resolutionOutcomes.filter(
      (outcome) => outcome.filePath === 'pkg/unsupported.py',
    );
    expect(summarizeUnresolvedReceivers(outcomes)).toMatchObject({
      counts: { target: 2 },
      totalSites: 2,
    });
  });

  it('declines conditional assignment proofs without treating a last-branch built-in as external', () => {
    expect(
      targetCalls()
        .filter((edge) => edge.sourceFilePath === 'pkg/conditional.py')
        .map((edge) => `${edge.source} -> ${edge.targetFilePath}`),
    ).toEqual(['sequential -> pkg/decoy.py']);
    const outcomes = result.resolutionOutcomes.filter(
      (outcome) => outcome.filePath === 'pkg/conditional.py',
    );
    expect(
      outcomes.map((outcome) =>
        outcome.kind === 'suppressed'
          ? [outcome.range.startLine, outcome.receiverOrigin]
          : undefined,
      ),
    ).toEqual([
      [12, 'unknown'],
      [18, 'unknown'],
      [25, 'unknown'],
    ]);
    expect(summarizeUnresolvedReceivers(outcomes)).toEqual({
      counts: { target: 3 },
      totalSites: 3,
    });
  });

  it('preserves constructor and class-returning factory dispatch without dropped calls', () => {
    expect(
      calls().filter((edge) => edge.source === 'existing' && edge.target === 'work'),
    ).toHaveLength(3);
    expect(
      summarizeUnresolvedReceivers(
        result.resolutionOutcomes.filter((outcome) => outcome.filePath === 'pkg/classes.py'),
      ),
    ).toBeUndefined();
  });

  it('keeps rejected namespace proofs observable and positively external calls separate', () => {
    const summary = summarizeUnresolvedReceivers(
      result.resolutionOutcomes.filter((outcome) => outcome.filePath === 'pkg/rejected.py'),
    );
    expect(summary).toMatchObject({
      counts: { target: 5 },
      totalSites: 5,
      externalCounts: { target: 1 },
      externalSites: 1,
    });
    expect(
      summarizeUnresolvedReceivers(
        result.resolutionOutcomes.filter((outcome) =>
          ['pkg/user.py', 'pkg/imported.py'].includes(outcome.filePath),
        ),
      ),
    ).toBeUndefined();
  });
});
