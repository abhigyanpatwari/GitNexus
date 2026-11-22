// Implicitly typed lambda parameters typed from workspace and JDK functional interfaces (SAM targets).
import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

const targets = (edges: readonly RelEdge[], caller: string, member: string): string[] =>
  edges
    .filter((edge) => edge.rel.sourceId === caller && edge.target === member)
    .map((edge) => edge.rel.targetId)
    .sort();

describe('Java functional interfaces and the identity of Object.equals', () => {
  const result = useFixture('java-sam-object-identity', {
    'p/Object.java': 'package p; public class Object {}',
    'p/Item.java': 'package p; public class Item { public void save() {} }',
    'other/Other.java': 'package other; public class Other { public void save() {} }',
    'p/Imported.java': `package p;
import java.lang.Object;
interface Imported { boolean equals(Object x); void accept(Item it); }`,
    'p/Main.java': `package p;
interface Local { boolean equals(Object x); void accept(Item it); }
interface Canonical { boolean equals(java.lang.Object x); void accept(Item it); }
class Main {
  void local(Local cb) {} void canonical(Canonical cb) {} void imported(Imported cb) {}
  void rejected() { local(x -> x.save()); }
  void accepted() { canonical(x -> x.save()); }
  void explicitlyImported() { imported(x -> x.save()); }
}`,
  });

  it.each([
    ['rejected', []],
    ['accepted', ['Method:p/Item.java:Item.save#0']],
    ['explicitlyImported', ['Method:p/Item.java:Item.save#0']],
  ] as const)('resolves the parameter where equals was declared in %s', (name, expected) => {
    const caller = `Method:p/Main.java:Main.${name}#0`;
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'save')).toEqual(expected);
  });
});

