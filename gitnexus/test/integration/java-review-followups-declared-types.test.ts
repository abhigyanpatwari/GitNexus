import { describe, expect, it } from 'vitest';
import type { PipelineResult } from '../../src/types/pipeline.js';
import { getRelationships, useFixture } from './resolvers/helpers.js';

// Every fixture has two `save` owners, so a missing proof cannot pass by luck.
const OWNERS = {
  'app/User.java': 'package app; public class User { public void save() {} }',
  'app/Other.java': 'package app; public class Other { public void save() {} }',
};
const USER = 'Method:app/User.java:User.save#0';
const OTHER = 'Method:app/Other.java:Other.save#0';

function saveTargets(result: PipelineResult, caller: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.rel.sourceId === caller && edge.target === 'save')
    .map((edge) => edge.rel.targetId)
    .sort();
}

describe('Java declared types: record components and switch-group locals', () => {
  const result = useFixture('java-followup-lexical-owner', {
    ...OWNERS,
    'app/NestRec.java': `package app;
import java.util.List;
class NestRec {
  List<Other> users;
  record Page(List<User> users) {
    void inside() { for (var u : users) u.save(); }
  }
  void nrFor() { for (var u : users) u.save(); }
  void nrLambda() { users.forEach(u -> u.save()); }
  void localRecord() {
    record Local(List<User> users) {}
    for (var u : users) u.save();
  }
}`,
    'app/Sw.java': `package app;
import java.util.List;
class Sw {
  List<Other> users;
  void inside(int k) {
    switch (k) { case 1: List<User> users = null; users.forEach(u -> u.save()); }
  }
  void after(int k) {
    switch (k) { case 1: List<User> users = null; }
    users.forEach(u -> u.save());
  }
}`,
  });

  it.each<[string, string, string[]]>([
    ['NestRec.nrFor', 'Method:app/NestRec.java:NestRec.nrFor#0', [OTHER]],
    ['NestRec.nrLambda', 'Method:app/NestRec.java:NestRec.nrLambda#0', [OTHER]],
    ['NestRec.localRecord', 'Method:app/NestRec.java:NestRec.localRecord#0', [OTHER]],
    ['Page.inside', 'Method:app/NestRec.java:Page.inside#0', [USER]],
    ['Sw.inside', 'Method:app/Sw.java:Sw.inside#1', [USER]],
    ['Sw.after', 'Method:app/Sw.java:Sw.after#1', [OTHER]],
  ])('%s sees only declarations in its lexical owner', (_label, caller, expected) => {
    expect(saveTargets(result(), caller)).toEqual(expected);
  });
});

describe('Java declared types: inherited fields shadow enclosing fields', () => {
  const result = useFixture('java-followup-inherited-field', {
    ...OWNERS,
    'app/Outer.java': `package app;
import java.util.List;
class Base2 { List<Other> items; }
interface HasItems {}
class Outer {
  List<User> items;
  class In extends Base2 {
    void run() { items.forEach(v -> v.save()); }
    void loop() { for (var v : items) v.save(); }
  }
  class Impl implements HasItems {
    void run() { items.forEach(v -> v.save()); }
  }
  class Plain {
    void run() { items.forEach(v -> v.save()); }
  }
  void anon() {
    new Base2() { void run() { items.forEach(v -> v.save()); } };
  }
}`,
  });

  // Java member lookup takes Base2.items (List<Other>) before Outer.items.
  it.each([
    ['In.run', 'Method:app/Outer.java:In.run#0'],
    ['In.loop', 'Method:app/Outer.java:In.loop#0'],
    ['anonymous Base2.run', 'Method:app/Outer.java:Outer$1.run#0'],
  ])('%s reads the inherited field, not the enclosing one', (_label, caller) => {
    expect(saveTargets(result(), caller)).toEqual([OTHER]);
  });

  // HasItems declares nothing, so `items` is still Outer.items (List<User>).
  it.each([
    ['Impl.run', 'Method:app/Outer.java:Impl.run#0'],
    ['Plain.run', 'Method:app/Outer.java:Plain.run#0'],
  ])('%s keeps the enclosing field when no supertype declares it', (_label, caller) => {
    expect(saveTargets(result(), caller)).toEqual([USER]);
  });
});

describe('Java declared types: type parameters are scoped to their declaration', () => {
  const result = useFixture('java-followup-type-parameter-scope', {
    ...OWNERS,
    'app/App.java': `package app;
class Noise<User> {}
class App {
  void run(User[] users) { for (User user : users) user.save(); }
  <Other> void unrelated() {}
  void run2(Other[] others) { for (Other other : others) other.save(); }
  <User> void generic(User[] users) { for (User user : users) user.save(); }
}`,
  });

  it.each<[string, string, string[]]>([
    ['App.run', 'Method:app/App.java:App.run#1', [USER]],
    ['App.run2', 'Method:app/App.java:App.run2#1', [OTHER]],
    ['App.generic', 'Method:app/App.java:App.generic#1', []],
  ])('%s reads a type parameter only inside its declaration', (_label, caller, expected) => {
    expect(saveTargets(result(), caller)).toEqual(expected);
  });
});

