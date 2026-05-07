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
import { spawn } from 'node:child_process';
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
import { installGlobalStdoutSentinel } from './stdio-context.js';
import type { LocalBackend } from './local/local-backend.js';
import { getResourceDefinitions, getResourceTemplates, readResource } from './resources.js';

const ISOLATED_TOOL_NAMES = new Set([
  'query',
  'cypher',
  'context',
  'detect_changes',
  'rename',
  'get_impact_score',
  'export_context',
  'runtime_context',
  'impact',
  'route_map',
  'tool_map',
  'shape_check',
  'api_impact',
  'group_sync',
]);

const CHILD_RESULT_MARKER = '__GITNEXUS_MCP_CHILD_RESULT__';

function shouldIsolateToolCall(toolName: string): boolean {
  const value = process.env.GITNEXUS_MCP_ISOLATE_DB_TOOLS?.toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no' && ISOLATED_TOOL_NAMES.has(toolName);
}

function callToolInChildProcess(name: string, args: unknown): Promise<unknown> {
  const backendUrl = new URL('./local/local-backend.js', import.meta.url).href;
  const toolArgs = Buffer.from(JSON.stringify(args ?? {}), 'utf8').toString('base64url');
  const childScript = `
    import { writeSync } from 'node:fs';
    const { LocalBackend } = await import(process.env.GITNEXUS_LOCAL_BACKEND_URL);
    const marker = process.env.GITNEXUS_CHILD_RESULT_MARKER;
    try {
      const backend = new LocalBackend();
      await backend.init();
      const args = JSON.parse(Buffer.from(process.env.GITNEXUS_TOOL_ARGS || '', 'base64url').toString('utf8'));
      const result = await backend.callTool(process.env.GITNEXUS_TOOL_NAME, args);
      const payload = Buffer.from(JSON.stringify(result), 'utf8').toString('base64url');
      writeSync(1, marker + payload + '\\n');
    } catch (err) {
      writeSync(2, (err?.stack || err?.message || String(err)) + '\\n');
      process.exit(1);
    }
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GITNEXUS_LOCAL_BACKEND_URL: backendUrl,
        GITNEXUS_TOOL_NAME: name,
        GITNEXUS_TOOL_ARGS: toolArgs,
        GITNEXUS_CHILD_RESULT_MARKER: CHILD_RESULT_MARKER,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const tryResolveFromStdout = () => {
      const markerIndex = stdout.lastIndexOf(CHILD_RESULT_MARKER);
      if (markerIndex === -1) return;
      const payloadStart = markerIndex + CHILD_RESULT_MARKER.length;
      const payloadEnd = stdout.indexOf('\n', payloadStart);
      if (payloadEnd === -1) return;

      const payload = stdout.slice(payloadStart, payloadEnd).trim();
      try {
        const result = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        finish(() => resolve(result));
        child.kill();
      } catch (err) {
        finish(() => reject(err));
        child.kill();
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`GitNexus tool "${name}" timed out in isolated worker`)));
    }, 120_000);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      tryResolveFromStdout();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      finish(() => reject(err));
    });
    child.on('close', (code) => {
      if (settled) return;
      tryResolveFromStdout();
      if (settled) return;
      if (code !== 0) {
        finish(() =>
          reject(
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                `GitNexus tool "${name}" failed in isolated worker with exit code ${code}`,
            ),
          ),
        );
        return;
      }

      const markerIndex = stdout.lastIndexOf(CHILD_RESULT_MARKER);
      if (markerIndex === -1) {
        finish(() =>
          reject(new Error(`GitNexus tool "${name}" returned no isolated worker result`)),
        );
        return;
      }

      const payload = stdout
        .slice(markerIndex + CHILD_RESULT_MARKER.length)
        .trim()
        .split(/\s+/)[0];
      try {
        finish(() => resolve(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))));
      } catch (err) {
        finish(() => reject(err));
      }
    });
  });
}

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
      return `\n\n---\n**Next:** If planning changes, use get_impact_score({target: "${args?.name || '<name>'}"${repoParam}}) for a quick risk read, then impact({target: "${args?.name || '<name>'}", direction: "upstream"${repoParam}}) for full blast radius.`;

    case 'get_impact_score':
      return `\n\n---\n**Next:** For MEDIUM/HIGH/CRITICAL scores, run impact({target: "${args?.target || '<target>'}", direction: "upstream"${repoParam}}) and inspect d=1 dependants before editing.`;

    case 'export_context':
      return `\n\n---\n**Next:** Use the exported nodes and edges as bounded agent context. For risk, run get_impact_score({target: "${args?.target || '<target>'}"${repoParam}}).`;

    case 'runtime_context':
      return `\n\n---\n**Next:** Combine runtime evidence with impact({target: "${args?.target || '<target>'}", direction: "upstream"${repoParam}}) before prioritizing edits.`;

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

function shouldReleaseDbAfterRequest(): boolean {
  const value = process.env.GITNEXUS_MCP_KEEP_DB_OPEN?.toLowerCase();
  return value !== '1' && value !== 'true' && value !== 'yes';
}

async function releaseBackendDbAfterRequest(backend: LocalBackend): Promise<void> {
  if (!shouldReleaseDbAfterRequest()) return;

  const releasable = backend as LocalBackend & { releaseConnections?: () => Promise<void> };
  const release = releasable.releaseConnections ?? releasable.dispose;
  if (!release) return;

  try {
    await release.call(backend);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`GitNexus MCP: failed to release LadybugDB handles: ${message}\n`);
  }
}

type BackendRequestQueue = {
  run<T>(fn: () => Promise<T>): Promise<T>;
};

function createBackendRequestQueue(backend: LocalBackend): BackendRequestQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const previous = tail;
      let releaseTail: () => void = () => {};
      tail = new Promise<void>((resolve) => {
        releaseTail = resolve;
      });

      return previous
        .catch(() => {
          /* keep later requests moving after an earlier failure */
        })
        .then(async () => {
          try {
            return await fn();
          } finally {
            await releaseBackendDbAfterRequest(backend);
            releaseTail();
          }
        });
    },
  };
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
    },
  );
  const backendQueue = createBackendRequestQueue(backend);

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = getResourceDefinitions();
    return {
      resources: resources.map((r) => ({
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
      resourceTemplates: templates.map((t) => ({
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
      const content = await backendQueue.run(() => readResource(uri, backend));
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
      annotations: tool.annotations,
    })),
  }));

  // Handle tool calls — append next-step hints to guide agent workflow
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const isolated = shouldIsolateToolCall(name);

    try {
      const result = isolated
        ? await callToolInChildProcess(name, args)
        : await backendQueue.run(() => backend.callTool(name, args));
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
        description:
          'Analyze the impact of your current changes before committing. Guides through scope selection, change detection, process analysis, and risk assessment.',
        arguments: [
          {
            name: 'scope',
            description: 'What to analyze: unstaged, staged, all, or compare',
            required: false,
          },
          { name: 'base_ref', description: 'Branch/commit for compare scope', required: false },
        ],
      },
      {
        name: 'generate_map',
        description:
          'Generate architecture documentation from the knowledge graph. Creates a codebase overview with execution flows and mermaid diagrams.',
        arguments: [
          {
            name: 'repo',
            description: 'Repository name (omit if only one indexed)',
            required: false,
          },
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

  // Idempotent global sentinel install. cli/mcp.ts calls this first thing
  // (before warnMissingOptionalGrammars / backend.init can emit to stdout);
  // calling again here is a safety net for direct callers of startMCPServer
  // (tests, future entry points). The transport's _safeStdout Proxy is a
  // second layer that guarantees transport writes reach the sentinel even
  // if anything else re-replaces process.stdout.write later. Tagged
  // transport writes (wrapped in withMcpWrite by compatible-stdio-transport.send)
  // pass through to the captured realStdoutWrite; untagged writes reaching
  // the Proxy or process.stdout get redirected to stderr with the
  // [mcp:stdout-redirect] prefix. See stdio-context.ts.
  const sentinel = installGlobalStdoutSentinel();
  const safeStdout = new Proxy(process.stdout, {
    get(target, prop, receiver) {
      if (prop === 'write') return sentinel.write;
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
  const transport = new CompatibleStdioServerTransport(process.stdin, safeStdout);
  await server.connect(transport);

  // Keep the stdio MCP process alive even when no native DB handle is open.
  // Tool handlers release LadybugDB after requests to avoid file-lock
  // contention, so the database can no longer double as the process anchor.
  const keepAliveTimer = setInterval(() => {}, 60_000);

  // Surface the redirect counter on shutdown so users see the volume of
  // stray writes even when individual payloads were truncated/suppressed.
  process.on('exit', () => sentinel.flushSummary());

  // Graceful shutdown helper
  let shuttingDown = false;
  const shutdown = async (exitCode = 0, _reason = 'signal') => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAliveTimer);
    try {
      await backend.disconnect();
    } catch {}
    try {
      await server.close();
    } catch {}
    process.exit(exitCode);
  };

  // Handle graceful shutdown
  process.on('SIGINT', () => shutdown(0, 'SIGINT'));
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));

  // Log crashes to stderr so they aren't silently lost.
  // uncaughtException is fatal — shut down.
  // unhandledRejection is logged but kept non-fatal (availability-first):
  // killing the server for one missed catch would be worse than logging it.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`GitNexus MCP uncaughtException: ${err?.stack || err}\n`);
    shutdown(1, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason: any) => {
    process.stderr.write(`GitNexus MCP unhandledRejection: ${reason?.stack || reason}\n`);
  });

  // Handle stdio errors — stdin close means the parent process is gone
  process.stdin.on('end', () => shutdown(0, 'stdin end'));
  process.stdin.on('error', () => shutdown(0, 'stdin error'));
  process.stdout.on('error', () => shutdown(0, 'stdout error'));
}
