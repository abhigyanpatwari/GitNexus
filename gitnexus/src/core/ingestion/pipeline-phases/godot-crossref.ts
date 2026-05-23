/**
 * Phase: godot-crossref
 *
 * Joins the SceneIndex (populated by `scenes`) with the File and symbol
 * nodes the upstream phases materialize, and emits four kinds of
 * cross-file edges for Godot scene + autoload relationships:
 *
 *   - MEMBER_OF (reason='script-attached')
 *       .tscn File -> .gd File
 *       Emitted whenever a [node] has `script = ExtResource("X")` and
 *       the X-resource resolves to a Script.
 *
 *   - USES (reason='scene-instance')
 *       parent .tscn File -> child .tscn File
 *       Emitted whenever a [node] uses `instance=ExtResource("X")` and X
 *       resolves to a PackedScene.
 *
 *   - CONNECTS_SIGNAL (reason='declarative-connection')
 *       emitter signal symbol -> handler method symbol
 *       Emitted for every [connection] entry whose `from` and `to` node
 *       paths can be resolved to a script with the named symbol present
 *       in the graph. Built-in signals (Timer.timeout, Button.pressed,
 *       etc.) and connections whose endpoints can't be resolved are
 *       silently skipped — they have no user-script symbol to attach an
 *       edge to.
 *
 *   - IMPORTS (reason='autoload')
 *       .gd File -> autoload script File
 *       Emitted for every .gd file that textually references a registered
 *       autoload name as an identifier. One edge per (file, autoload)
 *       pair, not per usage.
 *
 * @deps    parse, scenes
 * @reads   index (scenes), graph (File + symbol nodes), allPaths (parse)
 * @writes  graph (MEMBER_OF, USES, CONNECTS_SIGNAL, IMPORTS edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ScenesOutput } from './scenes.js';
import type { ParseOutput } from './parse.js';
import { generateId } from '../../../lib/utils.js';
import type {
  ParsedGodotResource,
  SceneNode,
} from '../godot/resource-parser.js';
import type { SceneIndex } from '../godot/scene-index.js';
import { resolveAutoload } from '../godot/autoload-resolver.js';
import { readFileContents } from '../filesystem-walker.js';
import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import type { GraphNode } from 'gitnexus-shared';

const _require = createRequire(import.meta.url);

export interface GodotCrossrefOutput {
  scriptAttachedCount: number;
  sceneInstanceCount: number;
  signalConnectionCount: number;
  autoloadImportCount: number;
}

function stripResPrefix(path: string): string {
  return path.startsWith('res://') ? path.slice('res://'.length) : path;
}

function findSceneNode(name: string, scene: ParsedGodotResource): SceneNode | null {
  if (name === '.') return scene.nodes.find((n) => n.parent === null) ?? null;
  return scene.nodes.find((n) => n.name === name && n.parent === '.') ?? null;
}

/**
 * Walk a scene-node reference (e.g. ".", "Player", "HUD") down to the
 * .gd script attached to its root. Handles instanced scenes by recursing
 * into the instanced scene's root node — necessary because a connection
 * may reference an instanced child whose script lives in the child
 * scene's source .tscn, not the current scene.
 */
function resolveNodeScriptPath(
  nodePathRef: string,
  scene: ParsedGodotResource,
  sceneIndex: SceneIndex,
): string | null {
  const node = findSceneNode(nodePathRef, scene);
  if (node === null) return null;
  return resolveScriptAttachment(node, scene, sceneIndex);
}

function resolveScriptAttachment(
  node: SceneNode,
  scene: ParsedGodotResource,
  sceneIndex: SceneIndex,
): string | null {
  const scriptProp = node.properties.script;
  if (scriptProp !== undefined && scriptProp.kind === 'ext_resource_ref') {
    const ext = scene.extResources.find((e) => e.id === scriptProp.id);
    if (ext !== undefined && ext.type === 'Script') {
      return stripResPrefix(ext.path);
    }
  }
  if (node.instanceExtResourceId !== null) {
    const ext = scene.extResources.find((e) => e.id === node.instanceExtResourceId);
    if (ext !== undefined && ext.type === 'PackedScene') {
      const childScenePath = `res://${stripResPrefix(ext.path)}`;
      const childScene = sceneIndex.getScene(childScenePath);
      if (childScene !== undefined) {
        const root = childScene.nodes.find((n) => n.parent === null);
        if (root !== undefined) return resolveScriptAttachment(root, childScene, sceneIndex);
      }
    }
  }
  return null;
}

