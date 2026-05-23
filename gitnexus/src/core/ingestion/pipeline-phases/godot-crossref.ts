/**
 * Phase: godot-crossref
 *
 * Joins the SceneIndex (populated by `scenes`) with the File nodes that
 * the `structure` phase materializes and emits cross-file edges for
 * Godot scene relationships:
 *
 *   - MEMBER_OF (reason='script-attached')
 *       .tscn File -> .gd File
 *       Emitted whenever a [node] has `script = ExtResource("X")` and
 *       the X-resource resolves to a Script.
 *
 *   - USES (reason='scene-instance')
 *       parent .tscn File -> child .tscn File
 *       Emitted whenever a [node] is instanced via
 *       `instance=ExtResource("X")` and X resolves to a PackedScene.
 *
 * Deferred to a follow-on slice once GDScript extractor configs land:
 *   - CONNECTS_SIGNAL — needs Method nodes for emitter / handler scripts
 *   - IMPORTS (reason='autoload') — needs walking GDScript identifier
 *     references against the SceneIndex autoload registry
 *
 * @deps    parse, scenes
 * @reads   index (scenes), graph (File nodes from structure)
 * @writes  graph (MEMBER_OF and USES edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ScenesOutput } from './scenes.js';
import { generateId } from '../../../lib/utils.js';

export interface GodotCrossrefOutput {
  scriptAttachedCount: number;
  sceneInstanceCount: number;
}

function stripResPrefix(path: string): string {
  return path.startsWith('res://') ? path.slice('res://'.length) : path;
}

export const godotCrossrefPhase: PipelinePhase<GodotCrossrefOutput> = {
  name: 'godot-crossref',
  deps: ['parse', 'scenes'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<GodotCrossrefOutput> {
    const scenes = getPhaseOutput<ScenesOutput>(deps, 'scenes');

    let scriptAttachedCount = 0;
    let sceneInstanceCount = 0;

    for (const scenePath of scenes.index.allScenePaths()) {
      const scene = scenes.index.getScene(scenePath);
      if (scene === undefined) continue;

      const sceneRelPath = stripResPrefix(scenePath);
      const sceneNodeId = `File:${sceneRelPath}`;
      if (ctx.graph.getNode(sceneNodeId) === undefined) continue;

      const extByid = new Map<string, { type: string; path: string }>();
      for (const er of scene.extResources) {
        extByid.set(er.id, { type: er.type, path: er.path });
      }

      for (const node of scene.nodes) {
        // ── Script attachment ────────────────────────────────────────
        const scriptProp = node.properties.script;
        if (scriptProp !== undefined && scriptProp.kind === 'ext_resource_ref') {
          const ext = extByid.get(scriptProp.id);
          if (ext !== undefined && ext.type === 'Script') {
            const scriptRelPath = stripResPrefix(ext.path);
            const scriptNodeId = `File:${scriptRelPath}`;
            if (ctx.graph.getNode(scriptNodeId) !== undefined) {
              ctx.graph.addRelationship({
                id: generateId(
                  'rel',
                  `${sceneNodeId}->${scriptNodeId}:script-attached:${node.name}`,
                ),
                sourceId: sceneNodeId,
                targetId: scriptNodeId,
                type: 'MEMBER_OF',
                confidence: 0.95,
                reason: 'script-attached',
              });
              scriptAttachedCount += 1;
            }
          }
        }

        // ── Scene instancing ─────────────────────────────────────────
        if (node.instanceExtResourceId !== null) {
          const ext = extByid.get(node.instanceExtResourceId);
          if (ext !== undefined && ext.type === 'PackedScene') {
            const childRelPath = stripResPrefix(ext.path);
            const childNodeId = `File:${childRelPath}`;
            if (ctx.graph.getNode(childNodeId) !== undefined) {
              ctx.graph.addRelationship({
                id: generateId(
                  'rel',
                  `${sceneNodeId}->${childNodeId}:scene-instance:${node.name}`,
                ),
                sourceId: sceneNodeId,
                targetId: childNodeId,
                type: 'USES',
                confidence: 0.95,
                reason: 'scene-instance',
              });
              sceneInstanceCount += 1;
            }
          }
        }
      }
    }

    return { scriptAttachedCount, sceneInstanceCount };
  },
};
