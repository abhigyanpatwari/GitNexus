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
const LIB_ITEM = 'Method:lib/Item.java:Item.save#0';

function saveTargets(result: PipelineResult, caller: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.rel.sourceId === caller && edge.target === 'save')
    .map((edge) => edge.rel.targetId)
    .sort();
}

// `var xs = producer(); for (var x : xs)`: the loop variable is typed only from
// the exactly selected producer's own declared JDK container return type, read
// where that return type was written.
describe('Java var loops over a selected method result', () => {
  const result = useFixture('java-followup-call-result-elements', {
    ...OWNERS,
    'lib/Item.java': 'package lib; public class Item { public void save() {} }',
    'other/Item.java': 'package other; public class Item { public void save() {} }',
    'app/Repo.java': `package app;
import java.util.List;
import java.util.Map;
public class Repo {
  public List<User> findAll() { return null; }
  public Map<String, User> byId() { return null; }
  public Map<User, Other> byUser() { return null; }
}`,
    'app/Catalog.java': `package app;
import java.util.List;
import lib.Item;
public class Catalog { public List<Item> items() { return null; } }`,
    'app/Generic.java': `package app;
import java.util.List;
public class Generic {
  public <User> List<User> shadowed() { return null; }
  public <T> List<T> generic() { return null; }
}`,
    'app/Overloads.java': `package app;
import java.util.List;
public class Overloads {
  public List<User> load(String key) { return null; }
  public List<Other> load(Integer key) { return null; }
}`,
    'app/Svc.java': `package app;
import java.util.List;
import other.Item;
public class Svc {
  private Repo repo;
  private Catalog catalog;
  private Generic generic;
  private Overloads overloads;
  List<User> all() { return null; }
  void sameClass() { var xs = all(); for (var x : xs) x.save(); }
  void crossFile() { var xs = repo.findAll(); for (var x : xs) x.save(); }
  void mapValues() { var m = repo.byId(); for (var u : m.values()) u.save(); }
  void mapKeys() { var m = repo.byUser(); for (var k : m.keySet()) k.save(); }
  void copied() { var xs = repo.findAll(); var ys = xs; for (var y : ys) y.save(); }
  void producerImport() { var xs = catalog.items(); for (var x : xs) x.save(); }
  void typeParameter() { var xs = generic.shadowed(); for (var x : xs) x.save(); }
  void methodTypeVariable() { var xs = generic.<User>generic(); for (var x : xs) x.save(); }
  void exactOverload() { var xs = overloads.load("a"); for (var x : xs) x.save(); }
  void unknownOverload(external.Key key) {
    var xs = overloads.load(key.value());
    for (var x : xs) x.save();
  }
}`,
    // A same-package type shadows a type-import-on-demand (JLS 6.4.1, 7.5.2).
    'shadow/List.java': 'package shadow; public class List<T> {}',
    'shadow/Repo.java': `package shadow;
import java.util.*;
import app.User;
public class Repo { public List<User> findAll() { return null; } }`,
    'shadow/Svc.java': `package shadow;
public class Svc {
  private Repo repo;
  void run() { var xs = repo.findAll(); for (var x : xs) x.save(); }
}`,
  });

  it.each<[string, string, string[]]>([
    ['same-class producer', 'Method:app/Svc.java:Svc.sameClass#0', [USER]],
    ['cross-file producer', 'Method:app/Svc.java:Svc.crossFile#0', [USER]],
    ['Map values()', 'Method:app/Svc.java:Svc.mapValues#0', [USER]],
    ['Map keySet()', 'Method:app/Svc.java:Svc.mapKeys#0', [USER]],
    ['a copied result', 'Method:app/Svc.java:Svc.copied#0', [USER]],
    ['the exactly selected overload', 'Method:app/Svc.java:Svc.exactOverload#0', [USER]],
  ])('%s types the loop variable from the declared return', (_label, caller, expected) => {
    expect(saveTargets(result(), caller)).toEqual(expected);
  });

  it("reads the element in the producer's import environment, not the caller's", () => {
    expect(saveTargets(result(), 'Method:app/Svc.java:Svc.producerImport#0')).toEqual([LIB_ITEM]);
  });

  it.each<[string, string]>([
    ['a same-package List over java.util.*', 'Method:shadow/Svc.java:Svc.run#0'],
    ['a method type parameter named User', 'Method:app/Svc.java:Svc.typeParameter#0'],
    ['a method type variable element', 'Method:app/Svc.java:Svc.methodTypeVariable#0'],
    ['overloads that cannot be selected', 'Method:app/Svc.java:Svc.unknownOverload#1'],
  ])('%s leaves the loop variable unbound', (_label, caller) => {
    expect(saveTargets(result(), caller)).toEqual([]);
  });

  it('keeps the selected overloads and producers as call targets', () => {
    const targets = getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === 'Method:app/Svc.java:Svc.exactOverload#0')
      .map((edge) => edge.rel.targetId)
      .sort();
    expect(targets).toEqual(['Method:app/Overloads.java:Overloads.load#1~String', USER]);
    expect(saveTargets(result(), 'Method:app/Svc.java:Svc.crossFile#0')).not.toContain(OTHER);
  });
});
