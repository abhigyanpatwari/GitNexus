/**
 * Integration tests for Issue #76 / WI-H76: Python class methods must be
 * typed as `Method` (not `Function`) in the graph.
 *
 * Bug: Python's tree-sitter captures every function_definition — including
 * class-nested ones — as `definition.function`. The pipeline then labels them
 * as `Function` nodes. This breaks parameterCount / returnType queryability
 * (WI-H86) and uniform cross-language behavior.
 *
 * Fix: add `labelOverride` to `pythonProvider` that walks the parent chain
 * looking for `class_definition` and reclassifies nested functions as `Method`.
 * Mirrors the existing Kotlin pattern (kotlin.ts:49).
 *
 * Tests are parse-level (against the actual tree-sitter parser + queries)
 * to avoid the cost of a full DB-backed pipeline run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { getLabelFromCaptures } from '../../src/core/ingestion/utils/ast-helpers.js';

let parser: Parser;

beforeAll(async () => {
  parser = await loadParser();
});

/** Parse code, run definition queries, return matched (name, label) pairs. */
function parseAndLabel(code: string, lang: SupportedLanguages): Array<{ name: string; label: string }> {
  const tree = parser.parse(code);
  const provider = getProvider(lang);
  const query = new Parser.Query(parser.getLanguage(), provider.treeSitterQueries);
  const matches = query.matches(tree.rootNode);

  const results: Array<{ name: string; label: string }> = [];

  for (const match of matches) {
    const captureMap: Record<string, any> = {};
    let nameNode: any = null;
    for (const capture of match.captures) {
      captureMap[capture.name] = capture.node;
      if (capture.name === 'name') nameNode = capture.node;
    }
    if (!nameNode) continue;

    const label = getLabelFromCaptures(captureMap, provider);
    if (label === null) continue; // skipped (import/call)
    results.push({ name: nameNode.text, label });
  }

  return results;
}

describe('WI-H76: Python class methods typed as Method (Issue #76)', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.Python);
  });

  it('reclassifies class-nested function as Method (basic case)', () => {
    const code = `
class UserService:
    def get_users(self):
        return []

def top_level():
    pass
`;
    const results = parseAndLabel(code, SupportedLanguages.Python);

    const getUsers = results.find(r => r.name === 'get_users');
    expect(getUsers).toBeDefined();
    expect(getUsers!.label).toBe('Method');

    const topLevel = results.find(r => r.name === 'top_level');
    expect(topLevel).toBeDefined();
    expect(topLevel!.label).toBe('Function');
  });

  it('reclassifies all method kinds in a class (__init__, instance, static, classmethod)', () => {
    const code = `
class Service:
    def __init__(self):
        pass

    def instance_method(self, x):
        return x

    @staticmethod
    def static_method(x):
        return x

    @classmethod
    def class_method(cls, x):
        return x
`;
    const results = parseAndLabel(code, SupportedLanguages.Python);

    for (const name of ['__init__', 'instance_method', 'static_method', 'class_method']) {
      const r = results.find(x => x.name === name);
      expect(r, `expected to find ${name}`).toBeDefined();
      expect(r!.label, `${name} should be Method (class-nested, decorators don't change class-nesting)`).toBe('Method');
    }
  });

  it('handles nested classes: class A → class B → def foo()', () => {
    const code = `
class A:
    class B:
        def foo(self):
            return 1
`;
    const results = parseAndLabel(code, SupportedLanguages.Python);

    const foo = results.find(r => r.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo!.label).toBe('Method');
  });

  it('mixes module-level and class-nested functions in one file', () => {
    const code = `
def helper_a():
    pass

class Service:
    def method_b(self):
        pass

def helper_c():
    pass

class Other:
    def method_d(self):
        pass
`;
    const results = parseAndLabel(code, SupportedLanguages.Python);

    expect(results.find(r => r.name === 'helper_a')!.label).toBe('Function');
    expect(results.find(r => r.name === 'method_b')!.label).toBe('Method');
    expect(results.find(r => r.name === 'helper_c')!.label).toBe('Function');
    expect(results.find(r => r.name === 'method_d')!.label).toBe('Method');
  });

  it('top-level helper above a class declaration stays Function', () => {
    const code = `
def top_level():
    return 42

class Calc:
    def add(self, x):
        return x

def another_top_level():
    pass
`;
    const results = parseAndLabel(code, SupportedLanguages.Python);

    expect(results.find(r => r.name === 'top_level')!.label).toBe('Function');
    expect(results.find(r => r.name === 'add')!.label).toBe('Method');
    expect(results.find(r => r.name === 'another_top_level')!.label).toBe('Function');
  });
});

describe('WI-H76: isPythonClassMethod helper — unit coverage', () => {
  beforeAll(async () => {
    await loadLanguage(SupportedLanguages.Python);
  });

  it('isPythonClassMethod returns true for function nested in class', async () => {
    const { isPythonClassMethod } = await import('../../src/core/ingestion/utils/ast-helpers.js');
    const code = `class C:\n    def m(self):\n        pass`;
    const tree = parser.parse(code);
    const fnDef = findFunctionDef(tree.rootNode, 'm');
    expect(fnDef).toBeDefined();
    expect(isPythonClassMethod(fnDef)).toBe(true);
  });

  it('isPythonClassMethod returns false for module-level function', async () => {
    const { isPythonClassMethod } = await import('../../src/core/ingestion/utils/ast-helpers.js');
    const code = `def top():\n    pass`;
    const tree = parser.parse(code);
    const fnDef = findFunctionDef(tree.rootNode, 'top');
    expect(fnDef).toBeDefined();
    expect(isPythonClassMethod(fnDef)).toBe(false);
  });

  it('isPythonClassMethod returns true for function inside nested class', async () => {
    const { isPythonClassMethod } = await import('../../src/core/ingestion/utils/ast-helpers.js');
    const code = `class A:\n    class B:\n        def m(self):\n            pass`;
    const tree = parser.parse(code);
    const fnDef = findFunctionDef(tree.rootNode, 'm');
    expect(fnDef).toBeDefined();
    expect(isPythonClassMethod(fnDef)).toBe(true);
  });
});

/** Walk AST depth-first, return the first function_definition whose identifier matches `name`. */
function findFunctionDef(node: any, name: string): any | null {
  if (node.type === 'function_definition') {
    const id = node.childForFieldName?.('name') ?? findChildByType(node, 'identifier');
    if (id?.text === name) return node;
  }
  for (const child of node.children ?? []) {
    const found = findFunctionDef(child, name);
    if (found) return found;
  }
  return null;
}

function findChildByType(node: any, type: string): any | null {
  for (let i = 0; i < (node.childCount ?? 0); i++) {
    const c = node.child(i);
    if (c?.type === type) return c;
  }
  return null;
}
