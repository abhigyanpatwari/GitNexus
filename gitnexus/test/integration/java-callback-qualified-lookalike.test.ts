import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './resolvers/helpers.js';

describe('Java callback container identity with a shadowed package root', () => {
  const result = useFixture('java-callback-qualified-lookalike', {
    'p/User.java': 'package p; public class User { public void save() {} }',
    'p/Other.java': `package p; import java.util.function.Consumer;
public class Other { public void save() {} public void forEach(Consumer<Other> callback) {} }`,
    'p/java.java': `package p;
import java.util.function.Consumer;
import java.util.function.BiConsumer;
import java.util.Iterator;
import java.util.Collection;
import java.util.Collections;
public class java {
  public static class util {
    public static class List<T> implements Iterable<Other> {
      public void forEach(Consumer<? super Other> callback) {}
      public Iterator<Other> iterator() { return Collections.emptyIterator(); }
    }
    public static class Map<K,V> {
      public Collection<Other> values() { return Collections.emptyList(); }
      public void forEach(BiConsumer<Other,Other> callback) {}
    }
  }
}`,
    'p/App.java': `package p; import java.util.List;
public class App {
  void run(java.util.List<User> values) { values.forEach(value -> value.save()); }
  void alias(java.util.List<User> values) { values.forEach(value -> { var copy = value; copy.save(); }); }
  void nested(java.util.List<List<User>> values) { values.forEach(value -> value.forEach(inner -> inner.save())); }
  void iterate(java.util.List<User> values) { for (var value : values) value.save(); }
  void mapValues(java.util.Map<String,User> values) { for (var value : values.values()) value.save(); }
  void mapCallback(java.util.Map<String,User> values) { values.forEach((key, value) -> value.save()); }
  void imported(List<User> values) { values.forEach(value -> value.save()); }
}`,
    'ok/User.java': 'package ok; public class User { public void save() {} }',
    'ok/App.java': `package ok; public class App {
  void run(java.util.List<User> values) { values.forEach(value -> value.save()); }
}`,
  });

  it.each(['run', 'alias', 'nested', 'iterate', 'mapValues', 'mapCallback'])(
    'does not infer a JDK element from a shadowed package root in %s',
    (caller) => {
      const targets = getRelationships(result(), 'CALLS')
        .filter(
          (edge) =>
            edge.rel.sourceId === `Method:p/App.java:App.${caller}#1` && edge.target === 'save',
        )
        .map((edge) => edge.rel.targetId);
      expect(targets).not.toContain('Method:p/User.java:User.save#0');
    },
  );

  it.each([
    ['p/App.java', 'App.imported#1', 'p/User.java'],
    ['ok/App.java', 'App.run#1', 'ok/User.java'],
  ])('retains proven JDK inference for %s:%s', (file, caller, targetFile) => {
    const targets = getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === `Method:${file}:${caller}` && edge.target === 'save')
      .map((edge) => edge.rel.targetId);
    expect(targets).toEqual([`Method:${targetFile}:User.save#0`]);
  });
});