// JLS 15.27.3 / 9.9: an implicitly typed lambda parameter takes the type of the
// matching parameter of its target's function type. The target is the
// parameter type of the method javac selects for the enclosing call.
describe('Java implicitly typed lambda parameters from a workspace functional interface', () => {
  const result = useFixture('java-r4-sam-lambda', {
    'cb/model/Item.java': `package cb.model;
public class Item { public void save() {} public void audit() {} }
`,
    'cb/ItemCallback.java': `package cb;
import cb.model.Item;
public interface ItemCallback { void accept(Item value); }
`,
    'app/Item.java': `package app;
public class Item { public void save() {} public void audit() {} }
`,
    'app/Main.java': `package app;
import cb.ItemCallback;
class Other { void save() {} void audit() {} }
interface OtherCallback { void accept(Other value); }
interface PairCallback { void accept(Item first, Other second); }
interface TwoMethods { void accept(Item value); void other(Item value); }
interface WithMembers {
  void accept(Item value);
  default void helper(Other value) {}
  static void util(Other value) {}
  boolean equals(Object other);
  String toString();
}
interface Base { void accept(Item value); }
interface Derived extends Base { default void more() {} }
interface External extends java.util.function.Consumer<Item> {}
interface Generic<T> { void accept(T value); }
class Typed {
  Other x;
  void accept(ItemCallback callback) {}
  void pair(PairCallback callback) {}
  void members(WithMembers callback) {}
  void derived(Derived callback) {}
  void generic(Generic<Item> callback) {}
  void bench() { accept(x -> x.audit()); }
  void groupedList(java.util.List<Item> values) { values.forEach(( /* item */ (x -> x.audit()))); }
  void pairs() { pair((x, second) -> { x.audit(); second.save(); }); }
  void localVar() { accept((var x) -> x.audit()); }
  void withMembers() { members(x -> x.audit()); }
  void inherited() { derived(x -> x.audit()); }
  void substituted() { generic(x -> x.audit()); }
  void nested() { accept(outer -> { accept(x -> x.audit()); outer.save(); }); }
  void fieldRead() { x.audit(); }
}
class Refused {
  Item x;
  void accept(ItemCallback callback) {}
  void two(TwoMethods callback) {}
  void external(External callback) {}
  void unknown(missing.Callback callback) {}
  void object(Object callback) {}
  void raw(Generic callback) {}
  void wildcard(Generic<? extends Item> callback) {}
  void nonFunctional() { two(x -> x.audit()); }
  void externalInterface() { external(x -> x.audit()); }
  void unknownType() { unknown(x -> x.audit()); }
  void objectTarget() { object(x -> x.audit()); }
  void arityMismatch() { accept((x, y) -> x.audit()); }
  void rawTarget() { raw(x -> x.audit()); }
  void wildcardTarget() { wildcard(x -> x.audit()); }
  void fieldRead() { x.audit(); }
}
class Overloads {
  Item x;
  void accept(ItemCallback callback) {}
  void accept(PairCallback callback) {}
  void accept(OtherCallback first, OtherCallback second) {}
  void bySamArity() { accept(x -> x.audit()); }
  void byGroupedSamArity() { accept(( /* callback */ (x -> x.audit()))); }
  void byCallArity() { accept(x -> x.audit(), y -> y.save()); }
  void groupedSecond() { accept(x -> x.audit(), /* second */ ((y -> y.save()))); }
}
class Receivers {
  void call(Overloads overloads) { overloads.accept(x -> x.audit()); }
}
class Ambiguous {
  Item x;
  void run(ItemCallback callback) {}
  void run(OtherCallback callback) {}
  void call() { run(x -> x.audit()); }
  void grouped() { run(((x -> x.audit()))); }
}
class StaticContext {
  Item x;
  void accept(ItemCallback callback) {}
  void accept(PairCallback callback) {}
  static void call() { accept(x -> x.audit()); }
}
`,
  });

  const workspaceItemAudit = 'Method:cb/model/Item.java:Item.audit#0';
  const localItemAudit = 'Method:app/Item.java:Item.audit#0';
  const otherAudit = 'Method:app/Main.java:Other.audit#0';

  it('types the bench shape from the interface, read in the interface file', () => {
    const edges = getRelationships(result(), 'CALLS');
    expect(targets(edges, 'Method:app/Main.java:Typed.bench#0', 'audit')).toEqual([
      workspaceItemAudit,
    ]);
  });

  it.each([
    ['Method:app/Main.java:Typed.localVar#0'],
    ['Method:app/Main.java:Typed.nested#0'],
    ['Method:app/Main.java:Overloads.bySamArity#0'],
    ['Method:app/Main.java:Overloads.byGroupedSamArity#0'],
    ['Method:app/Main.java:Receivers.call#1'],
  ])('binds the single abstract method parameter in %s', (caller) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'audit')).toEqual([
      workspaceItemAudit,
    ]);
  });

  it.each([
    ['Method:app/Main.java:Typed.withMembers#0'],
    ['Method:app/Main.java:Typed.inherited#0'],
    ['Method:app/Main.java:Typed.substituted#0'],
  ])('binds a same-package Item through %s', (caller) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'audit')).toEqual([localItemAudit]);
  });

  it('binds each parameter of a two-parameter function type', () => {
    const edges = getRelationships(result(), 'CALLS');
    const caller = 'Method:app/Main.java:Typed.pairs#0';
    expect(targets(edges, caller, 'audit')).toEqual([localItemAudit]);
    expect(targets(edges, caller, 'save')).toEqual(['Method:app/Main.java:Other.save#0']);
  });

  it('keeps an outer lambda parameter typed for its own body', () => {
    expect(
      targets(getRelationships(result(), 'CALLS'), 'Method:app/Main.java:Typed.nested#0', 'save'),
    ).toEqual(['Method:cb/model/Item.java:Item.save#0']);
  });

  it('selects the one overload whose functional interface matches the lambda arity', () => {
    const edges = getRelationships(result(), 'CALLS');
    expect(targets(edges, 'Method:app/Main.java:Overloads.bySamArity#0', 'accept')).toEqual([
      'Method:app/Main.java:Overloads.accept#1~ItemCallback',
    ]);
    expect(targets(edges, 'Method:app/Main.java:Overloads.byCallArity#0', 'accept')).toEqual([
      'Method:app/Main.java:Overloads.accept#2',
    ]);
    expect(targets(edges, 'Method:app/Main.java:Overloads.byCallArity#0', 'audit')).toEqual([
      otherAudit,
    ]);
    expect(targets(edges, 'Method:app/Main.java:Overloads.byCallArity#0', 'save')).toEqual([
      'Method:app/Main.java:Other.save#0',
    ]);
  });

  it('tracks a grouped lambda in its argument slot and on a JDK collection receiver', () => {
    const edges = getRelationships(result(), 'CALLS');
    expect(targets(edges, 'Method:app/Main.java:Overloads.groupedSecond#0', 'save')).toEqual([
      'Method:app/Main.java:Other.save#0',
    ]);
    expect(targets(edges, 'Method:app/Main.java:Typed.groupedList#1', 'audit')).toEqual([
      localItemAudit,
    ]);
  });

  it.each([
    ['Method:app/Main.java:Refused.nonFunctional#0'],
    ['Method:app/Main.java:Refused.externalInterface#0'],
    ['Method:app/Main.java:Refused.unknownType#0'],
    ['Method:app/Main.java:Refused.objectTarget#0'],
    ['Method:app/Main.java:Refused.arityMismatch#0'],
    ['Method:app/Main.java:Refused.rawTarget#0'],
    ['Method:app/Main.java:Refused.wildcardTarget#0'],
    ['Method:app/Main.java:Ambiguous.call#0'],
    ['Method:app/Main.java:Ambiguous.grouped#0'],
    ['Method:app/Main.java:StaticContext.call#0'],
  ])('leaves the parameter unbound, never the outer field, in %s', (caller) => {
    expect(result().graph.getNode(caller)).toBeDefined();
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'audit')).toEqual([]);
  });

  it.each([
    ['Method:app/Main.java:Typed.fieldRead#0', otherAudit],
    ['Method:app/Main.java:Refused.fieldRead#0', localItemAudit],
  ])('leaves the same-named field typed as declared in %s', (caller, target) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'audit')).toEqual([target]);
  });

  it.each([
    ['Method:app/Main.java:Ambiguous.call#0', 'run'],
    ['Method:app/Main.java:StaticContext.call#0', 'accept'],
  ])('does not select an overload for %s', (caller, member) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, member)).toEqual([]);
  });
});

