/**
 * Swift SPM-target file grouping for the registry-primary same-module
 * hooks (`implicit-imports.ts`, `target-siblings.ts`,
 * `sibling-type-bindings.ts`).
 *
 * A Swift module is an SPM *target* — a directory *subtree*
 * (`Sources/<Target>/…`), not a single immediate directory. Grouping by
 * the immediate containing directory (the prior `containingDir` proxy)
 * drops cross-directory same-module edges and can mis-resolve a
 * constructor call to a wrong same-simple-named type in another target.
 *
 * The SPM target map is threaded in via the `resolutionConfig` channel
 * (`loadSwiftPackageConfig` → `resolutionConfig` → these hooks); see
 * `scope-resolver.ts` and `scope-resolution/pipeline/run.ts`.
 *
 * Path matching is the same segment-boundary rule as import-config
 * (`fileMatchesSwiftTargetDir`). Grouping assigns each file to the FIRST
 * matching target; import-config fans a file out to every matching target.
 */

import { swiftDeclaredTargetPrefix, type SwiftPackageConfig } from '../../language-config.js';
export { coerceDeclaredSwiftTargets } from '../../language-config.js';

const DEFAULT_TARGET = '__default__';

/**
 * Group `items` by SPM target subtree:
 *
 *   - `targets` null/empty (no scanned source dir found) → ALL items go to
 *     a single `__default__` bucket (single-Xcode-project assumption).
 *   - Otherwise: a file matches a target when its normalized path either
 *     starts with `<targetDir>/` or contains `/<targetDir>/` at a segment
 *     boundary. Using a segment-aware suffix search matters when an earlier,
 *     non-boundary occurrence of the same text appears in the path (#2931).
 *   - Each file is assigned to the FIRST matching target only (one bucket per
 *     file, no fan-out).
 *   - Files matching no target fall into the `__default__` bucket.
 *
 * `targets` is `name → directory` (the `SwiftPackageConfig.targets` map).
 */
export function groupSwiftFilesBySpmTarget<T>(
  items: readonly T[],
  getPath: (item: T) => string,
  targets: ReadonlyMap<string, string> | null,
): Map<string, T[]> {
  // No SPM config -> single target (common for Xcode projects).
  if (targets === null || targets.size === 0) {
    return new Map([[DEFAULT_TARGET, [...items]]]);
  }

  const targetPrefixes = [...targets.entries()].map(([name, dir]) => ({
    name,
    prefix: swiftDeclaredTargetPrefix(dir),
  }));

  const groups = new Map<string, T[]>();
  const defaultGroup: T[] = [];

  for (const item of items) {
    const rawPath = getPath(item);
    const normalized = rawPath.includes('\\') ? rawPath.replace(/\\/g, '/') : rawPath;
    let assigned = false;
    for (const { name, prefix } of targetPrefixes) {
      if (pathMatchesTargetPrefix(normalized, prefix)) {
        let group = groups.get(name);
        if (group === undefined) {
          group = [];
          groups.set(name, group);
        }
        group.push(item);
        assigned = true;
        break; // FIRST match only — one bucket per file, no fan-out.
      }
    }
    if (!assigned) defaultGroup.push(item);
  }

  if (defaultGroup.length > 0) groups.set(DEFAULT_TARGET, defaultGroup);
  return groups;
}

/**
 * Duck-type the opaque `resolutionConfig` (loaded by
 * `loadSwiftPackageConfig` and threaded through the orchestrator) into the
 * SPM `targets` map, or `null` when no Swift package config is present.
 *
 * Uses structural duck-typing (no `instanceof`) because the value crosses
 * the `unknown`-typed `resolutionConfig` channel and may be `null`,
 * `undefined`, or a config object whose `targets` is a `Map<string,string>`.
 */
export function coerceSwiftTargets(resolutionConfig: unknown): ReadonlyMap<string, string> | null {
  const config = resolutionConfig as Partial<SwiftPackageConfig> | null | undefined;
  if (config != null && config.targets instanceof Map) {
    return config.targets;
  }
  return null;
}

function pathMatchesTargetPrefix(normalizedPath: string, prefix: string): boolean {
  if (prefix === '') return true;
  return normalizedPath.startsWith(prefix) || normalizedPath.includes(`/${prefix}`);
}

/** Segment-boundary membership used by grouping and declared import resolve. */
export function fileMatchesSwiftTargetDir(normalizedPath: string, targetDir: string): boolean {
  return pathMatchesTargetPrefix(normalizedPath, swiftDeclaredTargetPrefix(targetDir));
}
