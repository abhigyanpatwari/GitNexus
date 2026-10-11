import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

describe('FastAPI Depends() CALLS edge extraction', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'fastapi-depends'), () => {});
  }, 60000);

  it('emits CALLS edges from route handlers to get_current_user_record via Depends()', () => {
    const edges = getRelationships(result, 'CALLS');
    const dependsEdges = edges.filter((e) => e.target === 'get_current_user_record');
    expect(dependsEdges.length).toBe(2);
    const sources = dependsEdges.map((e) => e.source).sort();
    expect(sources).toContain('list_calls');
    expect(sources).toContain('get_user');
  });

  it('emits CALLS edges from route handlers to get_db via Depends()', () => {
    const edges = getRelationships(result, 'CALLS');
    const dependsEdges = edges.filter((e) => e.target === 'get_db');
    expect(dependsEdges.length).toBe(2);
    const sources = dependsEdges.map((e) => e.source).sort();
    expect(sources).toContain('list_calls');
    expect(sources).toContain('create_user');
  });

  it('traces typed default parameter: user: User = Depends(get_current_user_record)', () => {
    const edges = getRelationships(result, 'CALLS');
    const edge = edges.find(
      (e) => e.target === 'get_current_user_record' && e.sourceFilePath.includes('calls.py'),
    );
    expect(edge).toBeDefined();
  });

  it('traces untyped default parameter: db=Depends(get_db)', () => {
    const edges = getRelationships(result, 'CALLS');
    const edge = edges.find((e) => e.target === 'get_db' && e.sourceFilePath.includes('users.py'));
    expect(edge).toBeDefined();
  });
});

describe('FastAPI dependency caller and lookup ownership', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-fastapi-ownership-'));
    writeFixtureRepo(repoDir, {
      'outer.py': 'def dependency(): return 1\ndef hidden(): return 1\n',
      'inner.py': 'def dependency(): return 2\ndef hidden(): return 2\n',
      'routes.py': `from fastapi import Depends
from outer import dependency, hidden
import outer as deps

def handler(value=Depends(dependency)):
    from inner import dependency
    return dependency()

def member_handler(value=Depends(deps.dependency)):
    import inner as deps
    return deps.dependency()

def wrapper(hidden):
    def blocked_handler(value=Depends(hidden)):
        from inner import hidden
    return blocked_handler

def ordinary(value=dependency()):
    from inner import dependency
    return dependency()
`,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it.each(['handler', 'member_handler'])(
    'attributes dependencies to %s while resolving outside its local imports',
    (caller) => {
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.source === caller && edge.target === 'dependency')
          .map((edge) => edge.rel.targetId)
          .sort(),
      ).toEqual(['Function:inner.py:dependency', 'Function:outer.py:dependency']);
    },
  );

  it('keeps an outer parameter barrier for a dependency despite a handler-local import', () => {
    expect(getRelationships(result, 'CALLS').filter((edge) => edge.target === 'hidden')).toEqual(
      [],
    );
  });

  it('keeps ordinary default execution attributed to the file', () => {
    expect(
      getRelationships(result, 'CALLS')
        .filter(
          (edge) =>
            edge.target === 'dependency' &&
            (edge.sourceLabel === 'File' || edge.source === 'ordinary'),
        )
        .map((edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`)
        .sort(),
    ).toEqual([
      'File:routes.py -> Function:outer.py:dependency',
      'Function:routes.py:ordinary -> Function:inner.py:dependency',
    ]);
  });
});