// The functional interfaces live in another package than the method that
// takes them, and reach it only through `import cb.*;` (JLS 7.5.2), or through
// a qualified parameter type. The caller's field `x` has another type.
describe('Java SAM lambda targets reached through on-demand imports and qualified types', () => {
  const result = useFixture('java-r4-sam-on-demand', {
    'src/models/User.java': `package models;
public class User {
  public void save() {}
  public String getName() { return ""; }
}
`,
    'src/models/Other.java': `package models;
public class Other {
  public void save() {}
  public String getName() { return ""; }
}
`,
    'src/cb/Cb0.java': `package cb;
import models.User;
public interface Cb0 { void accept(User value); }
`,
    'src/cb/UserCb.java': `package cb;
import models.User;
public interface UserCb { void accept(User value); }
`,
    'src/cb/PairCb.java': `package cb;
import models.User;
import models.Other;
public interface PairCb { void accept(Other a, User b); }
`,
    'src/cb/QualifiedCb.java': `package cb;
public interface QualifiedCb { void accept(models.User value); }
`,
    'src/h/Harness.java': `package h;
import cb.*;
public class Harness {
  public void accept(UserCb cb) {}
  public void accept(PairCb cb) {}
  public void take0(Cb0 cb) {}
  public void qualified(cb.QualifiedCb callback) {}
}
`,
    'src/h/Caller.java': `package h;
public class Caller {
  models.Other x;
  void c0(Harness h) {
    h.take0(x -> x.save());
    h.accept(x -> x.getName());
    h.accept((a, b) -> a.save());
  }
  void take(Harness h) { h.take0(x -> x.save()); }
  void single(Harness h) { h.accept(x -> x.save()); }
  void pair(Harness h) { h.accept((a, b) -> a.getName()); }
  void qualified(Harness h) { h.qualified(x -> x.save()); }
}
`,
  });

  const caller = (name: string): string => `Method:src/h/Caller.java:Caller.${name}#1`;
  const userSave = 'Method:src/models/User.java:User.save#0';
  const otherSave = 'Method:src/models/Other.java:Other.save#0';

  it('resolves every call of the scaling shape exactly', () => {
    const edges = getRelationships(result(), 'CALLS')
      .filter((edge) => edge.rel.sourceId === caller('c0'))
      .map((edge) => edge.rel.targetId)
      .sort();
    expect(edges).toEqual([
      'Method:src/h/Harness.java:Harness.accept#1~PairCb',
      'Method:src/h/Harness.java:Harness.accept#1~UserCb',
      'Method:src/h/Harness.java:Harness.take0#1',
      otherSave,
      'Method:src/models/User.java:User.getName#0',
      userSave,
    ]);
  });

  it.each([['take'], ['single'], ['qualified']])(
    'types the lambda parameter from the interface, not the field, in %s',
    (name) => {
      expect(targets(getRelationships(result(), 'CALLS'), caller(name), 'save')).toEqual([
        userSave,
      ]);
    },
  );

  it('types each parameter of the selected two-parameter interface', () => {
    const edges = getRelationships(result(), 'CALLS');
    expect(targets(edges, caller('pair'), 'accept')).toEqual([
      'Method:src/h/Harness.java:Harness.accept#1~PairCb',
    ]);
    expect(targets(edges, caller('pair'), 'getName')).toEqual([
      'Method:src/models/Other.java:Other.getName#0',
    ]);
  });
});

