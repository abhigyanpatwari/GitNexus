import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { isBuiltinDescriptor } from '../../../../src/core/ingestion/languages/python/builtin-descriptors.js';

const parser = new Parser();
parser.setLanguage(Python);

/** Is `@staticmethod` on the function named `t` the builtin descriptor? */
const decoratesWithBuiltin = (source: string): boolean => {
  const target = parser
    .parse(source)
    .rootNode.descendantsOfType('function_definition')
    .find((fn) => fn.childForFieldName('name')?.text === 't')!;
  return isBuiltinDescriptor(target, 'staticmethod', 'staticmethod');
};

const method = ['    @staticmethod', '    def t(v):', '        return v'];
const resetHelper = ['def reset():', '    global staticmethod', '    del staticmethod'];
const nonlocalRebind = [
  '    def rebind():',
  '        nonlocal staticmethod',
  '        staticmethod = lambda f: f',
];

// `true` means CPython's `A().t(7)` returns 7, so the decorator evaluated to
// the builtin staticmethod. A wildcard import from a module this file cannot
// see is expected `false` because the resolver fails closed, not because
// CPython always shadows the builtin there.
describe('Python builtin descriptor identity', () => {
  it.each([
    ['a later module assignment', ['class A:', ...method, 'staticmethod = lambda f: f'], true],
    ['a plain read', ['g = staticmethod(len)', 'class A:', ...method], true],
    [
      'an import of the builtin itself',
      ['from builtins import staticmethod', 'class A:', ...method],
      true,
    ],
    ['a later class-body assignment', ['class A:', ...method, '    staticmethod = 1'], true],
    [
      'an outer class-body assignment',
      ['class O:', '    staticmethod = 1', '    class A:', ...method.map((line) => `    ${line}`)],
      true,
    ],
    [
      'a sibling function local',
      ['def other():', '    staticmethod = 1', 'class A:', ...method],
      true,
    ],
    ['an earlier module assignment', ['staticmethod = lambda f: f', 'class A:', ...method], false],
    [
      'an earlier import alias',
      ['from abc import abstractmethod as staticmethod', 'class A:', ...method],
      false,
    ],
    ['an earlier wildcard import', ['from helpers import *', 'class A:', ...method], false],
    ['an earlier class-body assignment', ['class A:', '    staticmethod = 1', ...method], false],
    [
      'a later assignment in the same loop',
      [
        'for i in range(2):',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        '    staticmethod = lambda f: f',
      ],
      false,
    ],
    [
      'a module assignment after a deferred class body',
      [
        'def make():',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        '    return A',
        'staticmethod = lambda f: f',
      ],
      false,
    ],
    [
      'a later local in the enclosing function',
      [
        'def make():',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        '    staticmethod = 1',
      ],
      false,
    ],
    [
      'a global declaration alone',
      ['class A:', ...method, 'def rebind():', '    global staticmethod'],
      true,
    ],
    ['an unconditional del', ['staticmethod = 1', 'del staticmethod', 'class A:', ...method], true],
    [
      'a class-body del',
      ['class A:', '    staticmethod = 1', '    del staticmethod', ...method],
      true,
    ],
    [
      'a conditional del',
      ['staticmethod = 1', 'if False:', '    del staticmethod', 'class A:', ...method],
      false,
    ],
    [
      'a same-name builtins re-export',
      ['from builtins import staticmethod as staticmethod', 'class A:', ...method],
      true,
    ],
    [
      'a global rebind defined after the class',
      [
        'class A:',
        ...method,
        'def rebind():',
        '    global staticmethod',
        '    staticmethod = lambda f: f',
        'rebind()',
      ],
      true,
    ],
    [
      'a global rebind defined before the class',
      [
        'def rebind():',
        '    global staticmethod',
        '    staticmethod = 1',
        'rebind()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'a builtins import after an override',
      ['staticmethod = lambda f: f', 'from builtins import staticmethod', 'class A:', ...method],
      true,
    ],
    ['a builtins wildcard import', ['from builtins import *', 'class A:', ...method], true],
    [
      'a class-body builtins import over a module override',
      ['staticmethod = 1', 'class A:', '    from builtins import staticmethod', ...method],
      true,
    ],
    [
      'a conditional builtins import after an override',
      [
        'staticmethod = 1',
        'if flag:',
        '    from builtins import staticmethod',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // A bare top-level call runs the helper's `global` delete at the call.
      'a global del in a called helper',
      ['staticmethod = lambda f: f', ...resetHelper, 'reset()', 'class A:', ...method],
      true,
    ],
    [
      'a global builtins import in a called helper',
      [
        'staticmethod = lambda f: f',
        'def reset():',
        '    global staticmethod',
        '    from builtins import staticmethod',
        'reset()',
        'class A:',
        ...method,
      ],
      true,
    ],
    [
      'a called helper before a deferred class body',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'reset()',
        'def make():',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        '    return A',
      ],
      true,
    ],
    [
      // CPython restores the builtin; a conditional call is not modelled.
      'a called helper inside an if',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'if True:',
        '    reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'a called helper inside a boolean expression',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'flag = False',
        'flag and reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // The target binds after the call returns.
      'a called helper whose result rebinds the name',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        '    return lambda f: f',
        'staticmethod = reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'an override after a called helper',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'reset()',
        'staticmethod = lambda f: f',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // Calling a generator function does not run its body.
      'a called generator helper',
      ['staticmethod = lambda f: f', ...resetHelper, '    yield', 'reset()', 'class A:', ...method],
      false,
    ],
    [
      'a called helper that may return first',
      [
        'staticmethod = lambda f: f',
        'def reset(flag=True):',
        '    global staticmethod',
        '    if flag:',
        '        return',
        '    del staticmethod',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'a called helper whose name is rebound',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'reset = print',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // The call runs the builtin print(); the helper is defined afterwards.
      'a call before the helper is defined',
      [
        'staticmethod = lambda f: f',
        'print()',
        'class A:',
        ...method,
        'def print():',
        '    global staticmethod',
        '    del staticmethod',
      ],
      false,
    ],
    [
      'a helper name captured by a match pattern',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'match 1:',
        '    case int() as reset:',
        '        pass',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'a match capture in the helper after its restore',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        '    match [1]:',
        '        case [*staticmethod]:',
        '            pass',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'a module-level match capture',
      ['match 1:', '    case object() as staticmethod:', '        pass', 'class A:', ...method],
      false,
    ],
    [
      // The call raises TypeError before the helper body runs.
      'a call missing a required helper argument',
      [
        'staticmethod = lambda f: f',
        'def reset(required):',
        '    global staticmethod',
        '    del staticmethod',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'a call to a helper whose parameters all have defaults',
      [
        'staticmethod = lambda f: f',
        'def reset(flag=True, *args: int, **kw):',
        '    global staticmethod',
        '    del staticmethod',
        'reset()',
        'class A:',
        ...method,
      ],
      true,
    ],
    [
      'a match value pattern that reads the name',
      [
        'import builtins',
        'match 1:',
        '    case builtins.staticmethod:',
        '        pass',
        'class A:',
        ...method,
      ],
      true,
    ],
    [
      'a match class pattern that reads the name',
      ['match 1:', '    case staticmethod():', '        pass', 'class A:', ...method],
      true,
    ],
    [
      'a match keyword capture of the name',
      ['match 1:', '    case int(real=staticmethod):', '        pass', 'class A:', ...method],
      false,
    ],
    [
      // A parameter named like the helper is local to its own function.
      'a function parameter named like the helper',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'def unrelated(reset):',
        '    pass',
        'reset()',
        'class A:',
        ...method,
      ],
      true,
    ],
    [
      // CPython keeps the builtin because swap() is never called; the
      // resolver cannot prove that, so it fails closed.
      'a global rebind of the helper name in another function',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'def swap():',
        '    global reset',
        '    reset = print',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // CPython restores the builtin; any `global` rebind in the helper keeps
      // the resolver fail-closed, even after a return.
      'a helper that rebinds after returning',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        '    return',
        '    staticmethod = 1',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'a helper whose restore is conditional',
      [
        'staticmethod = lambda f: f',
        'def reset(flag=False):',
        '    global staticmethod',
        '    if flag:',
        '        del staticmethod',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // Calling a coroutine function does not run its body.
      'a called async helper',
      [
        'staticmethod = lambda f: f',
        'async def reset():',
        '    global staticmethod',
        '    del staticmethod',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      'a called helper that returns after restoring',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        '    return',
        'reset()',
        'class A:',
        ...method,
      ],
      true,
    ],
    [
      // A nested function's return does not end the helper.
      'a called helper with a nested return before restoring',
      [
        'staticmethod = lambda f: f',
        'def reset():',
        '    global staticmethod',
        '    def g(): return 1',
        '    del staticmethod',
        'reset()',
        'class A:',
        ...method,
      ],
      true,
    ],
    [
      // CPython restores the builtin; the wildcard import could rebind the
      // helper name, so the resolver fails closed.
      'a called helper after a wildcard import',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'from os.path import *',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // The helper writes module globals, not the class namespace.
      'a class-body call after a class-local override',
      [
        'staticmethod = lambda f: f',
        ...resetHelper,
        'class A:',
        '    staticmethod = lambda f: f',
        '    reset()',
        ...method,
      ],
      false,
    ],
    [
      'a function-body call after a function-local override',
      [
        'def reset():',
        '    global staticmethod',
        '    from builtins import staticmethod',
        'def make():',
        '    staticmethod = lambda f: f',
        '    reset()',
        '    class A:',
        ...method.map((line) => `    ${line}`),
      ],
      false,
    ],
    [
      // CPython restores the builtin; the helper's earlier `global` rebind
      // keeps the resolver fail-closed.
      'a called helper that rebinds before deleting',
      [
        'staticmethod = lambda f: f',
        'def reset():',
        '    global staticmethod',
        '    staticmethod = 1',
        '    del staticmethod',
        'reset()',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // CPython keeps the builtin when rebind() is never called; whether it
      // is called is not modelled, so the resolver fails closed.
      'a global rebind helper that is never called',
      [
        'def rebind():',
        '    global staticmethod',
        '    staticmethod = lambda f: f',
        'class A:',
        ...method,
      ],
      false,
    ],
    [
      // CPython keeps the builtin; call order is not modelled (fail closed).
      'an uncalled nonlocal rebind over an enclosing builtins import',
      [
        'def make():',
        '    from builtins import staticmethod',
        ...nonlocalRebind,
        '    class A:',
        ...method.map((line) => `    ${line}`),
      ],
      false,
    ],
    [
      'a called nonlocal rebind over an enclosing builtins import',
      [
        'def make():',
        '    from builtins import staticmethod',
        ...nonlocalRebind,
        '    rebind()',
        '    class A:',
        ...method.map((line) => `    ${line}`),
      ],
      false,
    ],
    [
      // CPython keeps the builtin because make() runs after the del; call
      // order is not modelled (fail closed).
      'a module del after a deferred class body, called afterwards',
      [
        'staticmethod = lambda f: f',
        'def make():',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        '    return A',
        'del staticmethod',
        'make()',
      ],
      false,
    ],
    [
      // Each class statement builds a fresh namespace, so the decorator runs
      // before that iteration's own class-body assignment.
      'a later class-body assignment inside a loop',
      [
        'for i in range(2):',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        '        staticmethod = 1',
      ],
      true,
    ],
    [
      'a builtins import in the enclosing function',
      [
        'def make():',
        '    from builtins import staticmethod',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        '    staticmethod = 1',
      ],
      true,
    ],
    [
      'an enclosing-function local assigned before the class',
      [
        'def make():',
        '    staticmethod = 1',
        '    class A:',
        ...method.map((line) => `    ${line}`),
      ],
      false,
    ],
    [
      'an enclosing-function local assigned only after the class',
      [
        'def make():',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        '    staticmethod = 1',
      ],
      false,
    ],
    [
      'a nonlocal rebind in a nested function',
      [
        'def make():',
        '    staticmethod = 1',
        '    def rebind():',
        '        nonlocal staticmethod',
        '        staticmethod = 2',
        '    class A:',
        ...method.map((line) => `    ${line}`),
      ],
      false,
    ],
    [
      'a module del before a deferred class body',
      [
        'staticmethod = lambda f: f',
        'del staticmethod',
        'def make():',
        '    class A:',
        ...method.map((line) => `    ${line}`),
      ],
      true,
    ],
    [
      // make() may run while the override is still bound.
      'a module del after a deferred class body',
      [
        'staticmethod = lambda f: f',
        'def make():',
        '    class A:',
        ...method.map((line) => `    ${line}`),
        'del staticmethod',
      ],
      false,
    ],
  ])('with %s', (_case, lines, builtin) => {
    expect(decoratesWithBuiltin(lines.join('\n'))).toBe(builtin);
  });
});
