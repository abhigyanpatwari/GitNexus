/** Deterministic Java-local P1–P4 corpus. Expected graph identities come from
 * these source declarations, never from an analyzer or a recorded graph. */
export const SHAPES = Object.freeze({
  small: Object.freeze({ units: 8, fieldsPerUnit: 8 }),
  large: Object.freeze({ units: 32, fieldsPerUnit: 8 }),
  dense: Object.freeze({ units: 32, fieldsPerUnit: 64 }),
});

// Variadic methods have indeterminate arity and use the unsuffixed graph ID.
const method = (file, owner, member, arity = 0) =>
  `Method:${file}:${owner}.${member}${arity === null ? '' : `#${arity}`}`;
const type = (file, owner) => `Class:${file}:${owner}`;

export function createJavaIngestionCorpus({ shape = 'small', units } = {}) {
  const dimensions = SHAPES[shape];
  if (dimensions === undefined) throw new Error(`Unknown Java corpus shape: ${shape}`);
  const count = units ?? dimensions.units;
  if (!Number.isInteger(count) || count < 1 || count > 256)
    throw new Error('Java corpus units must be an integer from 1 through 256');
  const fieldsPerUnit = dimensions.fieldsPerUnit;
  const densityClassesPerUnit = fieldsPerUnit / 8;
  const files = {
    'models/Entity.java': 'package models; public class Entity { public void save() {} }',
    'other/Entity.java': 'package other; public class Entity { public void save() {} }',
    'shadow/ShadowItem.java': 'package shadow; public class ShadowItem { public void save() {} }',
    'shadow/ShadowOther.java': 'package shadow; public class ShadowOther { public void save() {} }',
    'shadow/ShadowCallback.java':
      'package shadow; public interface ShadowCallback<T> { void accept(T value); }',
    // A type obscures a package (JLS 6.4.2): in package `shadow`, the root of
    // `java.util.List` is the class `shadow.java`, so each lambda below takes
    // its `forEach`'s functional interface parameter type, never a JDK
    // element. The import names the JDK `Consumer` from the package root.
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
  };
  const expectations = [
    {
      id: 'shared/java-root-shadow',
      feature: 'P3/P4 package-root identity',
      sourceId: method('shadow/ShadowProbe.java', 'ShadowProbe', 'raw', 1),
      relation: 'CALLS',
      members: ['save'],
      targetIds: [method('shadow/ShadowOther.java', 'ShadowOther', 'save')],
      forbiddenTargetIds: [method('shadow/ShadowItem.java', 'ShadowItem', 'save')],
    },
    {
      id: 'shared/java-root-shadow-callback',
      feature: 'P3/P4 package-root identity',
      sourceId: method('shadow/ShadowProbe.java', 'ShadowProbe', 'callback', 1),
      relation: 'CALLS',
      members: ['save'],
      targetIds: [method('shadow/ShadowOther.java', 'ShadowOther', 'save')],
      forbiddenTargetIds: [method('shadow/ShadowItem.java', 'ShadowItem', 'save')],
    },
  ];

  // Shared adversarial controls stay constant while the independent units grow.
  Object.assign(files, {
    'custom-value/Value.java': 'package customvalue; public @interface Value {}',
    'custom-value/ShadowDependency.java': `package customvalue;
@org.springframework.stereotype.Repository public class ShadowDependency {}`,
    'custom-value/Consumer.java': `package customvalue; import lombok.*;
@org.springframework.stereotype.Service @Value class Consumer { ShadowDependency dependency; }`,
    'custom-value/NamedConsumer.java': `package customvalue; import lombok.Value;
@org.springframework.stereotype.Service @Value class NamedConsumer { ShadowDependency dependency; }`,
    'custom-value/Probe.java': `package customvalue; class Probe {
  void custom(Consumer value) { value.getDependency(); } // invalid absent getter control
  void named(NamedConsumer value) { value.getDependency(); }
}`,
    'type-prefix/lombok.java':
      'package typeprefix; public class lombok { public @interface Value {} }',
    'type-prefix/PrefixDependency.java': `package typeprefix;
@org.springframework.stereotype.Repository public class PrefixDependency {}`,
    'type-prefix/Consumer.java': `package typeprefix;
@org.springframework.stereotype.Service @lombok.Value class Consumer { PrefixDependency dependency; }`,
    'type-prefix/Probe.java': `package typeprefix; class Probe {
  void custom(Consumer value) { value.getDependency(); } // invalid absent getter control
}`,
    'context/a/User.java': 'package a; public class User { public void save() {} }',
    'context/Outer.java': `package genericcontext;
import java.util.List;
import a.User;
class Outer {
  List<User> users;
  void direct() { users.forEach(value -> value.save()); }
  class Inner {
    static class User { void save() {} }
    void callback() { users.forEach(value -> value.save()); }
    void loop() { for (var value : users) value.save(); }
  }
}`,
    'local-element/decoy/User.java': 'package decoy; public class User { public void save() {} }',
    'local-element/LocalElement.java': `package localelement;
import decoy.User;
class LocalElement {
  void callback() {
    class User { void save() {} }
    java.util.List<User> users = null;
    users.forEach(value -> value.save());
  }
  void loop() {
    class User { void save() {} }
    java.util.List<User> users = null;
    for (var value : users) value.save();
  }
}`,
    'annotated/p/User.java': 'package p; public class User { public void save() {} }',
    'annotated/probe/Ann.java': `package annotatedprobe;
@java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE) public @interface Ann {}`,
    'annotated/probe/Probe.java': `package annotatedprobe; class Probe {
  void constructed() { var value = new p.@Ann User(); value.save(); }
}`,
  });
  const customDependency = type('custom-value/ShadowDependency.java', 'ShadowDependency');
  const prefixDependency = type('type-prefix/PrefixDependency.java', 'PrefixDependency');
  for (const [file, owner, dependency, positive, id] of [
    ['custom-value/Consumer.java', 'Consumer', customDependency, false, 'same-package-value'],
    [
      'custom-value/NamedConsumer.java',
      'NamedConsumer',
      customDependency,
      true,
      'named-value-import',
    ],
    ['type-prefix/Consumer.java', 'Consumer', prefixDependency, false, 'lombok-type-prefix'],
  ]) {
    const probe = file.replace(/[^/]+$/, 'Probe.java');
    const member = positive ? 'named' : 'custom';
    const getter = method(file, owner, 'getDependency');
    expectations.push(
      {
        id: `shared/${id}/getter`,
        feature: 'P4 Lombok annotation identity',
        sourceId: method(probe, 'Probe', member, 1),
        relation: 'CALLS',
        members: ['getDependency'],
        targetIds: positive ? [getter] : [],
        forbiddenTargetIds: positive ? [] : [getter],
        ...(positive ? {} : { invalidJava: true }),
      },
      {
        id: `shared/${id}/di`,
        feature: 'P4 Lombok annotation identity',
        sourceId: type(file, owner),
        relation: 'INJECTS',
        targetIds: positive ? [dependency] : [],
        forbiddenTargetIds: positive ? [] : [dependency],
      },
    );
  }
  const contextualUser = method('context/a/User.java', 'User', 'save');
  for (const owner of ['Outer.direct', 'Inner.callback', 'Inner.loop']) {
    const dot = owner.lastIndexOf('.');
    expectations.push({
      id: `shared/declaration-context/${owner}`,
      feature: 'P3/P4 generic argument declaration context',
      sourceId: method('context/Outer.java', owner.slice(0, dot), owner.slice(dot + 1)),
      relation: 'CALLS',
      members: ['save'],
      targetIds: [contextualUser],
      forbiddenTargetIds: [method('context/Outer.java', 'User', 'save')],
    });
  }
  expectations.push({
    id: 'shared/annotated-construction',
    feature: 'P3 annotated qualified constructor',
    sourceId: method('annotated/probe/Probe.java', 'Probe', 'constructed'),
    relation: 'CALLS',
    members: ['save'],
    targetIds: [method('annotated/p/User.java', 'User', 'save')],
    forbiddenTargetIds: [contextualUser, method('context/Outer.java', 'User', 'save')],
  });
  // A block-local class named in the element type wins over the import
  // (JLS 6.3); each method declares its own local `User` (javac numbering).
  for (const [caller, localUser] of [
    ['callback', 'LocalElement$1User'],
    ['loop', 'LocalElement$2User'],
  ]) {
    expectations.push({
      id: `shared/local-element-proof/${caller}`,
      feature: 'P4 local element identity',
      sourceId: method('local-element/LocalElement.java', 'LocalElement', caller),
      relation: 'CALLS',
      members: ['save'],
      targetIds: [method('local-element/LocalElement.java', localUser, 'save')],
      forbiddenTargetIds: [method('local-element/decoy/User.java', 'User', 'save')],
    });
  }

  for (let index = 0; index < count; index++) {
    const key = `u${String(index).padStart(3, '0')}`;
    const file = `units/${key}/Main.java`;
    const densityFields = Array.from(
      { length: 8 },
      (_, n) => `  @lombok.NonNull String field${n};`,
    ).join('\n');
    const densityClasses = Array.from({ length: densityClassesPerUnit - 1 }, (_, n) => {
      const group = n + 1;
      const fields = Array.from(
        { length: 8 },
        (_, field) => `  @lombok.NonNull Dependency field${group * 8 + field};`,
      ).join('\n');
      return `@org.springframework.stereotype.Service @lombok.Data class DensityValue${group}_${key} {\n${fields}\n}`;
    }).join('\n');
    const densityCalls = Array.from(
      { length: densityClassesPerUnit - 1 },
      (_, n) =>
        `  void densityValue${n + 1}(DensityValue${n + 1}_${key} value) { value.getField${(n + 2) * 8 - 1}(); }`,
    ).join('\n');
    files[file] = `package bench.${key};
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import other.Entity;
interface ItemCallback { void accept(Item value); }
interface OtherCallback { void accept(Other value); }
class Item {
  void save() {} void audit() {} void during() {} void caught() {} void finalized() {} void after() {}
  public Item clone() { return this; } public String toString() { return "item"; }
}
class Other {
  void save() {} void audit() {} void during() {} void caught() {} void finalized() {} void after() {}
}
class Address { void save() {} }
class Customer { Address address; Other address() { return new Other(); } }
class Holder { Customer customer; }
class Factory { Item make() { return new Item(); } }
class OtherFactory { Other make() { return new Other(); } }
class Harness {
  Item field; Item x; Item[] arrayField;
  void accept(ItemCallback callback) {}
  void acceptOther(OtherCallback callback) {}
  void acceptExternal(missing.Callback callback) {}
  Item[] arrayResult() { return arrayField; }
  Item trailingResult()[] { return arrayField; }
  Item[] needsArgument(int ignored) { return arrayField; }
  void array(Item[] values) { values[0].save(); }
  void trailing(Item values[]) { values[0].save(); }
  void varargs(Item... values) { values[0].save(); }
  void mixed() { Item scalar = null, values[] = null; values[0].save(); }
  void mixedDimensions() { Item[] first = null, second[] = null; first[0].save(); }
  void fieldElement() { this.arrayField[0].save(); }
  void returned() { arrayResult()[0].save(); }
  void trailingReturned() { trailingResult()[0].save(); }
  // Deliberately invalid negatives: arrays/collections are not their elements.
  void wholeArray(Item[] values) { values.save(); }
  void partialArray(Item[][] values) { values[0].save(); }
  void mixedPartial() { Item[] first = null, second[] = null; second[0].save(); }
  void listIndex(List<Item> values) { values[0].save(); }
  void inapplicableProducer() { needsArgument()[0].save(); }
  void cloneArray(Item[] values) { values.clone(); }
  void stringifyArray(Item[] values) { values.toString(); }
  void parameterAlias(Item value) { var copy = value; copy.save(); }
  void fieldAlias() { var copy = this.field; copy.save(); }
  void fullFieldAlias(Holder holder) { var copy = holder.customer.address; copy.save(); }
  void factoryAlias(Factory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void competingFactory(OtherFactory factory) { var value = factory.make(); var copy = value; copy.save(); }
  void beforeLocal() { var copy = field; Other field = new Other(); copy.save(); }
  void unknownAlias(Object value) { var copy = value; copy.save(); } // invalid member negative
  void blockShadow() { { Other field = new Other(); field.save(); } field.audit(); }
  void qualified(models.Entity value) { value.save(); }
  void qualifiedMissing(missing.Entity value) { value.save(); } // absent external type negative
  void resources() {
    try (Resource field = new Resource(); var next = field.next()) { next.during(); }
    catch (Exception e) { field.caught(); }
    finally { field.finalized(); }
    field.after();
  }
  void typedLambda() { acceptOther((Other x) -> x.save()); }
  void unknownLambda() { accept(x -> x.audit()); }
  void externalLambda() { acceptExternal(x -> x.audit()); } // absent external type negative
  void siblingLambda() { accept((Item x) -> x.audit()); acceptOther((Other x) -> x.save()); }
  void own() {}
  void lexicalThis() { accept(x -> this.own()); }
  void nestedLambda() { accept((Item outer) -> { accept(x -> x.audit()); outer.save(); }); }
  void callback(List<Item> values) { values.forEach(x -> x.save()); }
  void streamCallback(Stream<Item> values) { values.forEachOrdered(x -> x.save()); }
  void mapCallback(Map<Other,Item> values) { values.forEach((key,value) -> { key.audit(); value.save(); }); }
  void iteration(Item[] values) { for (var value : values) value.save(); }
  void listIteration(List<Item> values) { for (var value : values) value.save(); }
  // Deliberately invalid negatives: raw/wildcard/SAM target types do not prove Item.
  void rawCallback(List values) { values.forEach(x -> x.save()); }
  void wildcardCallback(List<?> values) { values.forEach(x -> x.save()); }
  <T> void genericCallback(List<T> values) { values.forEach(x -> x.save()); }
  void values(ValueModel value) { value.getLabel(); value.isActive(); value.getBoxed(); value.getField7(); }
  void valueNegative(ValueModel value) { value.getHidden(); value.setLabel("x"); } // absent generated methods
${densityCalls}
}
class Resource implements java.lang.AutoCloseable {
  public void close() {} Resource next() { return new Resource(); } void during() {}
}
@lombok.Value class ValueModel {
  String label; boolean active; Boolean boxed;
  @lombok.Getter(lombok.AccessLevel.NONE) String hidden;
${densityFields}
}
@lombok.Value class ValueDecoy { String label; boolean active; Boolean boxed; }
@org.springframework.stereotype.Repository class Dependency {}
@org.springframework.stereotype.Repository class OtherDependency {}
@org.springframework.stereotype.Service @lombok.RequiredArgsConstructor class RequiredConsumer {
  final Dependency safe;
  @org.springframework.beans.factory.annotation.Qualifier("otherDependency") final OtherDependency uncertain;
}
@org.springframework.stereotype.Service @lombok.AllArgsConstructor class AllConsumer {
  Dependency dependency; final OtherDependency initialized = null;
  static OtherDependency shared; OtherDependency $skip;
}
@org.springframework.stereotype.Service @lombok.Data class DataConsumer { final Dependency dependency; }
@org.springframework.stereotype.Service @lombok.Value class ValueConsumer { Dependency dependency; }
@org.springframework.stereotype.Service @lombok.RequiredArgsConstructor class AmbiguousConsumer {
  final Dependency dependency;
  AmbiguousConsumer(OtherDependency other) { dependency = null; }
}
@org.springframework.stereotype.Service @lombok.RequiredArgsConstructor(staticName="of")
class ConfiguredConsumer { final Dependency dependency; }
@org.springframework.stereotype.Service @lombok.RequiredArgsConstructor class PropertyConsumer {
  final Dependency safe;
  @org.springframework.beans.factory.annotation.Value("fixed") final OtherDependency property;
}
@interface AllArgsConstructor {}
@org.springframework.stereotype.Service @AllArgsConstructor class UnprovenConsumer { Dependency dependency; }
${densityClasses}
`;
    // Spring's implicit bean names and written dependency types stay unique
    // across units; scaling must not create a different ambiguous application.
    files[file] = files[file].replace(
      /\b(?:Dependency|OtherDependency|RequiredConsumer|AllConsumer|DataConsumer|ValueConsumer|AmbiguousConsumer|ConfiguredConsumer|PropertyConsumer|UnprovenConsumer)\b/g,
      (name) => `${name}_${key}`,
    );
    const m = (owner, member = 'save', arity = 0) => method(file, owner, member, arity);
    const call = (caller, arity, members, targets, feature, invalidJava = false) =>
      expectations.push({
        id: `${key}/${caller}`,
        feature,
        sourceId: m('Harness', caller, arity),
        relation: 'CALLS',
        members,
        targetIds: [...targets].sort(),
        forbiddenTargetIds: [m('Item'), m('Other'), m('Address')].filter(
          (id) => !targets.includes(id),
        ),
        ...(invalidJava ? { invalidJava: true } : {}),
      });
    for (const [caller, arity] of [
      ['array', 1],
      ['trailing', 1],
      ['varargs', null],
      ['mixed', 0],
      ['mixedDimensions', 0],
      ['fieldElement', 0],
      ['returned', 0],
      ['trailingReturned', 0],
    ])
      call(caller, arity, ['save'], [m('Item')], 'P1 array element identity');
    for (const [caller, arity] of [
      ['wholeArray', 1],
      ['partialArray', 1],
      ['mixedPartial', 0],
      ['listIndex', 1],
      ['inapplicableProducer', 0],
    ])
      call(caller, arity, ['save'], [], 'P1 array negative', true);
    call('cloneArray', 1, ['clone'], [], 'P1 array Object members');
    expectations.at(-1).forbiddenTargetIds.push(m('Item', 'clone'));
    call('stringifyArray', 1, ['toString'], [], 'P1 array Object members');
    expectations.at(-1).forbiddenTargetIds.push(m('Item', 'toString'));
    for (const [caller, arity] of [
      ['parameterAlias', 1],
      ['fieldAlias', 0],
      ['factoryAlias', 1],
      ['beforeLocal', 0],
    ])
      call(caller, arity, ['save'], [m('Item')], 'P2 lexical aliases');
    call('fullFieldAlias', 1, ['save'], [m('Address')], 'P2 complete field receiver');
    call('competingFactory', 1, ['save'], [m('Other')], 'P2 producer identity');
    call('unknownAlias', 1, ['save'], [], 'P2 unknown alias barrier', true);
    call(
      'blockShadow',
      0,
      ['save', 'audit'],
      [m('Other'), m('Item', 'audit')],
      'P2 block ownership',
    );
    call(
      'qualified',
      1,
      ['save'],
      [method('models/Entity.java', 'Entity', 'save')],
      'P3 FQN collision',
    );
    expectations.at(-1).forbiddenTargetIds.push(method('other/Entity.java', 'Entity', 'save'));
    call('qualifiedMissing', 1, ['save'], [], 'P3 FQN miss', true);
    expectations.at(-1).forbiddenTargetIds.push(method('other/Entity.java', 'Entity', 'save'));
    call(
      'resources',
      0,
      ['during', 'caught', 'finalized', 'after'],
      [m('Resource', 'during'), m('Item', 'caught'), m('Item', 'finalized'), m('Item', 'after')],
      'P3 resource lifetime',
    );
    call('typedLambda', 0, ['save'], [m('Other')], 'P4 typed lambda owner');
    // JLS 15.27.3: `x` takes ItemCallback.accept's parameter type, Item.
    call('unknownLambda', 0, ['audit'], [m('Item', 'audit')], 'P4 workspace SAM lambda');
    expectations.at(-1).forbiddenTargetIds.push(m('Other', 'audit'));
    call('externalLambda', 0, ['audit'], [], 'P4 unknown lambda shadow barrier', true);
    expectations.at(-1).forbiddenTargetIds.push(m('Item', 'audit'), m('Other', 'audit'));
    call(
      'siblingLambda',
      0,
      ['audit', 'save'],
      [m('Item', 'audit'), m('Other')],
      'P4 sibling lambda owners',
    );
    call('lexicalThis', 0, ['own'], [m('Harness', 'own')], 'P4 lexical this');
    call(
      'nestedLambda',
      0,
      ['save', 'audit'],
      [m('Item'), m('Item', 'audit')],
      'P4 nested lambda names',
    );
    expectations.at(-1).forbiddenTargetIds.push(m('Other', 'audit'));
    for (const caller of ['callback', 'streamCallback', 'iteration', 'listIteration'])
      call(caller, 1, ['save'], [m('Item')], 'P4 contextual JDK elements');
    call(
      'mapCallback',
      1,
      ['audit', 'save'],
      [m('Other', 'audit'), m('Item')],
      'P4 proven map parameters',
    );
    for (const caller of ['rawCallback', 'wildcardCallback', 'genericCallback'])
      call(caller, 1, ['save'], [], 'P4 unproven generic elements', true);
    const accessors = ['getLabel', 'isActive', 'getBoxed', 'getField7'];
    call(
      'values',
      1,
      accessors,
      accessors.map((name) => m('ValueModel', name)),
      'P4 Lombok Value getters',
    );
    call('valueNegative', 1, ['getHidden', 'setLabel'], [], 'P4 Lombok suppressed accessors', true);
    for (const owner of [
      'RequiredConsumer',
      'AllConsumer',
      'DataConsumer',
      'ValueConsumer',
      'PropertyConsumer',
      'AmbiguousConsumer',
      'ConfiguredConsumer',
      'UnprovenConsumer',
    ]) {
      const selected = !['AmbiguousConsumer', 'ConfiguredConsumer', 'UnprovenConsumer'].includes(
        owner,
      );
      expectations.push({
        id: `${key}/${owner}`,
        feature: 'P4 generated constructor DI',
        sourceId: type(file, `${owner}_${key}`),
        relation: 'INJECTS',
        targetIds: selected ? [type(file, `Dependency_${key}`)] : [],
        forbiddenTargetIds: [type(file, `OtherDependency_${key}`)],
      });
    }
    for (let group = 1; group < densityClassesPerUnit; group++) {
      const owner = `DensityValue${group}_${key}`;
      const getter = `getField${(group + 1) * 8 - 1}`;
      call(`densityValue${group}`, 1, [getter], [m(owner, getter)], 'P4 dense Lombok getters');
      expectations.push({
        id: `${key}/${owner}`,
        feature: 'P4 dense NonNull constructor DI',
        sourceId: type(file, owner),
        relation: 'INJECTS',
        targetIds: [type(file, `Dependency_${key}`)],
        forbiddenTargetIds: [type(file, `OtherDependency_${key}`)],
      });
    }
  }
  const positiveCases = expectations.filter((entry) => entry.targetIds.length > 0).length;
  return {
    files,
    expectations,
    stats: {
      shape,
      units: count,
      files: Object.keys(files).length,
      sourceBytes: Object.values(files).reduce((sum, source) => sum + Buffer.byteLength(source), 0),
      expectations: expectations.length,
      positiveCases,
      negativeCases: expectations.length - positiveCases,
      densityFieldsPerUnit: fieldsPerUnit,
      densityClassesPerUnit,
      densityDeclarationCount: count * fieldsPerUnit,
      declaredFields: count * (25 + fieldsPerUnit) + 5,
      syntheticAccessorFields: count * (fieldsPerUnit + 8) + 1,
      syntheticAccessorMethods: count * (16 + 2 * (fieldsPerUnit - 8)) + 1,
      // Leaf emission has not yet seen the workspace's two annotation shadows:
      // Consumer.dependency in each shared custom-Value case is a candidate only.
      provisionalSyntheticAccessorMethods: count * (16 + 2 * (fieldsPerUnit - 8)) + 3,
    },
  };
}
