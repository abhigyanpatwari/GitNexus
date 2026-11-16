import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java local alias source order and block claims', () => {
  const result = useFixture('java-local-alias-scope-claims', {
    'Main.java': `
class User { void save() {} void userOnly() {} }
class Repo { void save() {} void repoOnly() {} }
class Unknown {}
class App {
  Repo x;
  void beforeLocal() { var copy = x; User x = new User(); copy.save(); }
  void afterLocal() { User x = new User(); var copy = x; copy.save(); }
  void afterNested() { { User x = new User(); } var copy = x; copy.save(); }
  void beforeNested() { var copy = x; { User x = new User(); } copy.save(); }
  void withinNested() { { User x = new User(); var copy = x; copy.save(); } }
  void siblingBlocks() {
    { User x = new User(); var copy = x; copy.userOnly(); }
    { Repo x = new Repo(); var copy = x; copy.repoOnly(); }
  }
  void afterFor() { for (User x = new User(); condition; ) { x.userOnly(); } var copy = x; copy.save(); }
  void unknownShadow() { Unknown x = null; var copy = x; copy.save(); }
  void invalidSelfRead() { var x = x; x.save(); }
}
`,
  });
  const targets = (caller: string, member = 'save') =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === `Method:Main.java:App.${caller}#0` && edge.target === member,
      )
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    ['beforeLocal', 'Repo'],
    ['afterLocal', 'User'],
    ['afterNested', 'Repo'],
    ['beforeNested', 'Repo'],
    ['withinNested', 'User'],
    ['afterFor', 'Repo'],
  ])('preserves the exact lexical owner in %s', (caller, owner) => {
    expect(targets(caller)).toEqual([`Method:Main.java:${owner}.save#0`]);
  });
  it('keeps sibling block aliases separate', () => {
    expect(targets('siblingBlocks', 'userOnly')).toEqual(['Method:Main.java:User.userOnly#0']);
    expect(targets('siblingBlocks', 'repoOnly')).toEqual(['Method:Main.java:Repo.repoOnly#0']);
  });
  it.each(['unknownShadow', 'invalidSelfRead'])(
    '%s cannot borrow an outer field type',
    (caller) => {
      expect(targets(caller)).toEqual([]);
    },
  );
});
