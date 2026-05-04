#!/usr/bin/env node

// Heap re-spawn removed — only analyze.ts needs the 8GB heap (via its own ensureHeap()).
// Removing it from here improves MCP server startup time significantly.

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createLazyAction } from './lazy-action.js';
import { registerGroupCommands } from './group.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');
const program = new Command();

program.name('gitnexus').description('GitNexus local CLI and MCP server').version(pkg.version);

program
  .command('setup')
  .description('One-time setup: configure MCP for Cursor, Claude Code, OpenCode, Codex')
  .action(createLazyAction(() => import('./setup.js'), 'setupCommand'));

program
  .command('analyze [path]')
  .description('Index a repository (full analysis)')
  .option('-f, --force', 'Force full re-index even if up to date')
  .option('--embeddings', 'Enable embedding generation for semantic search (off by default)')
  .option(
    '--drop-embeddings',
    'Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` ' +
      'preserves any embeddings already present in the index.',
  )
  .option('--skills', 'Generate repo-specific skill files from detected communities')
  .option('--skip-agents-md', 'Skip updating the gitnexus section in AGENTS.md and CLAUDE.md')
  .option('--no-stats', 'Omit volatile file/symbol counts from AGENTS.md and CLAUDE.md')
  .option('--skip-group-sync', 'Skip auto-syncing repo groups after analysis')
  .option(
    '--incremental',
    'Plan manifest-backed incremental invalidation before rebuilding the index',
  )
  .option('--llm-anchors', 'Enrich semantic anchors with the configured LLM provider')
  .option(
    '--llm-anchor-limit <n>',
    'Maximum nodes to enrich when --llm-anchors is enabled. Default: 50.',
  )
  .option(
    '--skip-git',
    'Treat the provided path/cwd as the index root and skip parent git-root discovery',
  )
  .option(
    '--name <alias>',
    'Register this repo under a custom name in ~/.gitnexus/registry.json ' +
      '(disambiguates repos whose paths share a basename, e.g. two different .../app folders)',
  )
  .option(
    '--allow-duplicate-name',
    'Register this repo even if another path already uses the same --name alias. ' +
      'Leaves `-r <name>` ambiguous for the two paths; use -r <path> to disambiguate.',
  )
  .option('-v, --verbose', 'Enable verbose ingestion warnings (default: false)')
  .option(
    '--max-file-size <kb>',
    'Skip files larger than this (KB). Default: 512. Hard cap: 32768 (tree-sitter limit).',
  )
  .option(
    '--worker-timeout <seconds>',
    'Worker sub-batch idle timeout before retry/fallback. Default: 30.',
  )
  .option('--embedding-threads <n>', 'Limit local ONNX embedding CPU threads')
  .option('--embedding-batch-size <n>', 'Number of nodes per embedding batch')
  .option('--embedding-sub-batch-size <n>', 'Number of chunks per embedding model call')
  .option('--embedding-device <device>', 'Embedding device: auto, cpu, dml, cuda, or wasm')
  .addHelpText(
    'after',
    '\nEnvironment variables:\n' +
      '  GITNEXUS_NO_GITIGNORE=1   Skip .gitignore parsing (still reads .gitnexusignore)\n' +
      '  GITNEXUS_MAX_FILE_SIZE=N  Override large-file skip threshold (KB). Default 512, max 32768.\n' +
      '  GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS=N  Worker idle timeout in milliseconds. Default 30000.\n' +
      '  GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES=N  Worker job byte budget. Default 8388608.\n' +
      '  GITNEXUS_EMBEDDING_THREADS=N  Limit local ONNX CPU threads for --embeddings.\n' +
      '  GITNEXUS_SEMANTIC_EXACT_SCAN_LIMIT=N  Max embedding chunks for exact-scan fallback. Default 10000.\n' +
      '\nTip: `.gitnexusignore` supports `.gitignore`-style negation. Add e.g.\n' +
      '     `!__tests__/` to index a directory that is auto-filtered by default (#771).',
  )
  .action(createLazyAction(() => import('./analyze.js'), 'analyzeCommand'));

