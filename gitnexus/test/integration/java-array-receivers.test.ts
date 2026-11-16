import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java array receiver identity', () => {
  const result = useFixture('java-array-receivers', {
    'Main.java': `
class User {
  void save() {}
  public User clone() { return this; }
  public String toString() { return "user"; }
  void getClass() {}
}
class Other { void save() {} }
class List<T> { void save() {} }
class App {
  User[] field;
  User[] getUsers() { return field; }
  User trailingReturn()[] { return field; }
  void parameter(User[] users) { users[0].save(); }
  void trailingParameter(User users[]) { users[0].save(); }
  void varargs(User... users) { users[0].save(); }
  void local() { User[] users = null; users[0].save(); }
  void trailingLocal() { User users[] = null; users[0].save(); }
  void mixedScalar() { User first = null, second[] = null; first.save(); }
  void mixedArray() { User first = null, second[] = null; second[0].save(); }
  void mixedDimensions() { User[] first = null, second[] = null; first[0].save(); }
  void fieldElement() { this.field[0].save(); }
  void methodElement() { getUsers()[0].save(); }
  void trailingMethodElement() { trailingReturn()[0].save(); }
  void unindexed(User[] users) { users.save(); }
  void partial(User[][] users) { users[0].save(); }
  void mixedPartial() { User[] first = null, second[] = null; second[0].save(); }
  void listIndex(List<User> users) { users[0].save(); }
  void cloneArray(User[] users) { users.clone(); }
  void stringifyArray(User[] users) { users.toString(); }
  void classArray(User[] users) { users.getClass(); }
  void iterateArray(User[] users) { for (var user : users) user.save(); }
  void iterateList(java.util.List<User> users) { for (var user : users) user.save(); }
}
`,
  });
  const targets = (caller: string, member = 'save') =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.source === caller && edge.target === member)
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    'parameter',
    'trailingParameter',
    'varargs',
    'local',
    'trailingLocal',
    'mixedScalar',
    'mixedArray',
    'mixedDimensions',
    'fieldElement',
    'methodElement',
    'trailingMethodElement',
    'iterateArray',
    'iterateList',
  ])('%s resolves only the element owner', (caller) => {
    expect(targets(caller)).toEqual(['Method:Main.java:User.save#0']);
  });

  it.each(['unindexed', 'partial', 'mixedPartial', 'listIndex'])(
    '%s refuses element ownership without a complete array index',
    (caller) => {
      expect(targets(caller)).toEqual([]);
    },
  );

  it.each([
    ['cloneArray', 'clone'],
    ['stringifyArray', 'toString'],
    ['classArray', 'getClass'],
  ])('%s never resolves an Object method to the element class', (caller, member) => {
    expect(targets(caller, member)).toEqual([]);
  });
});
