import path from 'node:path';
import { writeSync } from 'node:fs';
import { checkStalenessAsync } from '../core/git-staleness.js';
import {
  findRepo,
  listRegisteredRepos,
  loadCLIConfig,
  resolveRegistryEntry,
} from '../storage/repo-manager.js';
import {
  planWikiAutoRefresh,
  readWikiAutoRefreshMeta,
  type WikiAutoRefreshPlan,
} from '../core/wiki/auto-refresh.js';
import { planWikiProviderReadiness } from '../core/wiki/provider-readiness.js';

export interface WikiRefreshCommandOptions {
  repo?: string;
  format?: string;
  createIfMissing?: boolean;
}

interface WikiRefreshTarget {
  name: string;
  path: string;
  storagePath: string;
  lastCommit: string;
}

interface WikiRefreshPlanReport {
  schema_version: 'wiki-refresh-plan.v1alpha1';
  repo: {
    name: string;
    path: string;
    storagePath: string;
  };
  plan: WikiAutoRefreshPlan;
  execution_boundary: WikiRefreshExecutionBoundary;
  recommended_command?: string;
  caveats: string[];
}

interface WikiRefreshExecutionBoundary {
  mode: 'planning-only';
  provider_execution_enabled: false;
  output_mutation_enabled: false;
  config_writes_enabled: false;
  required_human_decisions: string[];
}

function output(data: string): void {
  try {
    writeSync(1, data + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') process.exit(0);
    process.stderr.write(data + '\n');
  }
}

function quoteCliArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function renderRecommendedCommand(repoPath: string): string {
  return `gitnexus wiki ${quoteCliArg(repoPath)}`;
}

async function resolveTarget(
  inputPath: string | undefined,
  options: WikiRefreshCommandOptions,
): Promise<WikiRefreshTarget> {
  if (options.repo) {
    const entry = resolveRegistryEntry(await listRegisteredRepos({ validate: true }), options.repo);
    return {
      name: entry.name,
      path: entry.path,
      storagePath: entry.storagePath,
      lastCommit: entry.lastCommit,
    };
  }

  const startPath = path.resolve(inputPath ?? process.cwd());
  const repo = await findRepo(startPath);
  if (!repo) {
    throw new Error('No GitNexus index found. Run `gitnexus analyze` first.');
  }

  return {
    name: path.basename(repo.repoPath),
    path: repo.repoPath,
    storagePath: repo.storagePath,
    lastCommit: repo.meta.lastCommit,
  };
}

function buildCaveats(plan: WikiAutoRefreshPlan): string[] {
  const caveats = [
    'This command does not run the wiki generator, invoke an LLM provider, or mutate wiki output.',
  ];

  if (plan.status !== 'dry-run') {
    caveats.push('No manual refresh command is recommended until the reported prerequisite is fixed.');
  }

  if (plan.reason === 'dry-run') {
    caveats.push('Run the recommended command manually to perform the existing GitNexus wiki workflow.');
  }

  return caveats;
}

function buildExecutionBoundary(): WikiRefreshExecutionBoundary {
  return {
    mode: 'planning-only',
    provider_execution_enabled: false,
    output_mutation_enabled: false,
    config_writes_enabled: false,
    required_human_decisions: [
      'Choose output location and overwrite/rollback policy before generated wiki mutation.',
      'Choose provider execution policy, cost boundary, timeout, and retry limits before unattended generation.',
      'Choose whether saved config writes are allowed or whether execution must use per-run environment only.',
    ],
  };
}

function buildReport(
  target: WikiRefreshTarget,
  plan: WikiAutoRefreshPlan,
): WikiRefreshPlanReport {
  const recommendedCommand = plan.status === 'dry-run'
    ? renderRecommendedCommand(target.path)
    : undefined;

  return {
    schema_version: 'wiki-refresh-plan.v1alpha1',
    repo: {
      name: target.name,
      path: target.path,
      storagePath: target.storagePath,
    },
    plan,
    execution_boundary: buildExecutionBoundary(),
    recommended_command: recommendedCommand,
    caveats: buildCaveats(plan),
  };
}

export function renderWikiRefreshPlanMarkdown(report: WikiRefreshPlanReport): string {
  const lines = [
    '# GitNexus Wiki Refresh Plan',
    '',
    `Schema: ${report.schema_version}`,
    `Repository: ${report.repo.name}`,
    `Status: ${report.plan.status}`,
    `Reason: ${report.plan.reason}`,
    '',
    '## Safety',
    '',
    `- Runs generator: ${report.plan.shouldRunGenerator ? 'yes' : 'no'}`,
    `- Mutates wiki output: ${report.plan.willMutateOutput ? 'yes' : 'no'}`,
    `- Runs LLM provider: ${report.plan.willRunLLM ? 'yes' : 'no'}`,
    `- Dry run: ${report.plan.dryRun ? 'yes' : 'no'}`,
    '',
    '## Prerequisites',
    '',
    `- Graph fresh: ${report.plan.graphFreshness.isFresh ? 'yes' : 'no'}`,
    `- Wiki metadata: ${report.plan.wikiMeta.exists ? (report.plan.wikiMeta.valid === false ? 'corrupt' : 'present') : 'missing'}`,
    `- Provider ready: ${report.plan.provider.ready ? 'yes' : 'no'}`,
  ];

  lines.push(
    '',
    '## Execution Boundary',
    '',
    `- Mode: ${report.execution_boundary.mode}`,
    `- Provider execution enabled: ${report.execution_boundary.provider_execution_enabled ? 'yes' : 'no'}`,
    `- Output mutation enabled: ${report.execution_boundary.output_mutation_enabled ? 'yes' : 'no'}`,
    `- Config writes enabled: ${report.execution_boundary.config_writes_enabled ? 'yes' : 'no'}`,
    '',
    'Required before mutation:',
    '',
    ...report.execution_boundary.required_human_decisions.map((decision) => `- ${decision}`),
  );

  if (report.recommended_command) {
    lines.push('', '## Manual Refresh Command', '', `\`${report.recommended_command}\``);
  }

  if (report.plan.messages.length > 0) {
    lines.push('', '## Messages', '', ...report.plan.messages.map((message) => `- ${message}`));
  }

  lines.push('', '## Caveats', '', ...report.caveats.map((caveat) => `- ${caveat}`));

  return lines.join('\n');
}

export async function wikiRefreshCommand(
  inputPath?: string,
  options: WikiRefreshCommandOptions = {},
): Promise<void> {
  const target = await resolveTarget(inputPath, options);
  const staleness = await checkStalenessAsync(target.path, target.lastCommit);
  const wikiMeta = await readWikiAutoRefreshMeta(target.storagePath);
  const provider = planWikiProviderReadiness({
    config: await loadCLIConfig(),
  });
  const plan = planWikiAutoRefresh({
    graphFreshness: {
      isFresh: !staleness.isStale,
      indexedCommit: target.lastCommit,
      source: 'wiki-refresh-cli',
      reason: staleness.hint,
    },
    wikiMeta,
    provider,
    dryRun: true,
    mutateOutput: false,
    createIfMissing: options.createIfMissing,
  });

  const report = buildReport(target, plan);
  if ((options.format ?? 'markdown').toLowerCase() === 'json') {
    output(JSON.stringify(report, null, 2));
    return;
  }

  output(renderWikiRefreshPlanMarkdown(report));
}
