/**
 * Phase: scenes
 *
 * Walks Godot scene/resource files (.tscn and project.godot), parses them
 * via parseGodotResource, and populates a SceneIndex that downstream phases
 * (godot-crossref in slice 7, GDScript autoload resolution in slice 6)
 * consume.
 *
 * Scene paths are keyed by `res://<relative-path>` so they match how scripts
 * reference scenes via preload()/load(). This is correct when the analyzed
 * repository IS a Godot project (project.godot at the repo root); analyzing
 * a meta-repo that contains multiple Godot projects will produce keys that
 * don't correspond to any in-game res:// path.
 *
 * @deps    structure
 * @reads   scannedFiles
 * @writes  graph (nothing yet — slice 7 emits edges from the SceneIndex)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import { readFileContents } from '../filesystem-walker.js';
import type { StructureOutput } from './structure.js';
import { parseGodotResource } from '../godot/resource-parser.js';
import { createSceneIndex, type SceneIndex } from '../godot/scene-index.js';

export interface ScenesOutput {
  /** The populated SceneIndex. Downstream phases look up scenes/autoloads here. */
  index: SceneIndex;
  /** Number of .tscn files indexed. */
  sceneCount: number;
  /** Number of autoload registrations indexed. */
  autoloadCount: number;
}

function isGodotResourceFile(path: string): boolean {
  if (path.endsWith('.tscn')) return true;
  const lastSlash = path.lastIndexOf('/');
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return basename === 'project.godot';
}

function isProjectGodot(path: string): boolean {
  const lastSlash = path.lastIndexOf('/');
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return basename === 'project.godot';
}

export const scenesPhase: PipelinePhase<ScenesOutput> = {
  name: 'scenes',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ScenesOutput> {
    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');

    const godotFiles = scannedFiles.filter((f) => isGodotResourceFile(f.path));
    const index = createSceneIndex();

    if (godotFiles.length === 0) {
      return { index, sceneCount: 0, autoloadCount: 0 };
    }

    const contents = await readFileContents(
      ctx.repoPath,
      godotFiles.map((f) => f.path),
    );

    let sceneCount = 0;
    let autoloadCount = 0;

    for (const { path } of godotFiles) {
      const content = contents.get(path);
      if (content === undefined) continue;

      const parsed = parseGodotResource(content);

      if (isProjectGodot(path)) {
        for (const autoload of parsed.autoloads) {
          index.addAutoload(autoload.name, autoload.path);
          autoloadCount += 1;
        }
        continue;
      }

      index.addScene(`res://${path}`, parsed);
      sceneCount += 1;
    }

    return { index, sceneCount, autoloadCount };
  },
};