describe('Java callback types with competing on-demand imports', () => {
  const result = useFixture('java-sam-split-package', {
    'model/User.java': 'package model; public class User { public void save() {} }',
    'own/Sink.java': 'package own; public interface Sink { void run(model.User value); }',
    // Dependencies can add Sink, Consumer or Object to this same package.
    'partial/Marker.java': 'package partial; public class Marker {}',
    'app/Workspace.java': `package app; import own.*; import partial.*;
class Workspace { void run(Sink cb) {} void call() { run(x -> x.save()); } }`,
    'app/Jdk.java': `package app; import java.util.function.*; import partial.*;
class Jdk { void run(Consumer<model.User> cb) {} void call() { run(x -> x.save()); } }`,
    'cb/Scoped.java': `package cb; import partial.*;
public interface Scoped { boolean equals(Object x); void run(model.User value); }`,
    'app/ObjectCase.java': `package app;
class ObjectCase { void run(cb.Scoped cb) {} void call() { run(x -> x.save()); } }`,
    'app/Explicit.java': `package app; import own.Sink; import partial.*;
class Explicit { void run(Sink cb) {} void call() { run(x -> x.save()); } }`,
  });

  it.each(['Workspace', 'Jdk', 'ObjectCase'])(
    'leaves the callback unresolved when %s depends on the contents of a split package',
    (owner) => {
      const caller = `Method:app/${owner}.java:${owner}.call#0`;
      expect(targets(getRelationships(result(), 'CALLS'), caller, 'save')).toEqual([]);
    },
  );

  it('keeps the explicitly imported callback when another package is imported on demand', () => {
    const caller = 'Method:app/Explicit.java:Explicit.call#0';
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'save')).toEqual([
      'Method:model/User.java:User.save#0',
    ]);
  });
});

/**
 * `Api.run(user -> user.save())` where the selected workspace method declares
 * its parameter as a JDK `java.util.function` interface. The lambda parameter
 * takes the type argument its single abstract method's parameter has, read in
 * the callee's declaration, once the written name is proven to denote the JDK
 * type there (JLS 6.4.1, 7.5, 15.27.3). A workspace type of that name that is
 * in scope wins; a wildcard or raw type argument types nothing.
 */
