// gitnexus/src/cli/group.ts
import { createRequire } from 'node:module';
import type { Command } from 'commander';
import type { RegistryWriteOutcome } from '../core/group/sync.js';
import type { MatchType } from '../core/group/types.js';
import { logger } from '../core/logger.js';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

export function registerGroupCommands(program: Command): void {
  const group = program
    .command('group')
    .description('Manage repository groups for cross-index impact analysis');

  group
    .command('create <name>')
    .description('Create a new group with template group.yaml')
    .option('--force', 'Overwrite existing group')
    .action(async (name: string, opts: { force?: boolean }) => {
      const { createGroupDir, getDefaultGitnexusDir } = await import('../core/group/storage.js');
      const dir = await createGroupDir(getDefaultGitnexusDir(), name, opts.force);
      console.log(`Created group "${name}" at ${dir}`);
      console.log('Edit group.yaml to add repos, then run: gitnexus group sync ' + name);
    });

  group
    .command('add <group> <groupPath> <registryName>')
    .description(
      'Add a repo to a group. <groupPath> = hierarchy path (e.g. hr/hiring/backend), <registryName> = name from registry',
    )
    .action(async (groupName: string, groupPath: string, registryName: string) => {
      const { getGroupDir, getDefaultGitnexusDir } = await import('../core/group/storage.js');
      const { loadGroupConfig } = await import('../core/group/config-parser.js');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const groupDir = getGroupDir(getDefaultGitnexusDir(), groupName);
      const config = await loadGroupConfig(groupDir);
      config.repos[groupPath] = registryName;

      await fs.writeFile(path.join(groupDir, 'group.yaml'), yaml.dump(config), 'utf-8');
      console.log(`Added ${registryName} as "${groupPath}" to group "${groupName}"`);
      console.log(`Run: gitnexus group sync ${groupName}`);
    });

  group
    .command('remove <group> <path>')
    .description('Remove a repo from a group')
    .action(async (groupName: string, repoPath: string) => {
      const { getGroupDir, getDefaultGitnexusDir } = await import('../core/group/storage.js');
      const { loadGroupConfig } = await import('../core/group/config-parser.js');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const groupDir = getGroupDir(getDefaultGitnexusDir(), groupName);
      const config = await loadGroupConfig(groupDir);
      if (!(repoPath in config.repos)) {
        logger.error(`Repo path "${repoPath}" not found in group "${groupName}"`);
        process.exitCode = 1;
        return;
      }
      delete config.repos[repoPath];
      await fs.writeFile(path.join(groupDir, 'group.yaml'), yaml.dump(config), 'utf-8');
      console.log(`Removed "${repoPath}" from group "${groupName}"`);
    });

  group
    .command('list [name]')
    .description('List all groups or details of one')
    .action(async (name?: string) => {
      const { listGroups, getDefaultGitnexusDir, getGroupDir } =
        await import('../core/group/storage.js');
      if (!name) {
        const groups = await listGroups();
        if (groups.length === 0) {
          console.log('No groups configured. Create one with: gitnexus group create <name>');
          return;
        }
        console.log('Groups:');
        groups.forEach((g) => console.log(`  ${g}`));
        return;
      }
      const { loadGroupConfig } = await import('../core/group/config-parser.js');
      const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
      const config = await loadGroupConfig(groupDir);
      console.log(`Group: ${config.name}`);
      if (config.description) console.log(`Description: ${config.description}`);
      console.log(`\nRepos (${Object.keys(config.repos).length}):`);
      for (const [p, id] of Object.entries(config.repos)) {
        console.log(`  ${p} -> ${id}`);
      }
      if (config.links.length > 0) {
        console.log(`\nManifest links (${config.links.length}):`);
        for (const link of config.links) {
          console.log(`  ${link.from} -> ${link.to} [${link.type}: ${link.contract}]`);
        }
      }
    });

  group
    .command('status <name>')
    .description('Check staleness of group and repos')
    .action(async (name: string) => {
      const { readContractRegistry, getGroupDir, getDefaultGitnexusDir } =
        await import('../core/group/storage.js');
      const { LocalBackend } = await import('../mcp/local/local-backend.js');

      const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
      const registry = await readContractRegistry(groupDir);

      console.log(
        `Group: ${name}${registry ? ` (last sync: ${registry.generatedAt})` : ' (never synced)'}\n`,
      );

      const backend = new LocalBackend();
      try {
        await backend.init();
        const raw = await backend.getGroupService().groupStatus({ name });
        const st = raw as {
          repos?: Record<
            string,
            {
              indexStale: boolean;
              contractsStale: boolean;
              missing: boolean;
              /**
               * Optional here on purpose: a payload produced before the split
               * carries no such key, and an absent one must degrade to the
               * label this command has always printed rather than to the new
               * one — an unrecorded cause is not evidence of a cause.
               */
              unresolvable?: boolean;
              unresolvableReason?: string;
              commitsBehind?: number;
            }
          >;
          missingRepos?: string[];
          unreadableRepos?: string[];
          suppressedMatchStages?: string[];
        };

        console.log('  Repo index / contracts staleness:');
        for (const [repoPath, row] of Object.entries(st.repos || {})) {
          if (row.missing) {
            // Two different facts with two different remedies: a repo the
            // registry never heard of is fixed by indexing it, while an entry
            // the resolver choked on is fixed by repairing the registry.
            // Printing "no entry in the registry" for the second one states a
            // cause that was never measured, and points at the wrong repair.
            if (row.unresolvable) {
              // The reason can be multi-line — an ambiguous registry names
              // every colliding clone. Fold it onto this row's line rather
              // than truncating it: those paths are what the operator acts on,
              // and a table row that swallows half its own explanation is the
              // failure this label exists to stop.
              const why = (row.unresolvableReason ?? 'the registry entry could not be resolved')
                .replace(/\s+/g, ' ')
                .trim();
              console.log(`  ${repoPath.padEnd(25)} UNRESOLVABLE (${why})`);
              continue;
            }
            console.log(`  ${repoPath.padEnd(25)} MISSING   (no entry in the registry)`);
            continue;
          }
          const idx = row.indexStale
            ? `STALE     (${row.commitsBehind ?? '?'} commits behind)`
            : 'OK        ';
          const ctr = row.contractsStale ? ' CONTRACTS_STALE' : '';
          console.log(`  ${repoPath.padEnd(25)} ${idx}${ctr}`);
        }
        // `undefined` and `[]` are different answers here: a registry written
        // before this was tracked has no opinion, while an empty array is a
        // measurement. Printing nothing for both would let an unmeasured sync
        // read as evidence that every index opened cleanly.
        //
        // `undefined` covers two ways of not knowing — the field is absent, or
        // it held something that was not a list of repo paths and `getStatus`
        // declined to guess. Naming only the first would make a corrupt
        // registry read as a merely old one, which is the same shape of wrong
        // answer this command exists to stop giving.
        const unreadable = st.unreadableRepos;
        if (unreadable === undefined) {
          console.log(
            `\n  Last sync unreadable repos: not recorded` +
              `\n     (the registry predates this field, or its value could not be read)` +
              `\n     Re-run \`gitnexus group sync\` to record it.`,
          );
        } else if (unreadable.length > 0) {
          console.log(`\n  Last sync unreadable repos: ${unreadable.join(', ')}`);
        }
        if ((st.missingRepos || []).length > 0) {
          console.log(`\n  Last sync missing repos: ${st.missingRepos!.join(', ')}`);
        }
        // Only the populated case prints. Absent means a registry that predates
        // the field, and empty is the ordinary clean sync — neither is worth a
        // line, whereas a narrowed registry changes how every later answer
        // should be read.
        const skippedStages = st.suppressedMatchStages ?? [];
        if (skippedStages.length > 0) {
          console.log(
            `\n  Last sync skipped matching stages: ${skippedStages.join(', ')}` +
              `\n     Cross-links those stages would have found are absent by request.` +
              `\n     Re-run \`gitnexus group sync\` without --exact-only for the complete set.`,
          );
        }
      } finally {
        await backend.dispose().catch(() => {});
      }
    });

  group
    .command('sync <name>')
    .description('Sync Contract Registry — extract contracts and build cross-links')
    .option(
      '--exact-only',
      'Skip wildcard service matching; cross-link on exact contract-id match only (manifest links still apply)',
    )
    .option('--verbose', 'Show additional sync diagnostics')
    .option('--json', 'JSON output')
    .action(async (name: string, opts: Record<string, boolean | undefined>) => {
      const { getGroupDir, getDefaultGitnexusDir } = await import('../core/group/storage.js');
      const { loadGroupConfig } = await import('../core/group/config-parser.js');
      const { syncGroup } = await import('../core/group/sync.js');
      const { GroupSyncLockError } = await import('../core/group/group-lock.js');

      const groupDir = getGroupDir(getDefaultGitnexusDir(), name);
      const config = await loadGroupConfig(groupDir);

      console.log(`Syncing group "${name}" (${Object.keys(config.repos).length} repos)...\n`);

      let result: Awaited<ReturnType<typeof syncGroup>>;
      try {
        result = await syncGroup(config, {
          groupDir,
          verbose: Boolean(opts.verbose),
          exactOnly: Boolean(opts.exactOnly),
        });
      } catch (err) {
        // A sync that could not take the group's lock did NOT run and wrote
        // nothing (R9 fails closed). That is an operator-actionable outcome, not
        // a crash, so report it as a failed command rather than letting it
        // surface as an unhandled rejection with a stack trace — commander's
        // async actions have no error handler, so an uncaught throw here would
        // print exactly that.
        if (!(err instanceof GroupSyncLockError)) throw err;
        logger.error(`⚠️ Did not sync group "${name}": ${err.message}`);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        // Repos we could not read are the most likely explanation for a small
        // or empty contract count, so they are reported before the counts —
        // otherwise a run that read nothing looks exactly like a clean run.
        if (result.unreadableRepos.length > 0) {
          // No "re-run with GITNEXUS_LOG_LEVEL=warn" hint: the default level is
          // `info`, and pino emits `warn` (40) at `info` (30), so the reason was
          // already printed by this same run — raising the level to `warn` would
          // only suppress the surrounding `info` output.
          console.log(
            `\n  ⚠️ Could not extract contracts from: ${result.unreadableRepos.join(', ')}` +
              `\n     None of their contracts are included in this sync (the warning above says why),` +
              `\n     or check \`gitnexus doctor\` in the affected repo.`,
          );
        }
        if (result.missingRepos.length > 0) {
          console.log(
            `\n  ⚠️ Not found in the registry: ${result.missingRepos.join(', ')}` +
              `\n     Index them with \`gitnexus analyze\`, or remove them from group.yaml.`,
          );
        }
        // Every stage that produced a link, not just `exact`. This used to print
        // `Matching cascade:` and then count `exact` alone, while the `Wrote
        // contracts.json (…)` line below reports `result.crossLinks.length` —
        // which also includes `manifest` and `wildcard` links. For any group with
        // those, the two numbers disagreed with nothing on screen explaining why.
        // Summing the stages here makes them reconcile by construction.
        console.log(`\nMatching:`);
        // Exhaustive by construction, same idiom as OUTCOME_LINE below: adding a
        // MatchType fails the build here instead of silently going uncounted and
        // reopening the very mismatch this replaced. Every stage prints even at
        // zero — a stage that is absent reads as "did not apply", not "found none".
        const STAGE_COUNTS: Record<MatchType, number> = {
          exact: 0,
          manifest: 0,
          wildcard: 0,
        };
        for (const link of result.crossLinks) STAGE_COUNTS[link.matchType] += 1;
        // A stage the sync was told to skip is reported as skipped, not as a
        // zero count. The two are different facts — "ran, matched nothing" and
        // "never ran" — and printing both as `0` is the same conflation this
        // block replaced. Driven by what the sync did (`suppressedMatchStages`)
        // rather than by what the caller asked for, so it stays correct on the
        // outcomes where the run ended without writing a registry.
        for (const stage of Object.keys(STAGE_COUNTS) as MatchType[]) {
          const count = STAGE_COUNTS[stage];
          const label = `${stage}:`.padEnd(10);
          if (result.suppressedMatchStages.includes(stage)) {
            console.log(`  ${label} skipped (--exact-only)`);
            continue;
          }
          const confidence = stage === 'exact' ? ' (confidence 1.0)' : '';
          console.log(`  ${label} ${count} cross-links${confidence}`);
        }
        console.log(`  ${'unmatched:'.padEnd(10)} ${result.unmatched.length} contracts`);
        // Driven by what actually happened to the file. This line used to be
        // unconditional, so a run that deliberately preserved the previous
        // registry still announced `Wrote contracts.json (0 contracts, 0
        // cross-links)` — a confident false statement about persisted state, on
        // the exact path this command exists to make legible.
        // Exhaustive by construction: a `Record` keyed on the union means a
        // new outcome fails the build here instead of printing nothing, which
        // is what previously pushed a distinct state into `preserved` and made
        // this summary false on one of the two branches it then covered.
        const OUTCOME_LINE: Record<RegistryWriteOutcome, string | null> = {
          written:
            `\nWrote contracts.json (${result.contracts.length} contracts, ` +
            `${result.crossLinks.length} cross-links)`,
          preserved:
            `\nKept the previous contracts.json — no repo in this group could be read.` +
            `\n  Its contracts and cross-links are unchanged; only the unreadable/missing` +
            `\n  repo lists were refreshed to describe THIS run. Fix the repos above and re-run.`,
          superseded:
            `\nDid NOT touch contracts.json — no repo in this group could be read, and another` +
            `\n  sync replaced the file while this one waited for the group lock. That sync's` +
            `\n  result stands and this run's repo lists were NOT recorded: they describe a` +
            `\n  group state older than what is on disk. Fix the repos above and re-run.`,
          'no-prior-registry':
            `\nDid NOT write contracts.json — no repo in this group could be read,` +
            `\n  and there is no previous contracts.json to fall back on. Fix the repos` +
            `\n  above and re-run.`,
          // Nothing to say: the caller asked for no write.
          'not-attempted': null,
        };
        const line = OUTCOME_LINE[result.registryOutcome];
        if (line) console.log(line);
      }
    });

  group
    .command('impact <name>')
    .description('Cross-repo impact for a symbol in one member repo of a group')
    .requiredOption('--target <symbol>', 'Symbol or file name to analyze')
    .requiredOption(
      '--repo <groupPath>',
      'Member path from group.yaml (e.g. app/backend), not the indexed repo name',
    )
    .option('--direction <dir>', 'upstream or downstream', 'upstream')
    .option('--service <path>', 'Optional monorepo service directory prefix (path filter)')
    .option(
      '--subgroup <path>',
      'Optional prefix limiting which group repos participate in cross fan-out',
    )
    .option('--max-depth <n>', 'Max graph traversal depth')
    .option('--cross-depth <n>', 'Cross-repository hop depth')
    .option('--min-confidence <n>', 'Minimum relation confidence (0–1)')
    .option('--include-tests', 'Include test files in traversal', false)
    .option('--timeout-ms <n>', 'Phase-1 local impact wall time in milliseconds')
    .option('--json', 'JSON output')
    .action(async (name: string, opts: Record<string, string | boolean | undefined>) => {
      const { LocalBackend } = await import('../mcp/local/local-backend.js');

      const backend = new LocalBackend();
      try {
        await backend.init();

        const payload: Record<string, unknown> = {
          name,
          repo: opts.repo,
          target: opts.target,
          direction: (opts.direction as string) || 'upstream',
        };
        if (opts.service) payload.service = opts.service;
        if (opts.subgroup) payload.subgroup = opts.subgroup;
        if (opts.maxDepth !== undefined && opts.maxDepth !== '') {
          const n = parseInt(String(opts.maxDepth), 10);
          if (!Number.isNaN(n)) payload.maxDepth = n;
        }
        if (opts.crossDepth !== undefined && opts.crossDepth !== '') {
          const n = parseInt(String(opts.crossDepth), 10);
          if (!Number.isNaN(n)) payload.crossDepth = n;
        }
        if (opts.minConfidence !== undefined && opts.minConfidence !== '') {
          const n = parseFloat(String(opts.minConfidence));
          if (!Number.isNaN(n)) payload.minConfidence = n;
        }
        if (opts.timeoutMs !== undefined && opts.timeoutMs !== '') {
          const n = parseInt(String(opts.timeoutMs), 10);
          if (!Number.isNaN(n)) payload.timeoutMs = n;
        }
        if (opts.includeTests) payload.includeTests = true;

        const raw = await backend.getGroupService().groupImpact(payload);
        if (raw && typeof raw === 'object' && 'error' in raw) {
          logger.error(String((raw as { error: string }).error));
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(raw, null, 2));
        } else {
          const summary = (raw as { summary?: Record<string, number> })?.summary;
          const risk = (raw as { risk?: string })?.risk;
          // A truncated fan-out under-reports risk (mergeRisk only grows with
          // traversed crossings), and the default human output used to print a
          // bare `risk=` indistinguishable from a complete run — the JSON
          // already carried `truncated`, but nobody reading the terminal saw it.
          const riskFloor =
            (raw as { riskEpistemic?: string })?.riskEpistemic === 'lower-bound' ? '+' : '';
          const boundaryOnly =
            (
              raw as {
                cross?: Array<{ fanout_status?: string }>;
              }
            )?.cross?.filter((entry) => entry.fanout_status === 'not_attempted').length ?? 0;
          console.log(
            `Group impact for "${name}" (${String(opts.repo)}): risk=${risk ?? '?'}${riskFloor}`,
          );
          if (summary) {
            const boundaryNote = boundaryOnly > 0 ? ` (${boundaryOnly} boundary-only)` : '';
            console.log(
              `  direct=${summary.direct ?? 0} processes=${summary.processes_affected ?? 0} cross=${summary.cross_repo_hits ?? 0}${boundaryNote}`,
            );
          }
          if (riskFloor) {
            // `truncated` has two independent causes that point at different
            // subsystems, so the note must name the one that actually fired:
            // dropped crossings, or a local walk that never finished (most
            // often the impact chunk cap, which any symbol with more than a
            // thousand locally-impacted nodes hits on every run). `dropped` is
            // deduped to distinct repos before it reaches here, so it counts
            // repos — reporting it as crossings understates a fan-out cap the
            // same way #2787's totals did.
            const dropped = (raw as { truncatedRepos?: string[] })?.truncatedRepos ?? [];
            const reason = (raw as { truncationReason?: string })?.truncationReason;
            // Keyed on the REASON, not on which incidental fact happens to be
            // non-empty. `truncatedRepos` is populated for a structural gap too
            // — the bridge's incomplete repos are unioned into it even when ZERO
            // crossings were attempted — so branching on its length first
            // reported "fan-out stopped early" for a run where nothing stopped
            // early, and omitted the only remedy that works. Same false-cause
            // shape the contract listing was just re-gated for, one command over.
            const floorReason = (): string => {
              if (reason === 'suppressed-stage') {
                return 'the last sync skipped a matching stage (--exact-only); re-run `gitnexus group sync` without it for the complete graph';
              }
              if (reason === 'incomplete-sync') {
                return dropped.length > 0
                  ? `the last sync could not account for ${dropped.join(', ')}; their contracts are absent from every query against this bridge — re-run \`gitnexus group sync\``
                  : 'the last sync could not say which repos it read — re-run `gitnexus group sync`';
              }
              return dropped.length > 0
                ? `fan-out stopped early; crossings to ${dropped.length} repo(s) not traversed: ${dropped.join(', ')}`
                : 'the local impact walk did not complete (every bridge crossing was traversed)';
            };
            console.log(`  risk is a LOWER BOUND — ${floorReason()}`);
          }
        }
      } finally {
        await backend.dispose().catch(() => {});
      }
    });

  group
    .command('query <name> <query>')
    .description('Search execution flows across all repos in a group')
    .option('--subgroup <path>', 'Limit search scope')
    .option('--limit <n>', 'Max merged results', '5')
    .option('--json', 'JSON output')
    .action(
      async (
        name: string,
        queryText: string,
        opts: Record<string, string | boolean | undefined>,
      ) => {
        const { LocalBackend } = await import('../mcp/local/local-backend.js');

        const limit = parseInt(String(opts.limit ?? '5'), 10) || 5;
        const subgroup = opts.subgroup as string | undefined;
        const backend = new LocalBackend();
        try {
          await backend.init();

          console.log(`Searching "${queryText}" across group "${name}"...\n`);

          const raw = await backend.getGroupService().groupQuery({
            name,
            query: queryText,
            limit,
            subgroup,
          });
          const merged = raw as {
            results: Array<Record<string, unknown>>;
            per_repo: Array<{ repo: string; count: number }>;
          };

          if (opts.json) {
            console.log(JSON.stringify(raw, null, 2));
          } else {
            console.log(`Results (top ${merged.results.length}):\n`);
            for (const p of merged.results) {
              const label = (p.summary || p.heuristicLabel || p.name || 'unnamed') as string;
              console.log(`  [${p._repo}] ${label} (rrf: ${(p._rrf_score as number).toFixed(4)})`);
            }
            if (merged.results.length === 0) {
              console.log('  No matching execution flows found.');
            }
          }
        } finally {
          await backend.dispose().catch(() => {});
        }
      },
    );

  group
    .command('contracts <name>')
    .description('Inspect Contract Registry')
    .option('--type <type>', 'Filter by contract type')
    .option('--repo <repo>', 'Filter by repo')
    .option('--unmatched', 'Show only unmatched contracts')
    .option('--json', 'JSON output')
    .action(async (name: string, opts: Record<string, string | boolean | undefined>) => {
      const { LocalBackend } = await import('../mcp/local/local-backend.js');

      const backend = new LocalBackend();
      try {
        await backend.init();
        const raw = await backend.getGroupService().groupContracts({
          name,
          type: opts.type as string | undefined,
          repo: opts.repo as string | undefined,
          unmatchedOnly: Boolean(opts.unmatched),
        });

        if (raw && typeof raw === 'object' && 'error' in raw) {
          logger.error(String((raw as { error: string }).error));
          process.exitCode = 1;
          return;
        }

        const {
          contracts,
          crossLinks,
          truncated,
          unreadableRepos,
          missingRepos,
          suppressedMatchStages,
          truncationReason,
        } = raw as {
          contracts: Array<{
            role: string;
            contractId: string;
            repo: string;
            symbolRef: { name: string };
          }>;
          crossLinks: Array<{
            from: { repo: string };
            to: { repo: string };
            matchType: string;
            confidence: number;
            contractId: string;
          }>;
          truncated?: boolean;
          suppressedMatchStages?: string[];
          truncationReason?: string;
          unreadableRepos?: string[];
          missingRepos?: string[];
        };

        if (opts.json) {
          // The whole payload, not a re-serialized subset. Destructuring the two
          // fields this command happens to print and rebuilding an object from
          // them dropped everything else the service returned — which is how the
          // completeness fields were invisible here while the MCP tool carried
          // them. Printing `raw` means a field added to the service reaches
          // `--json` without a matching edit in this file.
          console.log(JSON.stringify(raw, null, 2));
        } else {
          console.log(`Contracts (${contracts.length}):`);
          for (const c of contracts) {
            console.log(`  [${c.role}] ${c.contractId}  (${c.repo})  ${c.symbolRef.name}`);
          }
          console.log(`\nCross-links (${crossLinks.length}):`);
          for (const l of crossLinks) {
            console.log(
              `  ${l.from.repo} -> ${l.to.repo}  [${l.matchType}, conf=${l.confidence}]  ${l.contractId}`,
            );
          }
          // Separate from `truncated` below, and deliberately so: that one means
          // the sync could not read something and the remedy is to fix the repo.
          // This one means the sync was ASKED to skip a stage, and the remedy is
          // to re-run without the flag. A listing narrowed on purpose is still
          // narrowed, and without this the human view showed nothing at all.
          if (suppressedMatchStages && suppressedMatchStages.length > 0) {
            console.log(
              `\n⚠️ This listing is a lower bound: the last sync skipped ${suppressedMatchStages.join(', ')} matching` +
                `\n   (--exact-only), so cross-links that stage would have found are absent.` +
                `\n   Re-run \`gitnexus group sync\` without --exact-only for the complete set.`,
            );
          }
          // Gated on the REASON, not just the flag. A suppressed stage sets
          // `truncated` with both repo lists empty, which sent this block down
          // its else-branch and printed "the last sync did not record which
          // repos it could read" — a false statement, with the wrong remedy,
          // about a sync that recorded them fine. The suppressed-stage warning
          // above already said the true thing. When a repo gap co-occurs the
          // reason is 'incomplete-sync' (the repo side takes precedence in
          // `crossRepoCompleteness`), so this block still runs for it.
          if (truncated && truncationReason !== 'suppressed-stage') {
            // Counts above are a floor, not a census. Name the repos when the
            // registry recorded them, and say so plainly when it did not — a
            // listing that cannot say what it is missing is still incomplete.
            const absent = [...(unreadableRepos ?? []), ...(missingRepos ?? [])];
            console.log(
              absent.length > 0
                ? `\n⚠️ This listing is incomplete: the last sync could not account for ${absent.join(', ')}.` +
                    `\n   Contracts from those repos are absent, so the counts above are a lower bound.`
                : `\n⚠️ This listing is incomplete: the last sync did not record which repos it could` +
                    `\n   read, so the counts above are a lower bound. Re-run group sync.`,
            );
          }
        }
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
}
