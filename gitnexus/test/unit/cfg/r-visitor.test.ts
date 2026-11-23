import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createRCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/r.js';
import type { FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import { makeCfgHarness, type CfgHarness, block } from '../../helpers/cfg-harness.js';
import { isExitReachableFromAllBlocks } from '../../../src/core/ingestion/cfg/post-dominators.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';

// The R CfgVisitor (control flow only). Real-parser regressions asserting the
// EXACT node/edge structure: blocks are named by their source text ('' blocks
// are loop exits), so a shape reads `from -kind-> to`.

const rGrammar = createRequire(import.meta.url)('@eagleoutice/tree-sitter-r') as Parameters<
  typeof makeCfgHarness
>[0];
const r: CfgHarness = makeCfgHarness(rGrammar, createRCfgVisitor(), 'fixture.R');

const label = (cfg: FunctionCfg, i: number): string => {
  const b = cfg.blocks[i];
  return b.kind === 'entry' ? 'ENTRY' : b.kind === 'exit' ? 'EXIT' : b.text || '<exit>';
};
/** Sorted `from -kind-> to` strings. */
const shape = (cfg: FunctionCfg): string[] =>
  cfg.edges.map((e) => `${label(cfg, e.from)} -${e.kind}-> ${label(cfg, e.to)}`).sort();
const blockTexts = (cfg: FunctionCfg): string[] =>
  cfg.blocks.filter((b) => b.kind === 'normal').map((b) => b.text);

describe('R CfgVisitor — straight line and function forms', () => {
  it('straight-line body coalesces into one block: ENTRY -> block -> EXIT', () => {
    const cfg = r.cfgOf(`f <- function(x) {\n  a()\n  b()\n}\n`);
    expect(blockTexts(cfg)).toEqual(['a()\nb()']);
    expect(shape(cfg)).toEqual(['ENTRY -seq-> a()\nb()', 'a()\nb() -seq-> EXIT']);
    expect(cfg.bindings).toBeUndefined(); // control flow only: no def/use facts
  });

  it('empty function body: ENTRY -> EXIT', () => {
    const cfg = r.cfgOf(`f <- function() {}\n`);
    expect(cfg.blocks).toHaveLength(2);
    expect(shape(cfg)).toEqual(['ENTRY -seq-> EXIT']);
  });

  it('expression-bodied function and `\\(x)` lambda are CFG-bearing', () => {
    const cfgs = r.cfgsOf(`f = function(x) x + 1\ng <- \\(y) y * 2\n`);
    expect(cfgs.map(blockTexts)).toEqual([['x + 1'], ['y * 2']]);
    for (const cfg of cfgs) expect(cfg.edges).toHaveLength(2);
  });
});

describe('R CfgVisitor — branches', () => {
  it('if/else: cond-true/cond-false arms rejoin the code after', () => {
    const cfg = r.cfgOf(
      `f <- function(c) {\n  if (c) {\n    a()\n  } else {\n    b()\n  }\n  after()\n}\n`,
    );
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> c',
      'a() -seq-> after()',
      'after() -seq-> EXIT',
      'b() -seq-> after()',
      'c -cond-false-> b()',
      'c -cond-true-> a()',
    ]);
  });

  it('if without else: the false path falls through to the join', () => {
    const cfg = r.cfgOf(`f <- function(c) {\n  if (c) a()\n  after()\n}\n`);
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> c',
      'a() -seq-> after()',
      'after() -seq-> EXIT',
      'c -cond-true-> a()',
      'c -seq-> after()',
    ]);
    expect(computeControlDependence(cfg).edges).toEqual([
      { controllerBlock: block(cfg, 'c'), dependentBlock: block(cfg, 'a()'), label: 'T' },
    ]);
  });

  // An empty `{}` arm produces no block, so that arm is the fall-through edge from the
  // header (`seq`), exactly like a missing `else`. The sibling arm keeps its explicit
  // cond-true / cond-false kind and control dependence reads the fall-through arm as
  // its complement, so no branch sense is lost (the same convention as every visitor).
  it('empty then with a real else: cond-false arm plus a seq fall-through, CDG label F', () => {
    const cfg = r.cfgOf(`f <- function(c) {\n  if (c) {} else work()\n  after()\n}\n`);
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> c',
      'after() -seq-> EXIT',
      'c -cond-false-> work()',
      'c -seq-> after()',
      'work() -seq-> after()',
    ]);
    expect(computeControlDependence(cfg).edges).toEqual([
      { controllerBlock: block(cfg, 'c'), dependentBlock: block(cfg, 'work()'), label: 'F' },
    ]);
  });

  it('real then with an empty else: cond-true arm plus a seq fall-through, CDG label T', () => {
    const cfg = r.cfgOf(`f <- function(c) {\n  if (c) work() else {}\n  after()\n}\n`);
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> c',
      'after() -seq-> EXIT',
      'c -cond-true-> work()',
      'c -seq-> after()',
      'work() -seq-> after()',
    ]);
    expect(computeControlDependence(cfg).edges).toEqual([
      { controllerBlock: block(cfg, 'c'), dependentBlock: block(cfg, 'work()'), label: 'T' },
    ]);
  });

  it('both arms empty: a single seq edge and no control dependence (nothing differs)', () => {
    for (const body of ['if (c) {} else {}', 'if (c) {}']) {
      const cfg = r.cfgOf(`f <- function(c) {\n  ${body}\n  after()\n}\n`);
      expect(shape(cfg)).toEqual(['ENTRY -seq-> c', 'after() -seq-> EXIT', 'c -seq-> after()']);
      expect(computeControlDependence(cfg).edges).toEqual([]);
    }
  });

  it('empty then followed by an else-if: the chain keeps its own explicit arms', () => {
    const cfg = r.cfgOf(`f <- function(p, q) {\n  if (p) {} else if (q) a()\n  after()\n}\n`);
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> p',
      'a() -seq-> after()',
      'after() -seq-> EXIT',
      'p -cond-false-> q',
      'p -seq-> after()',
      'q -cond-true-> a()',
      'q -seq-> after()',
    ]);
    expect(computeControlDependence(cfg).edges).toEqual([
      { controllerBlock: block(cfg, 'p'), dependentBlock: block(cfg, 'q'), label: 'F' },
      { controllerBlock: block(cfg, 'q'), dependentBlock: block(cfg, 'a()'), label: 'T' },
    ]);
  });

  it('else-if chain nests through the alternative', () => {
    const cfg = r.cfgOf(`f <- function(p, q) {\n  if (p) a() else if (q) b() else c()\n}\n`);
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> p',
      'a() -seq-> EXIT',
      'b() -seq-> EXIT',
      'c() -seq-> EXIT',
      'p -cond-false-> q',
      'p -cond-true-> a()',
      'q -cond-false-> c()',
      'q -cond-true-> b()',
    ]);
  });
});

