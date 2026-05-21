/**
 * Integration tests for `findObjectLiteralBindingInfo`.
 *
 * Drives the helper against real tree-sitter ASTs (TypeScript) and pins the
 * Phase A / Phase B boundary semantics from the PR #1718 production-readiness
 * review (U1):
 *   - happy path: file-scope export const / const / export var → returns binding
 *   - local-inside-function / arrow / class-constructor → null
 *   - nested object literal → null (safe under-approximation)
 *   - block-scoped declaration (if / for body) → null
 *   - IIFE-wrapped object literal → null
 *   - assignment without declarator → null (no throw)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { findObjectLiteralBindingInfo } from '../../src/core/ingestion/utils/ast-helpers.js';
import { generateId } from '../../src/lib/utils.js';

let parser: Parser;

beforeAll(async () => {
  parser = await loadParser();
  await loadLanguage(SupportedLanguages.TypeScript, 'fixture.ts');
});

/** Locate every method_definition AST node by name. */
function findMethodNodes(root: Parser.SyntaxNode, methodName: string): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode) => {
    if (node.type === 'method_definition') {
      const name = node.childForFieldName('name');
      if (name?.text === methodName) out.push(node);
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };
  visit(root);
  return out;
}

function parseTs(code: string): Parser.Tree {
  return parser.parse(code);
}

describe('findObjectLiteralBindingInfo — happy paths', () => {
  it('exported const + shorthand method → owner binding', () => {
    const tree = parseTs(`export const fooService = { async getUser(id: string) { return id; } };`);
    const [methodNode] = findMethodNodes(tree.rootNode, 'getUser');
    expect(methodNode).toBeDefined();
    const result = findObjectLiteralBindingInfo(methodNode, 'src/foo.ts');
    expect(result).toEqual({ ownerId: generateId('Const', 'src/foo.ts:fooService') });
  });

  it('bare file-scope const → owner binding', () => {
    const tree = parseTs(`const fooService = { getUser(id: string) { return id; } };`);
    const [methodNode] = findMethodNodes(tree.rootNode, 'getUser');
    const result = findObjectLiteralBindingInfo(methodNode, 'src/foo.ts');
    expect(result).toEqual({ ownerId: generateId('Const', 'src/foo.ts:fooService') });
  });

  it('exported var (variable_declaration) → Variable label', () => {
    const tree = parseTs(`export var legacyService = { run() {} };`);
    const [methodNode] = findMethodNodes(tree.rootNode, 'run');
    const result = findObjectLiteralBindingInfo(methodNode, 'src/legacy.ts');
    expect(result).toEqual({ ownerId: generateId('Variable', 'src/legacy.ts:legacyService') });
  });
});

describe('findObjectLiteralBindingInfo — negative: container boundaries', () => {
  it('local const inside exported function → null', () => {
    const tree = parseTs(`
      export function processAll() {
        const handler = { run(x: string) { return x; } };
        return handler;
      }
    `);
    const [methodNode] = findMethodNodes(tree.rootNode, 'run');
    expect(findObjectLiteralBindingInfo(methodNode, 'src/p.ts')).toBe(null);
  });

  it('local const inside exported arrow function → null', () => {
    const tree = parseTs(`
      export const make = () => {
        const h = { run() {} };
        return h;
      };
    `);
    const [methodNode] = findMethodNodes(tree.rootNode, 'run');
    expect(findObjectLiteralBindingInfo(methodNode, 'src/p.ts')).toBe(null);
  });

  it('local const inside class constructor → null', () => {
    const tree = parseTs(`
      export class C {
        constructor() {
          const h = { run() {} };
          void h;
        }
      }
    `);
    const [methodNode] = findMethodNodes(tree.rootNode, 'run');
    expect(findObjectLiteralBindingInfo(methodNode, 'src/c.ts')).toBe(null);
  });
});

describe('findObjectLiteralBindingInfo — negative: nested literals', () => {
  it('inner method of nested literal → null (safe under-approximation)', () => {
    const tree = parseTs(`export const s = { nested: { method() {} } };`);
    const [methodNode] = findMethodNodes(tree.rootNode, 'method');
    expect(findObjectLiteralBindingInfo(methodNode, 'src/s.ts')).toBe(null);
  });

  it('top-level method alongside nested literal still binds to outer', () => {
    const tree = parseTs(`export const s = { nested: { inner() {} }, outer() {} };`);
    const [outerNode] = findMethodNodes(tree.rootNode, 'outer');
    expect(findObjectLiteralBindingInfo(outerNode, 'src/s.ts')).toEqual({
      ownerId: generateId('Const', 'src/s.ts:s'),
    });
    const [innerNode] = findMethodNodes(tree.rootNode, 'inner');
    expect(findObjectLiteralBindingInfo(innerNode, 'src/s.ts')).toBe(null);
  });
});

describe('findObjectLiteralBindingInfo — negative: block scope', () => {
  it('declared inside top-level if-block → null', () => {
    const tree = parseTs(`
      const cond = true;
      if (cond) {
        const handler = { run() {} };
        void handler;
      }
    `);
    const [methodNode] = findMethodNodes(tree.rootNode, 'run');
    expect(findObjectLiteralBindingInfo(methodNode, 'src/p.ts')).toBe(null);
  });

  it('declared inside for-of body → null', () => {
    const tree = parseTs(`
      const arr = [1, 2];
      for (const _i of arr) {
        const h = { run() {} };
        void h;
      }
    `);
    const [methodNode] = findMethodNodes(tree.rootNode, 'run');
    expect(findObjectLiteralBindingInfo(methodNode, 'src/p.ts')).toBe(null);
  });

  it('declared inside try-block → null', () => {
    const tree = parseTs(`
      try {
        const h = { run() {} };
        void h;
      } catch {}
    `);
    const [methodNode] = findMethodNodes(tree.rootNode, 'run');
    expect(findObjectLiteralBindingInfo(methodNode, 'src/p.ts')).toBe(null);
  });
});

describe('findObjectLiteralBindingInfo — negative: IIFE and assignment', () => {
  it('IIFE-wrapped object literal → null', () => {
    const tree = parseTs(`export const x = (() => ({ m() {} }))();`);
    const [methodNode] = findMethodNodes(tree.rootNode, 'm');
    expect(findObjectLiteralBindingInfo(methodNode, 'src/x.ts')).toBe(null);
  });

  it('assignment expression (no variable_declarator) → null without throwing', () => {
    const tree = parseTs(`
      let y: any;
      y = { m() {} };
    `);
    const [methodNode] = findMethodNodes(tree.rootNode, 'm');
    expect(() => findObjectLiteralBindingInfo(methodNode, 'src/y.ts')).not.toThrow();
    expect(findObjectLiteralBindingInfo(methodNode, 'src/y.ts')).toBe(null);
  });
});
