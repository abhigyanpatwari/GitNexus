import type { RepoIndexManifest } from '../../storage/repo-manager.js';
import type { FileManifestDiff } from './file-manifest.js';

const stableSort = (values: string[]): string[] => [...values].sort((a, b) => a.localeCompare(b));

export interface IncrementalInvalidationPlan {
  changedFiles: string[];
  deletedFiles: string[];
  invalidatedFiles: string[];
  reparsedFiles: string[];
  removedFiles: string[];
  impactedNodeIds: string[];
  impactedRelationshipIds: string[];
  reasonByFile: Record<string, string[]>;
  globalPhases: string[];
  canPatchGraph: boolean;
}

const GLOBAL_PHASES = ['mro', 'communities', 'processes'];

export const planIncrementalInvalidation = (
  diff: FileManifestDiff,
  indexManifest: RepoIndexManifest | null | undefined,
): IncrementalInvalidationPlan => {
  const reasonByFile = new Map<string, Set<string>>();
  const impactedNodeIds = new Set<string>();
  const impactedRelationshipIds = new Set<string>();
  const removedFiles = new Set<string>();

  const addReason = (filePath: string, reason: string): void => {
    let reasons = reasonByFile.get(filePath);
    if (reasons === undefined) {
      reasons = new Set();
      reasonByFile.set(filePath, reasons);
    }
    reasons.add(reason);
  };

  const recordExistingOwnership = (filePath: string): void => {
    const entry = indexManifest?.files[filePath];
    if (!entry) return;
    for (const nodeId of entry.emittedNodes) impactedNodeIds.add(nodeId);
    for (const relationshipId of entry.emittedEdges) impactedRelationshipIds.add(relationshipId);
  };

  for (const filePath of diff.added) {
    addReason(filePath, 'added');
  }

  for (const filePath of diff.modified) {
    addReason(filePath, 'modified');
    recordExistingOwnership(filePath);
  }

  for (const filePath of diff.deleted) {
    addReason(filePath, 'deleted');
    removedFiles.add(filePath);
    recordExistingOwnership(filePath);
  }

  if (indexManifest) {
    for (const changedFile of [...diff.modified, ...diff.deleted]) {
      const entry = indexManifest.files[changedFile];
      if (!entry) continue;
      for (const dependant of entry.dependants) {
        addReason(dependant, `imports changed file: ${changedFile}`);
        recordExistingOwnership(dependant);
      }
    }
  }

  const invalidatedFiles = stableSort([...reasonByFile.keys()]);
  const removed = stableSort([...removedFiles]);
  const reparsedFiles = invalidatedFiles.filter((filePath) => !removedFiles.has(filePath));
  const reasonObject: Record<string, string[]> = {};
  for (const filePath of invalidatedFiles) {
    reasonObject[filePath] = stableSort([...(reasonByFile.get(filePath) ?? [])]);
  }

  return {
    changedFiles: stableSort([...diff.added, ...diff.modified]),
    deletedFiles: stableSort(diff.deleted),
    invalidatedFiles,
    reparsedFiles,
    removedFiles: removed,
    impactedNodeIds: stableSort([...impactedNodeIds]),
    impactedRelationshipIds: stableSort([...impactedRelationshipIds]),
    reasonByFile: reasonObject,
    globalPhases: invalidatedFiles.length > 0 ? GLOBAL_PHASES : [],
    canPatchGraph: Boolean(indexManifest),
  };
};
