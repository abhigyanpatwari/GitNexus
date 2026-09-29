/**
 * `resolveImportTarget` adapter for the Swift `ScopeResolver`.
 *
 * With workspace modules (`loadSwiftWorkspaceConfig`), `import X` resolves to
 * the files of every importable module named X, as the compiler does. SwiftPM
 * rejects duplicate target names within one build graph, so several modules
 * named X belong to separate graphs; returning all of them is the sound
 * approximation. A name no module carries is external when every manifest and
 * project was read completely (`moduleNamesComplete`).
 *
 * Without workspace modules, a Package.swift declaration map
 * (`origin: 'package.swift'`) resolves only declared target names. Otherwise
 * refuse well-known SDK module names and fall back to the memoized
 * directory-segment index so local folder modules still resolve without a
 * manifest.
 *
 * Same-module visibility without `import` is `populateSwiftTargetSiblings`.
 * This adapter only resolves EXPLICIT cross-module `import`s.
 */

import type { ParsedFile, ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import {
  coerceDeclaredSwiftTargets,
  swiftDeclaredTargetPrefix,
  type SwiftPackageConfig,
} from '../../language-config.js';
import { swiftModuleKeysOf, swiftModuleSpecOf } from './target-grouping.js';
import { isSwiftSdkModule } from './sdk-modules.js';

export interface SwiftResolveContext {
  readonly fromFile: string;
  /** `ReadonlySet` so the orchestrator's stable run-level set flows
   *  straight through to the memoized index key. */
  readonly allFilePaths: ReadonlySet<string>;
  readonly resolutionConfig?: unknown;
  readonly parsedFiles?: readonly ParsedFile[];
}

interface SwiftModuleIndex {
  /** Module (directory-segment) name → original-case `.swift` files
   *  whose path contains a `/<module>/` directory segment. */
  readonly byModule: Map<string, string[]>;
}

interface SwiftDeclaredFileIndex {
  readonly declared: ReadonlyMap<string, string>;
  readonly byName: ReadonlyMap<string, string[]>;
}

const getSwiftModuleIndex = perFileSet((allFilePaths: ReadonlySet<string>): SwiftModuleIndex => {
  const byModule = new Map<string, string[]>();
  for (const raw of allFilePaths) {
    const norm = raw.replace(/\\/g, '/');
    if (!norm.endsWith('.swift')) continue;
    const segments = norm.split('/');
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (seg === '') continue;
      let bucket = byModule.get(seg);
      if (bucket === undefined) {
        bucket = [];
        byModule.set(seg, bucket);
      }
      bucket.push(raw);
    }
  }

  return { byModule };
});

const SWIFT_DECLARED_INDEX = new WeakMap<ReadonlySet<string>, SwiftDeclaredFileIndex>();

const SWIFT_MODULE_NAME_INDEX = new WeakMap<
  ReadonlySet<string>,
  { readonly config: object; readonly byName: ReadonlyMap<string, string[]> }
>();

/** Workspace-module config, or null for a hand-built or root-only config. */
function workspaceModulesConfig(resolutionConfig: unknown): Partial<SwiftPackageConfig> | null {
  const config = resolutionConfig as Partial<SwiftPackageConfig> | null | undefined;
  return config != null && Array.isArray(config.modules) ? config : null;
}

function isKnownModuleName(config: Partial<SwiftPackageConfig>, moduleName: string): boolean {
  return (config.modules ?? []).some((spec) => spec.name === moduleName);
}

/** Importable module name → member `.swift` files, memoized per file set. */
function getModuleFilesByName(
  allFilePaths: ReadonlySet<string>,
  config: object,
): ReadonlyMap<string, string[]> {
  const hit = SWIFT_MODULE_NAME_INDEX.get(allFilePaths);
  if (hit !== undefined && hit.config === config) return hit.byName;
  const byName = new Map<string, string[]>();
  for (const raw of allFilePaths) {
    if (!raw.endsWith('.swift')) continue;
    for (const key of swiftModuleKeysOf(raw, config)) {
      const spec = swiftModuleSpecOf(key, config);
      if (spec === undefined || !spec.importable) continue;
      const bucket = byName.get(spec.name);
      if (bucket === undefined) byName.set(spec.name, [raw]);
      else bucket.push(raw);
    }
  }
  SWIFT_MODULE_NAME_INDEX.set(allFilePaths, { config, byName });
  return byName;
}

function getDeclaredFilesByName(
  allFilePaths: ReadonlySet<string>,
  declared: ReadonlyMap<string, string>,
): ReadonlyMap<string, string[]> {
  const hit = SWIFT_DECLARED_INDEX.get(allFilePaths);
  if (hit !== undefined && hit.declared === declared) return hit.byName;

  const dirs = [...declared.entries()].map(([name, dir]) => ({
    name,
    prefix: swiftDeclaredTargetPrefix(dir),
  }));
  const byName = new Map<string, string[]>();
  for (const { name } of dirs) byName.set(name, []);

  for (const raw of allFilePaths) {
    const norm = raw.replace(/\\/g, '/');
    if (!norm.endsWith('.swift')) continue;
    for (const { name, prefix } of dirs) {
      if (!norm.startsWith(prefix) && !norm.includes(`/${prefix}`)) continue;
      const bucket = byName.get(name);
      if (bucket !== undefined) bucket.push(raw);
    }
  }

  const index = { declared, byName };
  SWIFT_DECLARED_INDEX.set(allFilePaths, index);
  return byName;
}

