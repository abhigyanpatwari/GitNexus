import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

/**
 * `Api.run(x -> x.save())` where `run(Generic<Item> g)` is declared in package
 * `c`. The lambda parameter takes the type argument `Item` of the selected
 * callee's parameter type, read where that parameter type was written: in the
 * callee's declaration, never in the caller's file. A caller-side `Item`, from
 * the caller's own package or from its single-type import, is never the owner.
 */
describe('Java SAM lambda type arguments read in the callee declaration', () => {
  const result = useFixture('java-r6-sam-callee-scope', {
    'c/Item.java': 'package c; public class Item { public void save() {} }',
    'c/Generic.java': 'package c; public interface Generic<T> { void accept(T t); }',
    'c/Api.java': 'package c; public class Api { public static void run(Generic<Item> g) {} }',
    'd/Item.java': 'package d; public class Item { public void save() {} }',
    'd/Caller.java': `package d;
import c.Api;
class Caller { void go() { Api.run(x -> x.save()); } }`,
    'e/Item.java': 'package e; public class Item { public void save() {} }',
    'd/Importer.java': `package d;
import c.Api;
import e.Item;
class Importer { void go() { Api.run(x -> x.save()); } }`,
  });

  const saveTargets = (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    ['a same-package Item', 'Method:d/Caller.java:Caller.go#0'],
    ['a single-type imported Item', 'Method:d/Importer.java:Importer.go#0'],
  ])('reads the callee Item, not the caller file %s', (_decoy, caller) => {
    expect(saveTargets(caller)).toEqual(['Method:c/Item.java:Item.save#0']);
  });
});