program
  .command('watch [path]')
  .description('Watch a repository and keep its GitNexus index fresh')
  .option('--debounce <ms>', 'Milliseconds to wait after file changes before re-analyzing', '1200')
  .option('--poll', 'Use polling instead of native recursive filesystem events')
  .option(
    '--interval <ms>',
    'Polling interval when --poll is used or native recursive watch is unavailable',
    '2000',
  )
  .option('--skip-initial', 'Skip the initial analyze run and only react to changes')
  .option('--embeddings', 'Preserve/generate embeddings during each analyze run')
  .option('--skip-git', 'Watch a folder without requiring a .git directory')
  .option('--name <alias>', 'Register this repo under a custom name in ~/.gitnexus/registry.json')
  .option('--max-file-size <kb>', 'Skip files larger than this (KB). Passed through to analyze.')
  .option(
    '--worker-timeout <seconds>',
    'Worker sub-batch idle timeout before retry/fallback. Passed through to analyze.',
  )
  .action(createLazyAction(() => import('./watch.js'), 'watchCommand'));

program
  .command('index [path...]')
  .description(
    'Register an existing .gitnexus/ folder into the global registry (no re-analysis needed)',
  )
  .option('-f, --force', 'Register even if meta.json is missing (stats will be empty)')
  .option('--allow-non-git', 'Allow registering folders that are not Git repositories')
  .action(createLazyAction(() => import('./index-repo.js'), 'indexCommand'));

program
  .command('serve')
  .description('Start local HTTP server for web UI connection')
  .option('-p, --port <port>', 'Port number', '4747')
  .option('--host <host>', 'Bind address (default: 127.0.0.1, use 0.0.0.0 for remote access)')
  .action(createLazyAction(() => import('./serve.js'), 'serveCommand'));

program
  .command('mcp')
  .description('Start MCP server (stdio) — serves all indexed repos')
  .action(createLazyAction(() => import('./mcp.js'), 'mcpCommand'));

program
  .command('list')
  .description('List all indexed repositories')
  .action(createLazyAction(() => import('./list.js'), 'listCommand'));

program
  .command('status')
  .description('Show index status for current repo')
  .action(createLazyAction(() => import('./status.js'), 'statusCommand'));

program
  .command('doctor')
  .description('Show runtime platform capabilities and embedding configuration')
  .action(createLazyAction(() => import('./doctor.js'), 'doctorCommand'));

program
  .command('clean')
  .description('Delete GitNexus index for current repo')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--all', 'Clean all indexed repos')
  .action(createLazyAction(() => import('./clean.js'), 'cleanCommand'));

program
  .command('remove <target>')
  .description(
    'Delete the GitNexus index for a registered repo (by alias, name, or absolute path). ' +
      'Unlike `clean`, does not require being inside the repo. Idempotent on unknown targets.',
  )
  .option('-f, --force', 'Skip confirmation prompt')
  .action(createLazyAction(() => import('./remove.js'), 'removeCommand'));

program
  .command('wiki [path]')
  .description('Generate repository wiki from knowledge graph')
  .option('-f, --force', 'Force full regeneration even if up to date')
  .option('--provider <provider>', 'LLM provider: openai or cursor (default: openai)')
  .option('--model <model>', 'LLM model or Azure deployment name (default: minimax/minimax-m2.5)')
  .option(
    '--base-url <url>',
    'LLM API base URL. Azure v1: https://{resource}.openai.azure.com/openai/v1',
  )
  .option('--api-key <key>', 'LLM API key or Azure api-key (saved to ~/.gitnexus/config.json)')
  .option(
    '--api-version <version>',
    'Azure api-version query param, e.g. 2024-10-21 (legacy Azure API only)',
  )
  .option(
    '--reasoning-model',
    'Mark deployment as reasoning model (o1/o3/o4-mini) — strips temperature, uses max_completion_tokens',
  )
  .option('--no-reasoning-model', 'Disable reasoning model mode (overrides saved config)')
  .option('--concurrency <n>', 'Parallel LLM calls (default: 3)', '3')
  .option('--gist', 'Publish wiki as a public GitHub Gist after generation')
  .option('-v, --verbose', 'Enable verbose output (show LLM commands and responses)')
  .option('--review', 'Stop after grouping to review module structure before generating pages')
  .action(createLazyAction(() => import('./wiki.js'), 'wikiCommand'));

