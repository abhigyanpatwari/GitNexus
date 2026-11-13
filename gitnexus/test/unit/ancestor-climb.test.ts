/**
 * Enclosing-function climbs in the parse worker must be linear in the file,
 * however deep the nesting (#3912 review: a 1.6 MB file of closures nested 48
 * deep is quarantined by the worker pool's timeout).
 *
 * Two climbs ran from every call or reference to its enclosing named function
 * and passed every anonymous closure on the way: `findEnclosingScopeKey`
 * (type-env, once per receiver lookup) and `findEnclosingFunctionId`
 * (parse-worker, once per call). Each step read `parent`, which re-descends
 * from the root in node-tree-sitter, so a lookup k levels deep cost k steps of
 * depth each. Both now go through `climbAncestors`: parents from a per-tree
 * index, and the answer kept at every ancestor a climb examined.
 *
 * parse-worker.ts cannot be imported here (it posts to `parentPort` on load),
 * so its climb is covered through `climbAncestors` with the same stop rule
 * shape; type-env's climb is covered through `buildTypeEnv(...).lookup`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildTypeEnv } from '../../src/core/ingestion/type-env.js';
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

type Stats = { climbSteps: number; nativeParentReads: number };

function typeEnvCost(depth: number): Stats & { types: string[] } {
  const tree = parse(nest(depth));
  const env = buildTypeEnv(tree, SupportedLanguages.TypeScript);
  const calls = callsOf(tree.rootNode);
  resetAncestorClimbStats();
  const types = calls.map((call) => env.lookup('cs', call) ?? '-');
  return { ...getAncestorClimbStats(), types };
}

function climbCost(depth: number): Stats {
  const tree = parse(nest(depth));
  const calls = callsOf(tree.rootNode);
  const memo = new Map<number, string | null>();
  resetAncestorClimbStats();
  for (const call of calls) climbAncestors(call, memo, NAMED_FUNCTION, null);
  return getAncestorClimbStats();
}

/**
 * Linear growth: the steps added by 48 more levels (16 -> 64) are at most 6x
 * the steps added by 8 more (8 -> 16). A climb per lookup that passes every
 * enclosing closure makes each added level cost more than the one before.
 */
function expectLinear(cost: (depth: number) => Stats): void {
  const [d8, d16, d64] = [8, 16, 64].map((depth) => cost(depth));
  expect(d64.climbSteps - d16.climbSteps).toBeLessThanOrEqual(6 * (d16.climbSteps - d8.climbSteps));
  // Every parent came from the index, none from a native read.
  expect(d64.nativeParentReads).toBe(0);
}

describe('enclosing-function climbs are linear in nesting depth', () => {
  beforeEach(() => resetAncestorClimbStats());

  it('type-env: every receiver lookup reuses the scope an enclosing lookup found', () => {
    expectLinear(typeEnvCost);
    // Each `cs.save(...)` and `items.forEach(...)` call reads `cs` in f's scope.
    expect(new Set(typeEnvCost(16).types)).toEqual(new Set(['Address']));
  });

  it('parse-worker shape: a call climbs only as far as the first ancestor already answered', () => {
    expectLinear(climbCost);
  });

  it('the memoised answer is the answer a fresh climb gives, for every call', () => {
    const tree = parse(nest(32));
    const memo = new Map<number, string | null>();
    for (const call of callsOf(tree.rootNode)) {
      const fresh = climbAncestors(call, new Map(), NAMED_FUNCTION, null);
      expect(climbAncestors(call, memo, NAMED_FUNCTION, null)).toBe(fresh);
    }
  });
});
