import { describe, expect, it } from 'vitest';
import { synthesizeJavaFactoryAliasCaptures } from '../../../../src/core/ingestion/languages/java/factory-alias-captures.js';
import { getJavaParser } from '../../../../src/core/ingestion/languages/java/query.js';

function producerAliases(source: string) {
  const tree = getJavaParser().parse(source);
  return synthesizeJavaFactoryAliasCaptures(tree.rootNode).map((capture) => ({
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
    const [capture] = synthesizeJavaFactoryAliasCaptures(tree.rootNode);
    expect(capture?.['@call-result-assignment.call']?.text).toBe('factory.make()');
    expect(capture?.['@call-result-assignment.scope']?.range).toEqual(
      capture?.['@call-result-assignment.lhs']?.range,
    );
  });

  it.each([
    'if (ready) { value = other.make(); var copy = value; }',
    'while (ready) { var copy = value; value = other.make(); }',
    'if (ready) { var copy = value; } value++;',
    'new Object() { void m() { var copy = value; } };',
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
    const [capture] = synthesizeJavaFactoryAliasCaptures(tree.rootNode);
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
