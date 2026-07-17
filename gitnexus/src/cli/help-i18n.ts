import type { Command, Option } from 'commander';
import { t, type CliMessageKey } from './i18n/index.js';

const TITLE_KEYS = {
  'Usage:': 'help.title.usage',
  'Arguments:': 'help.title.arguments',
  'Options:': 'help.title.options',
  'Global Options:': 'help.title.globalOptions',
  'Commands:': 'help.title.commands',
} satisfies Record<string, CliMessageKey>;

const COMMAND_DESCRIPTION_KEYS = {
  '': 'help.description.root',
  setup: 'help.command.setup.description',
  uninstall: 'help.command.uninstall.description',
  analyze: 'help.command.analyze.description',
  index: 'help.command.index.description',
  serve: 'help.command.serve.description',
  mcp: 'help.command.mcp.description',
  list: 'help.command.list.description',
  status: 'help.command.status.description',
  doctor: 'help.command.doctor.description',
  embeddings: 'help.command.embeddings.description',
  'embeddings install': 'help.command.embeddings.install.description',
  clean: 'help.command.clean.description',
  remove: 'help.command.remove.description',
  wiki: 'help.command.wiki.description',
  augment: 'help.command.augment.description',
  publish: 'help.command.publish.description',
  query: 'help.command.query.description',
  context: 'help.command.context.description',
  impact: 'help.command.impact.description',
  cypher: 'help.command.cypher.description',
  'detect-changes': 'help.command.detectChanges.description',
  check: 'help.command.check.description',
  trace: 'help.command.trace.description',
  'eval-server': 'help.command.evalServer.description',
  group: 'help.command.group.description',
  'group create': 'help.command.group.create.description',
  'group add': 'help.command.group.add.description',
  'group remove': 'help.command.group.remove.description',
  'group list': 'help.command.group.list.description',
  'group status': 'help.command.group.status.description',
  'group sync': 'help.command.group.sync.description',
  'group impact': 'help.command.group.impact.description',
  'group query': 'help.command.group.query.description',
  'group contracts': 'help.command.group.contracts.description',
} satisfies Record<string, CliMessageKey>;