describe('Java lambdas passed to a JDK functional interface parameter', () => {
  const result = useFixture('java-r6-jdk-functional', {
    'model/User.java': `package model;
public class User { public void save() {} public String name() { return ""; } }`,
    'model/Other.java': 'package model; public class Other { public void audit() {} }',
    'imported/Api.java': `package imported;
import java.util.function.Consumer;
import model.User;
public class Api { public static void run(Consumer<User> callback) {} }`,
    'imported/Use.java':
      'package imported; class Use { void go() { Api.run(user -> user.save()); } }',
    'qualified/Api.java': `package qualified;
import model.User;
public class Api { public static void run(java.util.function.Consumer<User> callback) {} }`,
    'qualified/Use.java':
      'package qualified; class Use { void go() { Api.run(user -> user.save()); } }',
    'ondemand/Api.java': `package ondemand;
import java.util.function.*;
import model.User;
public class Api { public static void run(Consumer<User> callback) {} }`,
    'ondemand/Use.java':
      'package ondemand; class Use { void go() { Api.run(user -> user.save()); } }',
    'pair/Api.java': `package pair;
import java.util.function.BiConsumer;
import model.Other;
import model.User;
public class Api { public static void run(BiConsumer<User, Other> callback) {} }`,
    'pair/Use.java': `package pair;
class Use { void go() { Api.run((user, other) -> { user.save(); other.audit(); }); } }`,
    'mapping/Api.java': `package mapping;
import java.util.function.Function;
import model.User;
public class Api { public static void map(Function<User, String> mapper) {} }`,
    'mapping/Use.java':
      'package mapping; class Use { void go() { Api.map(user -> user.name()); } }',
    'primitive/Api.java': `package primitive;
import java.util.function.ObjIntConsumer;
import model.User;
public class Api { public static void run(ObjIntConsumer<User> callback) {} }`,
    'primitive/Use.java':
      'package primitive; class Use { void go() { Api.run((user, count) -> user.save()); } }',
    // A single-type import shadows a same-package type of that name.
    'single/Consumer.java': `package single;
import model.Other;
public interface Consumer<T> { void accept(Other value); }`,
    'single/Api.java': `package single;
import java.util.function.Consumer;
import model.User;
public class Api { public static void run(Consumer<User> callback) {} }`,
    'single/Use.java': `package single;
class Use { void go() { Api.run(value -> { value.save(); value.audit(); }); } }`,
    // A same-package type shadows a type-import-on-demand: the workspace
    // interface's own abstract method types the lambda.
    'shadowed/Consumer.java': `package shadowed;
import model.Other;
public interface Consumer<T> { void accept(Other value); }`,
    'shadowed/Api.java': `package shadowed;
import java.util.function.*;
import model.User;
public class Api { public static void run(Consumer<User> callback) {} }`,
    'shadowed/Use.java': `package shadowed;
class Use { void go() { Api.run(value -> { value.save(); value.audit(); }); } }`,
    // A single-type import of another interface shadows a same-package one
    // (JLS 6.4.1), so the same-package interface never types the lambda.
    'vendor/Callback.java': `package vendor;
import model.User;
public interface Callback<T> { void accept(User value); }`,
    'chosen/Callback.java': `package chosen;
import model.Other;
public interface Callback<T> { void accept(Other value); }`,
    'chosen/Api.java': `package chosen;
import vendor.Callback;
public class Api { public static void run(Callback<String> callback) {} }`,
    'chosen/Use.java': `package chosen;
class Use { void go() { Api.run(value -> { value.save(); value.audit(); }); } }`,
    'external/Callback.java': `package external;
import model.Other;
public interface Callback<T> { void accept(Other value); }`,
    'external/Api.java': `package external;
import com.vendor.Callback;
public class Api { public static void run(Callback<String> callback) {} }`,
    'external/Use.java':
      'package external; class Use { void go() { Api.run(value -> value.audit()); } }',
    'wildcard/Api.java': `package wildcard;
import java.util.function.Consumer;
import model.User;
public class Api { public static void run(Consumer<? extends User> callback) {} }`,
    'wildcard/Use.java':
      'package wildcard; class Use { void go() { Api.run(user -> user.save()); } }',
    'raw/Api.java': `package raw;
import java.util.function.Consumer;
public class Api { public static void run(Consumer callback) {} }`,
    'raw/Use.java': 'package raw; class Use { void go() { Api.run(user -> user.save()); } }',
  });

  const jdkUseTargets = (pkg: string, member: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter(
        (edge: RelEdge) =>
          edge.rel.sourceId === `Method:${pkg}/Use.java:Use.go#0` && edge.target === member,
      )
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    ['an imported Consumer', 'imported', 'save', 'Method:model/User.java:User.save#0'],
    ['a canonical Consumer', 'qualified', 'save', 'Method:model/User.java:User.save#0'],
    ['an on-demand Consumer', 'ondemand', 'save', 'Method:model/User.java:User.save#0'],
    ['the first BiConsumer argument', 'pair', 'save', 'Method:model/User.java:User.save#0'],
    ['the second BiConsumer argument', 'pair', 'audit', 'Method:model/Other.java:Other.audit#0'],
    ['a Function input', 'mapping', 'name', 'Method:model/User.java:User.name#0'],
    ['an ObjIntConsumer object', 'primitive', 'save', 'Method:model/User.java:User.save#0'],
    [
      'an import over a same-package Consumer',
      'single',
      'save',
      'Method:model/User.java:User.save#0',
    ],
    ['a same-package Consumer', 'shadowed', 'audit', 'Method:model/Other.java:Other.audit#0'],
  ])('types the lambda through %s', (_shape, pkg, member, target) => {
    expect(jdkUseTargets(pkg, member)).toEqual([target]);
  });

  it.each([
    ['a same-package Consumer over the on-demand import', 'shadowed', 'save'],
    ['the JDK Consumer over a same-package one', 'single', 'audit'],
    ['an imported workspace interface over a same-package one', 'chosen', 'audit'],
    ['an unknown imported interface over a same-package one', 'external', 'audit'],
    ['a wildcard type argument', 'wildcard', 'save'],
    ['a raw Consumer', 'raw', 'save'],
  ])('leaves the call unresolved through %s', (_shape, pkg, member) => {
    expect(jdkUseTargets(pkg, member)).toEqual([]);
  });
});