describe('R CfgVisitor — loops', () => {
  it('for: header, body loop-back and structural exit', () => {
    const cfg = r.cfgOf(`f <- function(xs) {\n  for (i in xs) {\n    g(i)\n  }\n  done()\n}\n`);
    expect(shape(cfg)).toEqual([
      '<exit> -seq-> done()',
      'ENTRY -seq-> i in xs',
      'done() -seq-> EXIT',
      'g(i) -loop-back-> i in xs',
      'i in xs -cond-false-> <exit>',
      'i in xs -cond-true-> g(i)',
    ]);
  });

  it('while with break and next: break leaves the loop, next re-tests the header', () => {
    const cfg = r.cfgOf(
      `f <- function(c, d) {\n  while (c) {\n    if (d) next\n    if (c) break\n    w()\n  }\n  done()\n}\n`,
    );
    const edges = shape(cfg);
    expect(edges).toContain('next -continue-> c');
    expect(edges).toContain('break -break-> <exit>');
    expect(edges).toContain('w() -loop-back-> c');
    expect(edges).toContain('c -cond-false-> <exit>');
    expect(edges).toContain('<exit> -seq-> done()');
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('repeat with break: body loops back, break exits, structural escape stays', () => {
    const cfg = r.cfgOf(
      `f <- function(x) {\n  repeat {\n    s()\n    if (x) break\n  }\n  done()\n}\n`,
    );
    expect(shape(cfg)).toEqual([
      '<exit> -seq-> done()',
      'ENTRY -seq-> repeat',
      'break -break-> <exit>',
      'done() -seq-> EXIT',
      'repeat -cond-false-> <exit>',
      'repeat -cond-true-> s()',
      's() -seq-> x',
      'x -cond-true-> break',
      'x -loop-back-> repeat',
    ]);
  });

  it('`while (TRUE)` / bare `repeat` keep EXIT reverse-reachable and yield CDG edges', () => {
    for (const src of [
      `f <- function(x) {\n  while (TRUE) {\n    if (x) g()\n  }\n}\n`,
      `f <- function(x) {\n  repeat {\n    if (x) g()\n  }\n}\n`,
    ]) {
      const cfg = r.cfgOf(src);
      expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
      expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    }
  });
});

describe('R CfgVisitor — return, nesting, join key', () => {
  it('return(...) in the middle goes straight to EXIT; the fall-through path is separate', () => {
    const cfg = r.cfgOf(`f <- function(x) {\n  if (x) {\n    return(1)\n  }\n  after()\n}\n`);
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> x',
      'after() -seq-> EXIT',
      'return(1) -return-> EXIT',
      'x -cond-true-> return(1)',
      'x -seq-> after()',
    ]);
  });

  it('nested functions are opaque in the parent and get their own CFG', () => {
    const cfgs = r.cfgsOf(
      `outer <- function(x) {\n  inner <- function(y) {\n    return(y)\n  }\n  inner(x)\n}\n`,
    );
    expect(cfgs).toHaveLength(2);
    expect(blockTexts(cfgs[0])).toEqual(['inner <- function(y) {\n    return(y)\n  }\ninner(x)']);
    expect(shape(cfgs[1])).toEqual(['ENTRY -seq-> return(y)', 'return(y) -return-> EXIT']);
  });

  it('anchors the CFG at the function_definition, even when `f <-` is on an earlier line', () => {
    const [same, split, eq, lambda] = r.cfgsOf(
      `a <- function(x) x\nb <-\n  function(x) x\nc = function(x) x\nd <- \\(x) x\n`,
    );
    expect(
      [same, split, eq, lambda].map((c) => [c.functionStartLine, c.functionStartColumn]),
    ).toEqual([
      [1, 5],
      [3, 2],
      [4, 4],
      [5, 5],
    ]);
  });

  it('multi-line assignment spans a single block with its full line range', () => {
    const cfg = r.cfgOf(`f <- function() {\n  x <- c(1,\n         2)\n  y <- x\n}\n`);
    expect(cfg.blocks.filter((b) => b.kind === 'normal')).toMatchObject([
      { startLine: 2, endLine: 4, text: 'x <- c(1,\n         2)\ny <- x' },
    ]);
  });

  it('reports no-facts for reaching definitions (documented coverage gap)', () => {
    const result = computeReachingDefs(r.cfgOf(`f <- function(x) {\n  y <- x\n  y\n}\n`));
    expect(result.status).toBe('no-facts');
  });
});

