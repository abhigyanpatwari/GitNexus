import type { ParsedFile } from 'gitnexus-shared';
import { logger } from '../../../logger.js';
import { dartProvider } from '../dart.js';
import { emitDartScopeCaptures } from './captures.js';
import {
  dartCaptureDependsOnPackageLanguageVersion,
  dartVersionHasWildcardVariables,
} from './language-version.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import type { DartPackageConfig } from './package-config.js';

const versionsByConfig = new WeakMap<DartPackageConfig, Map<string, string | null>>();

/** Paths named in one warning; the count is always exact. */
const WARNING_PATH_SAMPLE = 5;

/** Language version of the nearest enclosing package, or null when that
 * package declares none (or no manifest encloses the file). */
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
  let version: string | null = null;
  while (true) {
    // A stored null is a package boundary without a version: it ends the walk.
    const known = cached.has(directory) ? cached.get(directory) : versions.get(directory);
    if (known !== undefined) {
      version = known;
      break;
    }
    visited.push(directory);
    if (directory === '') break;
    directory = directory.slice(0, Math.max(0, directory.lastIndexOf('/')));
  }
  for (const dir of visited) cached.set(dir, version);
  return version;
}

/** The package version under which a `_` parameter/local still binds, or null
 * when the worker's default capture already matches the package. */
function legacyPackageVersion(filePath: string, config: unknown): string | null {
  const version = packageVersion(filePath, config as DartPackageConfig | undefined);
  if (version === null) return null;
  return dartVersionHasWildcardVariables(version) ? null : version;
}

/** Source is needed only for a file that both sits in a pre-3.7 package and
 * recorded a version-sensitive `_` binder at capture time. Both inputs are
 * already in memory: the captured manifest map and the reused `ParsedFile`. */
export function requiresDartPackageSource(
  filePath: string,
  config: unknown,
  preExtracted?: ParsedFile,
): boolean {
  return (
    legacyPackageVersion(filePath, config) !== null &&
    dartCaptureDependsOnPackageLanguageVersion(preExtracted)
  );
}

function warnKeptCapture(reason: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  logger.warn(
    { reason, count: paths.length, relativePaths: paths.slice(0, WARNING_PATH_SAMPLE) },
    'Dart package language version could not be applied; the default capture is kept for these files.',
  );
}

/** Package metadata is acquired after worker capture and can change without a
 * source edit, so the worker always captures with the default (3.7+) rules and
 * records whether a `_` parameter/local makes that capture version-dependent.
 * Only those files of a pre-3.7 package are extracted again here, on both cold
 * and warm runs; every other file keeps its worker snapshot, and an explicit
 * file override already won in capture.
 *
 * A file whose source is unavailable, or whose extraction yields nothing,
 * keeps its reused `ParsedFile`: one file must not fail the resolution pass.
 */
export function applyDartPackageLanguageVersions(
  files: ParsedFile[],
  ctx: Parameters<NonNullable<ScopeResolver['populateWorkspaceReferences']>>[1],
): void {
  const sourceUnavailable: string[] = [];
  const extractionFailed: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file === undefined || !dartCaptureDependsOnPackageLanguageVersion(file)) continue;
    const version = legacyPackageVersion(file.filePath, ctx.resolutionConfig);
    if (version === null) continue;
    const source = ctx.fileContents.get(file.filePath);
    if (source === undefined || source.trim().length === 0) {
      sourceUnavailable.push(file.filePath);
      continue;
    }
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
    if (parsed === undefined) {
      extractionFailed.push(file.filePath);
      continue;
    }
    populateClassOwnedMembers(parsed);
    files[i] = { ...file, ...parsed };
  }
  warnKeptCapture('source-unavailable', sourceUnavailable);
  warnKeptCapture('extraction-failed', extractionFailed);
}