/** filePath -> name -> GraphNode (Method/Function/Variable). */
function buildSymbolIndex(
  graph: PipelineContext['graph'],
): Map<string, Map<string, GraphNode>> {
  const out = new Map<string, Map<string, GraphNode>>();
  graph.forEachNode((node) => {
    if (node.label !== 'Method' && node.label !== 'Function' && node.label !== 'Variable') return;
    const filePath = node.properties.filePath;
    if (typeof filePath !== 'string' || filePath.length === 0) return;
    let inner = out.get(filePath);
    if (inner === undefined) {
      inner = new Map();
      out.set(filePath, inner);
    }
    inner.set(node.properties.name, node);
  });
  return out;
}

let cachedGdScriptParser: Parser | null = null;
function getGdScriptParser(): Parser {
  if (cachedGdScriptParser !== null) return cachedGdScriptParser;
  const grammar = _require('tree-sitter-gdscript');
  const parser = new Parser();
  parser.setLanguage(grammar);
  cachedGdScriptParser = parser;
  return parser;
}

/** Returns the set of autoload names referenced as identifiers in the file. */
function scanAutoloadRefs(content: string, autoloadNames: ReadonlySet<string>): Set<string> {
  if (autoloadNames.size === 0) return new Set();
  const parser = getGdScriptParser();
  const tree = parser.parse(content);
  const language = parser.getLanguage();
  const query = new (
    Parser as unknown as { Query: new (lang: unknown, src: string) => unknown }
  ).Query(language, '(identifier) @id');
  const captures = (
    query as { captures: (n: unknown) => Array<{ name: string; node: { text: string } }> }
  ).captures(tree.rootNode);
  const refs = new Set<string>();
  for (const cap of captures) {
    if (autoloadNames.has(cap.node.text)) refs.add(cap.node.text);
  }
  return refs;
}

export const godotCrossrefPhase: PipelinePhase<GodotCrossrefOutput> = {
  name: 'godot-crossref',
  deps: ['parse', 'scenes'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<GodotCrossrefOutput> {
    const scenes = getPhaseOutput<ScenesOutput>(deps, 'scenes');
    const parse = getPhaseOutput<ParseOutput>(deps, 'parse');

    let scriptAttachedCount = 0;
    let sceneInstanceCount = 0;
    let signalConnectionCount = 0;
    let autoloadImportCount = 0;

    // Build O(1) symbol lookup once per phase invocation.
    const symbolIndex = buildSymbolIndex(ctx.graph);

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

      // ── Script attachment + scene instancing edges ─────────────────
      for (const node of scene.nodes) {
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

      // ── CONNECTS_SIGNAL edges ──────────────────────────────────────
      for (const conn of scene.connections) {
        const fromScript = resolveNodeScriptPath(conn.from, scene, scenes.index);
        const toScript = resolveNodeScriptPath(conn.to, scene, scenes.index);
        if (fromScript === null || toScript === null) continue;
        const emitter = symbolIndex.get(fromScript)?.get(conn.signal);
        const handler = symbolIndex.get(toScript)?.get(conn.method);
        if (emitter === undefined || handler === undefined) continue;
        ctx.graph.addRelationship({
          id: generateId(
            'rel',
            `${emitter.id}->${handler.id}:connects-signal:${scenePath}:${conn.from}:${conn.signal}`,
          ),
          sourceId: emitter.id,
          targetId: handler.id,
          type: 'CONNECTS_SIGNAL',
          confidence: 0.95,
          reason: 'declarative-connection',
        });
        signalConnectionCount += 1;
      }
    }

    // ── IMPORTS (autoload) edges ─────────────────────────────────────
    const autoloadNames = new Set(scenes.index.allAutoloadNames());
    if (autoloadNames.size > 0) {
      const gdPaths = parse.allPaths.filter((p) => p.endsWith('.gd'));
      if (gdPaths.length > 0) {
        const contents = await readFileContents(ctx.repoPath, gdPaths);
        for (const gdPath of gdPaths) {
          const content = contents.get(gdPath);
          if (content === undefined) continue;
          const sourceId = `File:${gdPath}`;
          if (ctx.graph.getNode(sourceId) === undefined) continue;
          const refs = scanAutoloadRefs(content, autoloadNames);
          for (const name of refs) {
            const targetPath = resolveAutoload(name, scenes.index);
            if (targetPath === null) continue;
            const targetRel = stripResPrefix(targetPath);
            const targetId = `File:${targetRel}`;
            if (ctx.graph.getNode(targetId) === undefined) continue;
            if (sourceId === targetId) continue; // self-references aren't imports
            ctx.graph.addRelationship({
              id: generateId('rel', `${sourceId}->${targetId}:autoload:${name}`),
              sourceId,
              targetId,
              type: 'IMPORTS',
              confidence: 0.85,
              reason: 'autoload',
            });
            autoloadImportCount += 1;
          }
        }
      }
    }

    return {
      scriptAttachedCount,
      sceneInstanceCount,
      signalConnectionCount,
      autoloadImportCount,
    };
  },
};
