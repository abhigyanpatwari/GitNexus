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
 * This module duplicates the legacy `groupSwiftFilesByTarget`
 * (`languages/swift.ts`) semantics **verbatim** so the registry-primary
 * path matches legacy SPM-subtree grouping without touching the legacy
 * pipeline (hard constraint: legacy stays byte-identical). The SPM target
 * map is threaded in via the `resolutionConfig` channel
 * (`loadSwiftPackageConfig` → `resolutionConfig` → these hooks); see
 * `scope-resolver.ts` and `scope-resolution/pipeline/run.ts`.
 *
 * NOTE: This intentionally differs from the import-config module's
 * leading-`startsWith` (`import-resolvers/configs/swift.ts`): that module
 * fans a file out to EVERY matching target (a nested file can belong to
 * multiple configured target dirs there), whereas legacy module grouping
 * assigns each file to the FIRST matching target only (legacy `break`s) —
 * one bucket per file. Do not copy the import-config behavior here.
 */

import type { SwiftPackageConfig } from '../../language-config.js';

const DEFAULT_TARGET = '__default__';

/**
 * Group `items` by SPM target subtree, replicating legacy
 * `groupSwiftFilesByTarget` semantics exactly:
 *
 *   - `targets` null/empty (no scanned source dir found) → ALL items go to
 *     a single `__default__` bucket (single-Xcode-project assumption).
 *   - Otherwise: a file matches a target when its normalized path either
 *     starts with `<targetDir>/` (`indexOf === 0`) OR contains it at a `/`
 *     boundary (`norm[idx - 1] === '/'`). Each file is assigned to the
 *     FIRST matching target only (one bucket per file, no fan-out).
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

  // Pre-convert target dirs to normalized prefix format once.
  const targetPrefixes = [...targets.entries()].map(([name, dir]) => ({
    name,
    prefix: dir.replace(/\\/g, '/') + '/',
  }));

  const groups = new Map<string, T[]>();
  const defaultGroup: T[] = [];

  for (const item of items) {
    const rawPath = getPath(item);
    const normalized = rawPath.includes('\\') ? rawPath.replace(/\\/g, '/') : rawPath;
    let assigned = false;
    for (const { name, prefix } of targetPrefixes) {
      const idx = normalized.indexOf(prefix);
      if (idx === 0 || (idx > 0 && normalized[idx - 1] === '/')) {
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
