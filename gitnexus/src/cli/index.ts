#!/usr/bin/env node

// Heap re-spawn removed — only analyze.ts needs the 8GB heap (via its own ensureHeap()).
// Removing it from here improves MCP server startup time significantly.

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createLazyAction, createLbugLazyAction } from './lazy-action.js';
import { EMBEDDING_DIMS_ERROR, normalizeEmbeddingDims } from './embedding-dims.js';
import { registerGroupCommands } from './group.js';
import { localizeCliHelp } from './help-i18n.js';
import { t } from './i18n/index.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');
const program = new Command();

function collectCodingAgents(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), ...value.split(',')];
}

program.name('gitnexus').description('GitNexus local CLI and MCP server').version(pkg.version);

program
  .command('setup')
  .description(
    'One-time setup: configure MCP for Cursor, Claude Code, Antigravity, OpenCode, CodeBuddy, Qoder, Codex',
  )
  .option(
    '-c, --coding-agent <agents>',
    'Configure only these coding agents (comma-separated or repeatable)',
    collectCodingAgents,
  )
  .action(createLazyAction(() => import('./setup.js'), 'setupCommand'));

program
  .command('uninstall')
  .description(
    'Reverse `setup`: remove GitNexus MCP entries, skills, and hooks from all detected editors',
  )
  .option('-f, --force', 'Apply the changes (default is a dry-run preview)')
  .action(createLazyAction(() => import('./uninstall.js'), 'uninstallCommand'));

// Baseline of GITNEXUS_EMBEDDING_DIMS captured by the analyze preAction hook
// before it overwrites the var, so the postAction hook can restore it. The
// analyzeCommand env snapshot is taken AFTER this hook runs, so it cannot undo
// the hook's write on its own — without this restore a CLI --embedding-dims
// would leak into a later in-process program.parseAsync (tests / long-running
// hosts). Single-shot CLI exits the process, making the restore a no-op there.
let dimsEnvBaseline: string | undefined;
let dimsEnvCaptured = false;

