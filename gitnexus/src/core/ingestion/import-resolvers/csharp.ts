/**
 * C# namespace import resolution.
 * Handles using-directive resolution via .csproj root namespace stripping.
 */

import type { SuffixIndex } from './utils.js';
import { suffixResolve } from './utils.js';

/** C# project config parsed from .csproj files */
export interface CSharpProjectConfig {
  /** Root namespace from <RootNamespace> or assembly name (default: project directory name) */
  rootNamespace: string;
  /** Directory containing the .csproj file */
  projectDir: string;
}

/**
 * Resolve a C# using-directive import path to matching .cs files.
 * Tries single-file match first, then directory match for namespace imports.
 */
export function resolveCSharpImport(
  importPath: string,
  csharpConfigs: CSharpProjectConfig[],
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string[] {
  const namespacePath = importPath.replace(/\./g, '/');
  const results: string[] = [];

  for (const config of csharpConfigs) {
    const nsPath = config.rootNamespace.replace(/\./g, '/');
    let relative: string;
    if (namespacePath.startsWith(nsPath + '/')) {
      relative = namespacePath.slice(nsPath.length + 1);
    } else if (namespacePath === nsPath) {
      // The import IS the root namespace — resolve to all .cs files in project root
      relative = '';
    } else {
      continue;
    }

    const dirPrefix = config.projectDir
      ? (relative ? config.projectDir + '/' + relative : config.projectDir)
      : relative;

    // 1. Try as single file: relative.cs (e.g., "Models/DlqMessage.cs")
    if (relative) {
      const candidate = dirPrefix + '.cs';
      if (index) {
        const result = index.get(candidate) || index.getInsensitive(candidate);
        if (result) return [result];
      }
      // Also try suffix match
      const suffixResult = index?.get(relative + '.cs') || index?.getInsensitive(relative + '.cs');
      if (suffixResult) return [suffixResult];
    }

    // 2. Try as directory: all .cs files directly inside (namespace import)
    if (index) {
      const dirFiles = index.getFilesInDir(dirPrefix, '.cs');
      for (const f of dirFiles) {
        const normalized = f.replace(/\\/g, '/');
        // Check it's a direct child by finding the dirPrefix and ensuring no deeper slashes
        const prefixIdx = normalized.indexOf(dirPrefix + '/');
        if (prefixIdx < 0) continue;
        const afterDir = normalized.substring(prefixIdx + dirPrefix.length + 1);
        if (!afterDir.includes('/')) {
          results.push(f);
        }
      }
      if (results.length > 0) return results;
    }

    // 3. Linear scan fallback for directory matching
    if (results.length === 0) {
      const dirTrail = dirPrefix + '/';
      for (let i = 0; i < normalizedFileList.length; i++) {
        const normalized = normalizedFileList[i];
        if (!normalized.endsWith('.cs')) continue;
        const prefixIdx = normalized.indexOf(dirTrail);
        if (prefixIdx < 0) continue;
        const afterDir = normalized.substring(prefixIdx + dirTrail.length);
        if (!afterDir.includes('/')) {
          results.push(allFileList[i]);
        }
      }
      if (results.length > 0) return results;
    }
  }

  // Fallback: suffix matching without namespace stripping (single file)
  const pathParts = namespacePath.split('/').filter(Boolean);
  const fallback = suffixResolve(pathParts, normalizedFileList, allFileList, index);
  return fallback ? [fallback] : [];
}

/**
 * Compute the directory suffix for a C# namespace import (for PackageMap).
 * Returns a suffix like "/ProjectDir/Models/" or null if no config matches.
 */
export function resolveCSharpNamespaceDir(
  importPath: string,
  csharpConfigs: CSharpProjectConfig[],
): string | null {
  const namespacePath = importPath.replace(/\./g, '/');

  for (const config of csharpConfigs) {
    const nsPath = config.rootNamespace.replace(/\./g, '/');
    let relative: string;
    if (namespacePath.startsWith(nsPath + '/')) {
      relative = namespacePath.slice(nsPath.length + 1);
    } else if (namespacePath === nsPath) {
      relative = '';
    } else {
      continue;
    }

    const dirPrefix = config.projectDir
      ? (relative ? config.projectDir + '/' + relative : config.projectDir)
      : relative;

    if (!dirPrefix) continue;
    return '/' + dirPrefix + '/';
  }

  return null;
}
