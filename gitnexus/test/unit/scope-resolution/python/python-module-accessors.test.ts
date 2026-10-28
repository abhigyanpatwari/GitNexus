import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { pythonProvider } from '../../../../src/core/ingestion/languages/python.js';
import { emitPythonScopeCaptures } from '../../../../src/core/ingestion/languages/python/captures.js';
import type { PythonCaptureSideChannel } from '../../../../src/core/ingestion/languages/python/module-accessors.js';
import { pythonScopeResolver } from '../../../../src/core/ingestion/languages/python/scope-resolver.js';
import { collectPythonSubtypeDispatchSideChannel } from '../../../../src/core/ingestion/languages/python/subtype-dispatch.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';

function snapshot(filePath: string) {
  return pythonProvider.collectCaptureSideChannel?.(filePath) as
    | PythonCaptureSideChannel
    | undefined;
}

function capture(source: string, filePath = 'accessors.py') {
  emitPythonScopeCaptures(source, filePath);
  const result = snapshot(filePath);
  expect(result?.kind).toBe('python-capture');
  return result!.moduleAccessors;
}

describe('Python module accessor capture facts', () => {
  it.each([
    ['import facade', 'facade'],
    ['import package.facade as lazy', 'lazy'],
    ['from . import facade as lazy', 'lazy'],
    ['from package import facade', 'facade'],
    ['import unused, facade', 'facade'],
  ])('retains exact callable and returned binding positions for %s', (statement, name) => {
    expect(capture(`def lazy_module():\n    ${statement}\n    return ${name}\n`)).toEqual([
      {
        definitionLine: 1,
        definitionColumn: 0,
        status: 'accepted',
        returnedName: name,
        returnLine: 3,
        returnColumn: 11,
      },
    ]);
  });

  it('allows a docstring and comments without changing return ownership', () => {
    expect(
      capture(
        'def lazy_module():\n    # documentation\n    """Load lazily."""\n    import facade\n    # after import\n    return facade\n',
      ),
    ).toEqual([
      {
        definitionLine: 1,
        definitionColumn: 0,
        status: 'accepted',
        returnedName: 'facade',
        returnLine: 6,
        returnColumn: 11,
      },
    ]);
  });

  it.each([
    [
      'conditional return',
      'def lazy_module():\n    import facade\n    if flag:\n        return facade',
    ],
    [
      'mixed returns',
      'def lazy_module():\n    import facade\n    if flag:\n        return other\n    return facade',
    ],
    ['implicit fallthrough', 'def lazy_module():\n    import facade'],
    ['bare return', 'def lazy_module():\n    import facade\n    return'],
    ['decorator', '@decorate\ndef lazy_module():\n    import facade\n    return facade'],
    ['generator', 'def lazy_module():\n    import facade\n    yield 1\n    return facade'],
    ['coroutine', 'async def lazy_module():\n    import facade\n    return facade'],
    [
      'finally override',
      'def lazy_module():\n    import facade\n    try:\n        return facade\n    finally:\n        return other',
    ],
    ['parameter', 'def lazy_module(facade):\n    import facade\n    return facade'],
    ['optional parameter', 'def lazy_module(flag=False):\n    import facade\n    return facade'],
    [
      'reassignment',
      'def lazy_module():\n    import facade\n    facade = other\n    return facade',
    ],
    [
      'later assignment',
      'def lazy_module():\n    import facade\n    return facade\n    facade = other',
    ],
    ['deletion', 'def lazy_module():\n    import facade\n    del facade\n    return facade'],
    [
      'global redirection',
      'def lazy_module():\n    global facade\n    import facade\n    return facade',
    ],
    [
      'nonlocal redirection',
      'def lazy_module():\n    nonlocal facade\n    import facade\n    return facade',
    ],
    ['unimported return', 'def lazy_module():\n    import facade\n    return other'],
    ['outer import only', 'import facade\ndef lazy_module():\n    return facade'],
    ['returned attribute', 'def lazy_module():\n    import package\n    return package.facade'],
    [
      'import rebinding',
      'def lazy_module():\n    import facade\n    import other as facade\n    return facade',
    ],
    [
      'interpolated string',
      'def lazy_module():\n    f"{side_effect()}"\n    import facade\n    return facade',
    ],
  ])('records a declined candidate for %s', (_label, source) => {
    const facts = capture(source);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual({
      definitionLine: source.startsWith('@') || source.startsWith('import ') ? 2 : 1,
      definitionColumn: 0,
      status: 'declined',
    });
  });

  it('keeps nested callable returns and yields separate from the outer callable', () => {
    expect(
      capture(
        [
          'def outer():',
          '    def nested():',
          '        import facade',
          '        return facade',
          '    def generator():',
          '        yield 1',
          '    return nested()',
        ].join('\n'),
      ),
    ).toEqual([
      { definitionLine: 1, definitionColumn: 0, status: 'declined' },
      {
        definitionLine: 2,
        definitionColumn: 4,
        status: 'accepted',
        returnedName: 'facade',
        returnLine: 4,
        returnColumn: 15,
      },
      { definitionLine: 5, definitionColumn: 4, status: 'declined' },
    ]);
  });

  it('records assigned bare no-argument calls at their exact reference and lexical scope', () => {
    const parsed = extractParsedFile(
      pythonProvider,
      [
        'def first():',
        '    module = lazy_module()',
        '    other = lazy_module()',
        '    argument = lazy_module(1)',
        '    keyword = lazy_module(flag=True)',
        '    qualified = package.lazy_module()',
        '    obj.field = lazy_module()',
        'def second():',
        '    module = lazy_module()',
      ].join('\n'),
      'assigned.py',
    )!;
    const assignments = parsed.callResultAssignmentSites ?? [];
    expect(assignments.map(({ lhs }) => lhs)).toEqual(['module', 'other', 'module']);
    expect(assignments.map(({ callSite }) => callSite.startLine)).toEqual([2, 3, 9]);
    for (const assignment of assignments) {
      const reference = parsed.referenceSites.find(
        (site) =>
          site.atRange.startLine === assignment.callSite.startLine &&
          site.atRange.startCol === assignment.callSite.startCol &&
          site.name === 'lazy_module',
      );
      expect(reference?.atRange).toEqual(assignment.callSite);
      expect(reference?.inScope).toBe(assignment.inScope);
    }
    expect(assignments[0]?.inScope).toBe(assignments[1]?.inScope);
    expect(assignments[0]?.inScope).not.toBe(assignments[2]?.inScope);
  });

  it.each([
    ['if', 'if flag:\n        module = lazy_module()'],
    ['else', 'if flag:\n        pass\n    else:\n        module = lazy_module()'],
    ['for', 'for value in values:\n        module = lazy_module()'],
    ['with', 'with manager():\n        module = lazy_module()'],
    ['while', 'while flag:\n        module = lazy_module()'],
    ['try', 'try:\n        module = lazy_module()\n    except Exception:\n        pass'],
    ['except', 'try:\n        pass\n    except Exception:\n        module = lazy_module()'],
    ['finally', 'try:\n        pass\n    finally:\n        module = lazy_module()'],
    ['match', 'match value:\n        case 1:\n            module = lazy_module()'],
  ])('retains generic provenance but declines %s assignment eligibility', (_label, body) => {
    const parsed = extractParsedFile(
      pythonProvider,
      `def caller():\n    ${body}\n`,
      'conditional.py',
    )!;
    const assignments = parsed.callResultAssignmentSites ?? [];
    expect(assignments).toHaveLength(1);
    expect(snapshot('conditional.py')).toHaveProperty('callResultAssignments', [
      {
        callLine: assignments[0]!.callSite.startLine,
        callColumn: assignments[0]!.callSite.startCol,
        straightLine: false,
      },
    ]);
  });

  it('stops conditional ancestry at the owning callable and records straight-line module assignments', () => {
    const parsed = extractParsedFile(
      pythonProvider,
      [
        'module = lazy_module()',
        'if flag:',
        '    def nested():',
        '        module = lazy_module()',
      ].join('\n'),
      'ownership.py',
    )!;
    expect(parsed.callResultAssignmentSites).toHaveLength(2);
    expect(snapshot('ownership.py')).toHaveProperty('callResultAssignments', [
      { callLine: 1, callColumn: 9, straightLine: true },
      { callLine: 4, callColumn: 17, straightLine: true },
    ]);
  });

  it('composes clone-safe accessor and subtype facts and restores both after reset', () => {
    const source = [
      'def lazy_module():',
      '    import facade',
      '    return facade',
      'class Worker:',
      '    def target(self, value):',
      '        return self.target(value)',
      'module = lazy_module()',
    ].join('\n');
    capture(source);
    const before = snapshot('accessors.py')!;
    const subtypeBefore = collectPythonSubtypeDispatchSideChannel('accessors.py');
    expect(before.subtypeDispatch).toEqual(subtypeBefore);
    expect(subtypeBefore?.simplePositionalCalls).toHaveLength(2);
    expect(subtypeBefore?.positionalCapacities).toHaveLength(1);
    const clone = structuredClone(before);
    expect(JSON.parse(JSON.stringify(before))).toEqual(clone);

    emitPythonScopeCaptures('', 'accessors.py');
    expect(snapshot('accessors.py')).toBeUndefined();
    expect(collectPythonSubtypeDispatchSideChannel('accessors.py')).toBeUndefined();
    pythonScopeResolver.applyCaptureSideChannel!({
      filePath: 'accessors.py',
      captureSideChannel: clone,
    } as ParsedFile);
    expect(snapshot('accessors.py')).toEqual(before);
    expect(collectPythonSubtypeDispatchSideChannel('accessors.py')).toEqual(subtypeBefore);

    pythonScopeResolver.applyCaptureSideChannel!({ filePath: 'accessors.py' } as ParsedFile);
    expect(snapshot('accessors.py')).toBeUndefined();
    expect(collectPythonSubtypeDispatchSideChannel('accessors.py')).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    {},
    [{ callLine: 1, callColumn: 9, straightLine: 'yes' }],
    [{ callLine: 0, callColumn: 9, straightLine: true }],
  ])(
    'clears stale assignment eligibility when restored facts are absent or malformed: %j',
    (facts) => {
      emitPythonScopeCaptures('module = lazy_module()', 'restore.py');
      expect(snapshot('restore.py')).toHaveProperty('callResultAssignments', [
        { callLine: 1, callColumn: 9, straightLine: true },
      ]);
      pythonScopeResolver.applyCaptureSideChannel!({
        filePath: 'restore.py',
        captureSideChannel: {
          kind: 'python-capture',
          moduleAccessors: [],
          callResultAssignments: facts,
        },
      } as unknown as ParsedFile);
      expect(snapshot('restore.py')).toBeUndefined();
    },
  );

  it('does not leak facts between files or reuse stale facts on recapture', () => {
    capture('def lazy_module():\n    import facade\n    return facade', 'first.py');
    capture('def lazy_module():\n    return other', 'second.py');
    expect(snapshot('first.py')!.moduleAccessors[0]?.status).toBe('accepted');
    expect(snapshot('second.py')!.moduleAccessors[0]?.status).toBe('declined');
    emitPythonScopeCaptures('', 'first.py');
    expect(snapshot('first.py')).toBeUndefined();
    expect(snapshot('second.py')!.moduleAccessors[0]?.status).toBe('declined');
  });

  it('remaps accessor and assignment facts to original notebook coordinates', () => {
    const source =
      'def lazy_module():\n    import facade\n    return facade\nmodule = lazy_module()';
    const captures = emitPythonScopeCaptures(source, 'notebook.ipynb', undefined, {
      sourceKind: 'pre-extracted-script',
      notebookSegments: [
        { extractStartLine: 0, extractEndLine: 3, jsonStartLine: 20, jsonEndLine: 23 },
      ],
    });
    expect(snapshot('notebook.ipynb')?.moduleAccessors).toEqual([
      {
        definitionLine: 21,
        definitionColumn: 0,
        status: 'accepted',
        returnedName: 'facade',
        returnLine: 23,
        returnColumn: 11,
      },
    ]);
    expect(snapshot('notebook.ipynb')).toHaveProperty('callResultAssignments', [
      { callLine: 24, callColumn: 9, straightLine: true },
    ]);
    expect(
      captures.find((match) => match['@call-result-assignment.call'])?.[
        '@call-result-assignment.call'
      ]?.range.startLine,
    ).toBe(24);
  });
});
