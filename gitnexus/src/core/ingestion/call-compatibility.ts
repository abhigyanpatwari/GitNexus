import type { RelationshipType } from 'gitnexus-shared';
import type { FileDiff } from '../../storage/git.js';

export interface CallCompatibilityTarget {
  id: string;
  name: string;
  type: string;
  filePath: string;
}

export interface CallCompatibilityCaller {
  target: string;
  filePath: string;
  relationType: RelationshipType;
}

export interface BrokenKeywordCall {
  target: string;
  name: string;
  filePath: string;
  line: number;
  keyword: string;
  keywords?: string[];
}

export interface CallCompatibilityResult {
  findings: BrokenKeywordCall[];
  complete: boolean;
  skipped: { filePath: string; reason: string }[];
}

export type CallCompatibilityFile = Pick<FileDiff, 'filePath' | 'oldFilePath'>;
export type CallCompatibilityLookup = (ids: string[]) => Promise<CallCompatibilityCaller[]>;

/** Compare named arguments in the selected Git images. Providers select the
 * target kinds and graph relations whose source semantics they can verify. */
export interface CallCompatibilityProvider {
  readonly acceptsTarget: (target: CallCompatibilityTarget) => boolean;
  readonly relationTypes: readonly RelationshipType[];
  readonly check: (
    directory: string,
    scope: string,
    base: string | undefined,
    targets: readonly CallCompatibilityTarget[],
    incoming: CallCompatibilityLookup,
    changedFiles?: readonly CallCompatibilityFile[],
    /** When set, only source images of the changed files may be inspected. */
    callerSourceUnavailable?: string,
  ) => Promise<CallCompatibilityResult>;
}
