/**
 * SceneIndex
 *
 * Keyed lookup over Godot scene files and autoload registrations.
 * Populated by ScenesPhase during ingestion; consumed by GodotCrossrefPhase
 * (slice 7) and by AutoloadResolver inside the GDScript LanguageProvider
 * (slice 6) for identifier resolution.
 *
 * Stored data is intentionally the raw ParsedGodotResource — consumers
 * decide what to extract. Keeping the surface narrow makes the index easy
 * to test and stable across upstream rebases.
 */

import type { ParsedGodotResource } from './resource-parser.js';

export interface SceneIndex {
  addScene(path: string, parsed: ParsedGodotResource): void;
  getScene(path: string): ParsedGodotResource | undefined;
  allScenePaths(): readonly string[];

  addAutoload(name: string, scriptPath: string): void;
  getAutoload(name: string): string | undefined;
  allAutoloadNames(): readonly string[];
}

export function createSceneIndex(): SceneIndex {
  const scenes = new Map<string, ParsedGodotResource>();
  const autoloads = new Map<string, string>();

  return {
    addScene(path, parsed) {
      scenes.set(path, parsed);
    },
    getScene(path) {
      return scenes.get(path);
    },
    allScenePaths() {
      return [...scenes.keys()];
    },
    addAutoload(name, scriptPath) {
      autoloads.set(name, scriptPath);
    },
    getAutoload(name) {
      return autoloads.get(name);
    },
    allAutoloadNames() {
      return [...autoloads.keys()];
    },
  };
}
