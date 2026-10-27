/**
 * R: only the S4 sentinel `contains = "VIRTUAL"` links to the placeholder `VIRTUAL` class.
 * An R6 `inherit = VIRTUAL` names an ordinary class, so it links to that class and mints
 * no placeholder. Both source forms yield an `inherits` reference named `VIRTUAL`; they
 * differ in how the deriving class is declared (an assignment, or a call that carries the
 * class name as a string).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getNodesByLabel, getRelationships, runPipelineFromRepo } from './helpers.js';
import { rScopeResolver } from '../../../src/core/ingestion/languages/r/scope-resolver.js';
import type { PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

const PLACEHOLDER = 'Class:VIRTUAL';
const extendsEdges = (result: PipelineResult, source: string) =>
  getRelationships(result, 'EXTENDS').filter((e) => e.source === source);

describe('R: an R6 class deriving from a class named VIRTUAL', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-virtual-r6'), () => {});
  }, 60000);

  it('links to that class (positive control)', () => {
    expect(extendsEdges(result, 'Child').map((e) => e.rel.targetId)).toEqual([
      'Class:R/classes.R:VIRTUAL',
    ]);
  });

  it('mints no placeholder node and no edge to it', () => {
    expect(result.graph.getNode(PLACEHOLDER)).toBeUndefined();
    const toPlaceholder = getRelationships(result, 'EXTENDS').filter(
      (e) => e.rel.targetId === PLACEHOLDER,
    );
    expect(toPlaceholder).toEqual([]);
  });
});

describe('R: the S4 sentinel and an R6 base of the same name in one repository', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-virtual-s4-and-r6'), () => {});
  }, 60000);

  it('keeps the placeholder edge for contains = "VIRTUAL" (positive control)', () => {
    expect(extendsEdges(result, 'Abstract').map((e) => e.rel.targetId)).toEqual([PLACEHOLDER]);
  });

  it('gives the R6 class that inherits an undefined VIRTUAL no edge to the placeholder', () => {
    expect(extendsEdges(result, 'Child')).toEqual([]);
  });
});

describe('R: the VIRTUAL placeholder edge next to other heritage edges', () => {
  let result: PipelineResult;
  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-s4-contains-forms'), () => {});
  }, 60000);

  it.each(['Both', 'SentinelFirst'])(
    '%s gets an edge to its real base and one to the placeholder',
    (source) => {
      expect(
        extendsEdges(result, source)
          .map((e) => e.rel.targetId)
          .sort(),
      ).toEqual([PLACEHOLDER, 'Class:R/classes.R:Base'].sort());
    },
  );

  it('gives the placeholder edge the confidence and reason of a resolved virtual heritage edge', () => {
    const edge = extendsEdges(result, 'Both').find((e) => e.rel.targetId === PLACEHOLDER);
    expect(edge?.rel.confidence).toBe(0.85);
    expect(edge?.rel.reason).toBe('scope-resolution: inherits (virtual)');
  });

  it('mints exactly one placeholder node', () => {
    expect(result.graph.getNode(PLACEHOLDER)?.label).toBe('Class');
    expect(getNodesByLabel(result, 'Class').filter((n) => n === 'VIRTUAL')).toHaveLength(1);
  });

  it('reads `contains` case-sensitively: CONTAINS = "Base" links nothing', () => {
    expect(extendsEdges(result, 'Shouted')).toEqual([]);
  });
});

describe('R: emitting the VIRTUAL heritage edges twice changes nothing', () => {
  let result: PipelineResult;
  let calls = 0;
  beforeAll(async () => {
    const original = rScopeResolver.emitHeritageEdges;
    if (original === undefined) throw new Error('the R scope resolver emits heritage edges');
    const spy = vi
      .spyOn(rScopeResolver, 'emitHeritageEdges')
      .mockImplementation((...args: Parameters<typeof original>) => {
        calls++;
        original(...args);
        original(...args);
      });
    try {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'r-s4-contains-forms'), () => {});
    } finally {
      spy.mockRestore();
    }
  }, 60000);

  it('ran the doubled hook (otherwise the checks below prove nothing)', () => {
    expect(calls).toBeGreaterThan(0);
  });

  it('keeps one placeholder node and one edge per class that names it', () => {
    expect(getNodesByLabel(result, 'Class').filter((n) => n === 'VIRTUAL')).toHaveLength(1);
    const toPlaceholder = getRelationships(result, 'EXTENDS').filter(
      (e) => e.rel.targetId === PLACEHOLDER,
    );
    expect(toPlaceholder.map((e) => e.source).sort()).toEqual(['Both', 'SentinelFirst']);
  });
});