program
  .command('analyze [path]')
  .description('Index a repository (full analysis)')
  .option('-f, --force', 'Force full re-index even if up to date')
  .option('--repair-fts', 'Repair/rebuild search FTS indexes without full re-analysis')
  .option(
    '--embeddings [limit]',
    'Enable embedding generation for semantic search (off by default). ' +
      'Optional [limit] overrides the 50,000-node safety cap; pass 0 to disable the cap entirely.',
  )
  .option(
    '--drop-embeddings',
    'Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` ' +
      'preserves any embeddings already present in the index.',
  )
  .option(
    '--skills',
    'Generate repo-specific skill files from detected communities ' +
      '(no-op when --index-only is also set).',
  )
  .option('--skip-agents-md', 'Skip updating the gitnexus section in AGENTS.md and CLAUDE.md')
  .option(
    '--pdg',
    'Build the control-flow-graph / PDG substrate (BasicBlock nodes + CFG edges) ' +
      'for supported languages. Opt-in; off by default. (#2081 M1)',
  )
  .option(
    '--default-branch <branch>',
    'Default branch used in the generated regression-compare example (base_ref). ' +
      'Falls back to .gitnexusrc, then auto-detected origin/HEAD, then "main".',
  )
  .option(
    '--branch <name>',
    'Pin the working tree into a dedicated per-branch index slot (multi-branch indexing). ' +
      'Without this flag, analyze always updates the workspace index, which follows the ' +
      'checked-out working tree. Distinct from --default-branch (cosmetic base_ref).',
  )
  .option('--no-stats', 'Omit volatile file/symbol counts from AGENTS.md and CLAUDE.md')
  .option(
    '--skip-skills',
    'Skip installing standard GitNexus skill files directly under .claude/skills/. ' +
      'Does not suppress community skills from --skills (those use .claude/skills/gitnexus-area-*). ' +
      'Use --index-only to skip all AI-context file injection.',
  )
  .option('--index-only', 'Pure index mode: skip all file injection (AGENTS.md, CLAUDE.md, skills)')
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
  .option(
    '--wal-checkpoint-threshold <bytes>',
    'LadybugDB WAL auto-checkpoint threshold in bytes during analyze ' +
      '(integer >= -1; default: 67108864 = 64 MiB; -1 keeps Ladybug stock ~16 MiB).',
  )
  .option(
    '--workers <n>',
    'Parse worker pool size (>=1). Default: cores-1 capped at 16, auto-sized to the repo.',
  )
  .option('--embedding-threads <n>', 'Limit local ONNX embedding CPU threads')
  .option('--embedding-batch-size <n>', 'Number of nodes per embedding batch')
  .option('--embedding-sub-batch-size <n>', 'Number of chunks per embedding model call')
  .option('--embedding-device <device>', 'Embedding device: auto, cpu, dml, cuda, or wasm')
  .option(
    '--embedding-base-url <url>',
    'OpenAI-compatible embeddings base URL including the /v1 suffix ' +
      '(e.g. http://10.219.32.29:11434/v1 for Ollama). Overrides GITNEXUS_EMBEDDING_URL.',
  )
  .option(
    '--embedding-model <model>',
    'Embedding model name (e.g. qwen3-embedding:8b). Overrides GITNEXUS_EMBEDDING_MODEL.',
  )
  .option(
    '--embedding-auth-token <token>',
    'Bearer token for the embeddings endpoint (omit for unauthenticated servers like Ollama). ' +
      'Overrides GITNEXUS_EMBEDDING_API_KEY.',
  )
  .option(
    '--embedding-dims <number>',
    'Embedding vector dimensions (positive integer; e.g. 4096 for Qwen3-Embedding-8B). ' +
      'Must match what the index was built with. Overrides GITNEXUS_EMBEDDING_DIMS.',
  )
  .addHelpText('after', () => t('help.analyze.environment'))
  .hook('preAction', (thisCommand: Command) => {
    // ONLY GITNEXUS_EMBEDDING_DIMS must be set here: schema.ts reads it at
    // module-load time during the lazy import('./analyze.js') below (via the
    // static chain analyze.ts → run-analyze.ts → schema.ts), so deferring to
    // analyzeCommandImpl would be too late. URL / MODEL / API_KEY are read
    // lazily at runtime (readConfig), so analyzeCommandImpl is their sole
    // setter — keeping them out of this hook means they fall under the impl's
    // env snapshot/restore and don't leak across in-process invocations.
    const dimsOpt = thisCommand.opts()['embeddingDims'];
    if (dimsOpt !== undefined) {
      // Validate + normalize BEFORE writing the env var: schema.ts throws on a
      // bad value at module-load, which — on the synchronous program.parse()
      // path, before the analyze fatal-handlers are installed — would surface
      // as a raw unhandled rejection instead of this friendly message.
      const dims = normalizeEmbeddingDims(String(dimsOpt));
      if (dims === null) {
        process.stderr.write(`\n  ${EMBEDDING_DIMS_ERROR}\n\n`);
        process.exit(1);
      }
      dimsEnvBaseline = process.env.GITNEXUS_EMBEDDING_DIMS;
      dimsEnvCaptured = true;
      process.env.GITNEXUS_EMBEDDING_DIMS = dims;
    }
  })
  .hook('postAction', () => {
    // Restore the pre-hook GITNEXUS_EMBEDDING_DIMS so a CLI override doesn't
    // persist into a later program.parseAsync in the same process. (Fires on a
    // microtask after a successful parse; the crash path never reaches here,
    // but the hook validates dims before writing, so there's nothing to undo.)
    if (!dimsEnvCaptured) return;
    dimsEnvCaptured = false;
    if (dimsEnvBaseline === undefined) {
      delete process.env.GITNEXUS_EMBEDDING_DIMS;
    } else {
      process.env.GITNEXUS_EMBEDDING_DIMS = dimsEnvBaseline;
    }
  })
  .action(createLbugLazyAction(() => import('./analyze.js'), 'analyzeCommand'));

program
  .command('index [path...]')
  .description(
    'Register an existing .gitnexus/ folder into the global registry (no re-analysis needed)',
  )
  .option('-f, --force', 'Register even if index metadata is missing (stats will be empty)')
  .option('--allow-non-git', 'Allow registering folders that are not Git repositories')
  .action(createLazyAction(() => import('./index-repo.js'), 'indexCommand'));

program
  .command('serve')
  .description('Start local HTTP server for web UI connection')
  .option('-p, --port <port>', 'Port number', '4747')
  .option('--host <host>', 'Bind address (default: 127.0.0.1, use 0.0.0.0 for remote access)')
  .action(createLbugLazyAction(() => import('./serve.js'), 'serveCommand'));

