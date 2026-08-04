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
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';

// Every test here spins its own worker pool (see the note above), and the file
// now covers a dozen languages across four describes. Under that contention a
// single case can exceed the 30s default even though it takes ~7s alone, so the
// budget is raised file-wide rather than per-test.
vi.setConfig({ testTimeout: 90_000 });

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

  it('TypeScript: a NON-closure class field stays a Property', async () => {
    // The closure rule must key on the initializer, not the field syntax —
    // otherwise every class field would become a callable member.
    expect(
      await labelsFor('src/plain.ts', 'export class A {\n  address = "x";\n}\n', 'address'),
    ).toEqual(['Property']);
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

    expect(targets).toEqual(['Function:App.kt:handler']);
  });

  it('Swift: handler(1) resolves', async () => {
    const targets = await callTargetsFor(
      'App.swift',
      'let handler = { (x: Int) -> Int in return x }\n\nfunc caller() -> Int {\n    return handler(1)\n}\n',
    );

    expect(targets).toEqual(['Function:App.swift:handler']);
  });
  it('Dart: a top-level closure binding resolves', async () => {
    // The top-level form parses as `initialized_identifier`; the function-local
    // form as `initialized_variable_definition`. Only the latter was in Dart's
    // `bindingNodeTypes`, so the top-level binding emitted no flow captures.
    const targets = await callTargetsFor(
      'app.dart',
      'var handler = (int x) => x;\n\nint caller() {\n  return handler(1);\n}\n',
    );

    expect(targets).toEqual(['Function:app.dart:handler']);
  });

  it('Dart: a function-local closure binding resolves', async () => {
    const targets = await callTargetsFor(
      'local.dart',
      'int caller() {\n  var handler = (int x) => x;\n  return handler(1);\n}\n',
    );

    // Qualified by #2699: Dart's enclosing callable is a SIBLING of the body
    // (function_signature + function_body), so the ancestor walk that builds
    // this prefix found nothing and every Dart local stayed bare. Two
    // same-named closures in one file therefore collapsed onto ONE node. Now
    // carries the same enclosing-callable + position identity as every other
    // language.
    expect(targets).toEqual(['Function:local.dart:caller.handler@1:2']);
  });

  it('Dart: a top-level `final` closure binding resolves', async () => {
    // `final` is the idiomatic top-level binding keyword and parses as a
    // static_final_declaration_list, not an initialized_identifier_list, so it
    // reaches neither the #2687 label rule nor the #2693 flow captures unless
    // both are taught about it.
    const targets = await callTargetsFor(
      'final.dart',
      'final handler = (int x) => x;\n\nint caller() {\n  return handler(1);\n}\n',
    );

    expect(targets).toEqual(['Function:final.dart:handler']);
  });

  it('Dart: every declarator of a multi-name local closure resolves', async () => {
    // Dart wraps only the FIRST declarator in initialized_variable_definition;
    // `g` is a nested initialized_identifier, so a rule keyed on the `name:`
    // field alone silently drops it.
    const targets = await callTargetsFor(
      'multi.dart',
      'int caller() {\n  var f = (int x) => x, g = (int y) => y;\n  return f(1) + g(2);\n}\n',
    );

    // Both declarators are function-local, so both carry the enclosing-callable
    // + position identity (#2699). The distinct columns are the point: `g` is a
    // nested initialized_identifier on the SAME line as `f`.
    expect(targets).toEqual([
      'Function:multi.dart:caller.f@1:2',
      'Function:multi.dart:caller.g@1:24',
    ]);
  });

  it('Kotlin: a class-body closure property resolves to its Method node', async () => {
    // The class-body form is the common real-world shape and is the ONLY case
    // that exercises the `Method` arm of the callable-label check — narrowing
    // that check to `Function` would delete this silently.
    const targets = await callTargetsFor(
      'Box.kt',
      'class Box {\n    val handler = { x: Int -> x }\n    fun caller(): Int {\n        return handler(1)\n    }\n}\n',
    );

    expect(targets).toEqual(['Method:Box.kt:Box.handler']);
  });
});

