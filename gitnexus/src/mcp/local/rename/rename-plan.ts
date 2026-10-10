import fs from 'node:fs/promises';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';

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

interface ReportedEdit extends Omit<OccurrenceEdit, 'file_path'> {
  line: number;
  confidence: 'semantic';
  before: string;
  after: string;
}

interface FileChange {
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

/** Lexical containment must be checked before resolving symlinks. */
export function repositoryPath(repoPath: string, filePath: string): string {
  const root = path.resolve(repoPath);
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RenameFailure(
      'outside_repository',
      `Rename path is outside the repository: ${filePath}`,
    );
  }
  return absolute;
}

async function checkedRealPath(repoPath: string, filePath: string): Promise<string> {
  const absolute = repositoryPath(repoPath, filePath);
  const [root, real] = await Promise.all([fs.realpath(repoPath), fs.realpath(absolute)]);
  repositoryPath(root, real);
  return real;
}

function result(symbol: RenameSymbol, newName: string, changes: FileChange[] = []): RenameResult {
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

function blocked(symbol: RenameSymbol, newName: string, error: unknown): RenameResult {
  return {
    ...result(symbol, newName),
    status: 'error',
    application_status: 'not_started',
    planning_status: error instanceof RenameFailure ? error.planningStatus : 'blocked',
    code: error instanceof RenameFailure ? error.code : 'rename_failed',
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof RenameFailure && error.candidates ? { candidates: error.candidates } : {}),
  };
}

async function validateSnapshots(plan: RenamePlan): Promise<void> {
  for (const [file, snapshot] of plan.snapshots) {
    if (!(await fs.readFile(file)).equals(Buffer.from(snapshot, 'utf8'))) {
      throw new RenameFailure(
        'source_changed',
        `Source changed while planning rename: ${file}. Retry from current sources.`,
      );
    }
  }
}

