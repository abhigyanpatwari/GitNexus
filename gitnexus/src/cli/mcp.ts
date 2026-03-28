/**
 * MCP Command
 *
 * Starts the MCP server in standalone mode.
 * Loads all indexed repos from the global registry.
 * No longer depends on cwd — works from any directory.
 */

import { startMCPServer } from '../mcp/server.js';
import { LocalBackend } from '../mcp/local/local-backend.js';

export const mcpCommand = async () => {
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

  // Initialize multi-repo backend from registry.
  // The server starts even with 0 repos — tools call refreshRepos() lazily,
  // so repos indexed after the server starts are discovered automatically.
  const backend = new LocalBackend();
  await backend.init();

  const repos = await backend.listRepos();
  if (repos.length === 0) {
    console.error(
      'GitNexus: No indexed repos yet. Run `gitnexus analyze` in a git repo — the server will pick it up automatically.',
    );
  } else {
    console.error(
      `GitNexus: MCP server starting with ${repos.length} repo(s): ${repos.map((r) => r.name).join(', ')}`,
    );
  }

  // Start MCP server (serves all repos, discovers new ones lazily)
  await startMCPServer(backend);
};