const getSwiftReexportFlag = perFileSet(
  (parsedFiles: readonly ParsedFile[]): { hasReexport: boolean } => {
    for (const parsed of parsedFiles) {
      for (const imp of parsed.parsedImports) {
        if (imp.kind === 'reexport') return { hasReexport: true };
      }
    }
    return { hasReexport: false };
  },
);

const getSwiftParsedByPath = perFileSet(
  (parsedFiles: readonly ParsedFile[]): ReadonlyMap<string, ParsedFile> => {
    const byPath = new Map<string, ParsedFile>();
    for (const parsed of parsedFiles) {
      byPath.set(parsed.filePath, parsed);
    }
    return byPath;
  },
);

function excludeImporter(files: readonly string[], fromFile: string): string[] {
  return files.filter((f) => f !== fromFile);
}

function firstSwiftModuleSegment(targetRaw: string): string | null {
  if (targetRaw === '') return null;
  const moduleName = targetRaw.split('.')[0];
  return moduleName === '' ? null : moduleName;
}

function narrowContext(workspaceIndex: WorkspaceIndex): SwiftResolveContext | null {
  const ctx = workspaceIndex as SwiftResolveContext | undefined;
  const allFilePaths = (ctx as { allFilePaths?: unknown } | undefined)?.allFilePaths;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    typeof (allFilePaths as { has?: unknown } | undefined)?.has !== 'function' ||
    typeof (allFilePaths as Iterable<string> | undefined)?.[Symbol.iterator] !== 'function'
  ) {
    return null;
  }
  return ctx;
}

/** Module files only — no @_exported closure. Null means external / unknown. */
function resolveSwiftModuleFiles(moduleName: string, ctx: SwiftResolveContext): string[] | null {
  if (moduleName === '') return null;

  const workspace = workspaceModulesConfig(ctx.resolutionConfig);
  if (workspace !== null) {
    const files = getModuleFilesByName(ctx.allFilePaths, workspace).get(moduleName);
    if (files !== undefined) {
      const out = excludeImporter(files, ctx.fromFile);
      return out.length > 0 ? out : null;
    }
    // Known but non-importable (a plugin), or every manifest was read: external.
    if (workspace.moduleNamesComplete === true || isKnownModuleName(workspace, moduleName)) {
      return null;
    }
  }

  const declared = workspace === null ? coerceDeclaredSwiftTargets(ctx.resolutionConfig) : null;
  if (declared !== null) {
    if (!declared.has(moduleName)) return null;
    const files = getDeclaredFilesByName(ctx.allFilePaths, declared).get(moduleName);
    if (files === undefined) return null;
    const out = excludeImporter(files, ctx.fromFile);
    return out.length > 0 ? out : null;
  }

  if (isSwiftSdkModule(moduleName)) return null;

  const index = getSwiftModuleIndex(ctx.allFilePaths);
  const files = index.byModule.get(moduleName);
  if (files === undefined || files.length === 0) return null;
  const out = excludeImporter(files, ctx.fromFile);
  return out.length > 0 ? out : null;
}

function expandSwiftReexportFiles(seed: readonly string[], ctx: SwiftResolveContext): string[] {
  const parsedFiles = ctx.parsedFiles;
  if (parsedFiles === undefined || parsedFiles.length === 0) return [...seed];
  if (!getSwiftReexportFlag(parsedFiles).hasReexport) return [...seed];
  const byPath = getSwiftParsedByPath(parsedFiles);

  const seenModules = new Set<string>();
  const out = new Set(seed);
  const queue = [...seed];
  let head = 0;

  while (head < queue.length) {
    const file = queue[head++];
    const parsed = byPath.get(file);
    if (parsed === undefined) continue;
    for (const imp of parsed.parsedImports) {
      if (imp.kind !== 'reexport') continue;
      const targetRaw = imp.targetRaw;
      if (targetRaw === null) continue;
      const moduleName = firstSwiftModuleSegment(targetRaw);
      if (moduleName === null || seenModules.has(moduleName)) continue;
      // `@_exported import struct Models.User` re-exports User, not Models.
      // File-level resolve cannot attribute a member to a file, so skip
      // the whole-module enqueue rather than painting every Models file.
      if (imp.importedName !== moduleName) continue;
      seenModules.add(moduleName);
      const more = resolveSwiftModuleFiles(moduleName, ctx);
      if (more === null) continue;
      for (const next of more) {
        if (out.has(next)) continue;
        out.add(next);
        queue.push(next);
      }
    }
  }

  return [...out];
}

export function resolveSwiftImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | readonly string[] | null {
  const ctx = narrowContext(workspaceIndex);
  if (ctx === null) return null;

  const targetRaw = parsedImport.targetRaw;
  if (targetRaw === null) return null;
  const moduleName = firstSwiftModuleSegment(targetRaw);
  if (moduleName === null) return null;

  const files = resolveSwiftModuleFiles(moduleName, ctx);
  if (files === null) return null;
  const expanded = expandSwiftReexportFiles(files, ctx);
  return expanded.length > 0 ? expanded : null;
}
