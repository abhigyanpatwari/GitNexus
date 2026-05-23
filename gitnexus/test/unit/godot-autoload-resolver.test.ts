import { describe, it, expect } from 'vitest';
import { resolveAutoload } from '../../src/core/ingestion/godot/autoload-resolver.js';
import { createSceneIndex } from '../../src/core/ingestion/godot/scene-index.js';

describe('resolveAutoload', () => {
  it('returns null for an empty SceneIndex', () => {
    const idx = createSceneIndex();
    expect(resolveAutoload('GameManager', idx)).toBeNull();
  });

  it('returns null for an unknown identifier', () => {
    const idx = createSceneIndex();
    idx.addAutoload('GameManager', '*res://autoloads/game_manager.gd');
    expect(resolveAutoload('NotAnAutoload', idx)).toBeNull();
  });

  it('returns the script path with the singleton prefix stripped', () => {
    const idx = createSceneIndex();
    idx.addAutoload('GameManager', '*res://autoloads/game_manager.gd');
    expect(resolveAutoload('GameManager', idx)).toBe('res://autoloads/game_manager.gd');
  });

  it('passes through paths that lack the singleton prefix', () => {
    const idx = createSceneIndex();
    // Godot autoloads without "*" register a non-singleton scene rather than
    // a singleton script — we still surface the path so callers can decide.
    idx.addAutoload('SceneRoot', 'res://ui/scene_root.tscn');
    expect(resolveAutoload('SceneRoot', idx)).toBe('res://ui/scene_root.tscn');
  });

  it('is case-sensitive (Godot autoload names are identifiers)', () => {
    const idx = createSceneIndex();
    idx.addAutoload('GameManager', '*res://gm.gd');
    expect(resolveAutoload('gamemanager', idx)).toBeNull();
    expect(resolveAutoload('GAMEMANAGER', idx)).toBeNull();
    expect(resolveAutoload('GameManager', idx)).toBe('res://gm.gd');
  });
});
