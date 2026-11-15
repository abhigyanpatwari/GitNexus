import type { ParsedFile } from 'gitnexus-shared';
import { dartProvider } from '../dart.js';
import { emitDartScopeCaptures } from './captures.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import type { DartPackageConfig } from './package-config.js';

const versionsByConfig = new WeakMap<DartPackageConfig, Map<string, string | null>>();

function packageVersion(filePath: string, config: DartPackageConfig | undefined): string | null {
  const versions = config?.languageVersionsByDirectory;
  if (versions === undefined || config === undefined) return null;
  let cached = versionsByConfig.get(config);
  if (cached === undefined) {
    cached = new Map();
    versionsByConfig.set(config, cached);
  }
  let directory = filePath.slice(0, Math.max(0, filePath.lastIndexOf('/')));
  const visited: string[] = [];
  let version: string | null;
  while (true) {
    if (cached.has(directory)) {
      version = cached.get(directory)!;
      break;
    }
    if (versions.has(directory)) {
      version = versions.get(directory)!;
      break;
    }
    visited.push(directory);
    if (directory === '') {
      version = null;
      break;
    }
    directory = directory.slice(0, Math.max(0, directory.lastIndexOf('/')));
  }
  for (const dir of visited) cached.set(dir, version);
  return version;
}

export function requiresDartPackageSource(filePath: string, config: unknown): boolean {
  const version = packageVersion(filePath, config as DartPackageConfig | undefined);
  if (version === null) return false;
  const [major, minor] = version.split('.').map(Number);
  return major! < 3 || (major === 3 && minor! < 7);
}

/** Package metadata is acquired after worker capture and can change without a
 * source edit. Re-extract legacy files here, on both cold and warm runs, so a
 * cached 3.7 capture cannot erase an older package's `_` bindings. Modern
 * packages keep the worker snapshots; explicit file overrides win in capture.
 */
export function applyDartPackageLanguageVersions(
  files: ParsedFile[],
  ctx: Parameters<NonNullable<ScopeResolver['populateWorkspaceReferences']>>[1],
): void {
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    if (!requiresDartPackageSource(file.filePath, ctx.resolutionConfig)) continue;
    const version = packageVersion(file.filePath, ctx.resolutionConfig as DartPackageConfig)!;
    const source = ctx.fileContents.get(file.filePath);
    if (source === undefined)
      throw new Error(`Dart language version requires source: ${file.filePath}`);
    const parsed = extractParsedFile(
      {
        ...dartProvider,
        emitScopeCaptures: (text, path, tree, meta) =>
          emitDartScopeCaptures(text, path, tree, meta, version),
      },
      source,
      file.filePath,
      undefined,
      ctx.treeCache?.get(file.filePath),
    );
    if (parsed === undefined)
      throw new Error(`Dart language-version extraction failed: ${file.filePath}`);
    populateClassOwnedMembers(parsed);
    files[i] = { ...file, ...parsed };
  }
}
