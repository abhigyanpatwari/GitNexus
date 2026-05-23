import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGodotResource } from '../../src/core/ingestion/godot/resource-parser.js';

const FIXTURES_DIR =
  process.env.GITNEXUS_GODOT_FIXTURES_DIR ??
  resolve(__dirname, '../../../../godot-demo-projects');

const MINIMAL_SCENE = `[gd_scene load_steps=2 format=3 uid="uid://abc123"]

[ext_resource type="Script" path="res://player.gd" id="1_player"]
[ext_resource type="PackedScene" path="res://enemy.tscn" id="2_enemy"]

[sub_resource type="CircleShape2D" id="CircleShape2D_1"]
radius = 16.0

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1_player")

[node name="Sprite" type="Sprite2D" parent="."]
position = Vector2(10, 20)

[node name="Hitbox" type="CollisionShape2D" parent="."]
shape = SubResource("CircleShape2D_1")

[node name="Enemy" parent="." instance=ExtResource("2_enemy")]
position = Vector2(100, 50)

[connection signal="died" from="Player" to="Sprite" method="_on_player_died"]
`;

const PROJECT_GODOT = `; Engine configuration file.
; It's best edited using the editor UI and not directly,
; since the parameters that go here are not all obvious.

config_version=5

[application]

config/name="Dodge The Creeps"
run/main_scene="res://main.tscn"

[autoload]

GameManager="*res://autoloads/game_manager.gd"
ScoreTracker="*res://autoloads/score_tracker.gd"

[rendering]

renderer/rendering_method="gl_compatibility"
`;

describe('parseGodotResource — scene files', () => {
  it('parses the gd_scene header', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    expect(parsed.header).not.toBeNull();
    expect(parsed.header?.kind).toBe('gd_scene');
    expect(parsed.header?.uid).toBe('uid://abc123');
    expect(parsed.header?.format).toBe(3);
  });

  it('extracts ext_resource entries with id, type, and path', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    expect(parsed.extResources).toHaveLength(2);
    expect(parsed.extResources).toEqual(
      expect.arrayContaining([
        { id: '1_player', type: 'Script', path: 'res://player.gd' },
        { id: '2_enemy', type: 'PackedScene', path: 'res://enemy.tscn' },
      ]),
    );
  });

  it('extracts sub_resource entries with id and type', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    expect(parsed.subResources).toHaveLength(1);
    expect(parsed.subResources[0]).toMatchObject({
      id: 'CircleShape2D_1',
      type: 'CircleShape2D',
    });
  });

  it('extracts scene nodes with name, type, and parent', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    const byName = new Map(parsed.nodes.map((n) => [n.name, n]));

    expect(parsed.nodes).toHaveLength(4);
    expect(byName.get('Player')).toMatchObject({ name: 'Player', type: 'CharacterBody2D', parent: null });
    expect(byName.get('Sprite')).toMatchObject({ name: 'Sprite', type: 'Sprite2D', parent: '.' });
    expect(byName.get('Hitbox')).toMatchObject({ name: 'Hitbox', type: 'CollisionShape2D', parent: '.' });
  });

  it('records ext_resource ids for instanced child scenes', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    const enemy = parsed.nodes.find((n) => n.name === 'Enemy');
    expect(enemy?.type).toBeNull();
    expect(enemy?.instanceExtResourceId).toBe('2_enemy');
  });

  it('records the script attachment ext_resource id on a node', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    const player = parsed.nodes.find((n) => n.name === 'Player');
    expect(player?.properties.script).toEqual({ kind: 'ext_resource_ref', id: '1_player' });
  });

  it('records sub_resource references in node properties', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    const hitbox = parsed.nodes.find((n) => n.name === 'Hitbox');
    expect(hitbox?.properties.shape).toEqual({ kind: 'sub_resource_ref', id: 'CircleShape2D_1' });
  });

  it('extracts signal connections', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    expect(parsed.connections).toHaveLength(1);
    expect(parsed.connections[0]).toEqual({
      signal: 'died',
      from: 'Player',
      to: 'Sprite',
      method: '_on_player_died',
    });
  });

  it('returns an empty autoloads array for scene files', () => {
    const parsed = parseGodotResource(MINIMAL_SCENE);
    expect(parsed.autoloads).toEqual([]);
  });
});

describe('parseGodotResource — project.godot', () => {
  it('returns no scene header for project.godot', () => {
    const parsed = parseGodotResource(PROJECT_GODOT);
    expect(parsed.header).toBeNull();
  });

  it('extracts autoload registrations', () => {
    const parsed = parseGodotResource(PROJECT_GODOT);
    expect(parsed.autoloads).toEqual(
      expect.arrayContaining([
        { name: 'GameManager', path: '*res://autoloads/game_manager.gd' },
        { name: 'ScoreTracker', path: '*res://autoloads/score_tracker.gd' },
      ]),
    );
  });

  it('does not produce nodes or connections from project.godot', () => {
    const parsed = parseGodotResource(PROJECT_GODOT);
    expect(parsed.nodes).toEqual([]);
    expect(parsed.connections).toEqual([]);
  });
});

describe('parseGodotResource — real godot-demo-projects fixtures', () => {
  const mainTscnPath = resolve(FIXTURES_DIR, '2d/dodge_the_creeps/main.tscn');

  it.skipIf(!existsSync(mainTscnPath))('parses dodge_the_creeps/main.tscn', () => {
    const parsed = parseGodotResource(readFileSync(mainTscnPath, 'utf8'));

    expect(parsed.header?.kind).toBe('gd_scene');
    expect(parsed.extResources.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        'res://main.gd',
        'res://mob.tscn',
        'res://player.tscn',
        'res://hud.tscn',
      ]),
    );

    const nodeNames = parsed.nodes.map((n) => n.name);
    expect(nodeNames).toEqual(
      expect.arrayContaining(['Main', 'Player', 'HUD', 'MobTimer', 'ScoreTimer']),
    );

    const main = parsed.nodes.find((n) => n.name === 'Main');
    expect(main?.properties.script).toEqual({ kind: 'ext_resource_ref', id: '1_0r6n5' });

    const player = parsed.nodes.find((n) => n.name === 'Player');
    expect(player?.type).toBeNull();
    expect(player?.instanceExtResourceId).toBe('3_veqnc');
  });
});
