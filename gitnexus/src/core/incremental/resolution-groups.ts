import { getLanguageFromFilename } from 'gitnexus-shared';
import { getProviderForFile } from '../ingestion/languages/index.js';
import { MAX_PROPERTY_DISPATCH_EDGES_PER_KEY } from '../ingestion/scope-resolution/property-dispatch-budget.js';

function resolutionGroupForFile(filePath: string): string | undefined {
  const provider = getProviderForFile(filePath);
  // A budget decision depends on all sites, including context files shared
  // across language passes. Re-examine source rows; the existing digest gate
  // still rewrites only files whose rows changed, including removed CALLS.
  if (Number.isFinite(MAX_PROPERTY_DISPATCH_EDGES_PER_KEY)) {
    return provider !== null || getLanguageFromFilename(filePath) !== null
      ? 'property-dispatch:workspace'
      : undefined;
  }
  if (provider === null) return undefined;
  const group = provider.incrementalResolutionGroup?.(filePath);
  return group === undefined ? undefined : `${provider.id}\0${group}`;
}

/**
 * Collect current files whose resolution may change with a sibling. Provider
 * keys are normally language-local; a dispatch budget spans context files.
 * Changed paths may include deleted files.
 * Two linear passes avoid rescanning the repository for every changed file.
 */
export function collectResolutionGroupFiles(
  changedFiles: readonly string[],
  currentFiles: readonly string[],
): Set<string> {
  const changedGroups = new Set<string>();
  for (const filePath of changedFiles) {
    const group = resolutionGroupForFile(filePath);
    if (group !== undefined) changedGroups.add(group);
  }

  const affected = new Set<string>();
  if (changedGroups.size === 0) return affected;
  for (const filePath of currentFiles) {
    const group = resolutionGroupForFile(filePath);
    if (group !== undefined && changedGroups.has(group)) {
      affected.add(filePath);
    }
  }
  return affected;
}

/** Whether any current file belongs to a resolution group. Repositories with
 * none never pay for per-file row digests. */
export function hasResolutionGroups(currentFiles: readonly string[]): boolean {
  return currentFiles.some((filePath) => resolutionGroupForFile(filePath) !== undefined);
}
