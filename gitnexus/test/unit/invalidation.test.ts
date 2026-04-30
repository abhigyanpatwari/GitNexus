import { describe, expect, it } from 'vitest';
import { planIncrementalInvalidation } from '../../src/core/incremental/invalidation.js';
import type { FileManifestDiff } from '../../src/core/incremental/file-manifest.js';
import type { RepoIndexManifest } from '../../src/storage/repo-manager.js';

const makeManifest = (): RepoIndexManifest => ({
  version: 1,
  generatedAt: '2026-04-30T12:00:00.000Z',
  files: {
    'src/a.ts': {
      size: 10,
      mtimeMs: 1,
      hash: 'a',
      emittedNodes: ['File:src/a.ts', 'Function:a'],
      emittedEdges: ['IMPORTS:a->b'],
      parseDiagnostics: [],
      dependencies: ['src/b.ts'],
      dependants: [],
    },
    'src/b.ts': {
      size: 10,
      mtimeMs: 1,
      hash: 'b',
      emittedNodes: ['File:src/b.ts', 'Function:b'],
      emittedEdges: ['CALLS:b->c'],
      parseDiagnostics: [],
      dependencies: [],
      dependants: ['src/a.ts'],
    },
    'src/c.ts': {
      size: 10,
      mtimeMs: 1,
      hash: 'c',
      emittedNodes: ['File:src/c.ts'],
      emittedEdges: [],
      parseDiagnostics: [],
      dependencies: [],
      dependants: [],
    },
  },
  summary: { fileCount: 3, nodeCount: 5, edgeCount: 2 },
});

describe('planIncrementalInvalidation', () => {
  it('invalidates changed files and their importers from the index manifest', () => {
    const diff: FileManifestDiff = {
      added: [],
      modified: ['src/b.ts'],
      deleted: [],
      unchanged: 2,
    };

    const plan = planIncrementalInvalidation(diff, makeManifest());

    expect(plan.changedFiles).toEqual(['src/b.ts']);
    expect(plan.deletedFiles).toEqual([]);
    expect(plan.invalidatedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(plan.reparsedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(plan.reasonByFile).toEqual({
      'src/a.ts': ['imports changed file: src/b.ts'],
      'src/b.ts': ['modified'],
    });
    expect(plan.impactedNodeIds).toEqual([
      'File:src/a.ts',
      'File:src/b.ts',
      'Function:a',
      'Function:b',
    ]);
    expect(plan.impactedRelationshipIds).toEqual(['CALLS:b->c', 'IMPORTS:a->b']);
    expect(plan.globalPhases).toEqual(['mro', 'communities', 'processes']);
    expect(plan.canPatchGraph).toBe(true);
  });

  it('keeps deleted files in the removal set while reparsing surviving dependants', () => {
    const diff: FileManifestDiff = {
      added: [],
      modified: [],
      deleted: ['src/b.ts'],
      unchanged: 2,
    };

    const plan = planIncrementalInvalidation(diff, makeManifest());

    expect(plan.invalidatedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(plan.removedFiles).toEqual(['src/b.ts']);
    expect(plan.reparsedFiles).toEqual(['src/a.ts']);
    expect(plan.reasonByFile['src/a.ts']).toEqual(['imports changed file: src/b.ts']);
    expect(plan.reasonByFile['src/b.ts']).toEqual(['deleted']);
  });

  it('still produces a conservative plan without an index manifest', () => {
    const diff: FileManifestDiff = {
      added: ['src/new.ts'],
      modified: ['src/a.ts'],
      deleted: ['src/old.ts'],
      unchanged: 0,
    };

    const plan = planIncrementalInvalidation(diff, null);

    expect(plan.invalidatedFiles).toEqual(['src/a.ts', 'src/new.ts', 'src/old.ts']);
    expect(plan.impactedNodeIds).toEqual([]);
    expect(plan.impactedRelationshipIds).toEqual([]);
    expect(plan.canPatchGraph).toBe(false);
    expect(plan.globalPhases).toEqual(['mro', 'communities', 'processes']);
  });
});
