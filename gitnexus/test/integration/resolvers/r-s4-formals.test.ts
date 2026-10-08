/**
 * R: a formal spelled with backticks or quotes (`Class` = "A", "Class" = "A")
 * names the definition exactly like the bare spelling. Runs through the real
 * pipeline; the plain forms in the same file are the positive controls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, getNodesByLabel, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

describe('R S4 definitions named by a backticked or quoted formal', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-s4-formals'), () => {});
  }, 60000);

  it('defines each class once, from the string that follows the formal', () => {
    expect(getNodesByLabel(result, 'Class').filter((n) => n !== 'VIRTUAL')).toEqual(
      ['Base', 'BacktickClass', 'BacktickRef', 'Plain', 'QuotedClass'].sort(),
    );
  });

  it('keeps the EXTENDS edge of a plain class and of each formal spelling', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    for (const source of ['Plain', 'BacktickClass', 'QuotedClass']) {
      expect(extends_.some((e) => e.source === source && e.target === 'Base')).toBe(true);
    }
  });

  it('defines the generic from name = with no Function from valueClass', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('backtickGeneric');
    expect(functions).not.toContain('numeric');
  });

  it('defines the method from f = with no Method from the signature', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('backtickMethod');
    expect(methods).not.toContain('Plain');
  });
});
