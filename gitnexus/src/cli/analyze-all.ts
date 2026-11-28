import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Command } from 'commander';
import { readRegistryStrict } from '../storage/repo-manager.js';
import { STORAGE_PATH_ENV, STORAGE_ROOT_ENV } from '../storage/storage-slot.js';

export async function analyzeAllCommand(
  inputPath: string | undefined,
  command: Command,
): Promise<void> {
  const options = command.opts();
  const args: string[] = [];
  // Forward only explicitly selected options and keep optional values attached
  // to their flag, so a bare --embeddings cannot consume the repository path.
  for (const option of command.options) {
    const key = option.attributeName();
    const flag = option.long;
    if (!flag || key === 'all' || command.getOptionValueSource(key) !== 'cli') continue;
    if (['watch', 'branch', 'name', 'shareWith', 'share'].includes(key)) {
      process.stderr.write(`  ${flag} cannot be used with --all.\n`);
      process.exitCode = 1;
      return;
    }
    const value = options[key];
    args.push(option.required || (option.optional && value !== true) ? `${flag}=${value}` : flag);
  }
  if (
    inputPath !== undefined ||
    process.env[STORAGE_PATH_ENV]?.trim() ||
    process.env[STORAGE_ROOT_ENV]?.trim()
  ) {
    process.stderr.write(
      `  --all uses registered repository paths and storage. Omit the path and unset ${STORAGE_PATH_ENV} and ${STORAGE_ROOT_ENV}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  let repos;
  try {
    repos = await readRegistryStrict();
  } catch (error) {
    process.stderr.write(`  Could not read the repository registry: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const aliases = new Map<string, number>();
  for (const repo of repos) {
    const alias = repo.name.toLowerCase();
    aliases.set(alias, (aliases.get(alias) ?? 0) + 1);
  }

  let activeChild: ChildProcess | undefined;
  let cancellation: NodeJS.Signals | undefined;
  const cancel = (signal: NodeJS.Signals) => {
    if (cancellation) return;
    cancellation = signal;
    activeChild?.kill(signal);
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    for (const repo of repos) {
      if (cancellation) break;
      if (!isAbsolute(repo.path)) {
        process.stderr.write(`  Invalid registered repository path: ${repo.path}\n`);
        failed++;
        continue;
      }
      try {
        if (!(await stat(repo.path)).isDirectory()) {
          process.stderr.write(`  Skipping ${repo.path} (not a directory).\n`);
          skipped++;
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          process.stderr.write(`  Skipping ${repo.path} (directory missing).\n`);
          skipped++;
        } else {
          process.stderr.write(`  Failed to access ${repo.path}: ${(error as Error).message}\n`);
          failed++;
        }
        continue;
      }

      if (cancellation) break;
      console.log(`\n  Analyzing ${repo.name} (${repo.path})`);
      // Each analyze can re-exec for heap sizing and exits after publishing the
      // graph. A separate process also isolates each repo's native DB handles.
      // Legacy registry entries can omit lastCommit. An empty commit is also
      // used by non-Git folders and checkouts without a HEAD.
      // --skip-git still detects Git at an explicit path when it is present.
      const repoArgs = (repo.lastCommit ?? '') === '' && !options.skipGit ? ['--skip-git'] : [];
      if (!options.allowDuplicateName && (aliases.get(repo.name.toLowerCase()) ?? 0) > 1) {
        repoArgs.push('--allow-duplicate-name');
      }
      const child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1], 'analyze', ...args, ...repoArgs, '--', repo.path],
        { stdio: 'inherit', windowsHide: true },
      );
      activeChild = child;
      let spawnError: Error | undefined;
      const { status, signal } = await new Promise<{
        status: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.on('error', (error) => {
          spawnError = error;
        });
        child.once('close', (status, signal) => resolve({ status, signal }));
      });
      activeChild = undefined;
      if (signal === 'SIGINT' || status === 130) cancellation ??= 'SIGINT';
      if (signal === 'SIGTERM' || status === 143) cancellation ??= 'SIGTERM';
      if (cancellation) break;
      if (status === 0) {
        succeeded++;
      } else {
        process.stderr.write(
          `  Analysis failed for ${repo.path} (${spawnError?.message ?? signal ?? status}).\n`,
        );
        failed++;
      }
    }

    if (cancellation) {
      process.exitCode = cancellation === 'SIGINT' ? 130 : 143;
      return;
    }
    console.log(
      `\n  Batch analysis: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed.`,
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
