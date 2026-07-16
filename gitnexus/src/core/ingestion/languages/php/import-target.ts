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

import type { ParsedFile, ParsedImport, WorkspaceIndex } from 'gitnexus-shared';
import type { ImportResolutionContext } from '../../scope-resolution/contract/scope-resolver.js';
import { resolvePhpImportInternal } from '../../import-resolvers/php.js';
import type { ComposerConfig } from '../../language-config.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PhpResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}

function normalizePhpPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function namespaceDirectories(
  targetRaw: string,
  composerConfig: ComposerConfig | null,
  resolved: string | null,
): string[] {
  const directories = new Set<string>();
  if (resolved !== null) {
    const normalizedResolved = normalizePhpPath(resolved);
    const separator = normalizedResolved.lastIndexOf('/');
    if (separator >= 0) directories.add(normalizedResolved.slice(0, separator));
  }

  if (composerConfig === null) return [...directories];

  const normalizedTarget = normalizePhpPath(targetRaw);
  const mappings = [...composerConfig.psr4.entries()].sort((left, right) => {
    const lengthDifference = right[0].length - left[0].length;
    return lengthDifference !== 0 ? lengthDifference : left[0].localeCompare(right[0]);
  });
  for (const [namespacePrefix, directoryPrefix] of mappings) {
    const normalizedPrefix = normalizePhpPath(namespacePrefix);
    if (
      normalizedTarget !== normalizedPrefix &&
      !normalizedTarget.startsWith(`${normalizedPrefix}/`)
    ) {
      continue;
    }

    const remainder = normalizedTarget.slice(normalizedPrefix.length).replace(/^\//, '');
    const separator = remainder.lastIndexOf('/');
    const relativeNamespace = separator >= 0 ? remainder.slice(0, separator) : '';
    directories.add(
      normalizePhpPath(
        relativeNamespace === '' ? directoryPrefix : `${directoryPrefix}/${relativeNamespace}`,
      ),
    );
    break;
  }
  return [...directories];
}

// A scope-resolution pass shares one stable parsedFiles array across imports.
const phpDirectoryIndexCache = new WeakMap<
  readonly ParsedFile[],
  ReadonlyMap<string, readonly ParsedFile[]>
>();

function parentDirectory(filePath: string): string {
  const normalizedPath = normalizePhpPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  return separator < 0 ? '' : normalizedPath.slice(0, separator);
}

function directoryAliases(filePath: string): string[] {
  const normalizedPath = normalizePhpPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  if (separator < 0) return [''];

  const parent = normalizedPath.slice(0, separator);
  const aliases = new Set([parent]);
  const segments = parent.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    aliases.add(segments.slice(index).join('/'));
  }
  return [...aliases];
}

function filesByDirectory(
  parsedFiles: readonly ParsedFile[],
): ReadonlyMap<string, readonly ParsedFile[]> {
  const cached = phpDirectoryIndexCache.get(parsedFiles);
  if (cached) return cached;

  const mutable = new Map<string, ParsedFile[]>();
  for (const parsed of parsedFiles) {
    for (const directory of directoryAliases(parsed.filePath)) {
      const files = mutable.get(directory) ?? [];
      files.push(parsed);
      mutable.set(directory, files);
    }
  }
  phpDirectoryIndexCache.set(parsedFiles, mutable);
  return mutable;
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
  context?: ImportResolutionContext,
): string | null {
  if (targetRaw === '') return null;

  const composerConfig =
    resolutionConfig !== undefined && resolutionConfig !== null
      ? (resolutionConfig as ComposerConfig)
      : null;

  const allFiles = allFilePaths as Set<string>;
  const normalizedFileList = [...allFiles].map((f) => f.replace(/\\/g, '/'));
  const allFileList = [...allFiles];

  const resolved = resolvePhpImportInternal(
    targetRaw,
    composerConfig,
    allFiles,
    normalizedFileList,
    allFileList,
    undefined,
  );

  const parsedImport = context?.parsedImport;
  const symbolKind =
    parsedImport?.kind === 'named' || parsedImport?.kind === 'alias'
      ? parsedImport.importedSymbolKind
      : undefined;
  if (
    context === undefined ||
    parsedImport === undefined ||
    (symbolKind !== 'function' && symbolKind !== 'const')
  ) {
    return resolved;
  }

  const importedName = targetRaw.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
  if (importedName === undefined) return resolved;

  const directories = namespaceDirectories(targetRaw, composerConfig, resolved);
  const directoryIndex = filesByDirectory(context.parsedFiles);
  const candidateFiles = [
    ...new Set(
      directories.flatMap((directory) => {
        const files = directoryIndex.get(normalizePhpPath(directory)) ?? [];
        // A suffix alias can match directories under different roots (for
        // example app/Models and vendor/pkg/app/Models). Picking either root
        // would be a guess, so fail closed to the composer resolution instead.
        const distinctParents = new Set(files.map((file) => parentDirectory(file.filePath)));
        return distinctParents.size > 1 ? [] : files;
      }),
    ),
  ];
  const expectedType = symbolKind === 'function' ? 'Function' : 'Variable';
  const declaringFiles = candidateFiles.filter((parsed) =>
    parsed.localDefs.some((def) => {
      if (def.type !== expectedType) return false;
      const simpleName = (def.qualifiedName ?? '').split(/[\\.]/).at(-1);
      return simpleName === importedName;
    }),
  );

  if (declaringFiles.length > 1) return null;
  if (declaringFiles.length === 1) return declaringFiles[0].filePath;

  // PHP constants are not currently emitted as local definitions. A single
  // file in the namespace directory is still unambiguous; multiple files must
  // fail closed rather than inheriting Set iteration order.
  if (symbolKind === 'const' && candidateFiles.length === 1) return candidateFiles[0].filePath;
  return resolved;
}
