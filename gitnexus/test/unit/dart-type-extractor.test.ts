import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { typeConfig } from '../../src/core/ingestion/type-extractors/dart.js';
import { findChild } from '../../src/core/ingestion/utils/ast-helpers.js';

function loadDartOrSkip() {
  return loadLanguage(SupportedLanguages.Dart).catch(() => null);
}

function parseAndFindNodes(parser: Parser, code: string, nodeType: string) {
  const tree = parser.parse(code);
  const results: any[] = [];
  function walk(node: any) {
    if (node.type === nodeType) results.push(node);
    for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
  }
  walk(tree.rootNode);
  return results;
}

describe('Dart type extractor', () => {
  let parser: Parser;

  beforeAll(async () => {
    parser = await loadParser();
    if (!(await loadDartOrSkip())) return;
  });

  describe('Tier 0: explicit type annotations', () => {
    it('extracts type from typed variable declaration', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const nodes = parseAndFindNodes(
        parser,
        'void f() { User admin = User("x"); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      typeConfig.extractDeclaration(nodes[0], env);
      expect(env.get('admin')).toBe('User');
    });

    it('extracts type from nullable declaration', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const nodes = parseAndFindNodes(
        parser,
        'void f() { User? maybeUser = null; }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      typeConfig.extractDeclaration(nodes[0], env);
      expect(env.get('maybeUser')).toBe('User');
    });

    it('skips dynamic type', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const nodes = parseAndFindNodes(
        parser,
        'void f() { dynamic x = 1; }',
        'initialized_variable_definition',
      );
      if (nodes.length > 0) {
        typeConfig.extractDeclaration(nodes[0], env);
        expect(env.has('x')).toBe(false);
      }
    });
  });

  describe('Tier 0: parameter extraction', () => {
    it('extracts typed parameter', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const tree = parser.parse('void greet(String name, int age) {}');
      // Find formal_parameter nodes
      const params: any[] = [];
      function walk(node: any) {
        if (node.type === 'formal_parameter') params.push(node);
        for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i));
      }
      walk(tree.rootNode);
      for (const p of params) {
        typeConfig.extractParameter(p, env);
      }
      expect(env.get('name')).toBe('String');
    });
  });

  describe('Tier 1: constructor inference', () => {
    it('infers type from direct constructor call', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const classNames = new Set(['User']);
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var user = User("x"); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      typeConfig.extractInitializer!(nodes[0], env, classNames);
      expect(env.get('user')).toBe('User');
    });

    it('infers type from named constructor', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const classNames = new Set(['Dog']);
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var d = Dog.unknown(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      typeConfig.extractInitializer!(nodes[0], env, classNames);
      expect(env.get('d')).toBe('Dog');
    });

    it('does not infer when callee is not a known class', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const classNames = new Set<string>();
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var x = getUser(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      typeConfig.extractInitializer!(nodes[0], env, classNames);
      expect(env.has('x')).toBe(false);
    });

    it('skips if explicit type present', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const classNames = new Set(['User']);
      const nodes = parseAndFindNodes(
        parser,
        'void f() { User user = User("x"); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      typeConfig.extractInitializer!(nodes[0], env, classNames);
      // Should not set — Tier 0 handles this
      expect(env.has('user')).toBe(false);
    });
  });

  describe('constructor binding scanner', () => {
    it('scans direct constructor call', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var user = User(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.scanConstructorBinding!(nodes[0]);
      expect(result).toEqual({ varName: 'user', calleeName: 'User' });
    });

    it('scans qualified call (method on receiver)', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var u = svc.getUser(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.scanConstructorBinding!(nodes[0]);
      expect(result?.varName).toBe('u');
      expect(result?.calleeName).toBe('getUser');
    });

    it('returns undefined for non-call assignment', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var x = y; }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.scanConstructorBinding!(nodes[0]);
      expect(result).toBeUndefined();
    });
  });

  describe('virtual dispatch detection', () => {
    it('detects constructor type for virtual dispatch', async () => {
      if (!(await loadDartOrSkip())) return;
      const classNames = new Set(['Dog']);
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var d = Dog(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.detectConstructorType!(nodes[0], classNames);
      expect(result).toBe('Dog');
    });
  });

  describe('literal type inference', () => {
    it('infers int literal', async () => {
      if (!(await loadDartOrSkip())) return;
      const tree = parser.parse('void f() { var x = 42; }');
      const nodes: any[] = [];
      function walk(n: any) {
        if (n.type.includes('integer_literal')) nodes.push(n);
        for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
      }
      walk(tree.rootNode);
      if (nodes.length > 0) {
        expect(typeConfig.inferLiteralType!(nodes[0])).toBe('int');
      }
    });

    it('infers string literal', async () => {
      if (!(await loadDartOrSkip())) return;
      const tree = parser.parse('void f() { var x = "hello"; }');
      const nodes: any[] = [];
      function walk(n: any) {
        if (n.type === 'string_literal') nodes.push(n);
        for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
      }
      walk(tree.rootNode);
      if (nodes.length > 0) {
        expect(typeConfig.inferLiteralType!(nodes[0])).toBe('String');
      }
    });

    it('infers bool literal', async () => {
      if (!(await loadDartOrSkip())) return;
      const tree = parser.parse('void f() { var x = true; }');
      const nodes: any[] = [];
      function walk(n: any) {
        if (n.type === 'true' || n.type === 'false') nodes.push(n);
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (c) walk(c);
        }
      }
      walk(tree.rootNode);
      if (nodes.length > 0) {
        expect(typeConfig.inferLiteralType!(nodes[0])).toBe('bool');
      }
    });
  });

  describe('Tier 2: pending assignment extraction', () => {
    it('extracts copy assignment', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var copy = original; }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.extractPendingAssignment!(nodes[0], new Map());
      expect(result).toEqual({ kind: 'copy', lhs: 'copy', rhs: 'original' });
    });

    it('extracts field access', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var n = user.name; }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.extractPendingAssignment!(nodes[0], new Map());
      expect(result).toEqual({ kind: 'fieldAccess', lhs: 'n', receiver: 'user', field: 'name' });
    });

    it('extracts call result', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var u = getUser(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.extractPendingAssignment!(nodes[0], new Map());
      expect(result).toEqual({ kind: 'callResult', lhs: 'u', callee: 'getUser' });
    });

    it('extracts method call result', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var r = svc.fetch(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.extractPendingAssignment!(nodes[0], new Map());
      expect(result).toEqual({
        kind: 'methodCallResult',
        lhs: 'r',
        receiver: 'svc',
        method: 'fetch',
      });
    });

    it('skips when lhs already in scope', async () => {
      if (!(await loadDartOrSkip())) return;
      const scope = new Map([['x', 'String']]);
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var x = y; }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.extractPendingAssignment!(nodes[0], scope);
      expect(result).toBeUndefined();
    });

    it('extracts call result from await expression', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() async { var user = await getUser(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.extractPendingAssignment!(nodes[0], new Map());
      expect(result).toEqual({ kind: 'callResult', lhs: 'user', callee: 'getUser' });
    });

    it('extracts method call result from await expression', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() async { var user = await svc.fetch(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.extractPendingAssignment!(nodes[0], new Map());
      expect(result).toEqual({
        kind: 'methodCallResult',
        lhs: 'user',
        receiver: 'svc',
        method: 'fetch',
      });
    });
  });

  describe('for-loop element type resolution', () => {
    it('extracts type from explicit for-loop annotation', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f(List<User> users) { for (User u in users) {} }',
        'for_statement',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const scopeEnv = new Map<string, string>();
      const ctx = {
        scopeEnv,
        declarationTypeNodes: new Map(),
        scope: 'test@0',
        returnTypeLookup: {
          lookupReturnType: () => undefined,
          lookupRawReturnType: () => undefined,
        },
      };
      typeConfig.extractForLoopBinding!(nodes[0], ctx);
      expect(scopeEnv.get('u')).toBe('User');
    });

    it('infers element type from call iterable return type', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { for (var u in getUsers()) {} }',
        'for_statement',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const scopeEnv = new Map<string, string>();
      const ctx = {
        scopeEnv,
        declarationTypeNodes: new Map(),
        scope: 'test@0',
        returnTypeLookup: {
          lookupReturnType: (name: string) => (name === 'getUsers' ? 'User' : undefined),
          lookupRawReturnType: (name: string) => (name === 'getUsers' ? 'List<User>' : undefined),
        },
      };
      typeConfig.extractForLoopBinding!(nodes[0], ctx);
      expect(scopeEnv.get('u')).toBe('User');
    });

    it('skips non-for_statement nodes', async () => {
      if (!(await loadDartOrSkip())) return;
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var x = 1; }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const scopeEnv = new Map<string, string>();
      const ctx = {
        scopeEnv,
        declarationTypeNodes: new Map(),
        scope: 'test@0',
        returnTypeLookup: {
          lookupReturnType: () => undefined,
          lookupRawReturnType: () => undefined,
        },
      };
      typeConfig.extractForLoopBinding!(nodes[0], ctx);
      expect(scopeEnv.size).toBe(0);
    });
  });

  describe('virtual dispatch — named constructor', () => {
    it('detects constructor type for named constructor', async () => {
      if (!(await loadDartOrSkip())) return;
      const classNames = new Set(['Dog']);
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var d = Dog.unknown(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.detectConstructorType!(nodes[0], classNames);
      expect(result).toBe('Dog');
    });

    it('returns undefined when callee is not a known class', async () => {
      if (!(await loadDartOrSkip())) return;
      const classNames = new Set<string>();
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var x = getUser(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      const result = typeConfig.detectConstructorType!(nodes[0], classNames);
      expect(result).toBeUndefined();
    });
  });

  describe('literal type inference — full coverage', () => {
    it('infers double literal', async () => {
      if (!(await loadDartOrSkip())) return;
      const tree = parser.parse('void f() { var x = 3.14; }');
      const nodes: any[] = [];
      function walk(n: any) {
        if (n.type.includes('floating_point')) nodes.push(n);
        for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
      }
      walk(tree.rootNode);
      if (nodes.length > 0) expect(typeConfig.inferLiteralType!(nodes[0])).toBe('double');
    });

    it('infers false literal', async () => {
      if (!(await loadDartOrSkip())) return;
      const tree = parser.parse('void f() { var x = false; }');
      const nodes: any[] = [];
      function walk(n: any) {
        if (n.type === 'false') nodes.push(n);
        for (let i = 0; i < n.childCount; i++) {
          const c = n.child(i);
          if (c) walk(c);
        }
      }
      walk(tree.rootNode);
      if (nodes.length > 0) expect(typeConfig.inferLiteralType!(nodes[0])).toBe('bool');
    });

    it('infers null literal', async () => {
      if (!(await loadDartOrSkip())) return;
      const tree = parser.parse('void f() { var x = null; }');
      const nodes: any[] = [];
      function walk(n: any) {
        if (n.type === 'null_literal') nodes.push(n);
        for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
      }
      walk(tree.rootNode);
      if (nodes.length > 0) expect(typeConfig.inferLiteralType!(nodes[0])).toBe('null');
    });

    it('returns undefined for unknown node type', async () => {
      if (!(await loadDartOrSkip())) return;
      expect(typeConfig.inferLiteralType!({ type: 'identifier' } as any)).toBeUndefined();
    });
  });

  describe('generic and const declarations', () => {
    it('extracts outer type from generic declaration', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const nodes = parseAndFindNodes(
        parser,
        'void f() { List<String> names = []; }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      typeConfig.extractDeclaration(nodes[0], env);
      expect(env.get('names')).toBe('List');
    });

    it('infers type from generic constructor call', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const classNames = new Set(['Repository']);
      const nodes = parseAndFindNodes(
        parser,
        'void f() { var repo = Repository(); }',
        'initialized_variable_definition',
      );
      expect(nodes.length).toBeGreaterThan(0);
      typeConfig.extractInitializer!(nodes[0], env, classNames);
      expect(env.get('repo')).toBe('Repository');
    });

    it('infers type from const constructor call', async () => {
      if (!(await loadDartOrSkip())) return;
      const env = new Map<string, string>();
      const classNames = new Set(['Config']);
      const nodes = parseAndFindNodes(
        parser,
        'void f() { const config = Config(); }',
        'initialized_variable_definition',
      );
      if (nodes.length > 0) {
        typeConfig.extractInitializer!(nodes[0], env, classNames);
        expect(env.get('config')).toBe('Config');
      }
    });
  });
});