program
  .command('augment <pattern>')
  .description('Augment a search pattern with knowledge graph context (used by hooks)')
  .action(createLazyAction(() => import('./augment.js'), 'augmentCommand'));

// ─── Direct Tool Commands (no MCP overhead) ────────────────────────
// These invoke LocalBackend directly for use in eval, scripts, and CI.

program
  .command('query <search_query>')
  .description('Search the knowledge graph for execution flows related to a concept')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max processes to return (default: 5)')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'queryCommand'));

program
  .command('context [name] [target]')
  .description('360-degree symbol view, or context push/pull snapshots')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('--content', 'Include full symbol source code')
  .option('--backend <backend>', 'Snapshot backend for push/pull: local or s3', 'local')
  .option('-o, --output <path>', 'Output file/folder for context pull')
  .option('--max-nodes <n>', 'Maximum graph node ids in a pushed snapshot (default: 250)')
  .option('--max-edges <n>', 'Maximum graph edge ids in a pushed snapshot (default: 500)')
  .option(
    '--redact <pattern>',
    'String/key pattern to redact from snapshots. Repeat for multiple patterns.',
    (value, previous: string[]) => [...previous, value],
    [],
  )
  .option('--signing-hook <path>', 'Executable that signs a snapshot path and prints a signature')
  .option('--endpoint-url <url>', 'S3-compatible endpoint URL for AWS CLI push/pull')
  .option('--json', 'JSON output for context push/pull')
  .addHelpText(
    'after',
    '\nExamples:\n' +
      '  gitnexus context AuthService\n' +
      '  gitnexus context push ./context-lake --redact C:/Users/me\n' +
      '  gitnexus context pull ./context-lake --output ./imported-context\n' +
      '  gitnexus context push s3://bucket/team-context/ --backend s3 --endpoint-url https://s3.example.com',
  )
  .action(async (mode: string | undefined, target: string | undefined, options) => {
    if (mode === 'push') {
      const { contextPushCommand } = await import('./context-lake.js');
      return contextPushCommand(target, options);
    }
    if (mode === 'pull') {
      const { contextPullCommand } = await import('./context-lake.js');
      return contextPullCommand(target, options);
    }
    const { contextCommand } = await import('./tool.js');
    return contextCommand(mode, options);
  });

program
  .command('impact-score [target]')
  .description('Fast preflight risk score for changing a symbol')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('-k, --kind <kind>', 'Symbol kind to disambiguate common names')
  .option('--include-tests', 'Include test files in examples')
  .option('--max-examples <n>', 'Max caller/dependency examples to return (default: 10)')
  .action(createLazyAction(() => import('./tool.js'), 'impactScoreCommand'));

program
  .command('export-context [target]')
  .description('Export a bounded graph neighborhood around a symbol')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('-k, --kind <kind>', 'Symbol kind to disambiguate common names')
  .option('--degree <n>', 'Neighborhood degree (default: 2, max: 3)')
  .option('-d, --direction <dir>', 'upstream, downstream, or both', 'both')
  .option('--format <format>', 'markdown, jsonl, or json', 'markdown')
  .option('--include-tests', 'Include test files in the exported neighborhood')
  .option('--max-nodes <n>', 'Maximum nodes before truncating (default: 80)')
  .action(createLazyAction(() => import('./tool.js'), 'exportContextCommand'));