describe('Java declared types: JDK container implementations and on-demand imports', () => {
  const result = useFixture('java-followup-jdk-containers', {
    ...OWNERS,
    'app/Svc.java': `package app;
import java.util.*;
class Svc {
  HashMap<String, User> users;
  Map<String, Other> others;
  void list(List<User> xs) { for (var u : xs) u.save(); }
  void arrayList(ArrayList<User> xs) { for (var u : xs) u.save(); }
  void linkedList(LinkedList<User> xs) { xs.forEach(u -> u.save()); }
  void set(Set<User> xs) { for (var u : xs) u.save(); }
  void hashMapValues() { for (var u : users.values()) u.save(); }
  void mapValues() { for (var o : others.values()) o.save(); }
  void deque(Deque<Other> xs) { for (var o : xs) o.save(); }
  void iterable(Iterable<User> xs) { for (var u : xs) u.save(); }
}`,
    'app/Single.java': `package app;
import java.util.ArrayList;
import java.util.HashMap;
class Single {
  void arrayList(ArrayList<User> xs) { xs.forEach(u -> u.save()); }
  void hashMap(HashMap<String, Other> m) { for (var o : m.values()) o.save(); }
}`,
  });

  it.each<[string, string, string[]]>([
    ['Svc.list', 'Method:app/Svc.java:Svc.list#1', [USER]],
    ['Svc.arrayList', 'Method:app/Svc.java:Svc.arrayList#1', [USER]],
    ['Svc.linkedList', 'Method:app/Svc.java:Svc.linkedList#1', [USER]],
    ['Svc.set', 'Method:app/Svc.java:Svc.set#1', [USER]],
    ['Svc.hashMapValues', 'Method:app/Svc.java:Svc.hashMapValues#0', [USER]],
    ['Svc.mapValues', 'Method:app/Svc.java:Svc.mapValues#0', [OTHER]],
    ['Svc.deque', 'Method:app/Svc.java:Svc.deque#1', [OTHER]],
    ['Svc.iterable', 'Method:app/Svc.java:Svc.iterable#1', [USER]],
    ['Single.arrayList', 'Method:app/Single.java:Single.arrayList#1', [USER]],
    ['Single.hashMap', 'Method:app/Single.java:Single.hashMap#1', [OTHER]],
  ])('%s infers the proven element owner', (_label, caller, expected) => {
    expect(saveTargets(result(), caller)).toEqual(expected);
  });
});

describe('Java declared types: a same-package type shadows an on-demand JDK import', () => {
  const result = useFixture('java-followup-on-demand-shadow', {
    ...OWNERS,
    'app/List.java': `package app;
public class List<T> implements Iterable<Other> {
  public java.util.Iterator<Other> iterator() { return null; }
}`,
    'app/Svc.java': `package app;
import java.util.*;
class Svc {
  void shadowed(List<User> xs) { for (var u : xs) u.save(); }
  void shadowedLambda(List<User> xs) { xs.forEach(u -> u.save()); }
  void unshadowed(ArrayList<User> xs) { for (var u : xs) u.save(); }
}`,
  });

  it.each([
    ['Svc.shadowed', 'Method:app/Svc.java:Svc.shadowed#1'],
    ['Svc.shadowedLambda', 'Method:app/Svc.java:Svc.shadowedLambda#1'],
  ])('%s never infers java.util.List for the package List', (_label, caller) => {
    expect(saveTargets(result(), caller)).not.toContain(USER);
    expect(saveTargets(result(), caller)).toEqual([]);
  });

  it('still proves an unshadowed on-demand name in the same file', () => {
    expect(saveTargets(result(), 'Method:app/Svc.java:Svc.unshadowed#1')).toEqual([USER]);
  });
});

describe('Java declared types: an inherited member type shadows a JDK import', () => {
  const result = useFixture('java-followup-inherited-member-type', {
    ...OWNERS,
    'lib/Base.java': `package lib;
public class Base {
  public static class List<T> { public void forEach(java.util.function.Consumer<app.Other> c) {} }
}`,
    'app/Sub.java': `package app;
import java.util.List;
import lib.Base;
class Sub extends Base {
  List<User> xs;
  void run() { xs.forEach(u -> u.save()); }
  void loop() { for (var u : xs) u.save(); }
}
class Plain {
  List<User> xs;
  void run() { xs.forEach(u -> u.save()); }
}`,
    'app/Sub2.java': `package app;
import java.util.*;
import lib.Base;
class Sub2 extends Base {
  List<User> xs;
  void run() { xs.forEach(u -> u.save()); }
}`,
  });

  it.each([
    ['Sub.run', 'Method:app/Sub.java:Sub.run#0'],
    ['Sub.loop', 'Method:app/Sub.java:Sub.loop#0'],
    ['Sub2.run', 'Method:app/Sub2.java:Sub2.run#0'],
  ])('%s does not treat the inherited List as java.util.List', (_label, caller) => {
    expect(saveTargets(result(), caller)).toEqual([]);
  });

  it('keeps the import proof in a class that inherits no List', () => {
    expect(saveTargets(result(), 'Method:app/Sub.java:Plain.run#0')).toEqual([USER]);
  });
});
