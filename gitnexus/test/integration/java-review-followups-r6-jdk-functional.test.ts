import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';

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

  const targets = (pkg: string, member: string): string[] =>
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
    expect(targets(pkg, member)).toEqual([target]);
  });

  it.each([
    ['a same-package Consumer over the on-demand import', 'shadowed', 'save'],
    ['the JDK Consumer over a same-package one', 'single', 'audit'],
    ['an imported workspace interface over a same-package one', 'chosen', 'audit'],
    ['an unknown imported interface over a same-package one', 'external', 'audit'],
    ['a wildcard type argument', 'wildcard', 'save'],
    ['a raw Consumer', 'raw', 'save'],
  ])('leaves the call unresolved through %s', (_shape, pkg, member) => {
    expect(targets(pkg, member)).toEqual([]);
  });
});
