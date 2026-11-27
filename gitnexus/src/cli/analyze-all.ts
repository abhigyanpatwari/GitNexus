import { spawnSync } from 'node:child_process';
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

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  for (const repo of repos) {
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

    console.log(`\n  Analyzing ${repo.name} (${repo.path})`);
    // Each analyze can re-exec for heap sizing and exits after publishing the
    // graph. A separate process also isolates each repo's native DB handles.
    // An empty indexed commit is also used by checkouts without a HEAD.
    // --skip-git still detects Git at an explicit path when it is present.
    const repoArgs = repo.lastCommit === '' && !options.skipGit ? ['--skip-git'] : [];
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, process.argv[1], 'analyze', ...args, ...repoArgs, '--', repo.path],
      { stdio: 'inherit', windowsHide: true },
    );
    if (child.signal === 'SIGINT' || child.status === 130) {
      process.exitCode = 130;
      return;
    }
    if (child.signal === 'SIGTERM' || child.status === 143) {
      process.exitCode = 143;
      return;
    }
    if (child.status === 0) {
      succeeded++;
    } else {
      process.stderr.write(
        `  Analysis failed for ${repo.path} (${child.error?.message ?? child.signal ?? child.status}).\n`,
      );
      failed++;
    }
  }

  console.log(`\n  Batch analysis: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}
