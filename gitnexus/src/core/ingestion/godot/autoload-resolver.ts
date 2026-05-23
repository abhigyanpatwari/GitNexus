/**
 * AutoloadResolver
 *
 * Resolves a GDScript identifier to its registered autoload script path,
 * if any. Autoloads are global singletons declared in project.godot's
 * `[autoload]` section: any script can reference them by name (e.g.
 * `GameManager.save()`).
 *
 * The Godot autoload registry stores the script path with a leading `*`
 * for singleton mode (`*res://autoloads/foo.gd`); this resolver strips
 * that prefix so callers see a plain `res://...` path they can hand to
 * the GDScript import resolver.
 *
 * This module is pure and stateless. The actual emission of IMPORTS
 * edges from identifier usage lives in the godot-crossref phase
 * (slice 7), which walks GDScript symbol references and calls this
 * resolver for each candidate identifier.
 */

import type { SceneIndex } from './scene-index.js';

export function resolveAutoload(name: string, sceneIndex: SceneIndex): string | null {
  const raw = sceneIndex.getAutoload(name);
  if (raw === undefined) return null;
  return raw.startsWith('*') ? raw.slice(1) : raw;
}
