import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java array method return owner identity', () => {
  const result = useFixture('java-array-method-return-identity', {
    'Main.java': `
class User { void save() {} }
class Other { void save() {} }
class App {
  User[] getUsers() { return null; }
  User trailingReturn()[] { return null; }
  void bare() { getUsers()[0].save(); }
  void trailing() { trailingReturn()[0].save(); }
  void explicit(Service service) { service.getUsers()[0].save(); }
}
class Ambiguous {
  User[] getUsers() { return null; }
  Other[] getUsers(int value) { return null; }
  void overloaded() { getUsers()[0].save(); }
}
class Service { Other[] getUsers() { return null; } }
`,
  });

  it.each([
    ['App.bare#0', 'User'],
    ['App.trailing#0', 'User'],
    ['App.explicit#1', 'Other'],
  ])('preserves the exact return owner for %s', (caller, owner) => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === `Method:Main.java:${caller}` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId)
      .sort();
    expect(targets).toEqual([`Method:Main.java:${owner}.save#0`]);
  });

  it('does not select a competing return from an intermediate overload set', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) =>
          edge.rel.sourceId === 'Method:Main.java:Ambiguous.overloaded#0' && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).not.toContain('Method:Main.java:Other.save#0');
  });
});