const OPTION_DESCRIPTION_KEYS = {
  '|-V, --version': 'help.option.version',
  'setup|-c, --coding-agent <agents>': 'help.option.setup.codingAgent',
  'analyze|-f, --force': 'help.option.analyze.force',
  'analyze|--repair-fts': 'help.option.analyze.repairFts',
  'analyze|--embeddings [limit]': 'help.option.analyze.embeddings',
  'analyze|--drop-embeddings': 'help.option.analyze.dropEmbeddings',
  'analyze|--skills': 'help.option.analyze.skills',
  'analyze|--skip-agents-md': 'help.option.analyze.skipAgentsMd',
  'analyze|--no-stats': 'help.option.analyze.noStats',
  'analyze|--skip-skills': 'help.option.analyze.skipSkills',
  'analyze|--index-only': 'help.option.analyze.indexOnly',
  'analyze|--skip-git': 'help.option.skipGit',
  'analyze|--name <alias>': 'help.option.analyze.name',
  'analyze|--allow-duplicate-name': 'help.option.analyze.allowDuplicateName',
  'analyze|-v, --verbose': 'help.option.verbose',
  'analyze|--max-file-size <kb>': 'help.option.analyze.maxFileSize',
  'analyze|--worker-timeout <seconds>': 'help.option.analyze.workerTimeout',
  'analyze|--wal-checkpoint-threshold <bytes>': 'help.option.analyze.walCheckpointThreshold',
  'analyze|--workers <n>': 'help.option.analyze.workers',
  'analyze|--embedding-threads <n>': 'help.option.analyze.embeddingThreads',
  'analyze|--embedding-batch-size <n>': 'help.option.analyze.embeddingBatchSize',
  'analyze|--embedding-sub-batch-size <n>': 'help.option.analyze.embeddingSubBatchSize',
  'analyze|--embedding-device <device>': 'help.option.analyze.embeddingDevice',
  'index|-f, --force': 'help.option.index.force',
  'index|--allow-non-git': 'help.option.index.allowNonGit',
  'mcp|--http': 'help.option.mcp.http',
  'mcp|-p, --port <port>': 'help.option.port',
  'mcp|--host <host>': 'help.option.mcp.host',
  'mcp|--auth-token <token>': 'help.option.mcp.authToken',
  'serve|-p, --port <port>': 'help.option.port',
  'serve|--host <host>': 'help.option.serve.host',
  'uninstall|-f, --force': 'help.option.uninstall.force',
  'clean|-f, --force': 'help.option.force.confirmation',
  'clean|--all': 'help.option.clean.all',
  'clean|--branch <name>': 'help.option.clean.branch',
  'clean|--lbug-sidecars': 'help.option.clean.lbugSidecars',
  'remove|-f, --force': 'help.option.force.confirmation',
  'wiki|-f, --force': 'help.option.wiki.force',
  'wiki|--provider <provider>': 'help.option.wiki.provider',
  'wiki|--model <model>': 'help.option.wiki.model',
  'wiki|--base-url <url>': 'help.option.wiki.baseUrl',
  'wiki|--api-key <key>': 'help.option.wiki.apiKey',
  'wiki|--api-version <version>': 'help.option.wiki.apiVersion',
  'wiki|--reasoning-model': 'help.option.wiki.reasoningModel',
  'wiki|--no-reasoning-model': 'help.option.wiki.noReasoningModel',
  'wiki|--concurrency <n>': 'help.option.wiki.concurrency',
  'wiki|--timeout <seconds>': 'help.option.wiki.timeout',
  'wiki|--retries <n>': 'help.option.wiki.retries',
  'wiki|--allow-insecure-connection <host>': 'help.option.wiki.allowInsecureConnection',
  'wiki|--gist': 'help.option.wiki.gist',
  'wiki|-v, --verbose': 'help.option.verbose',
  'wiki|--review': 'help.option.wiki.review',
  'wiki|--lang <lang>': 'help.option.wiki.lang',
  'publish|--id <owner/repo>': 'help.option.publish.id',
  'publish|--skip-git': 'help.option.skipGit',
  'query|-q, --query <text>': 'help.option.query.flag',
  'query|-r, --repo <name>': 'help.option.repo.targetOmitOne',
  'query|--branch <name>': 'help.option.branch',
  'query|-c, --context <text>': 'help.option.query.context',
  'query|-g, --goal <text>': 'help.option.query.goal',
  'query|-l, --limit <n>': 'help.option.query.limit',
  'query|--content': 'help.option.content',
  'context|-r, --repo <name>': 'help.option.repo.target',
  'context|--branch <name>': 'help.option.branch',
  'context|-u, --uid <uid>': 'help.option.context.uid',
  'context|-f, --file <path>': 'help.option.context.file',
  'context|-l, --limit <n>': 'help.option.context.limit',
  'context|--content': 'help.option.content',
  'impact|-d, --direction <dir>': 'help.option.impact.direction',
  'impact|-r, --repo <name>': 'help.option.repo.target',
  'impact|--branch <name>': 'help.option.branch',
  'impact|-u, --uid <uid>': 'help.option.context.uid',
  'impact|-f, --file <path>': 'help.option.context.file',
  'impact|--kind <kind>': 'help.option.impact.kind',
  'impact|--depth <n>': 'help.option.impact.depth',
  'impact|--include-tests': 'help.option.impact.includeTests',
  'impact|-l, --limit <n>': 'help.option.impact.limit',
  'impact|--offset <n>': 'help.option.impact.offset',
  'impact|--summary-only': 'help.option.impact.summaryOnly',
  'cypher|-r, --repo <name>': 'help.option.repo.target',
  'cypher|--branch <name>': 'help.option.branch',
  'cypher|-l, --limit <n>': 'help.option.cypher.limit',
  'detect-changes|-s, --scope <scope>': 'help.option.detectChanges.scope',
  'detect-changes|-b, --base-ref <ref>': 'help.option.detectChanges.baseRef',
  'detect-changes|-l, --limit <n>': 'help.option.detectChanges.limit',
  'detect-changes|-r, --repo <name>': 'help.option.repo.target',
  'detect-changes|--branch <name>': 'help.option.branch',
  'check|--cycles': 'help.option.check.cycles',
  'check|--json': 'help.option.json',
  'check|-r, --repo <name>': 'help.option.repo.target',
  'check|--branch <name>': 'help.option.branch',
  'trace|--from-uid <uid>': 'help.option.trace.fromUid',
  'trace|--from-file <path>': 'help.option.trace.fromFile',
  'trace|--to-uid <uid>': 'help.option.trace.toUid',
  'trace|--to-file <path>': 'help.option.trace.toFile',
  'trace|--depth <n>': 'help.option.trace.depth',
  'trace|--include-tests': 'help.option.trace.includeTests',
  'trace|-r, --repo <name>': 'help.option.repo.target',
  'trace|--branch <name>': 'help.option.branch',
  'eval-server|-p, --port <port>': 'help.option.port',
  'eval-server|--host <host>': 'help.option.evalServer.host',
  'eval-server|--idle-timeout <seconds>': 'help.option.evalServer.idleTimeout',
  'embeddings install|--cuda': 'help.option.embeddings.install.cuda',
  'embeddings install|--force': 'help.option.embeddings.install.force',
  'group create|--force': 'help.option.group.create.force',
  'group sync|--skip-embeddings': 'help.option.group.sync.skipEmbeddings',
  'group sync|--exact-only': 'help.option.group.sync.exactOnly',
  'group sync|--allow-stale': 'help.option.group.sync.allowStale',
  'group sync|--verbose': 'help.option.group.sync.verbose',
  'group sync|--json': 'help.option.json',
  'group impact|--target <symbol>': 'help.option.group.impact.target',
  'group impact|--repo <groupPath>': 'help.option.group.impact.repo',
  'group impact|--direction <dir>': 'help.option.impact.direction',
  'group impact|--service <path>': 'help.option.group.impact.service',
  'group impact|--subgroup <path>': 'help.option.group.impact.subgroup',
  'group impact|--max-depth <n>': 'help.option.impact.depth',
  'group impact|--cross-depth <n>': 'help.option.group.impact.crossDepth',
  'group impact|--min-confidence <n>': 'help.option.group.impact.minConfidence',
  'group impact|--include-tests': 'help.option.impact.includeTests',
  'group impact|--timeout-ms <n>': 'help.option.group.impact.timeoutMs',
  'group impact|--json': 'help.option.json',
  'group query|--subgroup <path>': 'help.option.group.query.subgroup',
  'group query|--limit <n>': 'help.option.group.query.limit',
  'group query|--json': 'help.option.json',
  'group contracts|--type <type>': 'help.option.group.contracts.type',
  'group contracts|--repo <repo>': 'help.option.group.contracts.repo',
  'group contracts|--unmatched': 'help.option.group.contracts.unmatched',
  'group contracts|--json': 'help.option.json',
} satisfies Record<string, CliMessageKey>;