program
  .command('run-skill <skill> [action]')
  .description('Run a generated executable skill action')
  .option('-r, --repo <name>', 'Target repository')
  .option('-t, --target <target>', 'Symbol name for impact/export_context actions')
  .option('-u, --uid <uid>', 'Direct symbol UID for impact/export_context actions')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('-k, --kind <kind>', 'Symbol kind to disambiguate common names')
  .option('-d, --direction <dir>', 'upstream, downstream, or both')
  .option('--degree <n>', 'Context export degree (default: 2, max: 3)')
  .option('--depth <n>', 'Impact max depth (default: 3)')
  .option('--format <format>', 'markdown, jsonl, or json')
  .option('--include-tests', 'Include test files in impact/export actions')
  .option('--max-nodes <n>', 'Maximum context export nodes (default: 80)')
  .action(createLazyAction(() => import('./tool.js'), 'runSkillCommand'));

const runtime = program
  .command('runtime')
  .description('Import and inspect runtime/log overlays for an indexed repo');

runtime
  .command('import <input>')
  .description(
    'Import OTLP JSON, structured JSONL logs, or stack traces into .gitnexus/runtime-signals.json',
  )
  .option('-r, --repo <name>', 'Target repository (omit to use current repo)')
  .option('--format <format>', 'auto, otlp-json, logs-jsonl, or stacktrace', 'auto')
  .option('--replace', 'Replace existing runtime-signals.json instead of merging')
  .option('--json', 'JSON output')
  .action(createLazyAction(() => import('./runtime.js'), 'runtimeImportCommand'));

runtime
  .command('context')
  .description('Read runtime evidence for a symbol, route, or service')
  .option('-r, --repo <name>', 'Target repository')
  .option('-t, --target <symbol>', 'Symbol name to match')
  .option('-u, --uid <uid>', 'Direct symbol UID')
  .option('-f, --file <path>', 'File path to disambiguate symbols')
  .option('-k, --kind <kind>', 'Symbol kind to disambiguate symbols')
  .option('--route <route>', 'Route path or id to match')
  .option('--service <service>', 'Service name to match')
  .option('--json', 'JSON output')
  .action(createLazyAction(() => import('./runtime.js'), 'runtimeContextCommand'));

program
  .command('impact <target>')
  .description('Blast radius analysis: what breaks if you change a symbol')
  .option('-d, --direction <dir>', 'upstream (dependants) or downstream (dependencies)', 'upstream')
  .option('-r, --repo <name>', 'Target repository')
  .option('--depth <n>', 'Max relationship depth (default: 3)')
  .option('--include-tests', 'Include test files in results')
  .action(createLazyAction(() => import('./tool.js'), 'impactCommand'));

program
  .command('cypher <query>')
  .description('Execute raw Cypher query against the knowledge graph')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./tool.js'), 'cypherCommand'));

program
  .command('detect-changes')
  .alias('detect_changes')
  .description('Map git diff hunks to indexed symbols and affected execution flows')
  .option('-s, --scope <scope>', 'What to analyze: unstaged, staged, all, or compare', 'unstaged')
  .option('-b, --base-ref <ref>', 'Branch/commit for compare scope (e.g. main)')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./tool.js'), 'detectChangesCommand'));

// ─── Eval Server (persistent daemon for SWE-bench) ─────────────────

program
  .command('eval-server')
  .description('Start lightweight HTTP server for fast tool calls during evaluation')
  .option('-p, --port <port>', 'Port number', '4848')
  .option('--idle-timeout <seconds>', 'Auto-shutdown after N seconds idle (0 = disabled)', '0')
  .action(createLazyAction(() => import('./eval-server.js'), 'evalServerCommand'));

registerGroupCommands(program);

program.parse(process.argv);
