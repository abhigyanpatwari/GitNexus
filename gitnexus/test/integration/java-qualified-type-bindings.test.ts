import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java qualified and annotated receiver bindings', () => {
  const result = useFixture('java-qualified-bindings', {
    'models/User.java': `package models; public class User<T> { public void save() {} }`,
    'other/User.java': `package other; public class User { public void save() {} }`,
    'app/Main.java': `package app;
import other.User;
@java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE) @interface Mark {}
class App {
  models.User field;
  models.User getUser() { return field; }
  void parameter(models.User user) { user.save(); }
  void local() { models.User user = null; user.save(); }
  void field() { this.field.save(); }
  void returned() { getUser().save(); }
  void constructor() { var user = new models.User(); user.save(); }
  void genericConstructor() { var user = new models.User<>(); user.save(); }
  void annotatedConstructor() { var user = new models.@Mark User<>(); user.save(); }
  void alias(models.User user) { var copy = user; copy.save(); }
  void annotated(models.@Mark User user) { user.save(); }
  void annotatedArray(models.User @Mark [] users) { users[0].save(); }
  void qualifiedArray(models.User[] users) { users[0].save(); }
  void unresolved() { missing.User user = null; user.save(); }
}
`,
  });
  const targets = (caller: string) =>
    getRelationships(result(), 'CALLS')
      .filter((edge) => edge.source === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();
  it.each([
    'parameter',
    'local',
    'field',
    'returned',
    'constructor',
    'genericConstructor',
    'annotatedConstructor',
    'alias',
    'annotated',
    'annotatedArray',
    'qualifiedArray',
  ])('%s retains the qualified owner despite a competing import', (caller) => {
    expect(targets(caller)).toEqual(['Method:models/User.java:User.save#0']);
  });
  it('does not replace an unresolved qualified type with an imported simple name', () => {
    expect(targets('unresolved')).toEqual([]);
  });
});
