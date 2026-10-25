/**
 * R replacement-call detection scales linearly with nesting depth and argument count.
 *
 * `emitRScopeCaptures` asks, for every free call, whether it lies in the target chain of an
 * assignment (`foo(x) <- v` runs `` `foo<-` ``). Asking that per call by walking up the tree
 * costs O(depth) per call (and tree-sitter's `.parent` re-descends from the root, so more in
 * real time), and finding the first argument by materialising the whole argument list costs
 * O(args) per call: a deep `nn(nn(...))` or a wide `c(f(1), ..., f(n))` then stalls the parse
 * worker, the file is dropped, and a large enough one aborts the whole analyse.
 *
 * The work is counted, not timed: every node read made through a counting wrapper is one
 * visit, and `.parent` is served from a precomputed map at one visit, so the count is the
 * same on every machine and gate load cannot flip it. Doubling the input may at most
 * (about) double the visits of the path `emitRScopeCaptures` uses. A control shows the
 * per-call oracle is super-linear on the same inputs, so the inputs do exercise the problem.
 * `rReplacementCallIds` must give exactly the oracle's answer on every R fixture.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SyntaxNode } from '../../../../src/core/ingestion/utils/ast-helpers.js';
import { getRParser, getRScopeQuery } from '../../../../src/core/ingestion/languages/r/query.js';
import {
  isRReplacementCall,
  rReplacementCallIds,
  rReplacementCallTest,
} from '../../../../src/core/ingestion/languages/r/assignment.js';
import { emitRScopeCaptures } from '../../../../src/core/ingestion/languages/r/captures.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures', import.meta.url));

const parse = (source: string) =>
  getRParser().parse(source, undefined, { bufferSize: 4 * source.length + 65536 });

/** Every node of the tree, top-down, without recursion. */
function allNodes(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    out.push(node);
    for (const child of node.namedChildren) stack.push(child);
  }
  return out;
}

/**
 * A view of the tree that counts node reads: every property read on a wrapped node is one
 * visit, and so is every node an array result hands back. `.parent` is answered from a map
 * built once, at one visit, so the count does not depend on how the binding finds a parent.
 */
function countingView(root: SyntaxNode) {
  const counter = { visits: 0 };
  const parentOf = new Map<number, SyntaxNode>();
  for (const node of allNodes(root)) {
    for (const child of node.children) parentOf.set(child.id, node);
  }
  const proto = Object.getPrototypeOf(root);
  const wrapped = new Map<number, SyntaxNode>();
  const isNode = (value: unknown): value is SyntaxNode =>
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === proto;
  const wrapValue = (value: unknown): unknown => {
    if (isNode(value)) return wrap(value);
    if (Array.isArray(value)) {
      counter.visits += value.length;
      return value.map(wrapValue);
    }
    return value;
  };
  const wrap = (node: SyntaxNode): SyntaxNode => {
    const known = wrapped.get(node.id);
    if (known !== undefined) return known;
    const proxy = new Proxy(node, {
      get(target, prop) {
        counter.visits++;
        if (prop === 'parent') {
          const parent = parentOf.get(target.id);
          return parent === undefined ? null : wrap(parent);
        }
        const value = Reflect.get(target, prop, target);
        if (typeof value === 'function') {
          return (...args: unknown[]) => wrapValue(value.apply(target, args));
        }
        return wrapValue(value);
      },
    });
    wrapped.set(node.id, proxy);
    return proxy;
  };
  return { counter, wrap };
}

/** The free calls the scope query captures, as `emitRScopeCaptures` sees them. */
function freeCalls(root: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  for (const match of getRScopeQuery().matches(root)) {
    for (const capture of match.captures) {
      if (capture.name === 'reference.call.free') calls.push(capture.node);
    }
  }
  return calls;
}

/** Visits the capture path spends answering "is this free call a replacement call?" for every free call. */
function capturePathVisits(source: string): number {
  const root = parse(source).rootNode;
  const calls = freeCalls(root);
  const { counter, wrap } = countingView(root);
  const isReplacement = rReplacementCallTest(wrap(root));
  for (const call of calls) isReplacement(wrap(call));
  return counter.visits;
}

/** Visits the per-call oracle spends on every call node (the control). */
function oracleVisits(source: string): number {
  const root = parse(source).rootNode;
  const calls = allNodes(root).filter((n) => n.type === 'call');
  const { counter, wrap } = countingView(root);
  for (const call of calls) isRReplacementCall(wrap(call));
  return counter.visits;
}

/** A shape both as an expression and as an assignment target, so the target chain is walked too. */
const both = (shape: string) => `${shape}\n${shape} <- v\n`;

const nested = (open: string, close: string, depth: number, leaf: string) =>
  open.repeat(depth) + leaf + close.repeat(depth);

const DEPTH_AXES: Array<[string, (depth: number) => string]> = [
  ['nn(nn(...))', (d) => both(nested('nn(', ')', d, 'x'))],
  ['list(a = list(...))', (d) => both(nested('list(a = ', ')', d, 'x'))],
  ['g(a$g(a$...))', (d) => both('g(' + nested('a$g(', ')', d - 1, 'x') + ')')],
];