/**
 * `Api.run(x -> x.save())` where `run(Generic<Item> g)` is declared in package
 * `c`. The lambda parameter takes the type argument `Item` of the selected
 * callee's parameter type, read where that parameter type was written: in the
 * callee's declaration, never in the caller's file. A caller-side `Item`, from
 * the caller's own package or from its single-type import, is never the owner.
 */
describe('Java SAM lambda type arguments read in the callee declaration', () => {
  const result = useFixture('java-r6-sam-callee-scope', {
    'c/Item.java': 'package c; public class Item { public void save() {} }',
    'c/Generic.java': 'package c; public interface Generic<T> { void accept(T t); }',
    'c/Api.java': 'package c; public class Api { public static void run(Generic<Item> g) {} }',
    'd/Item.java': 'package d; public class Item { public void save() {} }',
    'd/Caller.java': `package d;
import c.Api;
class Caller { void go() { Api.run(x -> x.save()); } }`,
    'e/Item.java': 'package e; public class Item { public void save() {} }',
    'd/Importer.java': `package d;
import c.Api;
import e.Item;
class Importer { void go() { Api.run(x -> x.save()); } }`,
  });

  const calleeSaveTargets = (caller: string): string[] =>
    getRelationships(result(), 'CALLS')
      .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
      .map((edge) => edge.rel.targetId)
      .sort();

  it.each([
    ['a same-package Item', 'Method:d/Caller.java:Caller.go#0'],
    ['a single-type imported Item', 'Method:d/Importer.java:Importer.go#0'],
  ])('reads the callee Item, not the caller file %s', (_decoy, caller) => {
    expect(calleeSaveTargets(caller)).toEqual(['Method:c/Item.java:Item.save#0']);
  });
});

describe('Java lambdas typed by a qualified type argument of a JDK functional parameter', () => {
  const result = useFixture('java-sam-qualified-argument', {
    'app/User.java': 'package app; public class User { public void save() {} }',
    'app/Other.java': 'package app; public class Other { public void save() {} }',
    'lib/Box.java': `package lib;
public class Box<T> {
  public void forEach(java.util.function.Consumer<app.Other> c) {}
  public void each(java.util.function.Consumer<app.Missing> c) {}
}`,
    'app/Boxed.java': `package app;
import lib.Box;
class Boxed {
  Box<User> xs;
  void run() { xs.forEach(u -> u.save()); }
  void missing() { xs.each(u -> u.save()); }
}`,
  });

  it.each([
    [
      'a workspace type',
      'Method:app/Boxed.java:Boxed.run#0',
      ['Method:app/Other.java:Other.save#0'],
    ],
    ['a type no file declares', 'Method:app/Boxed.java:Boxed.missing#0', []],
  ])('types the lambda parameter from %s named app.X', (_label, caller, expected) => {
    expect(targets(getRelationships(result(), 'CALLS'), caller, 'save')).toEqual(expected);
  });
});
