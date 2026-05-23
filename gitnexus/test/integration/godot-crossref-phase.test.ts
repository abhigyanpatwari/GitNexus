import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createSceneIndex } from '../../src/core/ingestion/godot/scene-index.js';
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

function buildDeps(
  scenesOutput: ScenesOutput,
  allPaths: readonly string[] = [],
): ReadonlyMap<string, PhaseResult<unknown>> {
  const deps = new Map<string, PhaseResult<unknown>>();
  deps.set('scenes', { phaseName: 'scenes', output: scenesOutput, durationMs: 0 });
  // godot-crossref reads parse.allPaths to discover .gd files for autoload
  // import scanning; other ParseOutput fields are ignored by this phase.
  deps.set('parse', { phaseName: 'parse', output: { allPaths }, durationMs: 0 });
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
      index: createSceneIndex(),
      sceneCount: 0,
      autoloadCount: 0,
    };
    const output = await godotCrossrefPhase.execute(ctx, buildDeps(scenesOutput));
    expect(output.scriptAttachedCount).toBe(0);
    expect(output.sceneInstanceCount).toBe(0);
    expect(output.signalConnectionCount).toBe(0);
    expect(output.autoloadImportCount).toBe(0);
  });

  it('emits autoload IMPORTS edges from .gd files that reference registered autoloads', async () => {
    // Synthetic mini-project on disk so the phase can read .gd contents.
    const tmp = mkdtempSync(join(tmpdir(), 'gn-autoload-'));
    try {
      writeFileSync(
        join(tmp, 'main.gd'),
        'extends Node\nfunc _ready():\n    GameManager.save()\n    ScoreTracker.increment(1)\n',
      );
      writeFileSync(join(tmp, 'game_manager.gd'), 'extends Node\nfunc save():\n    pass\n');
      writeFileSync(
        join(tmp, 'score_tracker.gd'),
        'extends Node\nfunc increment(n: int):\n    pass\n',
      );

      const graph = createKnowledgeGraph();
      seedFileNodes(graph, [
        { path: 'main.gd' },
        { path: 'game_manager.gd' },
        { path: 'score_tracker.gd' },
      ]);

      const ctx = buildContext(tmp, graph);
      const index = createSceneIndex();
      index.addAutoload('GameManager', '*res://game_manager.gd');
      index.addAutoload('ScoreTracker', '*res://score_tracker.gd');
      const scenesOutput: ScenesOutput = { index, sceneCount: 0, autoloadCount: 2 };

      const deps = new Map<string, PhaseResult<unknown>>();
      deps.set('scenes', { phaseName: 'scenes', output: scenesOutput, durationMs: 0 });
      deps.set('parse', {
        phaseName: 'parse',
        output: { allPaths: ['main.gd', 'game_manager.gd', 'score_tracker.gd'] },
        durationMs: 0,
      });

      const output = await godotCrossrefPhase.execute(ctx, deps);

      expect(output.autoloadImportCount).toBe(2);

      const imports = [...graph.iterRelationships()].filter(
        (r) => r.type === 'IMPORTS' && r.reason === 'autoload',
      );
      const pairs = new Set(imports.map((r) => `${r.sourceId}->${r.targetId}`));
      expect(pairs.has('File:main.gd->File:game_manager.gd')).toBe(true);
      expect(pairs.has('File:main.gd->File:score_tracker.gd')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves multi-segment connection paths through nested scene-tree nodes', async () => {
    // Mirrors the platformer pattern:
    //   game_singleplayer.tscn has a [connection signal=... from="Level/Player"
    //   to="InterfaceLayer/PauseMenu" ...] where Level and InterfaceLayer
    //   are direct children of root and Player / PauseMenu are their children.
    //   Player itself is instanced from player.tscn, so its script lives in
    //   player.gd; same for PauseMenu and pause_menu.gd.
    const graph = createKnowledgeGraph();
    seedFileNodes(graph, [
      { path: 'main.tscn' },
      { path: 'player.tscn' },
      { path: 'player.gd' },
      { path: 'pause_menu.tscn' },
      { path: 'pause_menu.gd' },
    ]);
    graph.addNode({
      id: 'Method:player.gd::coin_collected',
      label: 'Method',
      properties: { name: 'coin_collected', filePath: 'player.gd' },
    });
    graph.addNode({
      id: 'Function:pause_menu.gd::_on_coin_collected',
      label: 'Function',
      properties: { name: '_on_coin_collected', filePath: 'pause_menu.gd' },
    });

    const index = createSceneIndex();
    // player.tscn: root attaches player.gd
    index.addScene('res://player.tscn', {
      header: { kind: 'gd_scene', uid: null, format: 3 },
      extResources: [{ id: '1', type: 'Script', path: 'res://player.gd' }],
      subResources: [],
      nodes: [
        {
          name: 'Player',
          type: 'CharacterBody2D',
          parent: null,
          instanceExtResourceId: null,
          properties: { script: { kind: 'ext_resource_ref', id: '1' } },
        },
      ],
      connections: [],
      autoloads: [],
    });
    // pause_menu.tscn: root attaches pause_menu.gd
    index.addScene('res://pause_menu.tscn', {
      header: { kind: 'gd_scene', uid: null, format: 3 },
      extResources: [{ id: '1', type: 'Script', path: 'res://pause_menu.gd' }],
      subResources: [],
      nodes: [
        {
          name: 'PauseMenu',
          type: 'Control',
          parent: null,
          instanceExtResourceId: null,
          properties: { script: { kind: 'ext_resource_ref', id: '1' } },
        },
      ],
      connections: [],
      autoloads: [],
    });
    // main.tscn: nested tree with multi-segment paths in the connection
    index.addScene('res://main.tscn', {
      header: { kind: 'gd_scene', uid: null, format: 3 },
      extResources: [
        { id: '1', type: 'PackedScene', path: 'res://player.tscn' },
        { id: '2', type: 'PackedScene', path: 'res://pause_menu.tscn' },
      ],
      subResources: [],
      nodes: [
        { name: 'Main', type: 'Node', parent: null, instanceExtResourceId: null, properties: {} },
        { name: 'Level', type: 'Node', parent: '.', instanceExtResourceId: null, properties: {} },
        {
          name: 'Player',
          type: null,
          parent: 'Level',
          instanceExtResourceId: '1',
          properties: {},
        },
        {
          name: 'InterfaceLayer',
          type: 'CanvasLayer',
          parent: '.',
          instanceExtResourceId: null,
          properties: {},
        },
        {
          name: 'PauseMenu',
          type: null,
          parent: 'InterfaceLayer',
          instanceExtResourceId: '2',
          properties: {},
        },
      ],
      connections: [
        {
          signal: 'coin_collected',
          from: 'Level/Player',
          to: 'InterfaceLayer/PauseMenu',
          method: '_on_coin_collected',
        },
      ],
      autoloads: [],
    });
    const scenesOutput: ScenesOutput = { index, sceneCount: 3, autoloadCount: 0 };

    const ctx = buildContext('/tmp/multiseg', graph);
    const output = await godotCrossrefPhase.execute(ctx, buildDeps(scenesOutput));

    expect(output.signalConnectionCount).toBe(1);
    const connects = [...graph.iterRelationships()].filter(
      (r) => r.type === 'CONNECTS_SIGNAL' && r.reason === 'declarative-connection',
    );
    expect(connects).toHaveLength(1);
    expect(connects[0].sourceId).toBe('Method:player.gd::coin_collected');
    expect(connects[0].targetId).toBe('Function:pause_menu.gd::_on_coin_collected');
  });

  it('does not emit autoload IMPORTS edges when no autoloads are registered', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gn-autoload-empty-'));
    try {
      writeFileSync(join(tmp, 'main.gd'), 'extends Node\nfunc _ready():\n    GameManager.save()\n');
      const graph = createKnowledgeGraph();
      seedFileNodes(graph, [{ path: 'main.gd' }]);

      const ctx = buildContext(tmp, graph);
      const scenesOutput: ScenesOutput = {
        index: createSceneIndex(),
        sceneCount: 0,
        autoloadCount: 0,
      };
      const deps = new Map<string, PhaseResult<unknown>>();
      deps.set('scenes', { phaseName: 'scenes', output: scenesOutput, durationMs: 0 });
      deps.set('parse', { phaseName: 'parse', output: { allPaths: ['main.gd'] }, durationMs: 0 });

      const output = await godotCrossrefPhase.execute(ctx, deps);
      expect(output.autoloadImportCount).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
