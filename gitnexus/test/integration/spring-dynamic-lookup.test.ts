import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

const temporaryRepositories: string[] = [];

function temporaryRepository(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRepositories.push(root);
  return root;
}

function injectionEdges(result: PipelineResult) {
  return getRelationships(result, 'INJECTS').map((edge) => ({
    source: edge.source,
    target: edge.target,
    type: edge.rel.type,
    confidence: edge.rel.confidence,
    reason: edge.rel.reason,
  }));
}

afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Spring dynamic lookup production integration', () => {
  it('resolves Java imports, assignability, concrete targets, ranges, and nested callables', async () => {
    const root = temporaryRepository('gitnexus-java-spring-dynamic-');
    writeFixtureRepo(root, {
      'src/a/Parent.java': `package a;
        interface Parent {}
        interface Child extends Parent {}
        class Impl implements Child {}
        class SecondImpl implements Child {}`,
      'src/a/Base.java': 'package a; public class Base {}',
      'src/a/Concrete.java': 'package a; public class Concrete extends Base {}',
      'src/a/RecordBean.java': 'package a; public record RecordBean(String value) {}',
      'src/b/Parent.java': 'package b; public interface Parent {}',
      'src/b/OtherImpl.java': 'package b; public class OtherImpl implements Parent {}',
      'src/a/SamePackageCaller.java': `package a;
        class SamePackageCaller {
          void samePackageLookup() { ctx.getBeans(Parent.class); }
        }`,
      'src/c/JavaCaller.java': `package c;
        import a.Parent;
        import a.Base;
        import a.Concrete;
        import a.RecordBean;
        class JavaCaller {
          JavaCaller() { beanFactory.getBean(Concrete.class); }
          void javaCollection(){ SpringContextUtil.getBeans(Parent.class); }
          void adjacentMiss(){}
          void javaBase(){ applicationContext.getBeansOfType(Base.class); }
          void javaSingle(){ ctx.getBean(Concrete.class); }
          void javaRecord(){ ctx.getBean(RecordBean.class); }
          void javaAmbiguousSingle(){ ctx.getBean(Parent.class); }
          void javaOuter() {
            Runnable task = new Runnable() {
              public void run() { ctx.getBeans(Parent.class); }
            };
          }
          void javaFalsePositives() {
            // ctx.getBeans(Parent.class);
            /* applicationContext.getBeansOfType(Parent.class); */
            String normal = "ctx.getBean(Concrete.class)";
            String block = """
              ctx.getBeans(Parent.class)
              """;
          }
        }`,
      'src/c/AmbiguousCaller.java': `package c;
        import a.*;
        import b.*;
        class AmbiguousCaller {
          void ambiguousLookup() { ctx.getBeans(Parent.class); }
        }`,
      'src/foreign.ts': 'interface Parent {}',
    });

    const result = await runPipelineFromRepo(root, () => {});
    const edges = injectionEdges(result);

    expect(edges).toEqual(
      expect.arrayContaining([
        {
          source: 'javaCollection',
          target: 'Impl',
          type: 'INJECTS',
          confidence: 0.8,
          reason: 'Spring dynamic lookup: SpringContextUtil.getBeans(Parent)',
        },
        {
          source: 'javaCollection',
          target: 'SecondImpl',
          type: 'INJECTS',
          confidence: 0.8,
          reason: 'Spring dynamic lookup: SpringContextUtil.getBeans(Parent)',
        },
        expect.objectContaining({ source: 'javaBase', target: 'Concrete', confidence: 0.8 }),
        {
          source: 'javaSingle',
          target: 'Concrete',
          type: 'INJECTS',
          confidence: 0.9,
          reason: 'Spring dynamic lookup: ctx.getBean(Concrete)',
        },
        expect.objectContaining({
          source: 'javaRecord',
          target: 'RecordBean',
          confidence: 0.9,
        }),
        expect.objectContaining({
          source: 'javaAmbiguousSingle',
          target: 'Impl',
          confidence: 0.5,
        }),
        expect.objectContaining({
          source: 'javaAmbiguousSingle',
          target: 'SecondImpl',
          confidence: 0.5,
        }),
        expect.objectContaining({ source: 'run', target: 'Impl', confidence: 0.8 }),
        expect.objectContaining({ source: 'samePackageLookup', target: 'Impl', confidence: 0.8 }),
      ]),
    );
    expect(edges.some((edge) => edge.source === 'adjacentMiss')).toBe(false);
    expect(edges.some((edge) => edge.source === 'javaOuter')).toBe(false);
    expect(edges.some((edge) => edge.source === 'javaFalsePositives')).toBe(false);
    expect(edges.some((edge) => edge.source === 'ambiguousLookup')).toBe(false);
    expect(
      edges
        .filter((edge) => edge.source === 'javaAmbiguousSingle')
        .every((edge) => edge.reason.includes('ambiguous candidates: Impl, SecondImpl')),
    ).toBe(true);
    expect(
      edges.some(
        (edge) =>
          edge.source === 'javaCollection' &&
          (edge.target === 'Child' || edge.target === 'OtherImpl'),
      ),
    ).toBe(false);
    expect(edges.some((edge) => edge.target === 'Concrete' && edge.confidence === 0.5)).toBe(false);
    expect(
      edges.filter((edge) => edge.source === 'JavaCaller' && edge.target === 'Concrete'),
    ).toHaveLength(1);
  }, 60000);

  it('resolves Kotlin class literals through the same graph semantics', async () => {
    const root = temporaryRepository('gitnexus-kotlin-spring-dynamic-');
    writeFixtureRepo(root, {
      'src/a/Parent.kt': 'package a\ninterface Parent',
      'src/a/Child.kt': 'package a\ninterface Child : Parent',
      'src/a/Impl.kt': 'package a\nclass Impl : Child',
      'src/a/Concrete.kt': 'package a\nopen class Base\nclass Concrete : Base()',
      'src/c/KotlinCaller.kt': `package c
        import a.Parent
        import a.Base
        import a.Concrete
        class KotlinCaller {
          constructor(marker: String) { beanFactory.getBean(Concrete::class.java) }
          fun kotlinCollection(){ SpringContextUtil.getBeans(Parent::class.java) }
          fun adjacentMiss(){}
          fun kotlinBase(){ applicationContext.getBeansOfType(Base::class.java) }
          fun kotlinSingle(){ ctx.getBean(Concrete::class) }
          fun kotlinOuter() {
            val task = object : Runnable {
              override fun run() { ctx.getBeans(Parent::class.java) }
            }
          }
          fun kotlinFalsePositives() {
            // ctx.getBeans(Parent::class.java)
            /* applicationContext.getBeansOfType(Parent::class.java) */
            val normal = "ctx.getBean(Concrete::class.java)"
            val raw = ${'"""'}ctx.getBeans(Parent::class.java)${'"""'}
          }
        }`,
      'src/foreign.ts': 'interface Parent {}',
    });

    const result = await runPipelineFromRepo(root, () => {});
    const edges = injectionEdges(result);

    expect(edges).toEqual(
      expect.arrayContaining([
        {
          source: 'kotlinCollection',
          target: 'Impl',
          type: 'INJECTS',
          confidence: 0.8,
          reason: 'Spring dynamic lookup: SpringContextUtil.getBeans(Parent)',
        },
        expect.objectContaining({ source: 'kotlinBase', target: 'Concrete', confidence: 0.8 }),
        {
          source: 'kotlinSingle',
          target: 'Concrete',
          type: 'INJECTS',
          confidence: 0.9,
          reason: 'Spring dynamic lookup: ctx.getBean(Concrete)',
        },
        expect.objectContaining({ source: 'run', target: 'Impl', confidence: 0.8 }),
      ]),
    );
    expect(edges.some((edge) => edge.source === 'adjacentMiss')).toBe(false);
    expect(edges.some((edge) => edge.source === 'kotlinOuter')).toBe(false);
    expect(edges.some((edge) => edge.source === 'kotlinFalsePositives')).toBe(false);
    expect(
      edges.filter((edge) => edge.source === 'constructor' && edge.target === 'Concrete'),
    ).toHaveLength(1);
  }, 60000);
});
