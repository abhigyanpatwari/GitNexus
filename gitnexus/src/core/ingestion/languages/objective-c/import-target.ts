import { posix } from 'node:path';

interface WorkspacePath {
  readonly original: string;
  readonly normalized: string;
}

const normalizedWorkspacePaths = new WeakMap<ReadonlySet<string>, readonly WorkspacePath[]>();

function workspacePaths(allFilePaths: ReadonlySet<string>): readonly WorkspacePath[] {
  let paths = normalizedWorkspacePaths.get(allFilePaths);
  if (paths === undefined) {
    paths = [...allFilePaths].map((original) => ({
      original,
      normalized: original.replace(/\\/g, '/'),
    }));
    normalizedWorkspacePaths.set(allFilePaths, paths);
  }
  return paths;
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

/**
 * Resolve project-local Objective-C imports without build-setting guesses.
 * Every fallback requires a unique workspace match; ambiguity fails closed.
 */
export function resolveObjectiveCImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const target = normalizeImportTarget(targetRaw);
  if (target === null) return null;
  const paths = workspacePaths(allFilePaths);
  const from = fromFile.replace(/\\/g, '/');

  const sibling = posix.normalize(posix.join(posix.dirname(from), target));
  if (!sibling.startsWith('../')) {
    const siblingMatch = uniqueMatch(paths, (candidate) => candidate.normalized === sibling);
    if (siblingMatch !== null) return siblingMatch;
  }

  const exact = uniqueMatch(paths, (candidate) => candidate.normalized === target);
  if (exact !== null) return exact;

  const suffix = `/${target}`;
  const suffixMatch = uniqueMatch(
    paths,
    (candidate) => candidate.normalized === target || candidate.normalized.endsWith(suffix),
  );
  if (suffixMatch !== null) return suffixMatch;

  if (target.includes('.') && !target.endsWith('.h')) {
    const modulePath = target.replace(/\./g, '/');
    const leaf = modulePath.slice(modulePath.lastIndexOf('/') + 1);
    const moduleCandidates = [`${modulePath}.h`, `${modulePath}/${leaf}.h`];
    return uniqueMatch(paths, (candidate) =>
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
      paths,
      (candidate) =>
        candidate.normalized === umbrella || candidate.normalized.endsWith(`/${umbrella}`),
    );
  }
  return null;
}
