import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { scenesPhase } from '../../src/core/ingestion/pipeline-phases/scenes.js';
import { godotCrossrefPhase } from '../../src/core/ingestion/pipeline-phases/godot-crossref.js';
import type {
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { StructureOutput } from '../../src/core/ingestion/pipeline-phases/structure.js';
import type { ScenesOutput } from '../../src/core/ingestion/pipeline-phases/scenes.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

const FIXTURES_DIR =
  process.env.GITNEXUS_GODOT_FIXTURES_DIR ??
  resolve(__dirname, '../../../../godot-demo-projects');

function walk(root: string): { path: string; size: number }[] {
  const results: { path: string; size: number }[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      const relPath = relative(root, full);
      results.push({ path: relPath, size: st.size });
    }
  }
  return results;
}

function seedFileNodes(graph: KnowledgeGraph, scannedFiles: { path: string }[]): void {
  for (const { path } of scannedFiles) {
    graph.addNode({
      id: `File:${path}`,
      label: 'File',
      properties: { name: path.split('/').pop() ?? path, filePath: path },
    });
  }
}

function buildContext(repoPath: string, graph: KnowledgeGraph): PipelineContext {
  return {
    repoPath,
    graph,
    onProgress: () => {},
    options: {},
    pipelineStart: Date.now(),
  };
}

function buildDeps(scenesOutput: ScenesOutput): ReadonlyMap<string, PhaseResult<unknown>> {
  const deps = new Map<string, PhaseResult<unknown>>();
  deps.set('scenes', { phaseName: 'scenes', output: scenesOutput, durationMs: 0 });
  // godot-crossref deps on 'parse' for ordering only — it doesn't read parse output.
  deps.set('parse', { phaseName: 'parse', output: {}, durationMs: 0 });
  return deps;
}

describe('godotCrossrefPhase integration', () => {
  const dodgeCreeps = resolve(FIXTURES_DIR, '2d/dodge_the_creeps');

  it.skipIf(!existsSync(dodgeCreeps))(
    'emits script-attached MEMBER_OF edges from .tscn files to their attached .gd scripts',
    async () => {
      const graph = createKnowledgeGraph();
      const ctx = buildContext(dodgeCreeps, graph);
      const scannedFiles = walk(dodgeCreeps);
      seedFileNodes(graph, scannedFiles);

      const scenesDeps = new Map<string, PhaseResult<unknown>>();
      const structureOutput: StructureOutput = {
        scannedFiles,
        allPaths: scannedFiles.map((f) => f.path),
        allPathSet: new Set(scannedFiles.map((f) => f.path)),
        totalFiles: scannedFiles.length,
      };
      scenesDeps.set('structure', {
        phaseName: 'structure',
        output: structureOutput,
        durationMs: 0,
      });
      const scenesOutput = await scenesPhase.execute(ctx, scenesDeps);

      const output = await godotCrossrefPhase.execute(ctx, buildDeps(scenesOutput));

      expect(output.scriptAttachedCount).toBeGreaterThan(0);

      // main.tscn attaches main.gd to the Main node
      const mainAttachment = [...graph.iterRelationships()].find(
        (r) =>
          r.type === 'MEMBER_OF' &&
          r.reason === 'script-attached' &&
          r.sourceId === 'File:main.tscn' &&
          r.targetId === 'File:main.gd',
      );
      expect(mainAttachment).toBeDefined();
    },
  );

  it.skipIf(!existsSync(dodgeCreeps))(
    'emits scene-instance USES edges from parent .tscn files to child .tscn files',
    async () => {
      const graph = createKnowledgeGraph();
      const ctx = buildContext(dodgeCreeps, graph);
      const scannedFiles = walk(dodgeCreeps);
      seedFileNodes(graph, scannedFiles);

      const scenesDeps = new Map<string, PhaseResult<unknown>>();
      const structureOutput: StructureOutput = {
        scannedFiles,
        allPaths: scannedFiles.map((f) => f.path),
        allPathSet: new Set(scannedFiles.map((f) => f.path)),
        totalFiles: scannedFiles.length,
      };
      scenesDeps.set('structure', {
        phaseName: 'structure',
        output: structureOutput,
        durationMs: 0,
      });
      const scenesOutput = await scenesPhase.execute(ctx, scenesDeps);

      const output = await godotCrossrefPhase.execute(ctx, buildDeps(scenesOutput));

      expect(output.sceneInstanceCount).toBeGreaterThan(0);

      const instanceEdges = [...graph.iterRelationships()].filter(
        (r) => r.type === 'USES' && r.reason === 'scene-instance',
      );
      const pairs = new Set(instanceEdges.map((r) => `${r.sourceId}->${r.targetId}`));

      // main.tscn instances player.tscn and hud.tscn
      expect(pairs.has('File:main.tscn->File:player.tscn')).toBe(true);
      expect(pairs.has('File:main.tscn->File:hud.tscn')).toBe(true);
    },
  );

  it('emits zero edges when the SceneIndex has no scenes', async () => {
    const graph = createKnowledgeGraph();
    const ctx = buildContext('/tmp/empty', graph);
    const scenesOutput: ScenesOutput = {
      index: (await import('../../src/core/ingestion/godot/scene-index.js')).createSceneIndex(),
      sceneCount: 0,
      autoloadCount: 0,
    };
    const output = await godotCrossrefPhase.execute(ctx, buildDeps(scenesOutput));
    expect(output.scriptAttachedCount).toBe(0);
    expect(output.sceneInstanceCount).toBe(0);
  });
});