// docs/languages/r-provider.md, "Control flow / Not modelled": control flow nested inside an
// expression stays in one straight-line block, and `stop()`, `on.exit()` and `tryCatch()`
// handlers are ordinary calls. A statement that is only such an expression and the code after it
// coalesce into a single block between ENTRY and EXIT, with no branch edge.
describe('R CfgVisitor — control flow inside an expression is not modelled', () => {
  const straightLine = (body: string): void => {
    const cfg = r.cfgOf(`f <- function(c) {\n  ${body}\n  after()\n}\n`);
    expect(blockTexts(cfg)).toEqual([`${body}\nafter()`]);
    expect(shape(cfg)).toEqual([`ENTRY -seq-> ${body}\nafter()`, `${body}\nafter() -seq-> EXIT`]);
    expect(computeControlDependence(cfg).edges).toEqual([]);
  };

  it.each([
    'y <- if (c) a() else b()',
    'switch(c, a = x(), b = y())',
    'c && a()',
    'c || a()',
    'ifelse(c, a(), b())',
    'stop("x")',
    'on.exit(cleanup())',
    'tryCatch(a(), error = function(e) b())',
  ])('%s stays one block with no branch', (body) => {
    straightLine(body);
  });

  it('return() inside tryCatch({ }) or local({ }) does not reach EXIT early', () => {
    straightLine('tryCatch({\n    return(1)\n  }, error = function(e) 2)');
    straightLine('local({\n    return(1)\n  })');
  });

  it('break inside tryCatch({ }) in a loop leaves the loop only through its structural exit', () => {
    const cfg = r.cfgOf(
      `f <- function(c) {\n  for (i in 1:3) tryCatch({ break }, error = function(e) 1)\n  after()\n}\n`,
    );
    expect(shape(cfg)).toEqual([
      '<exit> -seq-> after()',
      'ENTRY -seq-> i in 1:3',
      'after() -seq-> EXIT',
      'i in 1:3 -cond-false-> <exit>',
      'i in 1:3 -cond-true-> tryCatch({ break }, error = function(e) 1)',
      'tryCatch({ break }, error = function(e) 1) -loop-back-> i in 1:3',
    ]);
  });
});

describe('R CfgVisitor — break and next with no enclosing loop', () => {
  it('break falls back to an edge to EXIT', () => {
    const cfg = r.cfgOf(`f <- function(c) {\n  break\n  after()\n}\n`);
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> break',
      'after() -seq-> EXIT',
      'break -break-> EXIT',
    ]);
  });

  it('next falls back to an edge to EXIT', () => {
    const cfg = r.cfgOf(`f <- function(c) {\n  next\n  after()\n}\n`);
    expect(shape(cfg)).toEqual([
      'ENTRY -seq-> next',
      'after() -seq-> EXIT',
      'next -continue-> EXIT',
    ]);
  });
});
