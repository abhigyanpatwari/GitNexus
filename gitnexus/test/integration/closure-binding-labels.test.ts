/**
 * #2687 follow-up — a closure bound to a name emits ONE `Function` node in
 * every language, not `Variable` in some and `Property` in others.
 *
 * `const f = () => {}` already produced a `Function` in TS/JS (that is what the
 * #2687 twin fix preserved), but the same construct produced a `Variable` in
 * Go/Python/Dart/C++ and a `Property` in Kotlin/Swift. The graph schema states
 * "Function: Functions and arrow functions", and every syntactic tagger the
 * convention was checked against (tree-sitter tags, universal-ctags) labels the
 * binding a function — so the callable label is the consistent one.
 *
 * Each language's value capture still matches the same declaration node, so
 * these rely on the #2687 pre-scan collapsing the pair; a regression there
 * would surface here as a twin rather than a wrong label.
 *
 * NOTE (deliberately not asserted): making the node a `Function` does NOT by
 * itself make `f()` resolve to it outside TS/JS. Free-call resolution runs off
 * the per-language scope-resolution queries, which still model these bindings
 * as values — see the closing note in the #2687 plan. These tests pin the graph
 * label only.
 */
import { describe, expect, it } from 'vitest';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';

const labelsFor = async (path: string, content: string, name: string): Promise<string[]> => {
  const { graph } = await parseFilesWithWorkers([{ path, content }]);
  return graph.nodes
    .filter((node) => node.properties.name === name)
    .map((node) => node.label)
    .sort();
};

describe('closure bindings emit a single Function node in every language', () => {
  it('Go: var f = func(){}', async () => {
    expect(
      await labelsFor(
        'src/handler.go',
        'package main\n\nvar Handler = func(x int) int { return x }\n',
        'Handler',
      ),
    ).toEqual(['Function']);
  });

  it('Python: f = lambda x: x', async () => {
    expect(await labelsFor('src/handler.py', 'handler = lambda x: x\n', 'handler')).toEqual([
      'Function',
    ]);
  });

  it('Kotlin: val f = { x -> x }', async () => {
    expect(await labelsFor('src/Handler.kt', 'val handler = { x: Int -> x }\n', 'handler')).toEqual(
      ['Function'],
    );
  });

  it('Swift: let f = { ... }', async () => {
    expect(
      await labelsFor(
        'src/Handler.swift',
        'let handler = { (x: Int) -> Int in return x }\n',
        'handler',
      ),
    ).toEqual(['Function']);
  });

  it('C++: auto f = [](int x){ ... }', async () => {
    expect(
      await labelsFor('src/handler.cpp', 'auto handler = [](int x) { return x; };\n', 'handler'),
    ).toEqual(['Function']);
  });

  it('Dart: var f = (int x) => x', async () => {
    expect(await labelsFor('src/handler.dart', 'var handler = (int x) => x;\n', 'handler')).toEqual(
      ['Function'],
    );
  });

  // The suppression must key on an actual closure value, never on the
  // declaration keyword — otherwise ordinary constants would vanish. One `it`
  // per language: each spins its own worker pool and four in a single test
  // exceeds the default timeout.

  it('Go: leaves a genuine const alone', async () => {
    expect(
      await labelsFor('src/consts.go', 'package main\n\nconst MaxSize = 10\n', 'MaxSize'),
    ).toEqual(['Const']);
  });

  it('Python: leaves a genuine assignment alone', async () => {
    expect(await labelsFor('src/consts.py', 'MAX_SIZE = 10\n', 'MAX_SIZE')).toEqual(['Variable']);
  });

  it('Kotlin: leaves a genuine property alone', async () => {
    expect(await labelsFor('src/Consts.kt', 'val maxSize = 10\n', 'maxSize')).toEqual(['Property']);
  });

  it('C++: leaves a genuine variable alone', async () => {
    expect(await labelsFor('src/consts.cpp', 'auto maxSize = 10;\n', 'maxSize')).toEqual([
      'Variable',
    ]);
  });

  it('Python: an annotated attribute stays a Property, not a Variable', async () => {
    // Regression guard. Python matches BOTH `@definition.property` (annotated)
    // and `@definition.variable` (bare assignment) on the same statement at the
    // same byte offset. Ranking `Property` level with the value labels made the
    // winner depend on match order, which silently turned every typed attribute
    // — including dataclass fields — into a file-level `Variable`.
    expect(await labelsFor('src/model.py', 'class C:\n    name: str = "x"\n', 'name')).toEqual([
      'Property',
    ]);
  });

  it('Python: an annotated attribute keeps its owning HAS_PROPERTY edge', async () => {
    // The label regression above also detached the attribute from its class:
    // the node became `Variable:<file>:name` reached by `File -DEFINES->`
    // instead of `Property:<file>:C.name` reached by `Class -HAS_PROPERTY->`.
    const { graph } = await parseFilesWithWorkers([
      { path: 'src/owned.py', content: 'class C:\n    name: str = "x"\n' },
    ]);

    expect(
      graph.relationships
        .filter((rel) => rel.type === 'HAS_PROPERTY')
        .map((rel) => `${rel.sourceId} -> ${rel.targetId}`),
    ).toEqual(['Class:src/owned.py:C -> Property:src/owned.py:C.name']);
  });
});
