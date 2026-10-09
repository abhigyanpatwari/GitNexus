import { describe, expect, it } from 'vitest';
import { emitPythonScopeCaptures } from '../../../../src/core/ingestion/languages/python/captures.js';
import { pythonProvider } from '../../../../src/core/ingestion/languages/python.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { getPythonParser } from '../../../../src/core/ingestion/languages/python/query.js';
import { pythonFunctionDefinitionLabel } from '../../../../src/core/ingestion/languages/python/simple-hooks.js';

function bindingScopes(source: string, name: string) {
  const parsed = extractParsedFile(pythonProvider, source, 'globals.py');
  expect(parsed).toBeDefined();
  return parsed!.scopes.filter((scope) => scope.bindings.has(name)).map((scope) => scope.kind);
}

describe('Python global declaration ownership', () => {
  it.each(['def target(): pass', 'class target: pass'])(
    'binds an explicitly global declaration at module scope: %s',
    (declaration) => {
      expect(
        bindingScopes(`def boot():\n    global target\n    ${declaration}\n`, 'target'),
      ).toEqual(['Module']);
    },
  );

  it.each(['def target(): pass', 'class target: pass'])(
    'does not promote a function-local declaration because a nested class declares it global: %s',
    (declaration) => {
      const source = `def boot():
    class Inner:
        global target
    ${declaration}
`;
      expect(bindingScopes(source, 'target')).toEqual(['Function']);
    },
  );

  it.each(['def target(): pass', 'class target: pass'])(
    'does not promote a declaration because a deeper function declares it global: %s',
    (declaration) => {
      const source = `def boot():
    def deeper():
        global target
    ${declaration}
`;
      expect(bindingScopes(source, 'target')).toEqual(['Function']);
    },
  );

  it.each(['def target(self): pass', 'class target: pass'])(
    'does not inherit global declarations across a nested class boundary: %s',
    (declaration) => {
      const source = `def boot():
    global target
    class Inner:
        ${declaration}
`;
      expect(bindingScopes(source, 'target')).toEqual(['Class']);
    },
  );

  it('does not inherit a global declaration across a nested function boundary', () => {
    const source = `def boot():
    global target
    def deeper():
        def target(): pass
`;
    expect(bindingScopes(source, 'target')).toEqual(['Function']);
  });

  it('applies class-owned globals to class and function declarations through control flow', () => {
    const source = `class Installer:
    global target, Target
    if True:
        def target(value): return value
        class Target: pass
`;
    expect(bindingScopes(source, 'target')).toEqual(['Module']);
    expect(bindingScopes(source, 'Target')).toEqual(['Module']);
    const matches = emitPythonScopeCaptures(source, 'globals.py');
    const target = matches.find((match) => match['@declaration.name']?.text === 'target')!;
    expect(target['@declaration.function']).toBeDefined();
    expect(target['@declaration.method']).toBeUndefined();
    expect(target['@declaration.parameter-count']?.text).toBe('1');
    expect(target['@declaration.required-parameter-count']?.text).toBe('1');
    expect(matches.some((match) => match['@type-binding.self'] !== undefined)).toBe(false);

    const tree = getPythonParser().parse(source);
    const functionNode = tree.rootNode.descendantsOfType('function_definition')[0]!;
    expect(pythonFunctionDefinitionLabel(functionNode, 'Function')).toBe('Function');
  });

  it('does not treat comments or strings as global declarations', () => {
    const source = `def boot():
    # global target
    description = "global target"
    def target(): pass
`;
    expect(bindingScopes(source, 'target')).toEqual(['Function']);
  });
});
