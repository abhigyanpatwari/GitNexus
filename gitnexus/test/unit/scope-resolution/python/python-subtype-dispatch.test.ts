import { describe, expect, it } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { emitPythonScopeCaptures } from '../../../../src/core/ingestion/languages/python/captures.js';
import {
  applyPythonSubtypeDispatchSideChannel,
  beginPythonSubtypeDispatchCapture,
  collectPythonSubtypeDispatchSideChannel,
} from '../../../../src/core/ingestion/languages/python/subtype-dispatch.js';
import { pythonMissingReceiverSubtypeCandidateCompatibility } from '../../../../src/core/ingestion/languages/python/scope-resolver.js';

const callerSource = [
  'class Caller:',
  '    def positional(self, value):',
  '        return self.target(value)',
  '    def keyword(self, value):',
  '        return self.target(value=value)',
  '    def too_few(self):',
  '        return self.target()',
  '    def too_many(self, value):',
  '        return self.target(value, value)',
].join('\n');

const targetSource = [
  'class Worker:',
  '    def target(self, value):',
  '        return value',
  'class KeywordOnly:',
  '    def target(self, *, value=0):',
  '        return value',
  'class PositionalOnly:',
  '    def target(self, value, /):',
  '        return value',
  'class RequiredKeywordOnly:',
  '    def target(self, value=0, *, required):',
  '        return value + required',
].join('\n');

const candidate = (line: number): SymbolDefinition => ({
  nodeId: `def:targets.py#${line}:4:Method:target`,
  filePath: 'targets.py',
  type: 'Method',
  parameterCount: 1,
  requiredParameterCount: 1,
});

const positionalSite = {
  arity: 1,
  atRange: { startLine: 3, startCol: 15, endLine: 3, endCol: 33 },
};
const keywordSite = {
  arity: 1,
  atRange: { startLine: 5, startCol: 15, endLine: 5, endCol: 39 },
};
const tooFewSite = {
  atRange: { startLine: 7, startCol: 15, endLine: 7, endCol: 28 },
};
const tooManySite = {
  atRange: { startLine: 9, startCol: 15, endLine: 9, endCol: 40 },
};

