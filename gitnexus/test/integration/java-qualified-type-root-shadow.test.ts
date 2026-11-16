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

// `prefix.User` names the member type `p.prefix.User`, because the root
// `prefix` is a class visible from the same package. A root that names a type
// declared in another file is refused rather than read as a member path, so
// the exact expected set is empty: no edge, and never the package `prefix`.
it('does not reinterpret a visible type qualifier as an unrelated package', () => {
  const targets = getRelationships(result(), 'CALLS')
    .filter((edge) => edge.rel.sourceId === 'Method:p/App.java:App.run#1' && edge.target === 'save')
    .map((edge) => edge.rel.targetId);
  expect(targets).toEqual([]);
});