/** Every CALLS edge id in a one-file repo, for the duplicate-shape assertions. */
const callEdgeIdsFor = async (filename: string, source: string): Promise<string[]> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-closure-edges-'));
  try {
    fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });
    return result.graph.relationships
      .filter((rel) => rel.type === 'CALLS')
      .map((rel) => rel.id)
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describeIfWorkerBuilt('the declaration route does not double-emit (#2693)', () => {
  // Go, Python and C++ already resolved these calls through their
  // `@declaration.function` capture. Widening `buildGraphTargetIndex` gives the
  // same call a SECOND possible route, so each must still produce exactly one
  // edge — `tryEmitEdge` dedups by key, and a collapsed and a site-anchored key
  // are different keys, so a genuine regression here shows up as two ids.

  it('TypeScript: one CALLS edge for one call site', async () => {
    expect(
      await callEdgeIdsFor(
        'app.ts',
        'const handler = (x: number) => x;\n\nexport function caller(): number {\n  return handler(1);\n}\n',
      ),
    ).toHaveLength(1);
  });

  it('Go: one CALLS edge for one call site', async () => {
    expect(
      await callEdgeIdsFor(
        'main.go',
        'package main\n\nvar Handler = func(x int) int { return x }\n\nfunc Caller() int { return Handler(1) }\n',
      ),
    ).toHaveLength(1);
  });

  it('Python: one CALLS edge for one call site', async () => {
    expect(
      await callEdgeIdsFor(
        'app.py',
        'handler = lambda x: x\n\ndef caller():\n    return handler(1)\n',
      ),
    ).toHaveLength(1);
  });

  it('C++: one CALLS edge for one call site', async () => {
    expect(
      await callEdgeIdsFor(
        'main.cpp',
        'auto handler = [](int x) { return x; };\n\nint caller() { return handler(1); }\n',
      ),
    ).toHaveLength(1);
  });
});

