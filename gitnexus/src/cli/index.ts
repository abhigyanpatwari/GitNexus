#!/usr/bin/env node

// Heap re-spawn removed — only analyze.ts needs the 8GB heap (via its own ensureHeap()).
// Removing it from here improves MCP server startup time significantly.

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createLazyAction } from './lazy-action.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');
const program = new Command();

program
  .name('gitnexus')
  .description('GitNexus local CLI and MCP server')
  .version(pkg.version);

program
  .command('setup')
  .description('One-time setup: configure MCP for Cursor, Claude Code, OpenCode, Codex')
  .action(createLazyAction(() => import('./setup.js'), 'setupCommand'));


program
  .command('analyze [path]')
  .description('Index a repository (full analysis)')
  .option('-f, --force', 'Force full re-index even if up to date')
  .option('--embeddings', 'Enable embedding generation for semantic search (off by default)')
  .option('--skills', 'Generate repo-specific skill files from detected communities')
  .option('--skip-git', 'Index a folder without requiring a .git directory')
   .option('-v, --verbose', 'Enable verbose ingestion warnings (default: false)')
   .option('--lsp', 'Augment CALLS resolution with the TypeScript language server (TS-only, CALLS-only, confidence 0.70)')
   .option('--lsp-dry-run', 'Preview every LSP reconciliation decision and write nothing; implies --lsp')
   .addHelpText('after', '\nEnvironment variables:\n  GITNEXUS_NO_GITIGNORE=1  Skip .gitignore parsing (still reads .gitnexusignore)')
   .action(createLazyAction(() => import('./analyze.js'), 'analyzeCommand'));

program
  .command('index [path...]')
  .description('Register an existing .gitnexus/ folder into the global registry (no re-analysis needed)')
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
  .command('clean')
  .description('Delete GitNexus index for current repo')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--all', 'Clean all indexed repos')
  .action(createLazyAction(() => import('./clean.js'), 'cleanCommand'));

program
  .command('wiki [path]')
  .description('Generate repository wiki from knowledge graph')
  .option('-f, --force', 'Force full regeneration even if up to date')
  .option('--provider <provider>', 'LLM provider: openai or cursor (default: openai)')
  .option('--model <model>', 'LLM model name (default depends on provider)')
  .option('--base-url <url>', 'LLM API base URL (for openai provider)')
  .option('--api-key <key>', 'LLM API key (saved to ~/.gitnexus/config.json)')
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
  .command('context [name]')
  .description('360-degree view of a code symbol: callers, callees, processes')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'contextCommand'));

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
  .command('document-endpoint')
  .description('Generate API documentation JSON for an endpoint')
  .option('--all', 'Document all endpoints (always uses openapi mode, requires --outputPath)')
  .option('--allow-partial', 'Exit 0 if >=1 endpoint succeeds (default: exit 1 on any failure)')
  .option('--method <method>', 'HTTP method (GET, POST, PUT, DELETE, PATCH)')
  .option('--path <pattern>', 'Path pattern to match (e.g., "suggest", "/bookings/{id}")')
  .option('--depth <n>', 'Max trace depth (default: 10)', '10')
  .option('--mode <mode>', 'Output mode: openapi (default) or ai_context', 'openapi')
  .option('--input-yaml <path>', 'CLI-only: path to existing YAML to enrich')
  .option('--outputPath <path>', 'Output directory for JSON and OpenAPI YAML files')
  .option('--schema-path <path>', 'Path to custom JSON schema file (default: bundled schema)')
  .option('--strict', 'Fail on schema validation errors (default: warn)', false)
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./tool.js'), 'documentEndpointCommand'));

// ─── Eval Server (persistent daemon for SWE-bench) ─────────────────

program
  .command('eval-server')
  .description('Start lightweight HTTP server for fast tool calls during evaluation')
  .option('-p, --port <port>', 'Port number', '4848')
  .option('--idle-timeout <seconds>', 'Auto-shutdown after N seconds idle (0 = disabled)', '0')
  .action(createLazyAction(() => import('./eval-server.js'), 'evalServerCommand'));

// ─── LSP utilities (one-shot `doctor` diagnostic) ──────────────────
//
// WI-#7: surfaces whether `typescript-language-server` is on PATH
// and whether the workspace is in a state where LSP results are
// trustworthy. Always exits 0 (informational — absence is a
// normal report, not an error). See design `#sd-lsp-doctor`.

program
  .command('lsp <action>')
  .description('LSP utilities (doctor)')
  .option('--format <format>', 'text or json (default: text)', 'text')
  .action(createLazyAction(() => import('./lsp.js'), 'lspCommand'));

// ─── Verify (LSP read-only — Mode C) ────────────────────────────────
//
// WI-#8: read-only verifier that compares heuristic CALLS edges
// to LSP-resolved definitions. See design `#sd-verify-mode-c`.

program
  .command('verify')
  .description('Verify heuristic accuracy against LSP (Mode C) — read-only')
  .option('--lsp', 'Run Mode C: compare heuristic CALLS edges to LSP-resolved targets')
  .option('--strict', 'Exit non-zero when LSP is unavailable')
  .option('--sample <n>', 'Sample size (default: 200)', '200')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./verify.js'), 'verifyCommand'));

program.parse(process.argv);
