/**
 * Resolve Solidity import targets (relative + Foundry remappings + suffix match).
 */

import {
  applySolidityRemapping,
  type SolidityRemappingConfig,
} from './remappings.js';

function resolveRelative(
  rel: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const normFrom = fromFile.replace(/\\/g, '/');
  const fromDir = normFrom.includes('/') ? normFrom.slice(0, normFrom.lastIndexOf('/')) : '';
  const parts = fromDir.length > 0 ? fromDir.split('/') : [];
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const target = parts.join('/');
  if (allFilePaths.has(target)) return target;
  for (const fp of allFilePaths) {
    if (fp === target || fp.endsWith('/' + target)) return fp;
  }
  if (!target.endsWith('.sol')) {
    const withExt = target + '.sol';
    if (allFilePaths.has(withExt)) return withExt;
    for (const fp of allFilePaths) {
      if (fp === withExt || fp.endsWith('/' + withExt)) return fp;
    }
  }
  return null;
}

function resolveBySuffix(
  targetRaw: string,
  allFilePaths: ReadonlySet<string>,
): string | null {
  const candidates: string[] = [];
  for (const fp of allFilePaths) {
    if (fp === targetRaw || fp.endsWith('/' + targetRaw)) {
      candidates.push(fp);
      continue;
    }
    const base = targetRaw.includes('/')
      ? targetRaw.slice(targetRaw.lastIndexOf('/') + 1)
      : targetRaw;
    if (base.endsWith('.sol') && (fp.endsWith('/' + base) || fp === base)) {
      candidates.push(fp);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0]!;
}

export function resolveSolidityImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
): string | readonly string[] | null {
  if (!targetRaw) return null;

  if (targetRaw.startsWith('.')) {
    return resolveRelative(targetRaw, fromFile, allFilePaths);
  }

  const remappings = resolutionConfig as SolidityRemappingConfig | undefined;
  const remapped = applySolidityRemapping(targetRaw, remappings);
  if (remapped) {
    if (allFilePaths.has(remapped)) return remapped;
    const viaSuffix = resolveBySuffix(remapped, allFilePaths);
    if (viaSuffix) return viaSuffix;
    for (const fp of allFilePaths) {
      const norm = fp.replace(/\\/g, '/');
      if (norm === remapped || norm.endsWith('/' + remapped) || norm.startsWith(remapped)) {
        return fp;
      }
    }
  }

  return resolveBySuffix(targetRaw, allFilePaths);
}
