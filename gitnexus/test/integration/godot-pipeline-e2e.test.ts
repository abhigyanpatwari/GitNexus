/**
 * End-to-end pipeline smoke test on a real Godot project fixture.
 *
 * Runs the entire ingestion pipeline (scan -> structure -> markdown ->
 * cobol -> scenes -> parse -> godot-crossref -> ...) against
 * godot-demo-projects/2d/dodge_the_creeps and asserts the produced graph
 * contains the Godot-specific edges the fork is supposed to add, as well
 * as the GDScript symbol nodes the existing pipeline extracts from .gd
 * captures.
 *
 * This is slice 8 of docs/plans/godot-support.md — the verification that
 * slices 1-7 hang together as a usable end-to-end story.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURES_DIR =
  process.env.GITNEXUS_GODOT_FIXTURES_DIR ??
  resolve(__dirname, '../../../../godot-demo-projects');

const dodgeCreeps = resolve(FIXTURES_DIR, '2d/dodge_the_creeps');

describe('end-to-end pipeline — dodge_the_creeps', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    if (!existsSync(dodgeCreeps)) return;
    result = await runPipelineFromRepo(dodgeCreeps, () => {}, { skipGraphPhases: true });
  }, 60000);

  it.skipIf(!existsSync(dodgeCreeps))('produces a non-empty graph', () => {
    expect(result.graph.nodeCount).toBeGreaterThan(0);
    expect(result.graph.relationshipCount).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(dodgeCreeps))('emits a script-attached MEMBER_OF edge for every scene', () => {
    const attachments = [...result.graph.iterRelationships()].filter(
      (r) => r.type === 'MEMBER_OF' && r.reason === 'script-attached',
    );
    const pairs = new Set(attachments.map((r) => `${r.sourceId}->${r.targetId}`));
    expect(pairs.has('File:player.tscn->File:player.gd')).toBe(true);
    expect(pairs.has('File:mob.tscn->File:mob.gd')).toBe(true);
    expect(pairs.has('File:main.tscn->File:main.gd')).toBe(true);
    expect(pairs.has('File:hud.tscn->File:hud.gd')).toBe(true);
  });

  it.skipIf(!existsSync(dodgeCreeps))('emits scene-instance USES edges for nested scenes', () => {
    const instances = [...result.graph.iterRelationships()].filter(
      (r) => r.type === 'USES' && r.reason === 'scene-instance',
    );
    const pairs = new Set(instances.map((r) => `${r.sourceId}->${r.targetId}`));
    expect(pairs.has('File:main.tscn->File:player.tscn')).toBe(true);
    expect(pairs.has('File:main.tscn->File:hud.tscn')).toBe(true);
  });

  it.skipIf(!existsSync(dodgeCreeps))('extracts GDScript symbol nodes from .gd files', () => {
    const labels = new Set<string>();
    result.graph.forEachNode((n) => labels.add(n.label));
    // GDScript captures yield Function and Variable definitions through
    // the existing capture-driven processor even though the per-language
    // extractor configs are still stubs.
    expect([...labels]).toEqual(expect.arrayContaining(['File', 'Function']));
  });

  it.skipIf(!existsSync(dodgeCreeps))('does not crash the existing call-graph machinery', () => {
    // Sanity: ordinary CALLS edges still get produced (i.e. .gd parsing
    // doesn't poison the cross-language pipeline).
    const calls = [...result.graph.iterRelationships()].filter((r) => r.type === 'CALLS');
    expect(calls.length).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(dodgeCreeps))(
    'emits CONNECTS_SIGNAL edges for the user-defined cross-scene signal wires',
    () => {
      const connects = [...result.graph.iterRelationships()].filter(
        (r) => r.type === 'CONNECTS_SIGNAL' && r.reason === 'declarative-connection',
      );

      // dodge_the_creeps has two user-defined cross-scene signals:
      //   main.tscn: [connection signal="hit" from="Player" to="." method="game_over"]
      //     -> Player is an instance of player.tscn, so the emitter `hit`
      //        lives in player.gd; the handler `game_over` is in main.gd.
      //   main.tscn: [connection signal="start_game" from="HUD" to="." method="new_game"]
      //     -> HUD instances hud.tscn; emitter `start_game` in hud.gd,
      //        handler `new_game` in main.gd.
      // The other 7 connections wire built-in signals (Timer.timeout,
      // Button.pressed, VisibleOnScreenNotifier2D.screen_exited,
      // body_entered) which have no user-script emitter symbol and are
      // intentionally skipped.
      expect(connects.length).toBeGreaterThanOrEqual(2);

      const sigLookups = connects.map((r) => {
        const src = result.graph.getNode(r.sourceId);
        const tgt = result.graph.getNode(r.targetId);
        return {
          fromFile: src?.properties.filePath,
          fromName: src?.properties.name,
          toFile: tgt?.properties.filePath,
          toName: tgt?.properties.name,
        };
      });

      expect(sigLookups).toContainEqual({
        fromFile: 'player.gd',
        fromName: 'hit',
        toFile: 'main.gd',
        toName: 'game_over',
      });
      expect(sigLookups).toContainEqual({
        fromFile: 'hud.gd',
        fromName: 'start_game',
        toFile: 'main.gd',
        toName: 'new_game',
      });
    },
  );
});
