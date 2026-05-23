/**
 * GDScript import resolution config.
 *
 * GDScript expresses dependencies via `preload("res://path.gd")` and
 * `load("res://path.gd")` calls. The `res://` scheme rooted at the Godot
 * project (which we treat as the repo root) is the only import form we
 * resolve in v1; runtime resource lookups, `class_name`-based global
 * references, and `extends "res://..."` inheritance arrive in later slices.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import type { ImportResolutionConfig, ImportResolverStrategy } from '../types.js';

const RES_PREFIX = 'res://';

export const gdscriptResStrategy: ImportResolverStrategy = (rawImportPath, _filePath, ctx) => {
  if (!rawImportPath.startsWith(RES_PREFIX)) return null;
  const relative = rawImportPath.slice(RES_PREFIX.length);
  if (ctx.allFilePaths.has(relative)) {
    return { kind: 'files', files: [relative] };
  }
  return null;
};

export const gdscriptImportConfig: ImportResolutionConfig = {
  language: SupportedLanguages.Godot,
  strategies: [gdscriptResStrategy],
};
