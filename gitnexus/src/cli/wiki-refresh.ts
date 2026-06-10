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
  runWikiAutoRefresh,
  type WikiAutoRefreshPlan,
  type WikiAutoRefreshResult,
} from '../core/wiki/auto-refresh.js';
import { planWikiProviderReadiness } from '../core/wiki/provider-readiness.js';
import { resolveLLMConfig } from '../core/wiki/llm-client.js';
import { WikiGenerator } from '../core/wiki/generator.js';

export interface WikiRefreshCommandOptions {
  repo?: string;
  format?: string;
  createIfMissing?: boolean;
  execute?: boolean;
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
  plan: WikiAutoRefreshPlan | WikiAutoRefreshResult;
  execution_boundary: WikiRefreshExecutionBoundary;
  execution: WikiRefreshExecutionSummary;
  recommended_command?: string;
  caveats: string[];
}

interface WikiRefreshExecutionBoundary {
  mode: 'planning-only' | 'explicit-cli-execution';
  activation: 'report-only' | 'explicit-execute-flag';
  provider_execution_enabled: boolean;
  output_mutation_enabled: boolean;
  config_writes_enabled: false;
  required_human_decisions: string[];
}

interface WikiRefreshExecutionSummary {
  requested: boolean;
  performed: boolean;
  status: 'not-requested' | 'completed' | 'failed' | 'skipped';
  duration_ms?: number;
  mode?: 'full' | 'incremental' | 'up-to-date';
  pages_generated?: number;
  failed_modules?: string[];
  error_message?: string;
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

function buildCaveats(plan: WikiAutoRefreshPlan | WikiAutoRefreshResult, execute: boolean): string[] {
  const caveats = execute
    ? [
        'Execution uses existing environment or saved provider configuration only; it never prompts for setup or writes config.',
      ]
    : [
        'This command does not run the wiki generator, invoke an LLM provider, or mutate wiki output.',
      ];

  if (!execute && plan.status !== 'dry-run') {
    caveats.push('No manual refresh command is recommended until the reported prerequisite is fixed.');
  }

  if (!execute && plan.reason === 'dry-run') {
    caveats.push('Run the recommended command manually to perform the existing GitNexus wiki workflow.');
  }

  return caveats;
}

function buildExecutionBoundary(execute: boolean): WikiRefreshExecutionBoundary {
  if (execute) {
    return {
      mode: 'explicit-cli-execution',
      activation: 'explicit-execute-flag',
      provider_execution_enabled: true,
      output_mutation_enabled: true,
      config_writes_enabled: false,
      required_human_decisions: [],
    };
  }

  return {
    mode: 'planning-only',
    activation: 'report-only',
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

function buildExecutionSummary(
  execute: boolean,
  plan: WikiAutoRefreshPlan | WikiAutoRefreshResult,
): WikiRefreshExecutionSummary {
  if (!execute) {
    return {
      requested: false,
      performed: false,
      status: 'not-requested',
    };
  }

  const result = plan as WikiAutoRefreshResult;
  const wikiRun = result.wikiRun;
  if (result.status === 'complete') {
    return {
      requested: true,
      performed: true,
      status: 'completed',
      duration_ms: result.durationMs,
      mode: wikiRun?.mode,
      pages_generated: wikiRun?.pagesGenerated,
      failed_modules: wikiRun?.failedModules,
    };
  }

  if (result.status === 'failed') {
    return {
      requested: true,
      performed: true,
      status: 'failed',
      duration_ms: result.durationMs,
      error_message: result.errorMessage,
      failed_modules: wikiRun?.failedModules,
    };
  }

  return {
    requested: true,
    performed: false,
    status: 'skipped',
    duration_ms: result.durationMs,
  };
}

function buildReport(
  target: WikiRefreshTarget,
  plan: WikiAutoRefreshPlan | WikiAutoRefreshResult,
  execute: boolean,
): WikiRefreshPlanReport {
  const recommendedCommand = !execute && plan.status === 'dry-run'
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
    execution_boundary: buildExecutionBoundary(execute),
    execution: buildExecutionSummary(execute, plan),
    recommended_command: recommendedCommand,
    caveats: buildCaveats(plan, execute),
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
    `- Activation: ${report.execution_boundary.activation}`,
    `- Provider execution enabled by requested mode: ${report.execution_boundary.provider_execution_enabled ? 'yes' : 'no'}`,
    `- Output mutation enabled by requested mode: ${report.execution_boundary.output_mutation_enabled ? 'yes' : 'no'}`,
    `- Config writes enabled: ${report.execution_boundary.config_writes_enabled ? 'yes' : 'no'}`,
  );

  if (report.execution_boundary.required_human_decisions.length > 0) {
    lines.push(
      '',
      'Required before mutation:',
      '',
      ...report.execution_boundary.required_human_decisions.map((decision) => `- ${decision}`),
    );
  }

  if (report.execution.requested) {
    lines.push(
      '',
      '## Execution Result',
      '',
      `- Status: ${report.execution.status}`,
      `- Performed: ${report.execution.performed ? 'yes' : 'no'}`,
    );
    if (report.execution.mode) {
      lines.push(`- Generator mode: ${report.execution.mode}`);
    }
    if (report.execution.pages_generated !== undefined) {
      lines.push(`- Pages generated: ${report.execution.pages_generated}`);
    }
    if (report.execution.duration_ms !== undefined) {
      lines.push(`- Duration ms: ${report.execution.duration_ms}`);
    }
    if (report.execution.failed_modules && report.execution.failed_modules.length > 0) {
      lines.push(`- Failed modules: ${report.execution.failed_modules.join(', ')}`);
    }
    if (report.execution.error_message) {
      lines.push(`- Error: ${report.execution.error_message}`);
    }
  }

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
  const config = await loadCLIConfig();
  const provider = planWikiProviderReadiness({
    config,
    mode: 'cli',
  });
  const baseInputs = {
    graphFreshness: {
      isFresh: !staleness.isStale,
      indexedCommit: target.lastCommit,
      source: 'wiki-refresh-cli',
      reason: staleness.hint,
    },
    wikiMeta,
    provider,
    createIfMissing: options.createIfMissing,
  };

  const plan = options.execute
    ? await runWikiAutoRefresh({
        ...baseInputs,
        dryRun: false,
        mutateOutput: true,
        runGenerator: async () => {
          const llmConfig = await resolveLLMConfig();
          const generator = new WikiGenerator(
            target.path,
            target.storagePath,
            path.join(target.storagePath, 'lbug'),
            llmConfig,
          );
          return generator.run();
        },
      })
    : planWikiAutoRefresh({
        ...baseInputs,
        dryRun: true,
        mutateOutput: false,
      });

  const report = buildReport(target, plan, Boolean(options.execute));
  if ((options.format ?? 'markdown').toLowerCase() === 'json') {
    output(JSON.stringify(report, null, 2));
  } else {
    output(renderWikiRefreshPlanMarkdown(report));
  }

  if (options.execute && report.execution.status !== 'completed') {
    process.exitCode = 1;
  }
}
