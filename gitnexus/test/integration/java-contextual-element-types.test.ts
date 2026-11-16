import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';

it('infers element receivers only at proven JDK callbacks and iteration operations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-contextual-elements-'));
  try {
    writeFixtureRepo(root, {
      'Main.java': `import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
class User { void save() {} void audit() {} }
class Key { void save() {} }
class App {
  User x;
  void list(List<User> users) { users.forEach(x -> x.save()); }
  void stream(Stream<User> users) { users.forEachOrdered(x -> x.save()); }
  void map(Map<Key, User> users) { users.forEach((key, value) -> { key.save(); value.save(); }); }
  void array(User[] users) { for (var user : users) { user.save(); } }
  void iterable(List<User> users) { for (var user : users) user.save(); }
  void mapValues(Map<Key, User> users) { for (var user : users.values()) user.save(); }
  void mapKeys(Map<Key, User> users) { for (var key : users.keySet()) key.save(); }
  void typedLoop(List<Key> users) { for (Key x : users) x.save(); x.audit(); }
  void raw(List users) { users.forEach(x -> x.save()); }
  void wildcard(List<? extends User> users) { users.forEach(x -> x.save()); }
  <T> void generic(List<T> users) { users.forEach(x -> x.save()); }
  void changing(Stream<User> users) { users.map(x -> x).forEach(x -> x.save()); }
  void unrelated(List<User> users) { users.arbitrary(x -> x.save()); }
  void containerAlias(List<User> users) { var copy = users; copy.save(); }
}
`,
      'Lookalike.java': `class List<T> { void forEach(Object callback) {} }
class Map<K,V> { Object values() { return null; } }
class FakeUser { void save() {} }
class Lookalike {
  FakeUser x;
  void custom(List<FakeUser> users) { users.forEach(x -> x.save()); }
  void customMap(Map<String,FakeUser> users) { for (var x : users.values()) x.save(); }
}
`,
    });
    const result = await runPipelineFromRepo(root, () => {}, {});
    const targets = (owner: string, caller: string, member: string, file = 'Main.java') =>
      getRelationships(result, 'CALLS')
        .filter(
          (edge) =>
            edge.rel.sourceId === `Method:${file}:${owner}.${caller}#1` && edge.target === member,
        )
        .map((edge) => edge.rel.targetId)
        .sort();
    for (const caller of ['list', 'stream', 'array', 'iterable', 'mapValues']) {
      expect(targets('App', caller, 'save')).toEqual(['Method:Main.java:User.save#0']);
    }
    expect(targets('App', 'typedLoop', 'save')).toEqual(['Method:Main.java:Key.save#0']);
    expect(targets('App', 'mapKeys', 'save')).toEqual(['Method:Main.java:Key.save#0']);
    expect(targets('App', 'typedLoop', 'audit')).toEqual(['Method:Main.java:User.audit#0']);
    expect(targets('App', 'map', 'save')).toEqual([
      'Method:Main.java:Key.save#0',
      'Method:Main.java:User.save#0',
    ]);
    for (const caller of [
      'raw',
      'wildcard',
      'generic',
      'changing',
      'unrelated',
      'containerAlias',
    ]) {
      expect(targets('App', caller, 'save')).toEqual([]);
    }
    expect(targets('Lookalike', 'custom', 'save', 'Lookalike.java')).toEqual([]);
    expect(targets('Lookalike', 'customMap', 'save', 'Lookalike.java')).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
