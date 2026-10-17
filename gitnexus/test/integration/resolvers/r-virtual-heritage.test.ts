/**
 * R: only the S4 sentinel `contains = "VIRTUAL"` links to the placeholder `VIRTUAL` class.
 * An R6 `inherit = VIRTUAL` names an ordinary class, so it links to that class and mints
 * no placeholder. Both source forms yield an `inherits` reference named `VIRTUAL`; they
 * differ in how the deriving class is declared (an assignment, or a call that carries the
 * class name as a string).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
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
