/**
 * Enclosing-function climbs in the parse worker must be linear in the file,
 * however deep the nesting (#3912 review: a 1.6 MB file of closures nested 48
 * deep is quarantined by the worker pool's timeout).
 *
 * parse-worker.ts cannot be imported here (it posts to `parentPort` on load),
 * so its climb is covered through `climbAncestors` with the same stop rule
 * shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import {
  climbAncestors,
  getAncestorClimbStats,
  resetAncestorClimbStats,
} from '../../src/core/ingestion/utils/ancestor-climb.js';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';

/** `depth` arrow functions passed as call arguments, each nested in the previous one. */
function nest(depth: number): string {
  let body = '';
  for (let j = 0; j < depth; j++) body += `  items.forEach((x${j}) => { cs.save(x${j});\n`;
  for (let j = 0; j < depth; j++) body += '  });\n';
  return `class Address { save(n: number) {} }\nfunction f(cs: Address, items: number[]) {\n${body}}\n`;
}

function parse(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(source);
}

function callsOf(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === 'call_expression') out.push(node);
    for (const child of node.namedChildren) stack.push(child);
  }
  return out;
}

/** The enclosing named function, the stop rule shape `findEnclosingFunctionId` uses. */
const NAMED_FUNCTION = (node: SyntaxNode): string | undefined =>
  node.type === 'function_declaration' || node.type === 'method_definition'
    ? (node.childForFieldName('name')?.text ?? undefined)
    : undefined;

function climbCost(source: string): ReturnType<typeof getAncestorClimbStats> {
  const tree = parse(source);
  const memo = new Map<number, string | null>();
  resetAncestorClimbStats(true);
  for (const call of callsOf(tree.rootNode)) climbAncestors(call, memo, NAMED_FUNCTION, null);
  return getAncestorClimbStats();
}

/** Independent oracle: no parent index or memo from the implementation. */
function nativeEnclosingName(node: SyntaxNode): string | null {
  for (let current = node.parent; current !== null; current = current.parent) {
    const name = NAMED_FUNCTION(current);
    if (name !== undefined) return name;
  }
  return null;
}

describe('enclosing-function climbs are linear in nesting depth', () => {
  beforeEach(() => resetAncestorClimbStats(true));
  afterEach(() => resetAncestorClimbStats());

  // Eight ancestors per nesting level plus the outer body. Exact counts reject
  // both repeated walks and native reads that keep growing with depth.
  it.each([8, 16, 64])('climbs %i nested closures once per ancestor', (depth) => {
    const stats = climbCost(nest(depth));
    expect(stats.climbSteps).toBe(8 * depth + 1);
    expect(stats.nativeParentReads).toBe(Math.min(8 * depth + 1, 256));
  });

  it('does not index a flat file for many shallow climbs', () => {
    // 300 calls, three ancestors each: more than 256 native reads, none deep.
    const stats = climbCost('function f() { g(); }\n'.repeat(300));
    expect(stats.climbSteps).toBe(900);
    expect(stats.nativeParentReads).toBe(900);
    expect(stats.indexedNodes).toBe(0);
  });

  it('matches native parents across defaults, bodies, different functions and file scope', () => {
    const tree = parse(`
      function first(a = defaultCall(1)) { bodyCall(a); }
      function second() { anotherCall(); }
      outsideCall();
    `);
    const calls = callsOf(tree.rootNode).sort((a, b) => a.startIndex - b.startIndex);
    const memo = new Map<number, string | null>();
    const expected = calls.map(nativeEnclosingName);
    expect(JSON.stringify(expected)).toBe(JSON.stringify(['first', 'first', 'second', null]));
    for (const [index, call] of calls.entries()) {
      expect(climbAncestors(call, memo, NAMED_FUNCTION, null)).toBe(expected[index]);
    }
  });

  it('reuses a negative answer inside unnamed file-scope closures', () => {
    const source = 'items.forEach(() => {\n'.repeat(64) + 'outsideCall();\n' + '});\n'.repeat(64);
    const tree = parse(source);
    const calls = callsOf(tree.rootNode).sort((a, b) => b.startIndex - a.startIndex);
    const memo = new Map<number, string | null>();
    for (const call of calls) {
      expect(climbAncestors(call, memo, NAMED_FUNCTION, null)).toBe(nativeEnclosingName(call));
    }
    // Five ancestors per closure, two outer nodes, and 64 cached stopping points.
    expect(getAncestorClimbStats().climbSteps).toBe(6 * 64 + 2);
    expect(getAncestorClimbStats().nativeParentReads).toBe(32);
  });

  it('does not index unrelated literal nodes for one short climb', () => {
    const tree = parse(`const rows = [${'123456789,'.repeat(22000)}];
      function first() { onlyCall(); }`);
    const call = tree.rootNode.descendantsOfType('call_expression')[0];
    expect(climbAncestors(call, new Map(), NAMED_FUNCTION, null)).toBe('first');
    const stats = getAncestorClimbStats();
    expect(stats.climbSteps).toBe(3);
    expect(stats.nativeParentReads).toBe(3);
    expect(stats.indexedNodes).toBe(0);
  });
});