describe('Python missing-member subtype argument shapes', () => {
  it('preserves simple positional compatibility across capture snapshot restore', () => {
    const captures = emitPythonScopeCaptures(callerSource, 'caller.py');
    emitPythonScopeCaptures(targetSource, 'targets.py');
    const callerSnapshot = collectPythonSubtypeDispatchSideChannel('caller.py');
    const targetSnapshot = collectPythonSubtypeDispatchSideChannel('targets.py');

    expect(callerSnapshot).toBeDefined();
    expect(targetSnapshot).toBeDefined();
    expect(() => structuredClone(callerSnapshot)).not.toThrow();
    expect(() => structuredClone(targetSnapshot)).not.toThrow();
    expect(captures.every((capture) => capture['@reference.arity'] === undefined)).toBe(true);
    expect(callerSnapshot?.simplePositionalCalls).toEqual([
      [3, 15, 1],
      [7, 15, 0],
      [9, 15, 2],
    ]);

    const fresh = [
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(5)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', keywordSite, candidate(8)),
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(11),
      ),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooFewSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooManySite, candidate(2)),
    ];
    expect(fresh).toEqual([
      'compatible',
      'incompatible',
      'unknown',
      'unknown',
      'incompatible',
      'incompatible',
    ]);

    beginPythonSubtypeDispatchCapture('caller.py');
    beginPythonSubtypeDispatchCapture('targets.py');
    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(2)),
    ).toBe('unknown');

    applyPythonSubtypeDispatchSideChannel({
      filePath: 'caller.py',
      captureSideChannel: callerSnapshot,
    } as ParsedFile);
    applyPythonSubtypeDispatchSideChannel({
      filePath: 'targets.py',
      captureSideChannel: targetSnapshot,
    } as ParsedFile);

    expect([
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(5)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', keywordSite, candidate(8)),
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(11),
      ),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooFewSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooManySite, candidate(2)),
    ]).toEqual(fresh);
  });

  it('records notebook side-channel facts in remapped source coordinates', () => {
    emitPythonScopeCaptures('target(value)', 'notebook.ipynb', undefined, {
      sourceKind: 'pre-extracted-script',
      notebookSegments: [
        { extractStartLine: 0, extractEndLine: 0, jsonStartLine: 20, jsonEndLine: 20 },
      ],
    });

    expect(collectPythonSubtypeDispatchSideChannel('notebook.ipynb')).toMatchObject({
      simplePositionalCalls: [[21, 0, 1]],
    });
  });

  it('does not prove a decorated subtype target when the decorator identity is unknown', () => {
    emitPythonScopeCaptures(callerSource, 'caller.py');
    emitPythonScopeCaptures(
      [
        'from abc import abstractmethod as am',
        'class AbstractWorker:',
        '    @am',
        '    def target(self, value):',
        '        return value',
        'class StaticWorker:',
        '    @staticmethod',
        '    def target(value):',
        '        return value',
        'class ClassWorker:',
        '    @classmethod',
        '    def target(cls, value):',
        '        return value',
      ].join('\n'),
      'targets.py',
    );

    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(4)),
    ).toBe('unknown');
    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(8)),
    ).toBe('compatible');
    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(12),
      ),
    ).toBe('compatible');
  });

  it('does not accept a receiverless ordinary method as a zero-argument instance target', () => {
    emitPythonScopeCaptures(
      'class Caller:\n    def dispatch(self):\n        return self.target()',
      'caller.py',
    );
    emitPythonScopeCaptures(
      'class Worker:\n    def target():\n        pass\n    @staticmethod\n    def static_target():\n        pass',
      'targets.py',
    );

    const site = { atRange: { startLine: 3, startCol: 15, endLine: 3, endCol: 28 } };
    const receiverless = { ...candidate(2), parameterCount: 0, requiredParameterCount: 0 };
    const staticTarget = {
      ...candidate(5),
      nodeId: 'def:targets.py#5:4:Method:static_target',
      parameterCount: 0,
      requiredParameterCount: 0,
    };

    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', site, receiverless),
    ).toBe('unknown');
    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', site, staticTarget),
    ).toBe('compatible');
  });

  it('resolves decorator identity the way CPython evaluates it', () => {
    emitPythonScopeCaptures(callerSource, 'caller.py');
    emitPythonScopeCaptures(
      [
        'from abc import abstractmethod',
        'class Commented:',
        '    @staticmethod  # type: ignore[misc]',
        '    def target(value):',
        '        return value',
        'class Stacked:',
        '    @staticmethod',
        '    @classmethod',
        '    def target(cls, value):',
        '        return value',
        'class Receiverless:',
        '    def target(**options):',
        '        return options',
        'class KeywordOnlyReceiverless:',
        '    def target(*, value=0):',
        '        return value',
      ].join('\n'),
      'targets.py',
    );
    emitPythonScopeCaptures(
      [
        // `import X as Y` binds only Y, so the builtin stays visible.
        'from builtins import staticmethod as sm',
        'class Aliased:',
        '    @staticmethod',
        '    def target(value):',
        '        return value',
      ].join('\n'),
      'aliased.py',
    );
    emitPythonScopeCaptures(
      [
        'from abc import abstractmethod as staticmethod',
        'class Shadowed:',
        '    @staticmethod',
        '    def target(value):',
        '        return value',
      ].join('\n'),
      'shadowed.py',
    );
    const receiverless = (line: number) => ({
      ...candidate(line),
      parameterCount: 0,
      requiredParameterCount: 0,
    });
    const shadowed = { ...candidate(4), nodeId: 'def:shadowed.py#4:4:Method:target' };
    const verdict = (site: typeof positionalSite | typeof tooFewSite, target: SymbolDefinition) =>
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', site, target);

    expect([
      // A trailing comment is not part of the decorator expression.
      verdict(positionalSite, candidate(4)),
      verdict(tooFewSite, candidate(4)),
      // staticmethod(classmethod(f)) yields a non-callable classmethod object.
      verdict(positionalSite, candidate(9)),
      // Python still passes the instance, which these signatures cannot bind.
      verdict(tooFewSite, receiverless(12)),
      verdict(tooFewSite, receiverless(15)),
      // The module rebinds `staticmethod`, so the decorator is not the builtin.
      verdict(positionalSite, { ...shadowed, filePath: 'shadowed.py' }),
      verdict(positionalSite, {
        ...candidate(4),
        nodeId: 'def:aliased.py#4:4:Method:target',
        filePath: 'aliased.py',
      }),
    ]).toEqual([
      'compatible',
      'incompatible',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'compatible',
    ]);
  });
});