const wide = (n: number) => both(`c(${Array.from({ length: n }, (_, i) => `f(${i})`).join(', ')})`);

const AXES: Array<[string, (n: number) => string, number[]]> = [
  ...DEPTH_AXES.map(([name, gen]): [string, (n: number) => string, number[]] => [
    `depth ${name}`,
    gen,
    [100, 200, 400],
  ]),
  ['width c(f(1), ..., f(n))', wide, [1000, 2000, 4000]],
];

describe('replacement-position detection on the capture path is linear', () => {
  it.each(AXES)('%s: doubling the input at most doubles the visits', (_axis, gen, sizes) => {
    const visits = sizes.map((n) => capturePathVisits(gen(n)));
    for (let i = 1; i < sizes.length; i++) {
      expect(
        visits[i],
        `visits ${sizes[i - 1]} -> ${sizes[i]}: ${visits.join(', ')}`,
      ).toBeLessThanOrEqual(2.2 * visits[i - 1]);
    }
  });

  it.each(AXES)(
    'control, %s: the per-call oracle is super-linear on the same inputs',
    (_axis, gen, sizes) => {
      // Two pairs are enough to show the growth, and keep the control cheap.
      const visits = sizes.slice(0, 2).map((n) => oracleVisits(gen(n)));
      expect(visits[1], `oracle visits: ${visits.join(', ')}`).toBeGreaterThan(3 * visits[0]);
    },
  );
});

/** Whether some capture of `matches` has exactly the text `text`. */
const capturesText = (matches: readonly CaptureMatch[], text: string): boolean =>
  matches.some((m) => Object.values(m).some((c) => c?.text === text));

describe('a pathological file finishes emitRScopeCaptures quickly', () => {
  // Generous absolute bounds: the old per-call walk took minutes on these inputs.
  it('first-argument nesting 1,500 deep', () => {
    const source = nested('nn(', ')', 1500, 'x') + '\nsentinel <- function() 1\n';
    const started = performance.now();
    const matches = emitRScopeCaptures(source, 'deep.R');
    expect(performance.now() - started).toBeLessThan(5000);
    expect(capturesText(matches, 'sentinel')).toBe(true);
  }, 30_000);

  it('10,000 call-valued arguments', () => {
    const args = Array.from({ length: 10_000 }, (_, i) => `k${i} = fn(${i})`).join(', ');
    const source = `x <- c(${args})\nsentinel <- function() 1\n`;
    const started = performance.now();
    const matches = emitRScopeCaptures(source, 'wide.R');
    expect(performance.now() - started).toBeLessThan(5000);
    expect(capturesText(matches, 'sentinel')).toBe(true);
  }, 30_000);
});

/** Every R source file under the test fixtures. */
function fixtureRFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...fixtureRFiles(full));
    else if (entry.isFile() && /\.[Rr]$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('rReplacementCallIds gives the per-call answer exactly', () => {
  const files = fixtureRFiles(FIXTURES);

  it('finds the R fixtures', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('agrees with isRReplacementCall on every call of every R fixture', () => {
    let replacementCalls = 0;
    const mismatches: string[] = [];
    for (const file of files) {
      const root = parse(fs.readFileSync(file, 'utf-8')).rootNode;
      const expected = allNodes(root)
        .filter((n) => n.type === 'call' && isRReplacementCall(n))
        .map((n) => n.id)
        .sort((a, b) => a - b);
      const actual = [...rReplacementCallIds(root)].sort((a, b) => a - b);
      replacementCalls += expected.length;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(path.relative(FIXTURES, file));
      }
    }
    expect(mismatches).toEqual([]);
    // The fixtures do contain replacement calls, so the agreement is not vacuous.
    expect(replacementCalls).toBeGreaterThan(20);
  });

  it.each([
    'foo(x) <- 1',
    'foo(bar(x)) <- 1',
    'foo(x, bar(1)) <- v',
    'foo(x)[bar(1)] <- v',
    'foo(x)$a <- 1',
    'names(foo(x)$a) <- v',
    'foo(x)[[i]] <- v',
    'v -> foo(x)',
    'v ->> foo(bar(x))',
    'foo(x) <<- v',
    'foo(x) = v',
    'pkg::foo(x) <- v',
    'foo(a = bar(x)) <- v',
    'foo(bar(x))@slot <- v',
    'y <- foo(bar(x))',
    '(foo(x)) <- 1',
    'foo(x <- bar(y))',
    'f(g(h(x))) <- k(1)',
    'a$g(b(x)) <- 1',
    'x[f(1)](g(2)) <- 3',
  ])('agrees on %s', (source) => {
    const root = parse(source).rootNode;
    const expected = allNodes(root)
      .filter((n) => n.type === 'call' && isRReplacementCall(n))
      .map((n) => n.text)
      .sort();
    const ids = rReplacementCallIds(root);
    const actual = allNodes(root)
      .filter((n) => ids.has(n.id))
      .map((n) => n.text)
      .sort();
    expect(actual).toEqual(expected);
  });
});