describeIfWorkerBuilt('closure bindings resolve in the remaining languages (#2693)', () => {
  // Ruby, Java, C# and PHP already emitted correct callable-flow seeds and
  // invokes; what they lacked was the #2687 piece — a CALLABLE graph node at
  // the binding, which is what `buildGraphTargetIndex` joins to by position.
  // Ruby and Java invoke through the callable-object protocol (`.call` /
  // `.apply`); C# and PHP call the binding directly.

  it('Ruby: handler.call(1) resolves', async () => {
    const targets = await callTargetsFor(
      'a.rb',
      'handler = ->(x) { x }\n\ndef caller\n  handler.call(1)\nend\n',
    );

    expect(targets).toEqual(['Function:a.rb:handler']);
  });

  it('Java: handler.apply(1) resolves to ONE node, not a Function/Property twin', async () => {
    // The rule is anchored on field_declaration — the same node the value rule
    // uses — so the parse-worker dedup collapses the pair. Anchoring on the
    // inner variable_declarator produced both a Function and a Property node.
    const targets = await callTargetsFor(
      'A.java',
      'import java.util.function.Function;\n' +
        'class A {\n' +
        '  static Function<Integer,Integer> handler = x -> x;\n' +
        '  int caller() { return handler.apply(1); }\n' +
        '}\n',
    );

    expect(targets).toEqual(['Function:A.java:A.handler']);
  });

  it('C#: handler(1) resolves', async () => {
    const targets = await callTargetsFor(
      'A.cs',
      'using System;\nclass A {\n' +
        '  static Func<int,int> handler = x => x;\n' +
        '  int Caller() { return handler(1); }\n}\n',
    );

    expect(targets).toEqual(['Function:A.cs:A.handler']);
  });

  it('PHP: $handler(1) resolves', async () => {
    const targets = await callTargetsFor(
      'a.php',
      '<?php\n$handler = fn($x) => $x;\n' +
        'function caller() {\n  global $handler;\n  return $handler(1);\n}\n',
    );

    expect(targets).toEqual(['Function:a.php:$handler']);
  });

  it('PHP: an anonymous function binding resolves too', async () => {
    const targets = await callTargetsFor(
      'b.php',
      '<?php\n$handler = function ($x) { return $x; };\n' +
        'function caller() {\n  global $handler;\n  return $handler(1);\n}\n',
    );

    expect(targets).toEqual(['Function:b.php:$handler']);
  });

  it('TypeScript: a class-field arrow is a callable member, like Kotlin', async () => {
    // A CALLS edge must target a CALLABLE node. This field used to emit
    // Property, so the edge pointed at a non-callable — the same defect class
    // as the `var` case below. Kotlin already modelled its class-body closure
    // as Method + HAS_METHOD.
    //
    // This diverges from tsc (PropertyDeclaration) and SCIP (a `.` term), both
    // of which class an arrow-initialised field as a property. Deliberate: the
    // label means "is a call target" here, not "is a tsc symbol kind".
    const targets = await callTargetsFor(
      'Box.ts',
      'export class Box {\n  handler = (x: number) => x;\n  caller(): number { return this.handler(1); }\n}\n',
    );

    expect(targets).toEqual(['Method:Box.ts:Box.handler']);
  });

  it('JavaScript: a class-field arrow is a callable member', async () => {
    const targets = await callTargetsFor(
      'C.js',
      'export class C {\n  handler = (x) => x;\n  caller() { return this.handler(1); }\n}\n',
    );

    expect(targets).toEqual(['Method:C.js:C.handler']);
  });

  it('PHP: a local closure sharing a name with a function resolves to the CLOSURE', async () => {
    // PHP keeps variables and functions in SEPARATE namespaces, so `$save` and
    // `save()` cannot collide in the language. Dropping the `$` made both mint
    // Function:<file>:save, so the closure was swallowed by the function's node
    // and the call got NO edge at all. Keeping the sigil restores PHP's own
    // separation; the positional join normalises it when matching.
    //
    // #2699 then added the enclosing-callable qualifier, so the id is
    // `run.$save`. The two fixes are independent and both still needed: the
    // sigil separates the VARIABLE namespace from the function one, the
    // qualifier separates this function's local from any other scope's.
    const targets = await callTargetsFor(
      'c.php',
      '<?php\nfunction save($x) { return $x; }\n' +
        'function run() {\n  $save = fn($x) => $x * 2;\n  return $save(1);\n}\n',
    );

    expect(targets).toEqual(['Function:c.php:run.$save@3:2']);
  });

  it('PHP: calling the real function still resolves to the function', async () => {
    const targets = await callTargetsFor(
      'f.php',
      '<?php\nfunction save($x) { return $x; }\nfunction run() { return save(1); }\n',
    );

    expect(targets).toEqual(['Function:f.php:save']);
  });

  it('JavaScript: a `var` closure binding is a Function, like const/let', async () => {
    // `var` is a different grammar node than const/let, so it kept a Variable
    // label — and the CALLS edge that resolved through the declaration route
    // pointed at a NON-callable node.
    const targets = await callTargetsFor(
      'c.js',
      'var handler = (x) => x;\n\nexport function caller() { return handler(1); }\n',
    );

    expect(targets).toEqual(['Function:c.js:handler']);
  });

  it('TypeScript: a generator EXPRESSION binding is a Function, like the other forms', async () => {
    // `function*` as an expression is its own grammar node, matched by none of
    // the closure-binding definition rules — so the binding emitted a `Const`
    // and `g(1)` resolved to nothing, since `buildGraphTargetIndex` only
    // admits a callable node. Same defect shape as the `var` case above.
    const targets = await callTargetsFor(
      'gen.ts',
      'const g = function* (x: number) {\n  yield x;\n};\n\nexport function caller() {\n  return g(1);\n}\n',
    );

    expect(targets).toEqual(['Function:gen.ts:g']);
  });

  it('JavaScript: an exported `var` generator expression resolves too', async () => {
    // Covers the two axes the rules multiply over — declaration keyword and
    // export wrapper — in the language where `var` is idiomatic.
    const targets = await callTargetsFor(
      'gen.js',
      'export var g = function* (x) {\n  yield x;\n};\n\nexport function caller() {\n  return g(1);\n}\n',
    );

    expect(targets).toEqual(['Function:gen.js:g']);
  });

  it('TypeScript: a generator DECLARATION is unaffected', async () => {
    // The declaration form already resolved; it shares the emit path the new
    // expression rules were inserted beside, so it is the guard against the
    // insertion disturbing it.
    const targets = await callTargetsFor(
      'decl.ts',
      'function* g(x: number) {\n  yield x;\n}\n\nexport function caller() {\n  return g(1);\n}\n',
    );

    expect(targets).toEqual(['Function:decl.ts:g']);
  });
});

