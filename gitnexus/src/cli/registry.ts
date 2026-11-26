/**
 * Registry Command (#3332)
 *
 * Registers `gitnexus registry ...` with lazy implementation loading so CLI
 * startup does not eagerly pull in storage modules.
 */

import type { Command } from 'commander';
import type { PruneBranchesOptions } from './registry-prune.js';

export function registerRegistryCommands(program: Command): void {
  const registry = program
    .command('registry')
    .description('Perform locked mutations on the global GitNexus registry');

  registry
    .command('prune-branches')
    .description(
      'Prune stale per-branch index slots; registry.json updates take the global registry lock',
    )
    .option('-r, --repo <path>', 'Path to the git repository', '.')
    .option('--dry-run', 'Report stale branches without deleting slots or modifying registry.json')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: PruneBranchesOptions) => {
      const { pruneBranchesCommand } = await import('./registry-prune.js');
      await pruneBranchesCommand(opts);
    });
}
