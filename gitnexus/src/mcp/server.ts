/**
 * MCP Server (Multi-Repo)
 *
 * Model Context Protocol server that runs on stdio.
 * External AI tools (Cursor, Claude) spawn this process and
 * communicate via stdin/stdout using the MCP protocol.
 *
 * Supports multiple indexed repositories via the global registry.
 *
 * Tools: list_repos, query, cypher, context, impact, detect_changes, rename
 * Resources: repos, repo/{name}/context, repo/{name}/clusters, ...
 */

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CompatibleStdioServerTransport } from './compatible-stdio-transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GITNEXUS_TOOLS } from './tools.js';
import type { LocalBackend } from './local/local-backend.js';
import { getResourceDefinitions, getResourceTemplates, readResource } from './resources.js';

/**
 * Next-step hints appended to tool responses.
 *
 * Agents often stop after one tool call. These hints guide them to the
 * logical next action, creating a self-guiding workflow without hooks.
 *
 * Design: Each hint is a short, actionable instruction (not a suggestion).
 * The hint references the specific tool/resource to use next.
 */
function getNextStepHint(toolName: string, args: Record<string, any> | undefined): string {
  const repo = args?.repo;
  const repoParam = repo ? `, repo: "${repo}"` : '';
  const repoPath = repo || '{name}';

  switch (toolName) {
    case 'list_repos':
      return `\n\n---\n**Next:** READ gitnexus://repo/{name}/context for any repo above to get its overview and check staleness.`;

    case 'query':
      return `\n\n---\n**Next:** To understand a specific symbol in depth, use context({name: "<symbol_name>"${repoParam}}) to see categorized refs and process participation.`;

    case 'context':
      return `\n\n---\n**Next:** If planning changes, use impact({target: "${args?.name || '<name>'}", direction: "upstream"${repoParam}}) to check blast radius. To see execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    case 'impact':
      return `\n\n---\n**Next:** Review d=1 items first (WILL BREAK). To check affected execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    case 'detect_changes':
      return `\n\n---\n**Next:** Review affected processes. Use context() on high-risk changed symbols. READ gitnexus://repo/${repoPath}/process/{name} for full execution traces.`;

    case 'rename':
      return `\n\n---\n**Next:** Run detect_changes(${repoParam ? `{repo: "${repo}"}` : ''}) to verify no unexpected side effects from the rename.`;

    case 'cypher':
      return `\n\n---\n**Next:** To explore a result symbol, use context({name: "<name>"${repoParam}}). For schema reference, READ gitnexus://repo/${repoPath}/schema.`;

    // Legacy tool names — still return useful hints
    case 'search':
      return `\n\n---\n**Next:** To understand a result in context, use context({name: "<symbol_name>"${repoParam}}).`;
    case 'explore':
      return `\n\n---\n**Next:** If planning changes, use impact({target: "<name>", direction: "upstream"${repoParam}}).`;
    case 'overview':
      return `\n\n---\n**Next:** To drill into an area, READ gitnexus://repo/${repoPath}/cluster/{name}. To see execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    default:
      return '';
  }
}

/**
 * Create a configured MCP Server with all handlers registered.
 * Transport-agnostic — caller connects the desired transport.
 */
export function createMCPServer(backend: LocalBackend): Server {
  const require = createRequire(import.meta.url);
  const pkgVersion: string = require('../../package.json').version;
  const server = new Server(
    {
      name: 'gitnexus',
      version: pkgVersion,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = getResourceDefinitions();
    return {
      resources: resources.map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  // Handle list resource templates request (for dynamic resources)
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const templates = getResourceTemplates();
    return {
      resourceTemplates: templates.map(t => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      })),
    };
  });

  // Handle read resource request
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    try {
      const content = await readResource(uri, backend);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/yaml',
            text: content,
          },
        ],
      };
    } catch (err: any) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Error: ${err.message}`,
          },
        ],
      };
    }
  });


  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: GITNEXUS_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  // Handle tool calls — append next-step hints to guide agent workflow
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await backend.callTool(name, args);
      const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      const hint = getNextStepHint(name, args as Record<string, any> | undefined);

      return {
        content: [
          {
            type: 'text',
            text: resultText + hint,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Handle list prompts request
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'detect_impact',
        description: 'Analyze the impact of your current changes before committing. Guides through scope selection, change detection, process analysis, and risk assessment.',
        arguments: [
          { name: 'scope', description: 'What to analyze: unstaged, staged, all, or compare', required: false },
          { name: 'base_ref', description: 'Branch/commit for compare scope', required: false },
        ],
      },
      {
        name: 'generate_map',
        description: 'Generate architecture documentation from the knowledge graph. Creates a codebase overview with execution flows and mermaid diagrams.',
        arguments: [
          { name: 'repo', description: 'Repository name (omit if only one indexed)', required: false },
        ],
      },
    ],
  }));

  // Handle get prompt request
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'detect_impact') {
      const scope = args?.scope || 'all';
      const baseRef = args?.base_ref || '';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Analyze the impact of my current code changes before committing.

Follow these steps:
1. Run \`detect_changes(${JSON.stringify({ scope, ...(baseRef ? { base_ref: baseRef } : {}) })})\` to find what changed and affected processes
2. For each changed symbol in critical processes, run \`context({name: "<symbol>"})\` to see its full reference graph
3. For any high-risk items (many callers or cross-process), run \`impact({target: "<symbol>", direction: "upstream"})\` for blast radius
4. Summarize: changes, affected processes, risk level, and recommended actions

Present the analysis as a clear risk report.`,
            },
          },
        ],
      };
    }

    if (name === 'generate_map') {
      const repo = args?.repo || '';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Generate architecture documentation for this codebase using the knowledge graph.

Follow these steps:
1. READ \`gitnexus://repo/${repo || '{name}'}/context\` for codebase stats
2. READ \`gitnexus://repo/${repo || '{name}'}/clusters\` to see all functional areas
3. READ \`gitnexus://repo/${repo || '{name}'}/processes\` to see all execution flows
4. For the top 5 most important processes, READ \`gitnexus://repo/${repo || '{name}'}/process/{name}\` for step-by-step traces
5. Generate a mermaid architecture diagram showing the major areas and their connections
6. Write an ARCHITECTURE.md file with: overview, functional areas, key execution flows, and the mermaid diagram`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  return server;
}

/**
 * Start the MCP server on stdio transport (for CLI use).
 */
export async function startMCPServer(backend: LocalBackend): Promise<void> {
  const server = createMCPServer(backend);

  // Connect to stdio transport
  const transport = new CompatibleStdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown helper
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await backend.disconnect(); } catch {}
    try { await server.close(); } catch {}
    process.exit(0);
  };

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Handle stdio errors — stdin close means the parent process is gone
  process.stdin.on('end', shutdown);
  process.stdin.on('error', () => shutdown());
  process.stdout.on('error', () => shutdown());
}
