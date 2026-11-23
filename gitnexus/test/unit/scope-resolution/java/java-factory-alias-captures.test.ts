import { describe, expect, it } from 'vitest';
import { makeScopeId } from 'gitnexus-shared';
import {
  JAVA_ENCLOSING_LOCAL_ROUTE,
  synthesizeJavaFactoryAliasCaptures,
} from '../../../../src/core/ingestion/languages/java/factory-alias-captures.js';
import { getJavaParser } from '../../../../src/core/ingestion/languages/java/query.js';

function producerAliases(source: string) {
  const tree = getJavaParser().parse(source);
  return synthesizeJavaFactoryAliasCaptures(tree.rootNode, 'App.java').map((capture) => ({
    name: capture['@call-result-assignment.lhs']!.text,
    call: capture['@call-result-assignment.call']!.text,
    at: capture['@call-result-assignment.call']!.range,
  }));
}

describe('Java factory alias producer identity', () => {
  it('preserves the exact call through same-block aliases and source reassignment', () => {
    const aliases = producerAliases(`class App { void run() {
      var value = factory.make();
      var copy = (value);
      value = other.make();
      var second = copy;
    } }`);
    expect(aliases.map(({ name, call }) => ({ name, call }))).toEqual([
      { name: 'copy', call: 'factory.make()' },
      { name: 'second', call: 'factory.make()' },
    ]);
    expect(aliases[0]!.at).toEqual(aliases[1]!.at);
  });

  it('keeps same-named producers in separate methods independent', () => {
    expect(
      producerAliases(`class App {
      void one() { var value = first.make(); var copy = value; }
      void two() { var value = second.make(); var copy = value; }
    }`).map(({ name, call }) => ({ name, call })),
    ).toEqual([
      { name: 'copy', call: 'first.make()' },
      { name: 'copy', call: 'second.make()' },
    ]);
  });

  it('does not move an alias into a producer in another lexical block', () => {
    expect(
      producerAliases(`class App { void run() {
      var value = factory.make();
      { var copy = value; }
      { var value = other.make(); }
      var copy = value;
    } }`).map(({ name, call }) => ({ name, call })),
    ).toEqual([
      { name: 'copy', call: 'factory.make()' },
      { name: 'copy', call: 'factory.make()' },
    ]);
  });

  it('anchors a nested-block copy at its own name, not at the outer call', () => {
    const tree = getJavaParser().parse(`class App { void run() {
      var value = factory.make();
      if (ready) { var copy = value; }
    } }`);
    const [capture] = synthesizeJavaFactoryAliasCaptures(tree.rootNode, 'App.java');
    expect(capture?.['@call-result-assignment.call']?.text).toBe('factory.make()');
    expect(capture?.['@call-result-assignment.scope']?.range).toEqual(
      capture?.['@call-result-assignment.lhs']?.range,
    );
  });

  it.each([
    'if (ready) { value = other.make(); var copy = value; }',
    'while (ready) { var copy = value; value = other.make(); }',
    'if (ready) { var copy = value; } value++;',
  ])('refuses a nested copy of a written or differently owned source: %s', (body) => {
    expect(
      producerAliases(`class App { void run() { var value = factory.make(); ${body} } }`),
    ).toEqual([]);
  });

  it.each(['value = other.make();', 'if (condition) { value = other.make(); }', 'value++;'])(
    'refuses a producer after an intervening write: %s',
    (write) => {
      expect(
        producerAliases(`class App { void run() {
      var value = factory.make(); ${write} var copy = value;
    } }`),
      ).toEqual([]);
    },
  );

  it('requires an inferred declaration and refuses a same-name self-read', () => {
    expect(
      producerAliases(`class App { void run() {
      Repo value = factory.make(); var copy = value;
      var other = factory.make(); var other = other; var next = other;
    } }`),
    ).toEqual([]);
  });

  it('keeps a copy after a local type, anchored at the copy inside its visibility scope', () => {
    const tree = getJavaParser().parse(`class App { void run() {
      var value = factory.make();
      class Local {}
      var copy = value;
    } }`);
    const [capture] = synthesizeJavaFactoryAliasCaptures(tree.rootNode, 'App.java');
    expect(capture?.['@call-result-assignment.call']?.text).toBe('factory.make()');
    expect(capture?.['@call-result-assignment.scope']?.range).toEqual(
      capture?.['@call-result-assignment.lhs']?.range,
    );
  });

  it.each([
    'switch (k) { case 1: var copy = value; }',
    'int r = switch (k) { case 1: var copy = value; yield 1; default: yield 0; };',
  ])('treats an unbraced switch group as part of its switch block: %s', (body) => {
    expect(
      producerAliases(`class App { void run(int k) { var value = factory.make(); ${body} } }`).map(
        ({ name, call }) => ({ name, call }),
      ),
    ).toEqual([{ name: 'copy', call: 'factory.make()' }]);
  });

  it.each([
    'switch (k) { case 1: value = other.make(); var copy = value; }',
    'switch (k) { case 1: var copy = value; break; case 2: value = other.make(); }',
  ])('refuses a switch-group copy of a written source: %s', (body) => {
    expect(
      producerAliases(`class App { void run(int k) { var value = factory.make(); ${body} } }`),
    ).toEqual([]);
  });

  it('reads a copy in a constructor body', () => {
    expect(
      producerAliases(`class App { App() { var value = factory.make(); var copy = value; } }`).map(
        ({ name, call }) => ({ name, call }),
      ),
    ).toEqual([{ name: 'copy', call: 'factory.make()' }]);
  });

  it.each([
    'if (ready) { var copy = value; } class Local { Repo value; void f() { value = null; } }',
    'if (ready) { var copy = value; } new Object() { Repo value; void f() { value = null; } };',
    'if (ready) { var copy = value; } Consumer<Repo> c = (Repo value) -> { value = null; };',
  ])('does not treat a same-named field or parameter write as a write to the local: %s', (body) => {
    expect(
      producerAliases(`class App { void run() { var value = factory.make(); ${body} } }`).map(
        ({ name, call }) => ({ name, call }),
      ),
    ).toEqual([{ name: 'copy', call: 'factory.make()' }]);
  });
});

