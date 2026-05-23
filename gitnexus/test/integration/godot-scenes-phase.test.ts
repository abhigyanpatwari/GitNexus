import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { scenesPhase } from '../../src/core/ingestion/pipeline-phases/scenes.js';
import type {
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { StructureOutput } from '../../src/core/ingestion/pipeline-phases/structure.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

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

function buildContext(repoPath: string): PipelineContext {
  return {
    repoPath,
    graph: createKnowledgeGraph(),
    onProgress: () => {},
    options: {},
    pipelineStart: Date.now(),
  };
}

function buildStructureDeps(scannedFiles: { path: string; size: number }[]) {
  const allPaths = scannedFiles.map((f) => f.path);
  const structureOutput: StructureOutput = {
    scannedFiles,
    allPaths,
    allPathSet: new Set(allPaths),
    totalFiles: scannedFiles.length,
  };
  const deps = new Map<string, PhaseResult<unknown>>();
  deps.set('structure', {
    phaseName: 'structure',
    output: structureOutput,
    durationMs: 0,
  });
  return deps;
}

describe('scenesPhase integration', () => {
  const dodgeCreeps = resolve(FIXTURES_DIR, '2d/dodge_the_creeps');

  it.skipIf(!existsSync(dodgeCreeps))(
    'indexes every .tscn in dodge_the_creeps and exposes them via res:// keys',
    async () => {
      const ctx = buildContext(dodgeCreeps);
      const scannedFiles = walk(dodgeCreeps);
      const deps = buildStructureDeps(scannedFiles);

      const output = await scenesPhase.execute(ctx, deps);

      expect(output.sceneCount).toBe(4);
      expect(output.index.allScenePaths().sort()).toEqual(
        [
          'res://hud.tscn',
          'res://main.tscn',
          'res://mob.tscn',
          'res://player.tscn',
        ].sort(),
      );

      const main = output.index.getScene('res://main.tscn');
      expect(main?.header?.kind).toBe('gd_scene');
      expect(main?.nodes.some((n) => n.name === 'Main')).toBe(true);
    },
  );

  it.skipIf(!existsSync(dodgeCreeps))(
    'reports zero autoloads for dodge_the_creeps (which registers none)',
    async () => {
      const ctx = buildContext(dodgeCreeps);
      const scannedFiles = walk(dodgeCreeps);
      const deps = buildStructureDeps(scannedFiles);

      const output = await scenesPhase.execute(ctx, deps);

      expect(output.autoloadCount).toBe(0);
      expect(output.index.allAutoloadNames()).toEqual([]);
    },
  );

  it('returns an empty index when no .tscn or project.godot files are scanned', async () => {
    const ctx = buildContext('/tmp/empty-fake-repo');
    const deps = buildStructureDeps([{ path: 'README.md', size: 10 }]);

    const output = await scenesPhase.execute(ctx, deps);

    expect(output.sceneCount).toBe(0);
    expect(output.autoloadCount).toBe(0);
    expect(output.index.allScenePaths()).toEqual([]);
  });
});
