import { before, describe, it } from 'node:test';
import { expect } from 'expect';
import { fileURLToPath } from 'node:url';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';

describe('published TypeScript local identities', () => {
  let graph: Awaited<ReturnType<typeof runPipelineFromRepo>>['graph'];
  before(
    async () => {
      const root = fileURLToPath(
        new URL(
          '../../../../test/fixtures/compiler-conformance/typescript-local-binding-identities/',
          import.meta.url,
        ),
      );
      ({ graph } = await runPipelineFromRepo(root, () => {}, {
        workerPoolSize: 1,
        keepLocalValueSymbols: true,
      }));
    },
    { timeout: 90_000 },
  );
  function valueIds(file: string, name: string) {
    return graph.nodes
      .filter((node) => node.properties.filePath === file && node.properties.name === name)
      .map((node) => node.id)
      .sort();
  }
  function facts(file: string) {
    const calls = graph.relationships
      .filter(
        (rel) => rel.type === 'CALLS' && graph.getNode(rel.sourceId)?.properties.filePath === file,
      )
      .map((rel) => `${rel.sourceId} -> ${rel.targetId}`)
      .sort();
    const nodes = graph.nodes
      .filter((node) => node.properties.filePath === file && node.properties.name?.includes('save'))
      .map((node) => node.id)
      .sort();
    return { calls, nodes };
  }
  it('TypeScript: two locals and a top-level function are three distinct nodes', () => {
    const { calls, nodes } = facts('a.ts');

    // Three nodes, not one. `other`'s local is distinct from `run`'s: qualifying
    // by the enclosing FUNCTION (not the file) is what separates two locals that
    // share a name in different functions.
    expect(nodes).toEqual([
      'Function:a.ts:other.save@6:2',
      'Function:a.ts:run.save@2:2',
      'Function:a.ts:save',
    ]);

    // Each function calls its OWN local. The top-level `save` has no callers —
    // before this it collected both, and `impact` reported callers that do not
    // exist in the source.
    expect(calls).toEqual([
      'Function:a.ts:other -> Function:a.ts:other.save@6:2',
      'Function:a.ts:run -> Function:a.ts:run.save@2:2',
    ]);
  });

  it('a closure inside a METHOD is qualified by the method, not just the class', () => {
    // Before this, both closures qualified as `S.h` and collapsed — the class
    // was the only qualifier, so two methods' locals still collided.
    const { calls } = facts('s.ts');

    expect(calls).toEqual([
      'Method:s.ts:S.first#0 -> Function:s.ts:S.first.h@1:20',
      'Method:s.ts:S.second#0 -> Function:s.ts:S.second.h@2:21',
    ]);
  });

  it('an ANONYMOUS enclosing callable is named by its position', () => {
    // An anonymous function has no name to qualify with, but ECMAScript still
    // gives it an environment record, so its `save` is a genuinely different
    // binding from the file-level one. The anonymous link becomes `fn@1:9` —
    // unique by construction, since two functions cannot start at one offset.
    const { calls, nodes } = facts('anon.ts');

    expect(nodes).toEqual(['Function:anon.ts:outer.fn@1:9.save@2:4', 'Function:anon.ts:save']);
    // The returned callable owns its call; it must not borrow `outer`'s ID.
    // The existing nested and file-level `save` IDs remain unchanged.
    expect(calls).toEqual([
      'Function:anon.ts:outer.fn@1:9 -> Function:anon.ts:outer.fn@1:9.save@2:4',
    ]);
  });

  it('sibling BLOCKS hold different bindings, and each call reaches its own', () => {
    // `let`/`const` are block-scoped, so these are two bindings, not one name
    // declared twice. Two things had to be true for this to work, and the first
    // without the second is worse than neither: giving them distinct ids made
    // the collapse visible as DUPLICATE edges (each call resolving to both),
    // because JS/TS emitted no block scopes at all and the resolver could not
    // tell the branches apart. `(statement_block) @scope.block` supplies the
    // missing environment record — `tsBindingScopeFor` already implemented the
    // other half of the ECMAScript rule, hoisting `var` past blocks while
    // `let`/`const` bind innermost.
    const { calls } = facts('blocks.ts');

    // Exactly two edges: one per call, each to the binding in its OWN branch.
    expect(calls).toEqual([
      'Function:blocks.ts:outer -> Function:blocks.ts:outer.pick@2:4',
      'Function:blocks.ts:outer -> Function:blocks.ts:outer.pick@5:4',
    ]);
  });

  it('a MULTILINE local declaration does not alias onto a same-named sibling local', () => {
    // The two id phases anchor on different nodes ON PURPOSE: the graph node anchors on
    // the outer `lexical_declaration`, the scope def on the inner `arrow_function` (so
    // `anchor.range` lines up with `@scope.function` for auto-hoist). Splitting the
    // declaration across lines therefore puts them on different LINES and the position
    // join misses.
    //
    // Before the fix that miss fell through to the label-agnostic, first-write-wins
    // `simpleKey`, which aliased `other`'s local onto `run`'s and emitted a FABRICATED
    // edge `other -> run.pick@1:2`. Every other fixture in this file keeps the
    // declaration and its initializer on ONE line, where the anchors coincide — which is
    // exactly why the suite was green while the bug shipped.
    //
    // Correct behaviour is to fail CLOSED: two edges, each to its own binding, and no
    // third edge. A missing edge is recoverable; a fabricated caller silently corrupts
    // `impact`.
    const { calls } = facts('m.ts');

    expect(calls).toEqual([
      'Function:m.ts:other -> Function:m.ts:other.pick@6:2',
      'Function:m.ts:run -> Function:m.ts:run.pick@1:2',
    ]);
  });

  it('leaves top-level functions and ordinary methods unqualified', () => {
    // The bound on id churn: only a callable nested inside another callable
    // gains a prefix. If this ever fails, the change is rewriting far more ids
    // than it intends to.
    const { calls } = facts('t.ts');

    expect(calls).toEqual([
      'Function:t.ts:top -> Function:t.ts:helper',
      'Method:t.ts:T.m#0 -> Function:t.ts:helper',
    ]);
  });

  it('a function-local VALUE does not collapse onto the file-level node', () => {
    // FLIPPED, per this test's own former instruction. It previously pinned the
    // collapse as a KNOWN LIMIT: #2695 gave function-local CALLABLES a
    // position-bearing id and deliberately excluded VALUES, so a top-level
    // `const handler` and a function-local `const handler` shared ONE node.
    // That was the residual half of #2699's ORIGINAL complaint — the issue is
    // about values first, and no callable-only gate could ever reach it.
    //
    // Widened here via `isPositionQualifiedLocalLabel`, the single definition
    // shared by all THREE phases that must agree: id-building
    // (`parse-worker.ts`), resolution (`ids.ts` position key) and registration
    // (`node-lookup.ts`). Two of them disagreeing does not fail loudly — the
    // caller attaches to a node that does not exist and the edge is silently
    // dropped, which is the #2714 failure mode.
    //
    // The churn this was deferred for is real and was accepted deliberately:
    // it re-keys ~14,700 build-time nodes to change ~800 persisted ones,
    // because `pruneLocalSymbols` deletes most locals. Automatic parser
    // identity invalidates the warm cache and triggers a rebuild when these
    // parser artifacts change, preventing reuse of the old un-suffixed ids.
    //
    // Only LOCALS move. The prefix comes from `enclosingCallablePrefix`, which
    // returns undefined when nothing encloses the declaration, so the
    // file-level `handler` below keeps its bare id — that is what keeps this
    // off the symbols other files and stored references address.
    const ids = valueIds('v.ts', 'handler');

    // Two distinct nodes: the file-level one keeps its bare id, the local
    // carries its enclosing callable AND declaration position.
    expect(ids).toEqual(['Const:v.ts:handler', 'Const:v.ts:run.handler@3:2']);
  });
});