function localizeTitle(title: string): string {
  const key = TITLE_KEYS[title as keyof typeof TITLE_KEYS];
  return key ? t(key) : title;
}

function localizeOptionDescription(option: Option): string {
  const extraInfo = [];

  if (option.argChoices) {
    const label = t('help.optionMeta.choices');
    extraInfo.push(
      `${label}: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(', ')}`,
    );
  }

  if (option.defaultValue !== undefined) {
    const showDefault =
      option.required ||
      option.optional ||
      (option.isBoolean() && typeof option.defaultValue === 'boolean');
    if (showDefault) {
      const label = t('help.optionMeta.default');
      extraInfo.push(
        `${label}: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`,
      );
    }
  }

  if (option.presetArg !== undefined && option.optional) {
    const label = t('help.optionMeta.preset');
    extraInfo.push(`${label}: ${JSON.stringify(option.presetArg)}`);
  }

  if (option.envVar !== undefined) {
    const label = t('help.optionMeta.env');
    extraInfo.push(`${label}: ${option.envVar}`);
  }

  if (extraInfo.length > 0) {
    const extraDescription = `(${extraInfo.join(', ')})`;
    if (option.description) return `${option.description} ${extraDescription}`;
    return extraDescription;
  }

  return option.description;
}

function pathFor(commandPath: string, command: Command): string {
  if (!command.parent) return '';
  return commandPath ? `${commandPath} ${command.name()}` : command.name();
}

function applyHelpI18n(command: Command, commandPath = ''): void {
  const descriptionKey =
    COMMAND_DESCRIPTION_KEYS[commandPath as keyof typeof COMMAND_DESCRIPTION_KEYS];
  if (descriptionKey) command.description(t(descriptionKey));

  command.helpOption('-h, --help', t('help.option.help'));
  command.configureHelp({
    styleTitle: localizeTitle,
    optionDescription: localizeOptionDescription,
  });

  if (command.commands.length > 0) {
    command.helpCommand('help [command]', t('help.command.help.description'));
  }

  for (const option of command.options) {
    const optionKey =
      OPTION_DESCRIPTION_KEYS[
        `${commandPath}|${option.flags}` as keyof typeof OPTION_DESCRIPTION_KEYS
      ];
    if (optionKey) option.description = t(optionKey);
  }

  for (const subcommand of command.commands) {
    applyHelpI18n(subcommand, pathFor(commandPath, subcommand));
  }
}

export function localizeCliHelp(program: Command): Command {
  applyHelpI18n(program);
  return program;
}
