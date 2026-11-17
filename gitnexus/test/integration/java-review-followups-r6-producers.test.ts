import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

const saveTargetsOf =
  (result: () => Parameters<typeof getRelationships>[0]) =>
  (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();

/**
 * `users()[0].save()` peels the producer's declared return type to its element.
 * Type annotations and comments are not part of a Java type's spelling, so a
 * return type written `User @Mark []` or `User /* c *\/ []` (or with its
 * dimensions after the parameter list, or as a record component's type) types
 * the element exactly as `User[]`.
 */
describe('Java producer return types written with annotations or comments', () => {
  const result = useFixture('java-r6-annotated-producer-returns', {
    'e/User.java': 'package e; public class User { public void save() {} }',
    'e/Mark.java': `package e;
@java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE)
public @interface Mark {}`,
    'e/Repo.java': `package e;
class Repo {
  User @Mark [] annotated() { return null; }
  User /* c */ [] blockComment() { return null; }
  User // c
    [] lineComment() { return null; }
  User trailing() @Mark [] { return null; }
  User @Mark [] [] nested() { return null; }
  User @Mark [] split() /* c */ [] { return null; }
  User plain()[] { return null; }
  void callAnnotated() { annotated()[0].save(); }
  void callBlockComment() { blockComment()[0].save(); }
  void callLineComment() { lineComment()[0].save(); }
  void callTrailing() { trailing()[0].save(); }
  void callNested() { nested()[0][0].save(); }
  void callSplit() { split()[0][0].save(); }
  void callPlain() { plain()[0].save(); }
}`,
    'e/Rec.java': `package e;
record Rec(User @Mark [] users) { void callRecord() { users()[0].save(); } }`,
  });
  const saveTargets = saveTargetsOf(result);

  it.each([
    'e/Repo.java:Repo.callAnnotated#0',
    'e/Repo.java:Repo.callBlockComment#0',
    'e/Repo.java:Repo.callLineComment#0',
    'e/Repo.java:Repo.callTrailing#0',
    'e/Repo.java:Repo.callNested#0',
    'e/Repo.java:Repo.callSplit#0',
    'e/Repo.java:Repo.callPlain#0',
    'e/Rec.java:Rec.callRecord#0',
  ])('types the producer element in %s as User', (caller) => {
    expect(saveTargets(`Method:${caller}`)).toEqual(['Method:e/User.java:User.save#0']);
  });
});
