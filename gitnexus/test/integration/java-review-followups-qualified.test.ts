import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const callTargets = (result: PipelineResult, caller: string, name: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge) => edge.rel.sourceId === caller && edge.target === name)
    .map((edge) => edge.rel.targetId)
    .sort();

describe('Java qualified member-type spellings', () => {
  const result = useFixture('java-review-followups-nested-fqn', {
    'models/Outer.java': `package models;
public class Outer {
  public static class Inner { public void run() {} }
  public interface Face { void run(); }
}`,
    'models/Other.java': 'package models; public class Other { public void run() {} }',
    'app/App.java': `package app;
class App {
  void parameter(models.Outer.Inner value) { value.run(); }
  void local() { models.Outer.Inner value = null; value.run(); }
  void member(models.Outer.Face value) { value.run(); }
}`,
    'Same.java': `class Uniq { static class Solo { void run() {} } }
class Other2 { void run() {} }
class SameFile { void q4(Uniq.Solo value) { value.run(); } }`,
  });

  it.each([
    ['parameter', 'Method:app/App.java:App.parameter#1', 'Method:models/Outer.java:Inner.run#0'],
    ['local', 'Method:app/App.java:App.local#0', 'Method:models/Outer.java:Inner.run#0'],
    ['member', 'Method:app/App.java:App.member#1', 'Method:models/Outer.java:Face.run#0'],
    ['same-file', 'Method:Same.java:SameFile.q4#1', 'Method:Same.java:Solo.run#0'],
  ])('resolves a %s receiver typed by a nested type FQN', (_label, caller, target) => {
    expect(callTargets(result(), caller, 'run')).toEqual([target]);
  });

  it.each([
    ['Method:app/App.java:App.parameter#1', 'Method:models/Other.java:Other.run#0'],
    ['Method:Same.java:SameFile.q4#1', 'Method:Same.java:Other2.run#0'],
  ])('never binds %s to the unrelated owner %s', (caller, wrong) => {
    expect(callTargets(result(), caller, 'run')).not.toContain(wrong);
  });
});

describe('Java qualified spellings are judged per reference', () => {
  const result = useFixture('java-review-followups-per-reference', {
    'models/User.java': 'package models; public class User { public void save() {} }',
    'models/Other.java': 'package models; public class Other { public void save() {} }',
    'app/App.java': `package app;
import models.User;
class App {
  void good(models.User u) { u.save(); }
  static class Nested {
    static class models { static class User { void save() {} } }
    void unrelated(models.User u) { u.save(); }
  }
}`,
  });

  it('resolves the package-qualified reference outside the shadowing type', () => {
    expect(callTargets(result(), 'Method:app/App.java:App.good#1', 'save')).toEqual([
      'Method:models/User.java:User.save#0',
    ]);
  });

  it('resolves the shadowed reference to the member type, never to the package type', () => {
    expect(callTargets(result(), 'Method:app/App.java:Nested.unrelated#1', 'save')).toEqual([
      'Method:app/App.java:User.save#0',
    ]);
  });
});

describe('Java qualified spellings under an inherited member type', () => {
  const result = useFixture('java-review-followups-inherited-root', {
    'models/User.java': 'package models; public class User { public void save() {} }',
    'models/Other.java': 'package models; public class Other { public void save() {} }',
    'app/App.java': `package app;
class Base { static class models { static class User { void save() {} } } }
class Sub extends Base { void inherited(models.User u) { u.save(); } }
class Plain { void unrelated(models.User u) { u.save(); } }`,
  });

  it('refuses a root that a subclass may inherit as a member type', () => {
    expect(callTargets(result(), 'Method:app/App.java:Sub.inherited#1', 'save')).toEqual([]);
  });

  it('keeps the package reading where no enclosing type inherits the member', () => {
    expect(callTargets(result(), 'Method:app/App.java:Plain.unrelated#1', 'save')).toEqual([
      'Method:models/User.java:User.save#0',
    ]);
  });
});
