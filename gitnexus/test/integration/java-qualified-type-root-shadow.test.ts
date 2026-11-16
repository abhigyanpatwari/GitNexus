import { expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

const result = useFixture('java-qualified-type-root-shadow', {
  'prefix/User.java': 'package prefix; public class User { public void save() {} }',
  'p/prefix.java': `package p; public class prefix {
  public static class User { public void save() {} }
}`,
  'p/App.java': `package p; public class App {
  void run(prefix.User value) { value.save(); }
}`,
});

// `prefix.User` names the member type `p.prefix.User`: the root `prefix` is a
// class in scope from the same package, so it is read as a type and never as
// the package `prefix` (JLS 6.5.4.1), even though that package has a `User`.
it('reads a visible same-package type qualifier as a type, not as an unrelated package', () => {
  const targets = getRelationships(result(), 'CALLS')
    .filter((edge) => edge.rel.sourceId === 'Method:p/App.java:App.run#1' && edge.target === 'save')
    .map((edge) => edge.rel.targetId);
  expect(targets).not.toContain('Method:prefix/User.java:User.save#0');
  expect(targets).toEqual(['Method:p/prefix.java:User.save#0']);
});
