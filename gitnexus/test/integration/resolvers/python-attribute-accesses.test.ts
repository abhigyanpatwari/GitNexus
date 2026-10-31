import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';
import { cleanupTempDirSync } from '../../helpers/test-db.js';

// Issue #3794. Attribute reads and assignments are different operations:
// https://docs.python.org/3/reference/expressions.html#attribute-references
// https://docs.python.org/3/reference/simple_stmts.html#assignment-statements
describe('Python attribute access edges (#3794)', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-python-attributes-'));
    writeFixtureRepo(repoDir, {
      'pkg/__init__.py': '',
      'pkg/model.py': `from dataclasses import dataclass, field

@dataclass
class Result:
    failures: dict[str, str] = field(default_factory=dict)

class Plain:
    def __init__(self) -> None:
        self.value = 1
        for self.loop in (1,):
            pass

class Decoy:
    def __init__(self):
        self.value = 2

class Replaced:
    def __init__(self):
        self.stale = 1
    def __init__(self):
        self.live = 2

def check() -> Result:
    return Result()
`,
      'pkg/use.py': `from pkg.model import Plain, Result, check

def read_from_annotated_return() -> dict[str, str]:
    r = check()
    return r.failures

def read_from_constructor() -> dict[str, str]:
    r = Result()
    return r.failures

def read_from_annotated_param(p: Plain) -> int:
    return p.value

def read_from_loop_target(p: Plain) -> int:
    return p.loop
`,
      'ts/box.ts': `export class Box { size = 1; }
export function readBox(b: Box): number { return b.size; }
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60_000);

  afterAll(() => {
    if (repoDir) cleanupTempDirSync(repoDir);
  });

  it.each(['read_from_annotated_return', 'read_from_constructor'])(
    'links %s to the dataclass field',
    (reader) => {
      const accesses = getRelationships(result, 'ACCESSES').filter(
        (edge) => edge.source === reader,
      );
      expect(accesses.map((edge) => [edge.rel.targetId, edge.rel.reason])).toEqual([
        ['Property:pkg/model.py:Result.failures', 'read'],
      ]);
    },
  );

  it('creates a Property for an attribute assigned on the constructor receiver', () => {
    expect(result.graph.getNode('Property:pkg/model.py:Plain.value')).toMatchObject({
      label: 'Property',
      properties: { name: 'value', filePath: 'pkg/model.py', startLine: 8 },
    });
  });

  it('links an annotated parameter read to its instance field', () => {
    const accesses = getRelationships(result, 'ACCESSES').filter(
      (edge) => edge.source === 'read_from_annotated_param',
    );
    expect(accesses.map((edge) => [edge.rel.targetId, edge.rel.reason])).toEqual([
      ['Property:pkg/model.py:Plain.value', 'read'],
    ]);
  });

  it('does not create fields from a replaced constructor', () => {
    expect(result.graph.getNode('Property:pkg/model.py:Replaced.stale')).toBeUndefined();
    expect(result.graph.getNode('Property:pkg/model.py:Replaced.live')).toMatchObject({
      label: 'Property',
      properties: { name: 'live' },
    });
  });

  it('links reads to a field introduced by a constructor loop target', () => {
    expect(result.graph.getNode('Property:pkg/model.py:Plain.loop')).toMatchObject({
      label: 'Property',
      properties: { name: 'loop' },
    });
    const accesses = getRelationships(result, 'ACCESSES').filter(
      (edge) => edge.source === 'read_from_loop_target',
    );
    expect(accesses.map((edge) => [edge.rel.targetId, edge.rel.reason])).toEqual([
      ['Property:pkg/model.py:Plain.loop', 'read'],
    ]);
  });

  it('retains the TypeScript control edge', () => {
    const accesses = getRelationships(result, 'ACCESSES').filter(
      (edge) => edge.source === 'readBox',
    );
    expect(accesses.map((edge) => [edge.rel.targetId, edge.rel.reason])).toEqual([
      ['Property:ts/box.ts:Box.size', 'read'],
    ]);
  });
});
