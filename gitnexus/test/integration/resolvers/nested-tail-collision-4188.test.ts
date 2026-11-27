/**
 * Same-tail nested-type collision — Python, C#, Kotlin, Swift (#4188).
 *
 * When two enclosing types each define a nested type with the same simple name,
 * the graph must produce two distinct Class nodes keyed by their fully-qualified
 * path (e.g. Outer.Inner vs Other.Inner).  Without `qualifiedNodeId: true` in
 * the class-extractor config, both collapse into a single node and methods
 * cross-wire.  Modeled on the C++/Ruby fix verified in #1978/#2874.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabelFull,
  findDanglingEdges,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Python: class UserForm > class Meta  vs  class PostForm > class Meta
// ---------------------------------------------------------------------------

describe('Python nested same-tail collision — distinct qualified nodes (#4188)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-nested-tail-collision'),
      () => {},
    );
  }, 60000);

  it('materializes UserForm.Meta and PostForm.Meta as two distinct Class nodes', () => {
    const qns = getNodesByLabelFull(result, 'Class')
      .map((n) => n.properties.qualifiedName)
      .filter((q) => q === 'UserForm.Meta' || q === 'PostForm.Meta')
      .sort();
    expect(qns).toEqual(['PostForm.Meta', 'UserForm.Meta']);
  });

  it('owns clean_username / clean_title through their OWN parent (not Meta)', () => {
    expect(findDanglingEdges(result, ['HAS_METHOD'])).toEqual([]);
    const hm = getRelationships(result, 'HAS_METHOD');
    const ownerQn = (target: string) => {
      const e = hm.find((x) => x.target === target);
      expect(e, `HAS_METHOD -> ${target}`).toBeDefined();
      return result.graph.getNode(e!.rel.sourceId)?.properties.qualifiedName;
    };
    expect(ownerQn('clean_username')).toBe('UserForm');
    expect(ownerQn('clean_title')).toBe('PostForm');
  });
});

// ---------------------------------------------------------------------------
// C#: class Outer > class Inner  vs  class Other > class Inner
// ---------------------------------------------------------------------------

describe('C# nested same-tail collision — distinct qualified nodes (#4188)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'csharp-nested-tail-collision'),
      () => {},
    );
  }, 60000);

  it('materializes Outer.Inner and Other.Inner as two distinct Class nodes', () => {
    const qns = getNodesByLabelFull(result, 'Class')
      .map((n) => n.properties.qualifiedName)
      .filter((q) => q === 'Outer.Inner' || q === 'Other.Inner')
      .sort();
    expect(qns).toEqual(['Other.Inner', 'Outer.Inner']);
  });

  it('owns FromOuter / FromOther through their OWN distinct node', () => {
    expect(findDanglingEdges(result, ['HAS_METHOD'])).toEqual([]);
    const hm = getRelationships(result, 'HAS_METHOD');
    const ownerQn = (target: string) => {
      const e = hm.find((x) => x.target === target);
      expect(e, `HAS_METHOD -> ${target}`).toBeDefined();
      return result.graph.getNode(e!.rel.sourceId)?.properties.qualifiedName;
    };
    expect(ownerQn('FromOuter')).toBe('Outer.Inner');
    expect(ownerQn('FromOther')).toBe('Other.Inner');
  });
});

// ---------------------------------------------------------------------------
// Kotlin: class Outer > class Inner  vs  class Other > class Inner
// ---------------------------------------------------------------------------

describe('Kotlin nested same-tail collision — distinct qualified nodes (#4188)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'kotlin-nested-tail-collision'),
      () => {},
    );
  }, 60000);

  it('materializes Outer.Inner and Other.Inner as two distinct Class nodes', () => {
    const qns = getNodesByLabelFull(result, 'Class')
      .map((n) => n.properties.qualifiedName)
      .filter((q) => q === 'Outer.Inner' || q === 'Other.Inner')
      .sort();
    expect(qns).toEqual(['Other.Inner', 'Outer.Inner']);
  });

  it('owns fromOuter / fromOther through their OWN distinct node', () => {
    expect(findDanglingEdges(result, ['HAS_METHOD'])).toEqual([]);
    const hm = getRelationships(result, 'HAS_METHOD');
    const ownerQn = (target: string) => {
      const e = hm.find((x) => x.target === target);
      expect(e, `HAS_METHOD -> ${target}`).toBeDefined();
      return result.graph.getNode(e!.rel.sourceId)?.properties.qualifiedName;
    };
    expect(ownerQn('fromOuter')).toBe('Outer.Inner');
    expect(ownerQn('fromOther')).toBe('Other.Inner');
  });
});

// ---------------------------------------------------------------------------
// Swift: class Outer > class Inner  vs  class Other > class Inner
// ---------------------------------------------------------------------------

describe('Swift nested same-tail collision — distinct qualified nodes (#4188)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'swift-nested-tail-collision'),
      () => {},
    );
  }, 60000);

  it('materializes Outer.Inner and Other.Inner as two distinct Class nodes', () => {
    const qns = getNodesByLabelFull(result, 'Class')
      .map((n) => n.properties.qualifiedName)
      .filter((q) => q === 'Outer.Inner' || q === 'Other.Inner')
      .sort();
    expect(qns).toEqual(['Other.Inner', 'Outer.Inner']);
  });

  it('owns fromOuter / fromOther through their OWN distinct node', () => {
    expect(findDanglingEdges(result, ['HAS_METHOD'])).toEqual([]);
    const hm = getRelationships(result, 'HAS_METHOD');
    const ownerQn = (target: string) => {
      const e = hm.find((x) => x.target === target);
      expect(e, `HAS_METHOD -> ${target}`).toBeDefined();
      return result.graph.getNode(e!.rel.sourceId)?.properties.qualifiedName;
    };
    expect(ownerQn('fromOuter')).toBe('Outer.Inner');
    expect(ownerQn('fromOther')).toBe('Other.Inner');
  });
});
