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

describe('Python missing-member subtype argument shapes', () => {
  it('preserves simple positional compatibility across capture snapshot restore', () => {
    emitPythonScopeCaptures(callerSource, 'caller.py');
    emitPythonScopeCaptures(targetSource, 'targets.py');
    const callerSnapshot = collectPythonSubtypeDispatchSideChannel('caller.py');
    const targetSnapshot = collectPythonSubtypeDispatchSideChannel('targets.py');

    expect(callerSnapshot).toBeDefined();
    expect(targetSnapshot).toBeDefined();
    expect(() => structuredClone(callerSnapshot)).not.toThrow();
    expect(() => structuredClone(targetSnapshot)).not.toThrow();

    const fresh = [
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(5)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', keywordSite, candidate(8)),
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(11),
      ),
    ];
    expect(fresh).toEqual(['compatible', 'incompatible', 'unknown', 'unknown']);

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
      simplePositionalCalls: [[21, 0]],
    });
  });
});
