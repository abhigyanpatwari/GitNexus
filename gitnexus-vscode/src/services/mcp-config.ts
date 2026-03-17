import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface McpServer {
  type?: string;
  command: string;
  args: string[];
}

interface McpConfig {
  servers?: Record<string, McpServer>;
  mcpServers?: Record<string, Omit<McpServer, 'type'>>;
}

export async function ensureWorkspaceMcpConfig(
  workspaceRoot: string,
  command: string,
  baseArgs: string[],
  mcpArgs: string[],
): Promise<boolean> {
  const vscodeDir = path.join(workspaceRoot, '.vscode');
  const mcpPath = path.join(vscodeDir, 'mcp.json');

  const stdioServer: McpServer = {
    type: 'stdio',
    command,
    args: [...baseArgs, ...mcpArgs],
  };

  const legacyServer = {
    command,
    args: [...baseArgs, ...mcpArgs],
  };

  let current: McpConfig = {};

  try {
    const raw = await fs.readFile(mcpPath, 'utf8');
    current = JSON.parse(raw) as McpConfig;
  } catch {
    current = {};
  }

  const next: McpConfig = {
    ...current,
    servers: {
      ...(current.servers ?? {}),
      gitnexus: stdioServer,
    },
    mcpServers: {
      ...(current.mcpServers ?? {}),
      gitnexus: legacyServer,
    },
  };

  const before = JSON.stringify(current);
  const after = JSON.stringify(next);
  if (before === after) {
    return false;
  }

  await fs.mkdir(vscodeDir, { recursive: true });
  await fs.writeFile(mcpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return true;
}
