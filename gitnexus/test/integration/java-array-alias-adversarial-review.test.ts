import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java array and factory alias adversarial controls', () => {
  const result = useFixture('java-array-alias-adversarial', {
    'Main.java': `
class Element {
  void save() {}
  public Element clone() { return this; }
  Element[] get() { return null; }
}
class Other { void save() {} }
class T { void save() {} }
class Base { void save() {} }
class Generic<T extends Base> {
  void bounded(T[] values) { values[0].save(); }
}
class Source { Element make() { return new Element(); } }
class ArraySource {
  Element[] onlyArgument(int selector) { return null; }
  private Element[] hidden() { return null; }
  Element[] varargs(int... selectors) { return null; }
}
class App {
  Element[] onlyArgument(int selector) { return null; }
  void inapplicableNoArg() { onlyArgument()[0].save(); }
  void inapplicableExplicit(ArraySource source) { source.onlyArgument()[0].save(); }
  void inaccessibleExplicit(ArraySource source) { source.hidden()[0].save(); }
  void applicableExplicit(ArraySource source) { source.onlyArgument(1)[0].save(); }
  void varargsExplicit(ArraySource source) { source.varargs()[0].save(); }
  void cloneChain(Element[] values) { values.clone().save(); }
  void partialCloneChain(Element[][] values) { values[0].clone().save(); }
  void parenthesizedArray(Element[] values) { ((values))[0].save(); }
  void copyArray(Element[] values) { var copy = values; copy[0].save(); }
  void copyArrayNegative(Element[] values) { var copy = values; copy.save(); }
  void factoryCopySnapshot(Source source, Source replacement) {
    var value = source.make();
    var copy = value;
    value = replacement.make();
    copy.save();
  }
}
`,
    'a/Element.java': 'package a; public class Element { public void save() {} }',
    'b/Element.java': 'package b; public class Element { public void save() {} }',
    'Qualified.java': `import b.Element;
class Qualified {
  void positive(a.Element[] values) { values[0].save(); }
  void negative(a.Element[] values) { values.save(); }
}`,
  });
  const targets = (owner: string, caller: string) =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId.startsWith(`Method:${owner}.${caller}#`) && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    'cloneChain',
    'partialCloneChain',
    'copyArrayNegative',
    'inapplicableExplicit',
    'inaccessibleExplicit',
  ])('%s never borrows an element owner', (caller) => {
    expect(targets('Main.java:App', caller)).toEqual([]);
  });
  it.each([
    'parenthesizedArray',
    'copyArray',
    'factoryCopySnapshot',
    'applicableExplicit',
    'varargsExplicit',
  ])('%s preserves the exact selected owner', (caller) => {
    expect(targets('Main.java:App', caller)).toEqual(['Method:Main.java:Element.save#0']);
  });
  it('never redirects a written qualified array element to an imported same-name owner', () => {
    for (const target of targets('Qualified.java:Qualified', 'positive')) {
      expect(target).toBe('Method:a/Element.java:Element.save#0');
    }
    expect(targets('Qualified.java:Qualified', 'negative')).toEqual([]);
  });
  it('does not interpret an array element type parameter as an unrelated same-named class', () => {
    expect(targets('Main.java:Generic', 'bounded')).not.toContain('Method:Main.java:T.save#0');
  });
  it('does not infer an array element from an inapplicable implicit producer call', () => {
    expect(targets('Main.java:App', 'inapplicableNoArg')).toEqual([]);
  });
});
