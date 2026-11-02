import { RenameFailure, type RenameSymbol, type RenameResult, type FileChange } from './types.js';

export function renameResult(
  symbol: RenameSymbol,
  newName: string,
  changes: FileChange[] = [],
): RenameResult {
  const count = changes.reduce((sum, file) => sum + file.edits.length, 0);
  return {
    result_version: 2,
    status: 'success',
    planning_status: 'ready',
    application_status: 'not_requested',
    applied: false,
    old_name: symbol.name,
    new_name: newName,
    files_affected: changes.length,
    total_edits: count,
    semantic_edits: count,
    graph_edits: 0,
    text_search_edits: 0,
    text_search: 'not_used',
    changes,
  };
}

export function blockedRenameResult(
  symbol: RenameSymbol,
  newName: string,
  error: unknown,
): RenameResult {
  return {
    ...renameResult(symbol, newName),
    status: 'error',
    application_status: 'not_started',
    planning_status: error instanceof RenameFailure ? error.planningStatus : 'blocked',
    code: error instanceof RenameFailure ? error.code : 'rename_failed',
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof RenameFailure && error.candidates ? { candidates: error.candidates } : {}),
  };
}
