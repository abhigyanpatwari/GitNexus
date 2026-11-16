import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture, type RelEdge } from './resolvers/helpers.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const saveTargets = (result: PipelineResult, caller: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge: RelEdge) => edge.rel.sourceId === caller && edge.target === 'save')
    .map((edge) => edge.rel.targetId)
    .sort();

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
