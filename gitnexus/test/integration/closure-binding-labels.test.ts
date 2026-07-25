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
 * The label alone does not make `f()` resolve. Go, Python and C++ carry a
 * `@declaration.function` capture anchored on the inner closure literal, so
 * free-call resolution finds the def directly. Kotlin, Swift and Dart cannot
 * take that route — they lack a `@scope.function` whose range matches the
 * closure literal (Kotlin deliberately scopes `lambda_literal` as a BLOCK,
 * #1757) and an unaligned declaration anchor mis-attributes callers.
 *
 * #2693 resolves those three through `callable-value-flow` instead: the graph
 * node this file asserts IS the evidence that admits the binding as a callable
 * target, so a regression in the labels above now also breaks call resolution.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';
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

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

/** Call targets resolved in a one-file repo, for the closure-call assertions. */
const callTargetsFor = async (filename: string, source: string): Promise<string[]> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-closure-calls-'));
  try {
    fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });
    return result.graph.relationships
      .filter((rel) => rel.type === 'CALLS')
      .map((rel) => rel.targetId)
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describeIfWorkerBuilt('calls to a closure binding resolve to its Function node', () => {
  // Two independent routes reach the same outcome.
  //
  // Go, Python and C++ take the DECLARATION route: a `@declaration.function`
  // anchored on the inner closure literal, so the def is owned by the closure's
  // own scope and free-call resolution finds it directly.
  //
  // Kotlin, Swift and Dart cannot — an unaligned declaration anchor
  // mis-attributes callers, and Kotlin scopes `lambda_literal` as a BLOCK on
  // purpose (#1757, smart casts). They take the CALLABLE-VALUE-FLOW route
  // instead (#2693): their capture layer already emits a `seed` naming the
  // binding as its own callable, and `buildGraphTargetIndex` admits the
  // binding because the graph node #2687 created for it is a `Function`.

  it('Go: Handler(1) resolves', async () => {
    const targets = await callTargetsFor(
      'main.go',
      'package main\n\nvar Handler = func(x int) int { return x }\n\nfunc Caller() int { return Handler(1) }\n',
    );

    expect(targets).toContain('Function:main.go:Handler');
  });

  it('Python: handler(1) resolves', async () => {
    const targets = await callTargetsFor(
      'app.py',
      'handler = lambda x: x\n\ndef caller():\n    return handler(1)\n',
    );

    expect(targets).toContain('Function:app.py:handler');
  });

  it('C++: handler(1) resolves', async () => {
    const targets = await callTargetsFor(
      'main.cpp',
      'auto handler = [](int x) { return x; };\n\nint caller() { return handler(1); }\n',
    );

    expect(targets).toContain('Function:main.cpp:handler');
  });

  it('Kotlin: handler(1) resolves', async () => {
    const targets = await callTargetsFor(
      'App.kt',
      'val handler = { x: Int -> x }\n\nfun caller(): Int {\n    return handler(1)\n}\n',
    );

    expect(targets).toContain('Function:App.kt:handler');
  });

  it('Swift: handler(1) resolves', async () => {
    const targets = await callTargetsFor(
      'App.swift',
      'let handler = { (x: Int) -> Int in return x }\n\nfunc caller() -> Int {\n    return handler(1)\n}\n',
    );

    expect(targets).toContain('Function:App.swift:handler');
  });
  it('Dart: a top-level closure binding resolves', async () => {
    // The top-level form parses as `initialized_identifier`; the function-local
    // form as `initialized_variable_definition`. Only the latter was in Dart's
    // `bindingNodeTypes`, so the top-level binding emitted no flow captures.
    const targets = await callTargetsFor(
      'app.dart',
      'var handler = (int x) => x;\n\nint caller() {\n  return handler(1);\n}\n',
    );

    expect(targets).toContain('Function:app.dart:handler');
  });

  it('Dart: a function-local closure binding resolves', async () => {
    const targets = await callTargetsFor(
      'local.dart',
      'int caller() {\n  var handler = (int x) => x;\n  return handler(1);\n}\n',
    );

    expect(targets).toContain('Function:local.dart:handler');
  });
});

describeIfWorkerBuilt('a non-callable value binding stays edge-free', () => {
  // The suppression must key on an actual callable value. Widening
  // `buildGraphTargetIndex` to admit value bindings whose graph node is a
  // `Function` is safe only because a genuine constant keeps its own
  // `Const`/`Property`/`Variable` node, so `resolveDefGraphId`'s qualified key
  // hits before the label-agnostic `simpleKey` fallback can reach a callable.

  it('Kotlin: a constant sharing its name with a function mints no CALLS to the constant', async () => {
    const targets = await callTargetsFor(
      'Shadow.kt',
      'val maxSize = 10\n\nfun size(): Int {\n    return maxSize\n}\n',
    );

    expect(targets).toEqual([]);
  });

  it('Kotlin: a property initialised from a call is not itself callable', async () => {
    const targets = await callTargetsFor(
      'Made.kt',
      'fun make(): Int = 1\n\nval made = make()\n\nfun caller(): Int {\n    return made\n}\n',
    );

    expect(targets).toEqual(['Function:Made.kt:make']);
  });
});
