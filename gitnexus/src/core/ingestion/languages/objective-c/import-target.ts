import { posix } from 'node:path';

interface WorkspacePath {
  readonly original: string;
  readonly normalized: string;
}

interface WorkspacePathIndex {
  readonly byBasename: ReadonlyMap<string, readonly WorkspacePath[]>;
}

const workspacePathIndexes = new WeakMap<ReadonlySet<string>, WorkspacePathIndex>();
const resolutionCaches = new WeakMap<ReadonlySet<string>, Map<string, string | null>>();

function workspacePathIndex(allFilePaths: ReadonlySet<string>): WorkspacePathIndex {
  let index = workspacePathIndexes.get(allFilePaths);
  if (index === undefined) {
    const byBasename = new Map<string, WorkspacePath[]>();
    for (const original of allFilePaths) {
      const candidate = { original, normalized: original.replace(/\\/g, '/') };
      const basename = posix.basename(candidate.normalized);
      const bucket = byBasename.get(basename) ?? [];
      bucket.push(candidate);
      byBasename.set(basename, bucket);
    }
    index = { byBasename };
    workspacePathIndexes.set(allFilePaths, index);
  }
  return index;
}

function normalizeImportTarget(targetRaw: string): string | null {
  const target = targetRaw.trim().replace(/\\/g, '/');
  if (target.length === 0 || target.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join('/');
}

function uniqueMatch(
  candidates: readonly WorkspacePath[],
  predicate: (candidate: WorkspacePath) => boolean,
): string | null {
  let match: string | null = null;
  for (const candidate of candidates) {
    if (!predicate(candidate)) continue;
    if (match !== null && match !== candidate.original) return null;
    match = candidate.original;
  }
  return match;
}

function candidatesForTarget(index: WorkspacePathIndex, target: string): readonly WorkspacePath[] {
  return index.byBasename.get(posix.basename(target)) ?? [];
}

function containsContiguousPath(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((part, offset) => haystack[start + offset] === part)) return true;
  }
  return false;
}

export interface ObjectiveCImportTargetOptions {
  /** True for `#import <...>`; angle imports do not use quoted-header sibling precedence. */
  readonly isSystem?: boolean;
}

/**
 * Resolve project-local Objective-C imports without build-setting guesses.
 * Every fallback requires a unique workspace match; ambiguity fails closed.
 */
export function resolveObjectiveCImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  options: ObjectiveCImportTargetOptions = {},
): string | null {
  let cache = resolutionCaches.get(allFilePaths);
  if (cache === undefined) {
    cache = new Map();
    resolutionCaches.set(allFilePaths, cache);
  }
  const from = fromFile.replace(/\\/g, '/');
  const cacheKey = `${options.isSystem === true ? 'system' : 'quoted'}\0${
    options.isSystem === true ? '' : from
  }\0${targetRaw}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const resolved = resolveObjectiveCImportTargetUncached(
    targetRaw,
    from,
    workspacePathIndex(allFilePaths),
    options,
  );
  cache.set(cacheKey, resolved);
  return resolved;
}

function resolveObjectiveCImportTargetUncached(
  targetRaw: string,
  fromFile: string,
  index: WorkspacePathIndex,
  options: ObjectiveCImportTargetOptions,
): string | null {
  const target = normalizeImportTarget(targetRaw);
  if (target === null) return null;

  if (options.isSystem !== true) {
    const sibling = posix.normalize(posix.join(posix.dirname(fromFile), target));
    if (!sibling.startsWith('../')) {
      const siblingMatch = uniqueMatch(
        candidatesForTarget(index, sibling),
        (candidate) => candidate.normalized === sibling,
      );
      if (siblingMatch !== null) return siblingMatch;
    }

    const exact = uniqueMatch(
      candidatesForTarget(index, target),
      (candidate) => candidate.normalized === target,
    );
    if (exact !== null) return exact;
  }

  // CocoaPods source layouts commonly place public headers below an
  // intermediate `Classes/` directory, so `<Module/Header.h>` is not a
  // literal path suffix. Treat literal and module-scoped system-header paths
  // as one candidate tier so ambiguity across those layouts also fails closed.
  const targetParts = target.split('/');
  if (options.isSystem === true && target.endsWith('.h') && targetParts.length > 1) {
    const suffix = `/${target}`;
    const moduleParts = targetParts.slice(0, -1);
    return uniqueMatch(candidatesForTarget(index, target), (candidate) => {
      const candidateParts = candidate.normalized.split('/');
      return (
        candidate.normalized === target ||
        candidate.normalized.endsWith(suffix) ||
        containsContiguousPath(candidateParts.slice(0, -1), moduleParts)
      );
    });
  }

  const suffix = `/${target}`;
  const suffixMatch = uniqueMatch(
    candidatesForTarget(index, target),
    (candidate) => candidate.normalized === target || candidate.normalized.endsWith(suffix),
  );
  if (suffixMatch !== null) return suffixMatch;

  if (target.includes('.') && !target.endsWith('.h')) {
    const modulePath = target.replace(/\./g, '/');
    const leaf = modulePath.slice(modulePath.lastIndexOf('/') + 1);
    const moduleCandidates = [`${modulePath}.h`, `${modulePath}/${leaf}.h`];
    const candidates = moduleCandidates.flatMap((candidate) =>
      candidatesForTarget(index, candidate),
    );
    return uniqueMatch(candidates, (candidate) =>
      moduleCandidates.some(
        (moduleCandidate) =>
          candidate.normalized === moduleCandidate ||
          candidate.normalized.endsWith(`/${moduleCandidate}`),
      ),
    );
  }

  if (!target.endsWith('.h')) {
    const umbrella = `${target}/${target}.h`;
    return uniqueMatch(
      candidatesForTarget(index, umbrella),
      (candidate) =>
        candidate.normalized === umbrella || candidate.normalized.endsWith(`/${umbrella}`),
    );
  }
  return null;
}
