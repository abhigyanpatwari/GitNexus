export interface RenameSymbol {
  uid?: string;
  name: string;
  kind?: string;
  filePath: string;
  /** Graph display ranges are one-based, inclusive. */
  startLine: number;
  endLine?: number;
}

export interface RenameOptions {
  new_name: string;
  dry_run?: boolean;
}

export interface RenameCoverage {
  name: string;
  scope: 'indexed-repository';
  source_file_count: number;
  languages: string[];
  limitations: string[];
}

export interface OccurrenceEdit {
  file_path: string;
  /** Offsets into the unchanged source, in UTF-16 code units. */
  start: number;
  length: number;
  old_text: string;
  new_text: string;
}

export interface RenamePlan {
  symbol: RenameSymbol;
  new_name: string;
  coverage: RenameCoverage;
  /** Includes all source files used by semantic resolution, even without edits. */
  snapshots: Map<string, string>;
  edits: OccurrenceEdit[];
}

export interface ReportedEdit extends Omit<OccurrenceEdit, 'file_path'> {
  line: number;
  confidence: 'semantic';
  before: string;
  after: string;
}

export interface FileChange {
  file_path: string;
  edits: ReportedEdit[];
}

export interface RenameResult {
  result_version: 2;
  status: 'success' | 'error' | 'partial';
  planning_status: 'ready' | 'blocked' | 'unsupported';
  application_status: 'not_requested' | 'not_started' | 'applied' | 'partial' | 'failed';
  applied: boolean;
  old_name: string;
  new_name: string;
  files_affected: number;
  total_edits: number;
  semantic_edits: number;
  graph_edits: 0;
  text_search_edits: 0;
  text_search: 'not_used';
  changes: FileChange[];
  coverage?: RenameCoverage;
  error?: string;
  code?: string;
  candidates?: string[];
  failed_files?: string[];
}

export class RenameFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly planningStatus: 'blocked' | 'unsupported' = 'blocked',
    public readonly candidates?: string[],
  ) {
    super(message);
  }
}

/** A source span uses JavaScript string offsets in the ORIGINAL source. */
export interface RenameSpan {
  readonly start: number;
  readonly length: number;
}

export interface RenameIssue {
  readonly code: string;
  readonly message: string;
  readonly status?: 'unsupported' | 'error';
}

export interface RenameReplacement extends RenameSpan {
  readonly oldText: string;
  readonly newText: string;
}
