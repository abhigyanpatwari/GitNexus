/**
 * `resolveImportTarget` adapter for the Swift `ScopeResolver`.
 *
 * Hybrid (KTD1): a Package.swift declaration map (`origin: 'package.swift'`)
 * resolves only declared target names. Otherwise refuse well-known SDK
 * module names and fall back to the memoized directory-segment index so
 * local folder modules still resolve without a manifest (R7).
 *
 * Same-module visibility without `import` is `populateSwiftTargetSiblings`.
 * This adapter only resolves EXPLICIT cross-module `import`s.
 */

import type { ParsedFile, ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { perFileSet } from '../../import-resolvers/per-file-set.js';
import { coerceDeclaredSwiftTargets, fileMatchesSwiftTargetDir } from './target-grouping.js';
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

function filesForDeclaredTarget(
  allFilePaths: ReadonlySet<string>,
  targetDir: string,
  fromFile: string,
): string[] {
  const out: string[] = [];
  for (const raw of allFilePaths) {
    const norm = raw.replace(/\\/g, '/');
    if (!norm.endsWith('.swift')) continue;
    if (!fileMatchesSwiftTargetDir(norm, targetDir)) continue;
    if (raw === fromFile) continue;
    out.push(raw);
  }
  return out;
}

function excludeImporter(files: readonly string[], fromFile: string): string[] {
  return files.filter((f) => f !== fromFile);
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
export function resolveSwiftModuleFiles(
  moduleName: string,
  ctx: SwiftResolveContext,
): string[] | null {
  if (moduleName === '') return null;

  const declared = coerceDeclaredSwiftTargets(ctx.resolutionConfig);
  if (declared !== null) {
    const dir = declared.get(moduleName);
    if (dir === undefined) return null;
    const files = filesForDeclaredTarget(ctx.allFilePaths, dir, ctx.fromFile);
    return files.length > 0 ? files : null;
  }

  if (isSwiftSdkModule(moduleName)) return null;

  const index = getSwiftModuleIndex(ctx.allFilePaths);
  const files = index.byModule.get(moduleName);
  if (files === undefined || files.length === 0) return null;
  const out = excludeImporter(files, ctx.fromFile);
  return out.length > 0 ? out : null;
}

export function expandSwiftReexportFiles(seed: readonly string[], ctx: SwiftResolveContext): string[] {
  const parsedByPath = new Map((ctx.parsedFiles ?? []).map((pf) => [pf.filePath, pf]));
  if (parsedByPath.size === 0) return [...seed];

  const seenModules = new Set<string>();
  const out = new Set(seed);
  const queue = [...seed];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const parsed = parsedByPath.get(file);
    if (parsed === undefined) continue;
    for (const imp of parsed.parsedImports) {
      if (imp.kind !== 'reexport') continue;
      const targetRaw = imp.targetRaw;
      if (targetRaw === null || targetRaw === '') continue;
      const moduleName = targetRaw.split('.')[0];
      if (moduleName === '' || seenModules.has(moduleName)) continue;
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
  if (targetRaw === null || targetRaw === '') return null;
  const moduleName = targetRaw.split('.')[0];
  if (moduleName === '') return null;

  const files = resolveSwiftModuleFiles(moduleName, ctx);
  if (files === null) return null;
  const expanded = expandSwiftReexportFiles(files, ctx);
  return expanded.length > 0 ? expanded : null;
}
