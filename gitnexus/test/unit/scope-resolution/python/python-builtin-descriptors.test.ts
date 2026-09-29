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

// Each expectation matches CPython: `A().t(7)` returns 7 exactly when the
// decorator evaluated to the builtin staticmethod.
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
  ])('with %s', (_case, lines, builtin) => {
    expect(decoratesWithBuiltin(lines.join('\n'))).toBe(builtin);
  });
});