program
  .command('mcp')
  .description(
    'Start MCP server. Default: stdio. Use --http for a remote HTTP server ' +
      '(Streamable HTTP at POST /mcp + legacy SSE at GET /sse, POST /messages).',
  )
  .option('--http', 'Serve MCP over HTTP instead of stdio (for remote clients)')
  .option('-p, --port <port>', 'HTTP port (only with --http). Default: 3000', '3000')
  .option(
    '--host <host>',
    'HTTP bind address (only with --http). Default: 127.0.0.1 (loopback). Use 0.0.0.0 to expose to all interfaces.',
    '127.0.0.1',
  )
  .option(
    '--auth-token <token>',
    'Require this bearer token in the Authorization header (only with --http); may also be set via the GITNEXUS_MCP_AUTH_TOKEN env var. Required for a non-loopback bind (--host 0.0.0.0/::), which otherwise refuses to start.',
  )
  .action(createLbugLazyAction(() => import('./mcp.js'), 'mcpCommand'));

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
  .command('embeddings')
  .description('Manage the on-demand local embedding runtime')
  .command('install')
  .description(
    'Install the local embedding stack (@huggingface/transformers + onnxruntime-node) on demand. ' +
      'Heals installs where npm skipped the optional packages (e.g. behind an HTTP proxy, #2370). ' +
      'Downloads only from your configured npm registry — mirrors and proxies apply.',
  )
  .option(
    '--cuda',
    "Also download the CUDA GPU binaries (runs onnxruntime-node's NuGet postinstall; " +
      'set GLOBAL_AGENT_HTTPS_PROXY behind a proxy)',
  )
  .option('--force', 'Install into the runtime prefix even when the stack already resolves')
  .action(createLazyAction(() => import('./embeddings.js'), 'embeddingsInstallCommand'));

program
  .command('clean')
  .description('Delete GitNexus index for current repo')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--all', 'Clean all indexed repos')
  .option('--branch <name>', 'Delete only the named branch index (not the workspace index)')
  .option(
    '--lbug-sidecars',
    'Clean parked LadybugDB recovery sidecars (missing-shadow WAL quarantines and dirty-recovery parks)',
  )
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
  .option(
    '--provider <provider>',
    'LLM provider: openai, openrouter, azure, custom, cursor, claude, codex, or opencode (default: openai)',
  )
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
  .option('--timeout <seconds>', 'LLM request timeout in seconds (default: disabled)')
  .option('--retries <n>', 'Max LLM retry attempts per request (default: 3)')
  .option(
    '--allow-insecure-connection <host>',
    'Allow exact host(s) for http:// LLM base URLs (comma-separated; HTTPS is preferred)',
  )
  .option('--gist', 'Publish wiki as a public GitHub Gist after generation')
  .option('-v, --verbose', 'Enable verbose output (show LLM commands and responses)')
  .option('--review', 'Stop after grouping to review module structure before generating pages')
  .option(
    '--lang <lang>',
    'Output language for generated documentation (e.g. english, chinese, spanish, japanese)',
  )
  .action(createLbugLazyAction(() => import('./wiki.js'), 'wikiCommand'));

program
  .command('augment <pattern>')
  .description('Augment a search pattern with knowledge graph context (used by hooks)')
  .action(createLbugLazyAction(() => import('./augment.js'), 'augmentCommand'));

program
  .command('publish [path]')
  .description(
    'Notify the understand-quickly registry that this repo has a fresh GitNexus index. ' +
      'Opt-in: requires UNDERSTAND_QUICKLY_TOKEN (fine-grained PAT with ' +
      '`Repository dispatches: write` on looptech-ai/understand-quickly). ' +
      'No-op without the token. See https://github.com/looptech-ai/understand-quickly.',
  )
  .option('--id <owner/repo>', 'Override the registry id (defaults to the origin remote)')
  .option('--skip-git', 'Treat cwd as the repo root and skip parent git-root discovery')
  .action(createLazyAction(() => import('./publish.js'), 'publishCommand'));

// ─── Direct Tool Commands (no MCP overhead) ────────────────────────
// These invoke LocalBackend directly for use in eval, scripts, and CI.

program
  .command('query [search_query]')
  .description('Search the knowledge graph for execution flows related to a concept')
  .option('-q, --query <text>', 'Search query (alias for positional argument)')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('--branch <name>', 'Scope to a specific branch index (multi-branch repos)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max processes to return (default: 5)')
  .option('--content', 'Include full symbol source code')
  .action(createLbugLazyAction(() => import('./tool.js'), 'queryCommand'));

