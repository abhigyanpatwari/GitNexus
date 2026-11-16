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
    ).toEqual([{ name: 'copy', call: 'factory.make()' }]);
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

  it('does not cross a local type visibility scope', () => {
    expect(
      producerAliases(`class App { void run() {
      var value = factory.make();
      class Local {}
      var copy = value;
    } }`),
    ).toEqual([]);
  });
});
