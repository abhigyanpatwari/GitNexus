import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

/**
 * `values.forEach(value -> value.save())` where `values` is written as a JDK
 * container but a workspace type gives that spelling another meaning. Capture
 * reads the spelling as the JDK container and types the lambda parameter by its
 * element, behind a proof that resolution refutes. The refuted lambda then takes
 * its parameter type from the selected `forEach` itself: the single abstract
 * method of the functional interface that `forEach` declares, a JDK
 * `java.util.function` one or a workspace one (JLS 15.27.3). Where the JDK
 * container reading stands, that element type is kept.
 */
describe('Java lambda parameters behind a refuted JDK container reading', () => {
  const result = useFixture('java-r6-shadow-root', {
    // In package `shadow`, the simple name `java` is the class `shadow.java`;
    // a type obscures a package (JLS 6.4.2), so `java.util.List` is the member
    // type `shadow.java.util.List`, never the JDK interface.
    'shadow/ShadowItem.java': 'package shadow; public class ShadowItem { public void save() {} }',
    'shadow/ShadowOther.java': 'package shadow; public class ShadowOther { public void save() {} }',
    'shadow/ShadowCallback.java':
      'package shadow; public interface ShadowCallback<T> { void accept(T value); }',
    // An import names its type from the package root (JLS 7.5.1), so this
    // `Consumer` is the JDK interface even inside package `shadow`.
    'shadow/java.java': `package shadow; import java.util.function.Consumer;
public class java {
  public static class util {
    public static class List<T> {
      public void forEach(Consumer<ShadowOther> callback) {}
    }
    public static class Set<T> {
      public void forEach(ShadowCallback<ShadowOther> callback) {}
    }
  }
}`,
    'shadow/ShadowProbe.java': `package shadow;
class ShadowProbe {
  ShadowItem value;
  void raw(java.util.List<ShadowItem> values) { values.forEach(value -> value.save()); }
  void callback(java.util.Set<ShadowItem> values) { values.forEach(value -> value.save()); }
}`,
    // A same-package type shadows a type-import-on-demand (JLS 6.4.1).
    'ondemand/Item.java': 'package ondemand; public class Item { public void save() {} }',
    'ondemand/Other.java': 'package ondemand; public class Other { public void save() {} }',
    'ondemand/Callback.java':
      'package ondemand; public interface Callback<T> { void accept(T value); }',
    'ondemand/List.java': `package ondemand;
public class List<T> { public void forEach(Callback<Other> callback) {} }`,
    'ondemand/Use.java': `package ondemand;
import java.util.*;
class Use {
  void run(List<Item> values) { values.forEach(value -> value.save()); }
}`,
    // The JDK reading stands: the lambda parameter is the container element.
    'jdk/Item.java': 'package jdk; public class Item { public void save() {} }',
    'jdk/Use.java': `package jdk;
import java.util.List;
class Use {
  void imported(List<Item> values) { values.forEach(value -> value.save()); }
  void raw(java.util.List<Item> values) { values.forEach(value -> value.save()); }
}`,
    // A lambda in an anonymous class body reads an enclosing local through a
    // supertype that declares no such field (JLS 6.4.1).
    'anon/Item.java': 'package anon; public class Item { public void save() {} }',
    'anon/Other.java': 'package anon; public class Other { public void save() {} }',
    'anon/Callback.java': 'package anon; public interface Callback<T> { void accept(T value); }',
    'anon/Box.java': `package anon;
public class Box<T> { public void forEach(Callback<Other> callback) {} }`,
    'anon/Base.java': 'package anon; public class Base {}',
    'anon/Use.java': `package anon;
class Use {
  void run(Box<Item> values) {
    new Base() { void go() { values.forEach(value -> value.save()); } };
  }
}`,
  });

  const saveTargets = (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    [
      'a shadowed java root with a JDK Consumer',
      'Method:shadow/ShadowProbe.java:ShadowProbe.raw#1',
      'Method:shadow/ShadowOther.java:ShadowOther.save#0',
    ],
    [
      'a shadowed java root with a workspace callback',
      'Method:shadow/ShadowProbe.java:ShadowProbe.callback#1',
      'Method:shadow/ShadowOther.java:ShadowOther.save#0',
    ],
    [
      'a same-package type over an on-demand import',
      'Method:ondemand/Use.java:Use.run#1',
      'Method:ondemand/Other.java:Other.save#0',
    ],
    [
      'an enclosing local no supertype field hides',
      'Method:anon/Use.java:Use$1.go#0',
      'Method:anon/Other.java:Other.save#0',
    ],
  ])('types the lambda by the workspace forEach behind %s', (_shape, caller, target) => {
    expect(saveTargets(caller)).toEqual([target]);
  });

  it.each([
    ['Use.imported#1', 'Method:jdk/Item.java:Item.save#0'],
    ['Use.raw#1', 'Method:jdk/Item.java:Item.save#0'],
  ])('keeps the JDK element type for %s', (method, target) => {
    expect(saveTargets(`Method:jdk/Use.java:${method}`)).toEqual([target]);
  });
});
