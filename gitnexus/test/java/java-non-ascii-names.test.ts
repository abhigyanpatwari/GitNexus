// Java identifiers and written types with non-ASCII names: annotations, comments, overloads, lambdas and Lombok.
import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from '../integration/resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const callTargets = (result: PipelineResult, caller: string, name: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === name)
    .map((edge) => edge.rel.targetId)
    .sort();
const saveTargets = (result: PipelineResult, caller: string): string[] =>
  callTargets(result, caller, 'save');

/** `Café` spelled with a combining acute accent (U+0301), a Java identifier part. */
const CAFE = 'Cafe\u0301';
/** `Handlér` spelled with the same combining mark inside the name. */
const HANDLER = 'Handle\u0301r';

// Node indices are UTF-16 string offsets, so a type written after two- and
// four-byte UTF-8 characters keeps its exact spelling once its annotations
// and comments are removed. Each name also has a same-package top-level
// decoy that a dropped or shifted qualifier would reach instead.
describe('Java written types with non-ASCII names before annotations and comments', () => {
  const result = useFixture('java-r5-non-ascii-spelling', {
    'p/Ann.java': `package p;
import java.lang.annotation.ElementType;
import java.lang.annotation.Target;
@Target(ElementType.TYPE_USE)
public @interface Ann { String value() default ""; }`,
    'p/Model.java': `package p;
public class Model {}
class Äußer {
  static class Ünïcödé { void save() {} }
  static class 𝒳漢字 { void save() {} }
}`,
    'p/Decoy.java': `package p;
class Ünïcödé { void save() {} }
class 𝒳漢字 { void save() {} }`,
    'p/Use.java': `package p;
// ü 𝒳 漢字 shift every later byte offset away from its string offset
class Use {
  void annotated(Äußer.@Ann("ü") Ünïcödé value) { value.save(); }
  void blockComment(Äußer./* ü */ Ünïcödé value) { value.save(); }
  void lineComment(Äußer. // ü
      Ünïcödé value) { value.save(); }
  void commentThenAnnotation(Äußer./* 𝒳 */ @Ann("漢字") Ünïcödé value) { value.save(); }
  void supplementary(Äußer.@Ann 𝒳漢字 value) { value.save(); }
  Äußer.@Ann /* 𝒳 */ Ünïcödé field;
  void viaField() { field.save(); }
  void local() { Äußer./* 𝒳 */ @Ann 𝒳漢字 v = null; v.save(); }
}`,
  });

  it.each([
    ['Method:p/Use.java:Use.annotated#1', 'Method:p/Model.java:Ünïcödé.save#0'],
    ['Method:p/Use.java:Use.blockComment#1', 'Method:p/Model.java:Ünïcödé.save#0'],
    ['Method:p/Use.java:Use.lineComment#1', 'Method:p/Model.java:Ünïcödé.save#0'],
    ['Method:p/Use.java:Use.commentThenAnnotation#1', 'Method:p/Model.java:Ünïcödé.save#0'],
    ['Method:p/Use.java:Use.supplementary#1', 'Method:p/Model.java:𝒳漢字.save#0'],
    ['Method:p/Use.java:Use.viaField#0', 'Method:p/Model.java:Ünïcödé.save#0'],
    ['Method:p/Use.java:Use.local#0', 'Method:p/Model.java:𝒳漢字.save#0'],
  ])('%s resolves the qualified member type exactly: %s', (caller, target) => {
    expect(saveTargets(result(), caller)).not.toContain('Method:p/Decoy.java:Ünïcödé.save#0');
    expect(saveTargets(result(), caller)).not.toContain('Method:p/Decoy.java:𝒳漢字.save#0');
    expect(saveTargets(result(), caller)).toEqual([target]);
  });
});

