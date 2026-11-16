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
  User[] pick(Integer value) { return null; }
  Other[] pick(String value) { return null; }
  void overloaded() { getUsers()[0].save(); }
  void tied() { this.pick(null)[0].save(); }
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

  // javac selects the zero-argument `getUsers()` (User[]) although the two
  // `getUsers` declarations disagree on the return type, so the receiver is
  // typed from that selected overload. A `null` argument applies to both
  // `pick` overloads and neither is more specific: no return type is chosen.
  it.each<[string, string[]]>([
    ['Ambiguous.overloaded#0', ['Method:Main.java:User.save#0']],
    ['Ambiguous.tied#0', []],
  ])('types %s only from the selected overload', (caller, expected) => {
    expect(result().graph.getNode(`Method:Main.java:${caller}`)).toBeDefined();
    const targets = getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === `Method:Main.java:${caller}` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual(expected);
  });
});