/** Validates the complete edit set and source versions before any write. */
export async function executeRenamePlan(
  repoPath: string,
  plan: RenamePlan,
  dryRun = true,
): Promise<RenameResult> {
  const changes: FileChange[] = [];
  const files = new Map<
    string,
    { absolute: string; real: string; snapshot: string; output: string }
  >();
  try {
    if (!plan.edits.length)
      throw new RenameFailure('no_locations', 'The provider returned no rename locations.');
    const byFile = new Map<string, OccurrenceEdit[]>();
    for (const edit of plan.edits) {
      const absolute = repositoryPath(repoPath, edit.file_path);
      const key = path.relative(path.resolve(repoPath), absolute).split(path.sep).join('/');
      const edits = byFile.get(key) ?? [];
      edits.push(edit);
      byFile.set(key, edits);
    }
    const realPaths = new Set<string>();
    for (const [file, unsorted] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const absolute = repositoryPath(repoPath, file);
      const real = await checkedRealPath(repoPath, file);
      if (realPaths.has(real))
        throw new RenameFailure(
          'duplicate_file',
          `Multiple rename paths refer to the same file: ${file}`,
        );
      realPaths.add(real);
      const snapshot = plan.snapshots.get(absolute);
      if (snapshot === undefined)
        throw new RenameFailure('missing_snapshot', `No source snapshot for ${file}.`);
      const edits: OccurrenceEdit[] = [];
      for (const edit of unsorted.sort((a, b) => a.start - b.start || a.length - b.length)) {
        if (
          !Number.isSafeInteger(edit.start) ||
          !Number.isSafeInteger(edit.length) ||
          edit.start < 0 ||
          edit.length <= 0 ||
          edit.start + edit.length > snapshot.length ||
          snapshot.slice(edit.start, edit.start + edit.length) !== edit.old_text
        ) {
          throw new RenameFailure(
            'invalid_edit',
            `Invalid rename span or expected text in ${file}.`,
          );
        }
        const previous = edits.at(-1);
        if (previous && previous.start + previous.length > edit.start) {
          if (
            previous.start === edit.start &&
            previous.length === edit.length &&
            previous.old_text === edit.old_text &&
            previous.new_text === edit.new_text
          )
            continue;
          throw new RenameFailure('overlapping_edits', `Conflicting rename spans in ${file}.`);
        }
        edits.push(edit);
      }
      let output = snapshot;
      for (const edit of [...edits].reverse())
        output =
          output.slice(0, edit.start) + edit.new_text + output.slice(edit.start + edit.length);
      files.set(file, { absolute, real, snapshot, output });
      changes.push({
        file_path: file,
        edits: edits.map(({ file_path: _file, ...edit }) => {
          const lineStart = snapshot.lastIndexOf('\n', edit.start - 1) + 1;
          const nextLine = snapshot.indexOf('\n', edit.start);
          const lineEnd = nextLine < 0 ? snapshot.length : nextLine;
          return {
            ...edit,
            confidence: 'semantic',
            line: snapshot.slice(0, edit.start).split('\n').length,
            before: snapshot.slice(lineStart, lineEnd),
            after:
              snapshot.slice(lineStart, edit.start) +
              edit.new_text +
              snapshot.slice(edit.start + edit.length, lineEnd),
          };
        }),
      });
    }
    await validateSnapshots(plan);
  } catch (error) {
    return { ...blocked(plan.symbol, plan.new_name, error), coverage: plan.coverage };
  }

  if (dryRun) return { ...result(plan.symbol, plan.new_name, changes), coverage: plan.coverage };
  const landed: FileChange[] = [];
  for (const change of changes) {
    const file = files.get(change.file_path)!;
    let temporaryDirectory: string | undefined;
    try {
      // Recheck each destination immediately before its write. A concurrent edit
      // after an earlier write is a partial operation, never a successful rename.
      if (
        (await checkedRealPath(repoPath, change.file_path)) !== file.real ||
        !(await fs.readFile(file.absolute)).equals(Buffer.from(file.snapshot, 'utf8'))
      ) {
        throw new RenameFailure(
          'source_changed',
          `Source changed before writing ${change.file_path}.`,
        );
      }
      // A rejected in-place write may already have truncated the source. Finish
      // a replacement beside the destination before installing it atomically.
      const { mode } = await fs.stat(file.real);
      temporaryDirectory = await fs.mkdtemp(
        path.join(path.dirname(file.real), '.gitnexus-rename-'),
      );
      const replacement = path.join(temporaryDirectory, 'replacement');
      await fs.writeFile(replacement, file.output, 'utf8');
      await fs.chmod(replacement, mode);
      if (
        (await checkedRealPath(repoPath, change.file_path)) !== file.real ||
        !(await fs.readFile(file.absolute)).equals(Buffer.from(file.snapshot, 'utf8'))
      ) {
        throw new RenameFailure(
          'source_changed',
          `Source changed before replacing ${change.file_path}.`,
        );
      }
      await fs.rename(replacement, file.real);
      landed.push(change);
    } catch (error) {
      return {
        ...result(plan.symbol, plan.new_name, landed),
        coverage: plan.coverage,
        status: 'partial',
        applied: landed.length > 0,
        application_status: landed.length ? 'partial' : 'failed',
        code: error instanceof RenameFailure ? error.code : 'write_failed',
        error: `${error instanceof Error ? error.message : String(error)} Check failed files before retrying; writes are not transactional.`,
        failed_files: changes.slice(landed.length).map((c) => c.file_path),
      };
    } finally {
      // Cleanup must not turn an installed replacement into a reported failure.
      if (temporaryDirectory)
        await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
  return {
    ...result(plan.symbol, plan.new_name, landed),
    coverage: plan.coverage,
    applied: true,
    application_status: 'applied',
  };
}

/** One planner for preview and application; unsupported providers never fall back to text search. */
export async function renameSymbol(
  repoPath: string,
  symbol: RenameSymbol,
  options: RenameOptions,
  graphNodes: readonly GraphNode[],
  referenceFiles: readonly string[] = [],
): Promise<RenameResult> {
  try {
    if (options.dry_run !== undefined && typeof options.dry_run !== 'boolean')
      throw new RenameFailure('invalid_argument', 'dry_run must be a boolean.');
    const { planGraphRename } = await import('./graph-rename.js');
    const plan = await planGraphRename(repoPath, symbol, options, graphNodes, referenceFiles);
    return await executeRenamePlan(repoPath, plan, options.dry_run ?? true);
  } catch (error) {
    return blocked(symbol, options.new_name, error);
  }
}
