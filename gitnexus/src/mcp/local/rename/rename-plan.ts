import {
  RenameFailure,
  applyEdits,
  prepareRenameEdits,
  renameResult as result,
  blockedRenameResult as blocked,
} from 'gitnexus-shared';
import type {
  RenameSymbol,
  RenameOptions,
  RenameResult,
  RenamePlan,
  FileChange,
  OccurrenceEdit,
} from 'gitnexus-shared';
export { RenameFailure } from 'gitnexus-shared';
export type {
  RenameSymbol,
  RenameOptions,
  RenameResult,
  RenamePlan,
  RenameCoverage,
  OccurrenceEdit,
} from 'gitnexus-shared';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { logger } from '../../../core/logger.js';

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

async function validateSnapshots(snapshots: ReadonlyMap<string, Buffer>): Promise<void> {
  const entries = [...snapshots];
  // Bound concurrent reads so large repositories cannot exhaust descriptors.
  // Every source is still checked before each replacement, including unedited files.
  for (let start = 0; start < entries.length; start += 8) {
    const batch = entries.slice(start, start + 8);
    const contents = await Promise.all(batch.map(([file]) => fs.readFile(file)));
    for (let index = 0; index < batch.length; index++) {
      const [file, snapshot] = batch[index]!;
      if (contents[index]!.equals(snapshot)) continue;
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
  // Reuse encoded snapshots across the full-scope checks instead of encoding
  // every unchanged source again for every file that is written.
  const expectedSnapshots = new Map(
    [...plan.snapshots].map(([file, snapshot]) => [file, Buffer.from(snapshot, 'utf8')]),
  );
  const files = new Map<string, { absolute: string; real: string; output: string }>();
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
      const { edits, reports } = prepareRenameEdits(snapshot, unsorted, file);
      const output = applyEdits(snapshot, edits);
      files.set(file, { absolute, real, output });
      changes.push({ file_path: file, edits: reports });
    }
    await validateSnapshots(expectedSnapshots);
  } catch (error) {
    return { ...blocked(plan.symbol, plan.new_name, error), coverage: plan.coverage };
  }

  if (dryRun) return { ...result(plan.symbol, plan.new_name, changes), coverage: plan.coverage };
  const landed: FileChange[] = [];
  for (const change of changes) {
    const file = files.get(change.file_path)!;
    let temporaryDirectory: string | undefined;
    try {
      // Recheck each destination before staging its replacement. A detected source
      // change after an earlier write is reported as a partial operation.
      if (
        (await checkedRealPath(repoPath, change.file_path)) !== file.real ||
        !(await fs.readFile(file.absolute)).equals(expectedSnapshots.get(file.absolute)!)
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
      // Unedited sources also contribute semantic evidence. Already installed
      // files must match their landed outputs rather than their old snapshots.
      await validateSnapshots(expectedSnapshots);
      // A later evidence read can race with an edit to this destination. Recheck
      // last; validation and replacement remain separate filesystem operations.
      if (
        (await checkedRealPath(repoPath, change.file_path)) !== file.real ||
        !(await fs.readFile(file.absolute)).equals(expectedSnapshots.get(file.absolute)!)
      ) {
        throw new RenameFailure(
          'source_changed',
          `Source changed before replacing ${change.file_path}.`,
        );
      }
      await fs.rename(replacement, file.real);
      expectedSnapshots.set(file.absolute, Buffer.from(file.output, 'utf8'));
      landed.push(change);
    } catch (error) {
      return {
        ...result(plan.symbol, plan.new_name, landed),
        coverage: plan.coverage,
        status: landed.length ? 'partial' : 'error',
        applied: landed.length > 0,
        application_status: landed.length ? 'partial' : 'failed',
        code: error instanceof RenameFailure ? error.code : 'write_failed',
        error: `${error instanceof Error ? error.message : String(error)} Inspect failed_files and unattempted_files before retrying; writes are not transactional.`,
        // Landed files are exactly changes[0..landed.length); the current change is the
        // one whose staging, validation or install threw, and the rest were never touched.
        failed_files: [change.file_path],
        unattempted_files: changes.slice(landed.length + 1).map((c) => c.file_path),
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
    if (!(error instanceof RenameFailure))
      logger.error(
        { err: error, symbolUid: symbol.uid, filePath: symbol.filePath },
        'Semantic rename planning failed',
      );
    return blocked(symbol, options.new_name, error);
  }
}