describe('Java factory aliases of an enclosing local in a local or anonymous class', () => {
  const routed = (source: string) =>
    synthesizeJavaFactoryAliasCaptures(getJavaParser().parse(source).rootNode, 'App.java').map(
      (capture) => ({
        name: capture['@call-result-assignment.lhs']!.text,
        call: capture['@call-result-assignment.call']!.text,
        route: capture['@call-result-assignment.element']?.text,
      }),
    );
  /** The route naming the class whose body spans `open`..`close` on line 1. */
  const routeThrough = (source: string, open: string, close: string, name = 'value'): string => {
    const startCol = source.indexOf(open);
    const endCol = source.indexOf(close, startCol) + close.length;
    const scope = makeScopeId({
      filePath: 'App.java',
      range: { startLine: 1, startCol, endLine: 1, endCol },
      kind: 'Class',
    });
    return JAVA_ENCLOSING_LOCAL_ROUTE + JSON.stringify([[scope, name]]);
  };

  it('copies an effectively final local into an anonymous class method, routed through that class', () => {
    const source =
      'class App { void run() { var value = factory.make(); new Task() { void m() { var copy = value; var second = copy; } }; } }';
    const route = routeThrough(source, '{ void m()', '} }');
    expect(routed(source)).toEqual([
      { name: 'copy', call: 'factory.make()', route },
      { name: 'second', call: 'factory.make()', route },
    ]);
  });

  it('copies an effectively final local into a local class method, routed through that class', () => {
    const source =
      'class App { void run() { var value = factory.make(); class Local { void m() { var copy = value; } } } }';
    expect(routed(source)).toEqual([
      {
        name: 'copy',
        call: 'factory.make()',
        route: routeThrough(source, 'class Local', '} }'),
      },
    ]);
  });

  it('names every class a copy is read through', () => {
    const [, deeper] = routed(`class App { void run() {
      var value = factory.make();
      new Task() { void m() { var copy = value; new Task() { void m() { var deeper = copy; } }; } };
    } }`);
    const proofs: unknown = JSON.parse(deeper!.route!.slice(JAVA_ENCLOSING_LOCAL_ROUTE.length));
    expect({ name: deeper!.name, call: deeper!.call }).toEqual({
      name: 'deeper',
      call: 'factory.make()',
    });
    expect((proofs as [string, string][]).map(([, name]) => name)).toEqual(['value', 'copy']);
  });

  it.each([
    'new Task() { Repo value; void m() { var copy = value; } };',
    'new Task() { void m() { var copy = value; } Repo value; };',
    'new Task() { void m(Repo value) { var copy = value; } };',
    'new Task() { void m(Object o) { if (o instanceof Repo value) { var copy = value; } } };',
    'class Local { Repo value; void m() { var copy = value; } }',
    'new Task() { void m() { var copy = value; } }; value = other.make();',
    'new Task() { void m() { var copy = value; } }; value += 1;',
    'class Local { void m() { var copy = value; } } if (ready) { value++; }',
    'interface Local { default void m() { var copy = value; } }',
    'enum Local { A; void m() { var copy = value; } }',
    'record Local() { void m() { var copy = value; } }',
    'class Local { static class Nested { void m() { var copy = value; } } }',
  ])('refuses a copy whose name is a member there or whose source is written: %s', (body) => {
    expect(
      routed(`class App { void run() { var value = factory.make(); ${body} } }`).filter(
        ({ name }) => name === 'copy',
      ),
    ).toEqual([]);
  });
});
