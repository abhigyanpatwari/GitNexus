import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java alias lexical ownership', () => {
  const result = useFixture('java-alias-lexical-ownership', {
    'Main.java': `
class User { void save() {} public String toString() { return "user"; } }
class Repo { void save() {} public String toString() { return "repo"; } }
class Unknown {}
class Address { void save() {} }
class OtherAddress { void save() {} }
class Holder { User user; }
class Customer {
  Address address;
  Unknown unresolved;
  OtherAddress address() { return new OtherAddress(); }
  OtherAddress unresolved() { return new OtherAddress(); }
}
class Factory { Repo make() { return new Repo(); } }
class OtherFactory { User make() { return new User(); } }
class App {
  Repo x;
  Repo field;
  void seedOtherMethod() { User x = new User(); }
  void parameterAlias(Repo x) { var copy = x; copy.save(); }
  void unknownParameterAlias(Unknown x) { var copy = x; copy.save(); }
  void fieldAlias(Customer user) {
    OtherAddress address = new OtherAddress();
    var copy = user.address;
    copy.save();
  }
  void fieldVersusMethodAlias(Customer user) { var copy = user.address; copy.save(); }
  void unknownFieldVersusMethodAlias(Customer user) { var copy = user.unresolved; copy.save(); }
  void thisFieldAlias() { var copy = this.field; copy.save(); }
  void nestedFieldAlias(Holder holder) { var copy = holder.user; copy.save(); }
  void beforeLocalDeclaration() {
    var copy = x;
    User x = new User();
    copy.save();
  }
  void afterLocalDeclaration() {
    User x = new User();
    var copy = x;
    copy.save();
  }
  void factoryAlias(Factory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void competingFactoryAlias(OtherFactory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void unknownLocalAlias() { Unknown x = new Unknown(); var copy = x; copy.save(); }
  void declaredTypeAfterAssignment(Factory factory) {
    Object value = new User();
    var copy = value;
    value = factory.make();
    copy.toString();
  }
}
`,
  });

  it.each([
    ['parameterAlias', 'Repo', 1],
    ['fieldAlias', 'Address', 1],
    ['fieldVersusMethodAlias', 'Address', 1],
    ['thisFieldAlias', 'Repo', 0],
    ['nestedFieldAlias', 'User', 1],
    ['beforeLocalDeclaration', 'Repo', 0],
    ['afterLocalDeclaration', 'User', 0],
    ['factoryAlias', 'Repo', 1],
    ['competingFactoryAlias', 'User', 1],
  ])('resolves %s to the exact %s owner', (caller, owner, arity) => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === `Method:Main.java:App.${caller}#${arity}` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId)
      .sort();
    expect(targets).toEqual([`Method:Main.java:${owner}.save#0`]);
  });

  it('does not infer an unknown parameter alias from a same-named field or another method', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:App.unknownParameterAlias#1' &&
          edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([]);
  });

  it('does not infer an unknown local alias from a same-named field or another method', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:App.unknownLocalAlias#0' &&
          edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([]);
  });

  it('does not reinterpret a field alias as a same-named zero-argument method', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:App.unknownFieldVersusMethodAlias#1' &&
          edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([]);
  });

  it('preserves the declared alias type across later assignment of its source', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:App.declaredTypeAfterAssignment#1' &&
          edge.target === 'toString',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([]);
  });
});
