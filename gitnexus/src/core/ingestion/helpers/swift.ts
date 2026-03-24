/**
 * Swift-specific ingestion helpers.
 *
 * Contains SPM target grouping and implicit import wiring logic
 * extracted from the Swift provider to keep defineLanguage() calls
 * as pure configuration.
 */

import type { SwiftPackageConfig } from '../language-config.js';

/**
 * Group Swift files by SPM target for implicit module visibility.
 * If SwiftPackageConfig is available, use target → directory mappings.
 * Otherwise, group all Swift files under a single "default" target
 * (assumes a single-module Xcode project).
 */
export function groupSwiftFilesByTarget(
  swiftFiles: string[],
  swiftPackageConfig: SwiftPackageConfig | null,
): Map<string, string[]> {
  // No SPM config → single target (common for Xcode projects)
  if (!swiftPackageConfig || swiftPackageConfig.targets.size === 0) {
    return new Map([['__default__', swiftFiles]]);
  }

  // Pre-convert target dirs to normalized prefix format once
  const targets = [...swiftPackageConfig.targets.entries()].map(
    ([name, dir]) => ({ name, prefix: dir.replace(/\\/g, '/') + '/' }),
  );

  const groups = new Map<string, string[]>();
  const defaultGroup: string[] = [];

  for (const file of swiftFiles) {
    const normalized = file.includes('\\') ? file.replace(/\\/g, '/') : file;
    let assigned = false;
    for (const { name, prefix } of targets) {
      const idx = normalized.indexOf(prefix);
      if (idx === 0 || (idx > 0 && normalized[idx - 1] === '/')) {
        let group = groups.get(name);
        if (!group) { group = []; groups.set(name, group); }
        group.push(file);
        assigned = true;
        break;
      }
    }
    if (!assigned) defaultGroup.push(file);
  }

  if (defaultGroup.length > 0) groups.set('__default__', defaultGroup);
  return groups;
}

/**
 * Wire implicit inter-file imports for Swift.
 * All files in the same SPM target see each other (full module visibility).
 * Two fast paths avoid unnecessary work:
 *   1. No existing imports for src → emit all (m-1) edges without Set.has checks
 *   2. Existing imports present → skip already-connected pairs
 */
export function wireSwiftImplicitImports(
  swiftFiles: string[],
  importMap: ReadonlyMap<string, ReadonlySet<string>>,
  addImportEdge: (src: string, target: string) => void,
  projectConfig: unknown,
): void {
  const configs = projectConfig as { swiftPackageConfig?: SwiftPackageConfig | null } | null;
  const targetGroups = groupSwiftFilesByTarget(swiftFiles, configs?.swiftPackageConfig ?? null);

  for (const group of targetGroups.values()) {
    const m = group.length;
    if (m <= 1) continue;
    // All-pairs implicit edges: O(m²) is inherent for full module visibility.
    for (let i = 0; i < m; i++) {
      const src = group[i];
      const existing = importMap.get(src);
      if (!existing || existing.size === 0) {
        // Fast path: no prior imports — emit all peers unconditionally
        for (let j = 0; j < m; j++) {
          if (i !== j) addImportEdge(src, group[j]);
        }
      } else {
        // Dedup path: skip already-connected pairs
        for (let j = 0; j < m; j++) {
          if (i !== j && !existing.has(group[j])) {
            addImportEdge(src, group[j]);
          }
        }
      }
    }
  }
}
