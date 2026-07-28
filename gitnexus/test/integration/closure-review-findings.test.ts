/**
 * Regression tests for the findings of the multi-engine review of #2699 part B.
 *
 * Each test here pins a defect that SHIPPED in the first cut of that work and
 * was caught only by review — three of the four by an independent engine
 * disagreeing with the authoring one. They are grouped in one file because they
 * share a root theme: the two query channels (graph-node vs scope-resolution)
 * must agree about which binding shapes exist, and when they cannot agree the
 * bridge must fail closed rather than guess.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

vi.setConfig({ testTimeout: 90_000 });

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

/** Every CALLS edge in a one-file repo, as `src -> dst`, sorted. */
const callEdges = async (filename: string, source: string): Promise<string[]> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-review-'));
  try {
    fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });
    return result.graph.relationships
      .filter((rel) => rel.type === 'CALLS')
      .map((rel) => `${rel.sourceId} -> ${rel.targetId}`)
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Node ids in a one-file repo whose id contains `needle`. */
const nodeIdsContaining = async (
  filename: string,
  source: string,
  needle: string,
): Promise<string[]> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-review-ids-'));
  try {
    fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
    const result = await runPipelineFromRepo(dir, () => {}, {
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });
    return result.graph.nodes
      .map((n) => n.id)
      .filter((id) => id.includes(needle))
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describeIfWorkerBuilt(
  '#2699 review P1-1 — a closure that cannot be named never credits its parent',
  () => {
    it('a MULTI-LINE closure binding does not fabricate a call from the enclosing function', async () => {
      // The two channels anchor on DIFFERENT nodes by design — graph-node on the
      // outer wrapper, scope-resolution on the inner closure. On one line they
      // share a row and the position join matches. Split across lines it misses,
      // and before the fix `resolveCallerGraphId` CLIMBED to the enclosing scope,
      // emitting `outer -> target` although `outer` calls nothing. That is a CALLS
      // edge present nowhere in the source — the exact defect class #2699 exists
      // to remove — so the bridge now fails closed at the owning callable.
      //
      // The single-line binding in the same fixture proves the fail-closed path
      // did not simply delete the feature.
      const edges = await callEdges(
        'ml.php',
        '<?php\nfunction target($x) { return $x; }\nfunction outer() {\n' +
          '  $single = function ($x) { return target($x); };\n' +
          '  $multi =\n    function ($x) { return target($x); };\n  return 1;\n}\n',
      );

      expect(edges).toEqual(['Function:ml.php:outer.$single@3:2 -> Function:ml.php:target']);
    });
  },
);

describeIfWorkerBuilt(
  '#2699 review P1-2 — widening identity to values must not touch class members',
  () => {
    it('a TypeScript constructor PARAMETER PROPERTY keeps its class-qualified id', async () => {
      // Admitting `Property` to the position-qualified set made this walk reach
      // the constructor's `method_definition` THROUGH the parameter list — a
      // LOCAL_SCOPE_BODY hit before any class boundary — so a genuine field was
      // re-keyed `Service.constructor.port@r:c`. That silently empties the
      // `Service.port` slot `impact`, `rename` and FTS address, while the class
      // still asserts HAS_PROPERTY against it. This is the DI idiom every
      // Angular/NestJS codebase uses, so the blast radius is large.
      const ids = await nodeIdsContaining(
        'svc.ts',
        'export class Port { send(): void {} }\n' +
          'export class Service {\n  constructor(private readonly port: Port) {}\n}\n',
        'port',
      );

      expect(ids).toEqual(['Property:svc.ts:Service.port']);
    });
  },
);

describeIfWorkerBuilt('#2699 review P1-3 — every Dart binding shape can be a call SOURCE', () => {
  it('top-level `var` and `final` closures are call sources, not just function-local ones', async () => {
    // The first cut matched only `initialized_variable_definition`, which is
    // Dart's FUNCTION-LOCAL shape. A top-level `var` is `initialized_identifier`
    // and a top-level `final` is `static_final_declaration`, so idiomatic
    // top-level closures got no declaration capture, no synthesized scope, and
    // could never be sources. captures.ts already listed all three shapes for
    // callable-flow — the declaration rule just did not mirror it.
    const edges = await callEdges(
      'top.dart',
      'int target(int x) => x;\n' +
        'var topVar = (int x) => target(x);\n' +
        'final topFinal = (int y) => target(y);\n',
    );

    expect(edges).toEqual([
      'Function:top.dart:topFinal -> Function:top.dart:target',
      'Function:top.dart:topVar -> Function:top.dart:target',
    ]);
  });
});

describeIfWorkerBuilt(
  '#2699 review P1-4 — Ruby do...end and Proc.new closures are call SOURCES',
  () => {
    it('covers brace, do...end and Proc.new forms alike', async () => {
      // `do ... end` is the dominant MULTI-LINE Ruby style and produces
      // (do_block), while the first cut matched only (block). The scope channel
      // already covered both, so these closures got a Block scope owning nothing
      // and their calls fell through to the enclosing method. Fixing it needed
      // BOTH channels — the graph-node channel had no rule for the (call) forms
      // either, exactly as Rust did.
      const edges = await callEdges(
        'rb.rb',
        'def target(x)\n  x\nend\ndef outer\n' +
          '  a = ->(x) { target(x) }\n' +
          '  b = lambda do |y| target(y) end\n' +
          '  c = Proc.new { |z| target(z) }\n' +
          'end\n',
      );

      expect(edges).toEqual([
        'Function:rb.rb:outer.a@4:2 -> Method:rb.rb:target#1',
        'Function:rb.rb:outer.b@5:2 -> Method:rb.rb:target#1',
        'Function:rb.rb:outer.c@6:2 -> Method:rb.rb:target#1',
      ]);
    });

    it('a receiver-qualified `.lambda` / `.proc` is NOT a closure binding', async () => {
      // The `#eq?` predicate tests the method NAME only, so without `!receiver`
      // `MyMod.lambda { }` was captured as a closure binding. `items.map { }` was
      // already rejected; this is the narrower sibling case.
      const edges = await callEdges(
        'recv.rb',
        'def target(x)\n  x\nend\ndef outer\n' + '  d = MyMod.lambda { |q| target(q) }\n' + 'end\n',
      );

      expect(edges).toEqual(['Method:recv.rb:outer#0 -> Method:recv.rb:target#1']);
    });
  },
);

describeIfWorkerBuilt(
  '#2699 review S3 — Rust closure bindings (previously untested entirely)',
  () => {
    it('a Rust closure binding is a call SOURCE', async () => {
      // The Rust half of this work shipped with ZERO test coverage — it was
      // verified once by a throwaway fixture and never pinned. Rust needed BOTH
      // channels because it emitted no graph node for `let f = || ...` at all.
      const edges = await callEdges(
        'a.rs',
        'fn target(x: i32) -> i32 { x }\nfn outer() -> i32 {\n    let handler = || target(1);\n    handler()\n}\n',
      );

      expect(edges).toEqual([
        'Function:a.rs:outer -> Function:a.rs:outer.handler@2:4',
        'Function:a.rs:outer.handler@2:4 -> Function:a.rs:target',
      ]);
    });
  },
);