describeIfWorkerBuilt('a closure binding as a call SOURCE (#2699 part B)', () => {
  // Known limit, pinned deliberately so it is visible rather than surprising.
  //
  // A call made INSIDE a closure binding is attributed to the ENCLOSING scope,
  // not to the binding's own node — so `impact(handler, direction:"downstream")`
  // reports nothing even though the closure calls `target`.
  //
  // Cause: `pickCallerCallableDef` (graph-bridge/ids.ts) finds the caller by
  // walking CHILD scopes whose range contains the call site, gated on
  // `child.kind === 'Function'`, and then requires that child to OWN a
  // callable def. The languages here fail at different points, which is worth
  // stating precisely because an earlier version of this comment claimed one
  // shared cause and that error propagated into a follow-up plan:
  //
  //   - Kotlin (`lambda_literal` @scope.block, deliberately — #1757 smart
  //     casts) and Ruby (`do_block`/`block` @scope.block) fail the KIND gate.
  //   - PHP does NOT: `anonymous_function`/`arrow_function` are already
  //     @scope.function (php/query.ts:61-62). It fails only the second half —
  //     the `$handler` def is owned by the enclosing scope, so the closure's
  //     own scope owns no callable def.
  //   - Dart has no scope over a closure literal at all, so there is no child
  //     scope for the walk to consider.
  //
  // So a fix needs per-language work, not one switch: a callable-boundary
  // signal independent of scope `kind` (Kotlin/Ruby — DONE, S2), an
  // association from a closure scope to its binding's def (PHP — DONE, S1;
  // Rust — DONE, S3), and a scope that did not exist at all (Dart — DONE, S4).
  // See #2699.
  //
  // All five languages now attribute closure calls to the binding. The review
  // of that work found the FIRST cut incomplete in four ways — multi-line
  // bindings, Dart top-level/`final` shapes, Ruby `do ... end`/`Proc.new`, and
  // TS constructor parameter properties — each now pinned in
  // `closure-review-findings.test.ts`.
  //
  // Probe-measured root cause (#2699): EVERY still-failing language has an
  // EMPTY ownedDefs on the closure's own scope, because the closure-binding
  // declaration rule (binding name + @declaration.function on the INNER
  // closure node) existed only in javascript/query.ts. Kotlin and Ruby need
  // BOTH that rule AND a relaxed kind gate — their lambda_literal / do_block
  // is @scope.block deliberately (#1757), so the rule alone leaves them
  // rejected. Dart has no closure scope at all: dart/query.ts declares no
  // @scope.function, and dart/captures.ts synthesizes one only from a
  // declaration WITH a body node, which an expression-bodied closure lacks.
  //
  // TS/JS free bindings are the exception: their arrow has a `@scope.function`
  // with a matching range, so the closure IS the anchor there. These tests exist
  // to catch that asymmetry changing in EITHER direction.

  it('Kotlin: a call inside the closure IS attributed to the binding (#2699 S2)', async () => {
    // FLIPPED by #2699 S2, which took BOTH halves:
    //   1. kotlin/query.ts gained the closure-binding declaration rule, with
    //      @declaration.function on the INNER lambda_literal so its range
    //      aligns with the (lambda_literal) @scope.block range;
    //   2. pickCallerCallableDef now accepts a Block-kind scope as a callable
    //      boundary when the scope IS the callable's body (def start position
    //      == scope start position).
    // Half 1 alone changes nothing here — the lambda stays @scope.block
    // deliberately (#1757 smart casts), so the kind gate would still reject it.
    const targets = await callEdgeIdsFor(
      'A.kt',
      'fun target(x: Int): Int = x\n\nval handler = { x: Int -> target(x) }\n',
    );

    expect(targets).toEqual(['rel:CALLS:Function:A.kt:handler->Function:A.kt:target']);
  });

  it('Kotlin: a call at block level is not attributed to a nested named function (#2736)', async () => {
    // A Block-kind scope may own a nested function without being that
    // function's body. The start-position alignment check is what keeps the
    // block-level call attributed to `outer`, rather than swallowing it into
    // the uncalled `nested`.
    const targets = await callEdgeIdsFor(
      'Block.kt',
      'fun target(): Int = 1\n\nfun outer(): Int {\n' +
        '  if (true) {\n    fun nested(): Int = 0\n    return target()\n  }\n' +
        '  return 0\n}\n',
    );

    expect(targets).toEqual(['rel:CALLS:Function:Block.kt:outer->Function:Block.kt:target']);
  });

  it('PHP: a call inside the closure IS attributed to the binding (#2699 S1)', async () => {
    // FLIPPED by #2699 S1. php/query.ts now carries the closure-binding
    // declaration rule with javascript/query.ts's anchor discipline
    // (@declaration.function on the INNER anonymous_function, so its range
    // aligns with the (anonymous_function) @scope.function above). The closure
    // scope therefore owns the callable def and pickCallerCallableDef stops
    // falling through to the enclosing scope — the closure is now a call
    // SOURCE, not only a TARGET.
    const targets = await callEdgeIdsFor(
      'a.php',
      '<?php\nfunction target($x) { return $x; }\n' +
        '$handler = function ($x) { return target($x); };\n',
    );

    expect(targets).toEqual(['rel:CALLS:Function:a.php:$handler->Function:a.php:target']);
  });

  it('Dart: two same-named closures in one file stay DISTINCT nodes (#2699 S4)', async () => {
    // The defect this pins is worse than a missing edge. Before #2699 S4 gave
    // Dart locals an enclosing-callable prefix, both closures keyed to the bare
    // `Function:collide.dart:handler`, so ONE node appeared to call BOTH
    // `target` and `other` — a CALLS edge that exists nowhere in the source.
    //
    // Dart is the only grammar here that splits a callable into a signature and
    // a SIBLING body, so its enclosing callable was unreachable by ancestor
    // walk and every Dart local stayed unqualified. Distinct positions in the
    // two ids are the whole property.
    const targets = await callEdgeIdsFor(
      'collide.dart',
      'int target(int x) => x;\nint other(int x) => x;\n' +
        'int outer() {\n  var handler = (int x) => target(x);\n  return handler(1);\n}\n' +
        'int second() {\n  var handler = (int x) => other(x);\n  return handler(2);\n}\n',
    );

    // The trailing `:5:9` / `:9:9` on the first and third edges is the CALL
    // SITE, not part of the node id: invoking a closure binding is an indirect
    // call emitted by the callable-value-flow pass, which keys its edge by the
    // invocation position. The direct `handler -> target` calls carry no such
    // suffix. Do not "normalize" these away — they are different edge kinds.
    expect(targets).toEqual([
      'rel:CALLS:Function:collide.dart:outer->Function:collide.dart:outer.handler@3:2:5:9',
      'rel:CALLS:Function:collide.dart:outer.handler@3:2->Function:collide.dart:target',
      'rel:CALLS:Function:collide.dart:second->Function:collide.dart:second.handler@7:2:9:9',
      'rel:CALLS:Function:collide.dart:second.handler@7:2->Function:collide.dart:other',
    ]);
  });

  it('Ruby: a call inside a lambda binding IS attributed to the binding (#2699 S2)', async () => {
    // Ruby had no pinned case before #2699 S2, so this is new coverage rather
    // than an inverted assertion. do_block/block stay @scope.block (matching
    // Kotlin), so this exercises the same Block-scope alignment path.
    const targets = await callEdgeIdsFor(
      'a.rb',
      'def target(x)\n  x\nend\n\nhandler = ->(x) { target(x) }\n',
    );

    expect(targets).toEqual(['rel:CALLS:Function:a.rb:handler->Method:a.rb:target#1']);
  });

  it('JavaScript: a free arrow binding IS the caller anchor', async () => {
    // The counter-case: an aligned @scope.function makes the closure the anchor.
    const targets = await callEdgeIdsFor(
      'c.js',
      'export function target(x) { return x; }\nvar handler = (x) => target(x);\n',
    );

    expect(targets).toEqual(['rel:CALLS:Function:c.js:handler->Function:c.js:target']);
  });
});

