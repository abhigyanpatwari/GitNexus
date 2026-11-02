import { getProviderForFile } from '../ingestion/languages/index.js';

/**
 * Collect current files whose resolution may change with a sibling. Provider
 * keys are language-local, and changed paths may include deleted files.
 * Two linear passes avoid rescanning the repository for every changed file.
 */
export function collectResolutionGroupFiles(
  changedFiles: readonly string[],
  currentFiles: readonly string[],
): Set<string> {
  const changedGroups = new Set<string>();
  for (const filePath of changedFiles) {
    const provider = getProviderForFile(filePath);
    if (!provider?.incrementalResolutionGroup) continue;
    const group = provider.incrementalResolutionGroup(filePath);
    if (group !== undefined) changedGroups.add(`${provider.id}\0${group}`);
  }

  const affected = new Set<string>();
  if (changedGroups.size === 0) return affected;
  for (const filePath of currentFiles) {
    const provider = getProviderForFile(filePath);
    if (!provider?.incrementalResolutionGroup) continue;
    const group = provider.incrementalResolutionGroup(filePath);
    if (group !== undefined && changedGroups.has(`${provider.id}\0${group}`)) {
      affected.add(filePath);
    }
  }
  return affected;
}
