import { describe, it, expect } from 'vitest';
import { createSceneIndex } from '../../src/core/ingestion/godot/scene-index.js';
import type { ParsedGodotResource } from '../../src/core/ingestion/godot/resource-parser.js';

function emptyScene(): ParsedGodotResource {
  return {
    header: { kind: 'gd_scene', uid: null, format: 3 },
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
    autoloads: [],
  };
}

describe('SceneIndex', () => {
  it('starts empty', () => {
    const idx = createSceneIndex();
    expect(idx.allScenePaths()).toEqual([]);
    expect(idx.allAutoloadNames()).toEqual([]);
  });

  it('stores scenes keyed by res:// path', () => {
    const idx = createSceneIndex();
    const player = emptyScene();
    idx.addScene('res://player.tscn', player);
    expect(idx.getScene('res://player.tscn')).toBe(player);
    expect(idx.allScenePaths()).toEqual(['res://player.tscn']);
  });

  it('returns undefined for unknown scene paths', () => {
    const idx = createSceneIndex();
    expect(idx.getScene('res://missing.tscn')).toBeUndefined();
  });

  it('overwrites a scene when added again with the same path', () => {
    const idx = createSceneIndex();
    const first = emptyScene();
    const second = emptyScene();
    idx.addScene('res://player.tscn', first);
    idx.addScene('res://player.tscn', second);
    expect(idx.getScene('res://player.tscn')).toBe(second);
  });

  it('stores autoloads keyed by name and exposes script path', () => {
    const idx = createSceneIndex();
    idx.addAutoload('GameManager', '*res://autoloads/game_manager.gd');
    expect(idx.getAutoload('GameManager')).toBe('*res://autoloads/game_manager.gd');
    expect(idx.allAutoloadNames()).toEqual(['GameManager']);
  });

  it('returns undefined for unknown autoload names', () => {
    const idx = createSceneIndex();
    expect(idx.getAutoload('Nope')).toBeUndefined();
  });
});
