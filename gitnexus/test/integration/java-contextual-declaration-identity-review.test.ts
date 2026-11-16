import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java contextual element declaration identity', () => {
  const result = useFixture('java-contextual-declaration-identity', {
    'a/User.java': 'package a; public class User { public void save() {} }',
    'Outer.java': `import java.util.List;
import a.User;
class Outer {
  List<User> users;
  void direct() { users.forEach(x -> x.save()); }
  class Inner {
    static class User { void save() {} }
    void callback() { users.forEach(x -> x.save()); }
    void loop() { for (var x : users) x.save(); }
  }
}`,
  });
  const targets = (caller: string) =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge) => edge.rel.sourceId === `Method:Outer.java:${caller}#0` && edge.target === 'save',
      )
      .map((edge) => edge.rel.targetId);

  it('retains ordinary imported element inference', () => {
    expect(targets('Outer.direct')).toEqual(['Method:a/User.java:User.save#0']);
  });
  it.each(['callback', 'loop'])(
    'never rebinds an outer container argument inside Inner.%s',
    (caller) => {
      const actual = targets(`Inner.${caller}`);
      expect(actual).not.toContain('Method:Outer.java:User.save#0');
      for (const target of actual) expect(target).toBe('Method:a/User.java:User.save#0');
    },
  );
});

describe('Java raw JDK inference with local element declarations', () => {
  const result = useFixture('java-contextual-local-element-identity', {
    'decoy/User.java': 'package decoy; public class User { public void save() {} }',
    'Outer.java': `import decoy.User;
class Outer {
  void callback() {
    class User { void save() {} }
    java.util.List<User> users = null;
    users.forEach(x -> x.save());
  }
  void loop() {
    class User { void save() {} }
    java.util.List<User> users = null;
    for (var x : users) x.save();
  }
}`,
  });
  it.each(['callback', 'loop'])('does not borrow the imported User in %s', (caller) => {
    expect(
      getRelationships(result(), 'CALLS')
        .filter(
          (edge) =>
            edge.rel.sourceId === `Method:Outer.java:Outer.${caller}#0` && edge.target === 'save',
        )
        .map((edge) => edge.rel.targetId),
    ).toEqual([]);
  });
});