describeIfWorkerBuilt('a value binding is never aliased onto a same-named callable', () => {
  // These are the regression tests for the defect the first cut of #2693
  // shipped. Admitting a value binding on a same-file NAME match let
  // `resolveDefGraphId` fall through to its label-agnostic, first-write-wins
  // `simpleKey(filePath, simpleName)` and bind the name to ANY same-named
  // callable in the file — a fabricated caller, chosen by declaration order.
  //
  // The join is positional now: a closure binding IS its callable node (same
  // file, same line, same name); an aliasing local is not. Every case below
  // pairs a value binding with a same-named callable, which is precisely the
  // collision the previous fixtures never created — they used DIFFERENT names
  // (`maxSize` vs `size`), so the pre-filter rejected them before the guard
  // they were named after could run, and deleting that guard changed nothing.

  it('TypeScript: a local aliasing a parameter does not call the same-named top-level function', async () => {
    const targets = await callTargetsFor(
      'alias.ts',
      'export function handler(): number {\n  return 1;\n}\n\n' +
        'export function caller(cb: () => number): number {\n  const handler = cb;\n  return handler();\n}\n',
    );

    expect(targets).toEqual([]);
  });

  it('TypeScript: a local closure does not call a same-named class method', async () => {
    // `Svc` is never instantiated. The local arrow has its own Function node,
    // which is the only legitimate target.
    const targets = await callTargetsFor(
      'svc.ts',
      'export class Svc {\n  save(x: number): number {\n    return x;\n  }\n}\n\n' +
        'export function run(): number {\n  const save = (x: number): number => x * 2;\n  return save(1);\n}\n',
    );

    // `run.save` — the local carries its enclosing function, so it can no
    // longer be confused with a file-level `save` (#2699).
    expect(targets).toEqual(['Function:svc.ts:run.save@7:2']);
  });

  it('TypeScript: a shadowing local does not also call the shadowed function', async () => {
    // `caller` invokes `other` through the shadowing binding; the outer
    // `handler` is unreachable from it.
    const targets = await callTargetsFor(
      'shadow.ts',
      'export function handler(x: number): number {\n  return x;\n}\n' +
        'export function other(x: number): number {\n  return x * 2;\n}\n\n' +
        'export function caller(): number {\n  const handler = other;\n  return handler(1);\n}\n',
    );

    expect(targets).toEqual(['Function:shadow.ts:other']);
  });

  it('Rust: a let binding does not call the same-named function', async () => {
    // Rust `let` bindings get no graph node at all, so the simple-name
    // fallback was the ONLY route — this is the shape with no value node to
    // claim the qualified key first.
    const targets = await callTargetsFor(
      'main.rs',
      'fn handler() -> i32 {\n    1\n}\n\n' +
        'fn caller(cb: fn() -> i32) -> i32 {\n    let handler = cb;\n    handler()\n}\n',
    );

    expect(targets).toEqual([]);
  });

  it('Dart: a local closure does not call a same-named class method', async () => {
    // Before the positional join this emitted the WRONG edge and lost the
    // right one: the only target was `Svc.save`, while the closure's own node
    // got nothing.
    const targets = await callTargetsFor(
      'svc.dart',
      'class Svc {\n  int save(int x) => x;\n}\n\n' +
        'int run() {\n  var save = (int x) => x * 2;\n  return save(1);\n}\n',
    );

    // The target is the LOCAL closure, never `Svc.save`. Since #2699 the local
    // also carries its enclosing callable and position, so the two are now
    // distinct by id and not merely by which node the edge happened to reach —
    // `run.save@5:2` cannot collide with the method however the lookup is keyed.
    expect(targets).toEqual(['Function:svc.dart:run.save@5:2']);
  });

  it('Kotlin: a genuine constant mints no CALLS', async () => {
    const targets = await callTargetsFor(
      'Consts.kt',
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