program
  .command('context [name]')
  .description('360-degree view of a code symbol: callers, callees, processes')
  .option('-r, --repo <name>', 'Target repository')
  .option('--branch <name>', 'Scope to a specific branch index (multi-branch repos)')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('-l, --limit <n>', 'Max callers/callees/processes to return')
  .option('--content', 'Include full symbol source code')
  .action(createLbugLazyAction(() => import('./tool.js'), 'contextCommand'));

program
  .command('impact [target]')
  .description('Blast radius analysis: what breaks if you change a symbol')
  .option('-d, --direction <dir>', 'upstream (dependants) or downstream (dependencies)', 'upstream')
  .option(
    '--mode <mode>',
    'Engine: callgraph (default) or pdg (opt-in, intra-procedural; needs analyze --pdg)',
    'callgraph',
  )
  .option(
    '--line <number>',
    '1-based source line — PDG-only statement anchor (--mode pdg): slice the dependence from the statement at this line and show what depends on it',
  )
  .option('-r, --repo <name>', 'Target repository')
  .option('--branch <name>', 'Scope to a specific branch index (multi-branch repos)')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option(
    '--kind <kind>',
    'Kind filter to disambiguate common names (e.g. Function, Class, Method)',
  )
  .option('--depth <n>', 'Max relationship depth (default: 3)')
  .option('--include-tests', 'Include test files in results')
  .option(
    '-l, --limit <n>',
    'Max symbols per depth level and affected processes/modules to return (default: 100)',
  )
  .option('--offset <n>', 'Skip N symbols per depth level for pagination')
  .option('--summary-only', 'Return counts and risk only, omit symbol list')
  .action(createLbugLazyAction(() => import('./tool.js'), 'impactCommand'));

program
  .command('trace <from> <to>')
  .description('Find the shortest directed path between two symbols (call + class-member edges)')
  .option('--from-uid <uid>', 'Source symbol UID (zero-ambiguity)')
  .option('--from-file <path>', 'Source file path hint')
  .option('--to-uid <uid>', 'Target symbol UID (zero-ambiguity)')
  .option('--to-file <path>', 'Target file path hint')
  .option('--depth <n>', 'Max path length in hops (default: 10)')
  .option('--include-tests', 'Include test files in results')
  .option('-r, --repo <name>', 'Target repository')
  .option('--branch <name>', 'Scope to a specific branch index')
  .action(createLbugLazyAction(() => import('./tool.js'), 'traceCommand'));

program
  .command('cypher <query>')
  .description('Execute raw Cypher query against the knowledge graph')
  .option('-r, --repo <name>', 'Target repository')
  .option('--branch <name>', 'Scope to a specific branch index (multi-branch repos)')
  .option('-l, --limit <n>', 'Max result rows to return')
  .action(createLbugLazyAction(() => import('./tool.js'), 'cypherCommand'));

program
  .command('detect-changes')
  .alias('detect_changes')
  .description('Map git diff hunks to indexed symbols and affected execution flows')
  .option('-s, --scope <scope>', 'What to analyze: unstaged, staged, all, or compare', 'unstaged')
  .option('-b, --base-ref <ref>', 'Branch/commit for compare scope (e.g. main)')
  .option('-r, --repo <name>', 'Target repository')
  .option('--branch <name>', 'Scope to a specific branch index (multi-branch repos)')
  .option('-l, --limit <n>', 'Max changed symbols to return')
  .action(createLbugLazyAction(() => import('./tool.js'), 'detectChangesCommand'));

program
  .command('check')
  .description('Run structural checks against the indexed graph')
  .option('--cycles', 'Detect circular imports and fail when any are found')
  .option('--json', 'Emit machine-readable JSON')
  .option('-r, --repo <name>', 'Target repository')
  .option('--branch <name>', 'Scope to a specific branch index (multi-branch repos)')
  .action(createLbugLazyAction(() => import('./tool.js'), 'checkCommand'));

// ─── Eval Server (persistent daemon for SWE-bench) ─────────────────

program
  .command('eval-server')
  .description('Start lightweight HTTP server for fast tool calls during evaluation')
  .option('-p, --port <port>', 'Port number', '4848')
  .option(
    '--host <host>',
    'Bind address or resolvable hostname (default: 127.0.0.1; non-loopback requires GITNEXUS_AUTH_TOKEN; hostnames resolve to IPv4)',
  )
  .option('--idle-timeout <seconds>', 'Auto-shutdown after N seconds idle (0 = disabled)', '0')
  .action(createLbugLazyAction(() => import('./eval-server.js'), 'evalServerCommand'));

registerGroupCommands(program);
localizeCliHelp(program);

program.parse(process.argv);