// JLS 3.8 Java letters include every Unicode letter, letter number, currency
// symbol and connector, and identifier parts add digits, combining marks and
// format characters. Each name below has an ASCII twin and a decoy that a
// truncated or refused name would reach or leave unresolved.
describe('Java names outside ASCII in element types, overloads, lambdas and Lombok', () => {
  const result = useFixture('java-r5-non-ascii-identifiers', {
    'p/Ann.java': `package p;
import java.lang.annotation.ElementType;
import java.lang.annotation.Target;
@Target(ElementType.TYPE_USE)
public @interface Ann {}`,
    'p/Nötig.java': `package p;
import java.lang.annotation.ElementType;
import java.lang.annotation.Target;
@Target(ElementType.TYPE_USE)
public @interface Nötig {}`,
    'p/Model.java': `package p;
public class Model {}
class Äußer {
  static class Ünïcödé { void save() {} }
  static class ötigÜnïcödé { void save() {} }
}
class Outer {
  static class Inner { void save() {} }
}
class ${CAFE} { void save() {} }
class Plain { void save() {} }`,
    'p/Decoy.java': `package p;
class Ünïcödé { void save() {} }
class Inner { void save() {} }`,
    'p/Elements.java': `package p;
import java.util.List;
class Elements {
  void element(List<Äußer.@Ann Ünïcödé /* ü */ > values) { for (var v : values) v.save(); }
  void lineComment(List<Äußer.Ünïcödé // ü
      > values) { for (var v : values) v.save(); }
  void eachLambda(List<Äußer.Ünïcödé> values) { values.forEach(v -> v.save()); }
  void combining(List<${CAFE}> values) { for (var v : values) v.save(); }
  void asciiElement(List<Outer.@Ann Inner /* u */ > values) { for (var v : values) v.save(); }
  void asciiLineComment(List<Outer.Inner // u
      > values) { for (var v : values) v.save(); }
  void asciiEachLambda(List<Outer.Inner> values) { values.forEach(v -> v.save()); }
}`,
    'straße/Ünïcödé.java': 'package straße; public class Ünïcödé { public void save() {} }',
    // The ASCII twin's package is not `strasse`: a case-insensitive APFS
    // volume folds `straße` and `strasse` to one directory.
    'ascii/Inner.java': 'package ascii; public class Inner { public void save() {} }',
    'p/Imported.java': `package p;
import java.util.List;
import straße.Ünïcödé;
class Imported { void element(List<Ünïcödé> values) { for (var v : values) v.save(); } }`,
    'p/ImportedAscii.java': `package p;
import java.util.List;
import ascii.Inner;
class ImportedAscii { void element(List<Inner> values) { for (var v : values) v.save(); } }`,
    'p/Overloads.java': `package p;
class Target {
  void take(Äußer.Ünïcödé value) {}
  void take(Äußer.ötigÜnïcödé value) {}
  void take(Outer.Inner value) {}
  void take(String value) {}
}
class CombiningTarget {
  void take(${CAFE} value) {}
  void take(Outer.Inner value) {}
  void take(String value) {}
}
class Picker {
  void local(Target t) { Äußer.@Nötig Ünïcödé v = null; t.take(v); }
  void parameter(Target t, Äußer.@Nötig Ünïcödé v) { t.take(v); }
  void asciiLocal(Target t) { Outer.@Ann Inner v = null; t.take(v); }
  void combining(CombiningTarget t) { ${CAFE} v = null; t.take(v); }
  void besideCombining(CombiningTarget t) { Outer.Inner v = null; t.take(v); }
}`,
    'p/Lambdas.java': `package p;
interface Handler<T> { void handle(T c); }
interface ${HANDLER} { void handle(Plain c); }
interface AsciiHandler { void handle(Plain c); }
interface Sub${HANDLER} extends ${HANDLER} {}
interface SubAscii extends AsciiHandler {}
class Lambdas {
  void onGeneric(Handler<${CAFE}> h) {}
  void onGenericAscii(Handler<Plain> h) {}
  void onNamed(${HANDLER} h) {}
  void onNamedAscii(AsciiHandler h) {}
  void onSub(Sub${HANDLER} h) {}
  void onSubAscii(SubAscii h) {}
  void generic() { onGeneric(c -> c.save()); }
  void genericAscii() { onGenericAscii(c -> c.save()); }
  void named() { onNamed(c -> c.save()); }
  void namedAscii() { onNamedAscii(c -> c.save()); }
  void sub() { onSub(c -> c.save()); }
  void subAscii() { onSubAscii(c -> c.save()); }
}`,
    'l/Bases.java': `package l;
public class Bases {}
class Basé {}
class Base {}
class Item {}`,
    'l/Models.java': `package l;
import lombok.Getter;
import lombok.Value;
public class Models {}
class Mödel extends Basé { @Getter private Item nämé; }
class Model extends Base { @Getter private Item name; }
@Getter class Klässe extends Basé { private Item fëld; }
@Value class Wërt extends Basé { Item wërt; }
class Other {
  Item getNämé() { return null; }
  Item getName() { return null; }
  Item getFëld() { return null; }
  Item getWërt() { return null; }
}`,
    'l/Callers.java': `package l;
class Callers {
  void field(Mödel m) { m.getNämé(); }
  void asciiField(Model m) { m.getName(); }
  void type(Klässe k) { k.getFëld(); }
  void value(Wërt w) { w.getWërt(); }
}`,
  });

  it.each([
    ['Elements.element#1', 'Method:p/Model.java:Ünïcödé.save#0'],
    ['Elements.lineComment#1', 'Method:p/Model.java:Ünïcödé.save#0'],
    ['Elements.eachLambda#1', 'Method:p/Model.java:Ünïcödé.save#0'],
    ['Elements.combining#1', `Method:p/Model.java:${CAFE}.save#0`],
    ['Elements.asciiElement#1', 'Method:p/Model.java:Inner.save#0'],
    ['Elements.asciiLineComment#1', 'Method:p/Model.java:Inner.save#0'],
    ['Elements.asciiEachLambda#1', 'Method:p/Model.java:Inner.save#0'],
  ])('types the JDK List element in %s as the written member type: %s', (method, target) => {
    const targets = saveTargets(result(), `Method:p/Elements.java:${method}`);
    expect(targets).not.toContain('Method:p/Decoy.java:Ünïcödé.save#0');
    expect(targets).not.toContain('Method:p/Decoy.java:Inner.save#0');
    expect(targets).toEqual([target]);
  });

  // The single-type import shadows the same-package decoy (JLS 6.4.1).
  it.each([
    ['Method:p/Imported.java:Imported.element#1', 'Method:straße/Ünïcödé.java:Ünïcödé.save#0'],
    ['Method:p/ImportedAscii.java:ImportedAscii.element#1', 'Method:ascii/Inner.java:Inner.save#0'],
  ])('types the element of %s through its single-type import: %s', (caller, target) => {
    expect(saveTargets(result(), caller)).toEqual([target]);
  });

  // The decoy overload takes `Äußer.ötigÜnïcödé`: what remains when only the
  // ASCII prefix of the annotation `@Nötig` is removed from `Äußer.@Nötig Ünïcödé`.
  it.each([
    ['Picker.local#1', 'Method:p/Overloads.java:Target.take#1~Äußer.Ünïcödé'],
    ['Picker.parameter#2', 'Method:p/Overloads.java:Target.take#1~Äußer.Ünïcödé'],
    ['Picker.asciiLocal#1', 'Method:p/Overloads.java:Target.take#1~Outer.Inner'],
    ['Picker.combining#1', `Method:p/Overloads.java:CombiningTarget.take#1~${CAFE}`],
    ['Picker.besideCombining#1', 'Method:p/Overloads.java:CombiningTarget.take#1~Outer.Inner'],
  ])('selects the overload of %s by its written argument type: %s', (method, target) => {
    expect(callTargets(result(), `Method:p/Overloads.java:${method}`, 'take')).toEqual([target]);
  });

  // A type argument substituted into the function type, a functional
  // interface named with a combining mark, and one inherited by a subinterface.
  it.each([
    ['Lambdas.generic#0', `Method:p/Model.java:${CAFE}.save#0`],
    ['Lambdas.genericAscii#0', 'Method:p/Model.java:Plain.save#0'],
    ['Lambdas.named#0', 'Method:p/Model.java:Plain.save#0'],
    ['Lambdas.namedAscii#0', 'Method:p/Model.java:Plain.save#0'],
    ['Lambdas.sub#0', 'Method:p/Model.java:Plain.save#0'],
    ['Lambdas.subAscii#0', 'Method:p/Model.java:Plain.save#0'],
  ])('types the lambda parameter in %s from its functional interface: %s', (method, target) => {
    const targets = saveTargets(result(), `Method:p/Lambdas.java:${method}`);
    expect(targets).not.toContain('Method:p/Decoy.java:Inner.save#0');
    expect(targets).toEqual([target]);
  });

  // A workspace base with a non-ASCII name is resolvable, so it can be shown
  // to declare no member type named Getter that would hide lombok.Getter.
  it.each([
    ['field#1', 'getNämé', 'Mödel'],
    ['asciiField#1', 'getName', 'Model'],
    ['type#1', 'getFëld', 'Klässe'],
    ['value#1', 'getWërt', 'Wërt'],
  ])('calls the generated Lombok accessor from Callers.%s: %s of %s', (method, name, owner) => {
    const accessor = `Method:l/Models.java:${owner}.${name}#0`;
    expect(callTargets(result(), `Method:l/Callers.java:Callers.${method}`, name)).toEqual([
      accessor,
    ]);
    expect(
      getRelationships(result(), 'HAS_METHOD')
        .filter((edge) => edge.rel.targetId === accessor)
        .map((edge) => edge.rel.sourceId),
    ).toEqual([`Class:l/Models.java:${owner}`]);
  });
});
