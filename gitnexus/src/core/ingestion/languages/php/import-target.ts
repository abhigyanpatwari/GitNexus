/**
 * Adapter from `(ParsedImport, WorkspaceIndex)` → concrete file path.
 *
 * Delegates to the existing `resolvePhpImportInternal` (PSR-4 via
 * composer.json + suffix matching fallback). The `WorkspaceIndex` is
 * opaque at this layer; consumers wire a `PhpResolveContext` shape
 * carrying `fromFile` + `allFilePaths`.
 *
 * `loadPhpComposerConfig` is the `ScopeResolver.loadResolutionConfig`
 * implementation — it loads `composer.json` once per workspace pass and
 * threads the parsed config into every subsequent `resolveImportTarget`
 * call via the opaque `resolutionConfig` parameter.
 *
 * Returning `null` lets the finalize algorithm mark the edge as
 * `linkStatus: 'unresolved'`.
 */

import type { ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import { resolvePhpImportInternal } from '../../import-resolvers/php.js';
import type { ComposerConfig } from '../../language-config.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PhpResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

// ─── loadResolutionConfig ──────────────────────────────────────────────────

/**
 * Load and parse `composer.json` from the repo root. Returns a
 * `ComposerConfig` object (PSR-4 namespace → directory mappings) or
 * `null` when no `composer.json` is present or it cannot be parsed.
 *
 * The result is threaded into each `resolvePhpImportInternal` call as
 * the `composerConfig` argument.
 */
export function loadPhpComposerConfig(repoPath: string): ComposerConfig | null {
  try {
    const composerPath = join(repoPath, 'composer.json');
    const raw = readFileSync(composerPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;

    const composer = parsed as Record<string, unknown>;
    const autoload = composer['autoload'] as Record<string, unknown> | undefined;
    if (autoload === undefined) return null;

    const psr4Raw = (autoload['psr-4'] ?? {}) as Record<string, string | string[]>;
    const psr4 = new Map<string, string>();

    for (const [ns, dirs] of Object.entries(psr4Raw)) {
      // namespace prefix ends with `\` — keep as-is; resolver strips it
      const normalizedNs = ns.replace(/\\$/, '');
      const dir = Array.isArray(dirs) ? dirs[0] : dirs;
      if (typeof dir === 'string') {
        // Normalize directory path (strip trailing slash)
        const normalizedDir = dir.replace(/\/+$/, '');
        psr4.set(normalizedNs, normalizedDir);
      }
    }

    return { psr4 };
  } catch {
    return null;
  }
}

// ─── resolvePhpImportTarget ────────────────────────────────────────────────

/**
 * LanguageProvider-shaped adapter: `(ParsedImport, WorkspaceIndex) → string | null`.
 *
 * The `WorkspaceIndex` is `unknown` in the shared contract. The scope-resolution
 * orchestrator hands us a `PhpResolveContext`-shaped object; narrow structurally
 * rather than via a cast chain so unexpected shapes return `null` cleanly.
 */
export function resolvePhpImportTarget(
  parsedImport: ParsedImport,
  workspaceIndex: WorkspaceIndex,
): string | null {
  const ctx = workspaceIndex as PhpResolveContext | undefined;
  if (
    ctx === undefined ||
    typeof (ctx as { fromFile?: unknown }).fromFile !== 'string' ||
    !((ctx as { allFilePaths?: unknown }).allFilePaths instanceof Set)
  ) {
    return null;
  }
  if (parsedImport.kind === 'dynamic-unresolved') return null;
  if (parsedImport.targetRaw === null || parsedImport.targetRaw === '') return null;

  const allFiles = ctx.allFilePaths as Set<string>;
  const normalizedFileList = [...allFiles].map((f) => f.replace(/\\/g, '/'));
  const allFileList = [...allFiles];

  return resolvePhpImportInternal(
    parsedImport.targetRaw,
    null, // composerConfig not available through LanguageProvider path
    allFiles,
    normalizedFileList,
    allFileList,
    undefined,
  );
}

/**
 * ScopeResolver-shaped adapter: `(targetRaw, fromFile, allFilePaths, resolutionConfig?) → string | null`.
 *
 * Used inside `scope-resolver.ts`. Accepts the optional `resolutionConfig`
 * (a `ComposerConfig | null` loaded once per workspace by
 * `loadPhpComposerConfig`) and threads it into `resolvePhpImportInternal`.
 */
export function resolvePhpImportTargetInternal(
  targetRaw: string,
  _fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
): string | null {
  if (targetRaw === '') return null;

  const composerConfig =
    resolutionConfig !== undefined && resolutionConfig !== null
      ? (resolutionConfig as ComposerConfig)
      : null;

  const allFiles = allFilePaths as Set<string>;
  const normalizedFileList = [...allFiles].map((f) => f.replace(/\\/g, '/'));
  const allFileList = [...allFiles];

  return resolvePhpImportInternal(
    targetRaw,
    composerConfig,
    allFiles,
    normalizedFileList,
    allFileList,
    undefined,
  );
}
