/**
 * MCP Command
 *
 * Starts the MCP server in standalone mode.
 * Loads indexed repos from the global registry (optional subset via --repos).
 * No longer depends on cwd — works from any directory.
 */

import { startMCPServer } from '../mcp/server.js';
import { LocalBackend, type LocalBackendOptions } from '../mcp/local/local-backend.js';
import { listRegisteredRepos } from '../storage/repo-manager.js';

function parseMcpRepoAllowlistTokens(cliRepos: string | undefined): string {
  const fromCli = cliRepos?.trim();
  const fromEnv = process.env.GITNEXUS_MCP_REPOS?.trim();
  return fromCli || fromEnv || '';
}

async function buildMcpBackendOptions(cliRepos?: string): Promise<LocalBackendOptions | undefined> {
  const rawList = parseMcpRepoAllowlistTokens(cliRepos);
  if (!rawList) return undefined;

  const tokens = rawList.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const entries = await listRegisteredRepos({ validate: true });
  const registered = new Set(entries.map((e) => e.name.toLowerCase()));
  const unknown = tokens.filter((t) => !registered.has(t.toLowerCase()));
  if (unknown.length > 0) {
    console.error(
      `GitNexus: Unknown repo name(s) in --repos / GITNEXUS_MCP_REPOS: ${unknown.join(', ')}`,
    );
    const label = entries.map((e) => e.name).join(', ');
    console.error(label ? `Registered repos: ${label}` : 'No repos registered yet.');
    process.exit(1);
  }

  const seen = new Set<string>();
  const matchedDisplay: string[] = [];
  for (const t of tokens) {
    const low = t.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    const entry = entries.find((e) => e.name.toLowerCase() === low);
    if (entry) matchedDisplay.push(entry.name);
  }
  return { mcpRepoAllowlist: matchedDisplay };
}

export const mcpCommand = async (options?: { repos?: string }) => {
  // Prevent unhandled errors from crashing the MCP server process.
  // LadybugDB lock conflicts and transient errors should degrade gracefully.
  process.on('uncaughtException', (err) => {
    console.error(`GitNexus MCP: uncaught exception — ${err.message}`);
    // Process is in an undefined state after uncaughtException — exit after flushing
    setTimeout(() => process.exit(1), 100);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`GitNexus MCP: unhandled rejection — ${msg}`);
  });

  const restricted = Boolean(parseMcpRepoAllowlistTokens(options?.repos));
  const backendOpts = await buildMcpBackendOptions(options?.repos);

  // Initialize multi-repo backend from registry.
  // The server starts even with 0 repos — tools call refreshRepos() lazily,
  // so repos indexed after the server starts are discovered automatically.
  const backend = new LocalBackend(backendOpts);
  await backend.init();

  const repos = await backend.listRepos();
  if (repos.length === 0) {
    console.error(
      'GitNexus: No indexed repos yet. Run `gitnexus analyze` in a git repo — the server will pick it up automatically.',
    );
  } else if (restricted) {
    console.error(
      `GitNexus: MCP server restricted to ${repos.length} repo(s): ${repos.map((r) => r.name).join(', ')}`,
    );
  } else {
    console.error(
      `GitNexus: MCP server starting with ${repos.length} repo(s): ${repos.map((r) => r.name).join(', ')}`,
    );
  }

  await startMCPServer(backend);
};
