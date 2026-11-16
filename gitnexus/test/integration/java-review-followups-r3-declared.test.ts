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

function lombokMethods(result: PipelineResult, filePath: string): string[] {
  return [...result.graph.iterNodes()]
    .filter((node) => node.properties.synthetic === 'lombok' && node.id.includes(`:${filePath}:`))
    .map((node) => node.id)
    .sort();
}

describe('Java Lombok workspace proof: a statically imported superclass', () => {
  const result = useFixture('java-r3-lombok-static-import', {
    // Holder is in another package: a same-package nested Base is already found
    // by the same-package lookup.
    'q/Holder.java': `package q;
public class Holder {
  public static class Base { public @interface Getter {} }
  public static class Plain { public @interface Marker {} }
}`,
    'p/Model.java': `package p;
import static q.Holder.Base;
import lombok.Getter;
class Model extends Base { @Getter String name; }`,
    'p/Control.java': `package p;
import static q.Holder.Plain;
import lombok.Getter;
class Control extends Plain { @Getter String name; }`,
  });

  it('lets the inherited member annotation type shadow Lombok', () => {
    expect(lombokMethods(result(), 'p/Model.java')).toEqual([]);
  });

  it('still synthesizes when the imported superclass declares no such member type', () => {
    expect(lombokMethods(result(), 'p/Control.java')).toEqual([
      'Method:p/Control.java:Control.getName#0',
    ]);
  });
});

describe('Java declared types: a field inherited from a workspace supertype', () => {
  const result = useFixture('java-r3-inherited-field-element', {
    ...OWNERS,
    'app/Base.java': `package app;
import java.util.List;
import java.util.Map;
public class Base {
  protected List<Other> items;
  protected Map<String, Other> byId;
  protected Other[] array;
}`,
    'app/Sub.java': `package app;
class Sub extends Base {
  void lambda() { items.forEach(v -> v.save()); }
  void loop() { for (var v : items) v.save(); }
  void values() { for (var v : byId.values()) v.save(); }
  void mapForEach() { byId.forEach((k, v) -> v.save()); }
  void array() { for (var v : array) v.save(); }
}`,
  });

  it.each<[string, string]>([
    ['Sub.lambda', 'Method:app/Sub.java:Sub.lambda#0'],
    ['Sub.loop', 'Method:app/Sub.java:Sub.loop#0'],
    ['Sub.values', 'Method:app/Sub.java:Sub.values#0'],
    ['Sub.mapForEach', 'Method:app/Sub.java:Sub.mapForEach#0'],
    ['Sub.array', 'Method:app/Sub.java:Sub.array#0'],
  ])('%s takes the element of the field Base declares', (_label, caller) => {
    expect(saveTargets(result(), caller)).toEqual([OTHER]);
  });
});

describe('Java declared types: which inherited field shadows an enclosing one', () => {
  const result = useFixture('java-r3-inherited-field-shadow', {
    ...OWNERS,
    'app/Outer.java': `package app;
import java.util.List;
class Generic<T> { List<T> items; }
class Hidden { private List<Other> items; }
interface Consts { List<Other> items = null; }
class Outer {
  List<User> items;
  class External extends java.util.ArrayList<String> {
    void run() { items.forEach(v -> v.save()); }
  }
  class Untyped extends Generic<Other> {
    void run() { items.forEach(v -> v.save()); }
  }
  class Private extends Hidden {
    void run() { items.forEach(v -> v.save()); }
  }
  class Constant implements Consts {
    void run() { items.forEach(v -> v.save()); }
  }
  interface Own {
    List<Other> items = null;
    default void run() { items.forEach(v -> v.save()); }
  }
}`,
  });

  it.each<[string, string, string[]]>([
    // A supertype outside the workspace may declare any field.
    ['External.run', 'Method:app/Outer.java:External.run#0', []],
    // Generic declares the field, but its element is a type parameter.
    ['Untyped.run', 'Method:app/Outer.java:Untyped.run#0', []],
    // A private field is not inherited (JLS 8.3): Outer.items applies.
    ['Private.run', 'Method:app/Outer.java:Private.run#0', [USER]],
    // An interface constant is inherited.
    ['Constant.run', 'Method:app/Outer.java:Constant.run#0', [OTHER]],
    // A type's own constant hides the enclosing field.
    ['Own.run', 'Method:app/Outer.java:Own.run#0', [OTHER]],
  ])('%s resolves the field Java member lookup selects', (_label, caller, expected) => {
    expect(saveTargets(result(), caller)).toEqual(expected);
  });
});
