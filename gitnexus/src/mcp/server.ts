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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

export async function startMCPServer(backend: LocalBackend): Promise<void> {
  const server = new Server(
    {
      name: 'gitnexus',
      version: '1.1.9',
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
      {
        name: 'exploring',
        description: 'Navigate unfamiliar code using the knowledge graph. Guides through discovery of execution flows, symbol context, and architecture.',
        arguments: [
          { name: 'query', description: 'What you want to understand (e.g. "How does authentication work?")', required: true },
          { name: 'repo', description: 'Repository name (omit if only one indexed)', required: false },
        ],
      },
      {
        name: 'debugging',
        description: 'Trace bugs through call chains using the knowledge graph. Guides through symptom analysis, suspect identification, and root cause tracing.',
        arguments: [
          { name: 'symptom', description: 'The error message or unexpected behavior to investigate', required: true },
          { name: 'repo', description: 'Repository name (omit if only one indexed)', required: false },
        ],
      },
      {
        name: 'impact_analysis',
        description: 'Analyze blast radius before making code changes. Guides through dependency mapping, process impact, and risk assessment.',
        arguments: [
          { name: 'target', description: 'The symbol name to analyze impact for', required: true },
          { name: 'repo', description: 'Repository name (omit if only one indexed)', required: false },
        ],
      },
      {
        name: 'refactoring',
        description: 'Plan safe refactors using blast radius and dependency mapping. Guides through rename, extract, or split operations.',
        arguments: [
          { name: 'target', description: 'The symbol name to refactor', required: true },
          { name: 'action', description: 'Type of refactor: rename, extract, or split', required: true },
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
    
    if (name === 'exploring') {
      const query = args?.query || 'project structure';
      const repo = args?.repo || '';
      const repoPath = repo || '{name}';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Navigate unfamiliar code using the GitNexus knowledge graph.

I want to understand: "${query}"

Follow these steps:
1. READ \`gitnexus://repo/${repoPath}/context\` — codebase overview, check staleness
2. \`query({query: "${query}"})\` — find related execution flows
3. For key symbols in the results, use \`context({name: "<symbol>"${repo ? `, repo: "${repo}"` : ''}})\` — see callers/callees/processes
4. READ \`gitnexus://repo/${repoPath}/process/{name}\` — trace full execution flow for important processes
5. Read the actual source files for implementation details

Checklist:
- [ ] Read context resource (check index freshness)
- [ ] Query for the concept
- [ ] Review returned execution flows
- [ ] Context on key symbols for callers/callees
- [ ] Trace execution flows via process resources
- [ ] Read source files for implementation details

Present a clear explanation of how this part of the codebase works.`,
            },
          },
        ],
      };
    }

    if (name === 'debugging') {
      const symptom = args?.symptom || 'unknown error';
      const repo = args?.repo || '';
      const repoPath = repo || '{name}';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Trace a bug through call chains using the GitNexus knowledge graph.

Symptom: "${symptom}"

Follow these steps:
1. \`query({query: "${symptom}"${repo ? `, repo: "${repo}"` : ''}})\` — find related execution flows and symbols
2. Identify suspect functions from the results
3. \`context({name: "<suspect>"${repo ? `, repo: "${repo}"` : ''}})\` — see callers, callees, and processes
4. READ \`gitnexus://repo/${repoPath}/process/{name}\` — trace execution flow
5. If needed, \`cypher({query: "MATCH path = (a)-[:CodeRelation {type: 'CALLS'}*1..2]->(b:Function {name: \\"<suspect>\\"}) RETURN [n IN nodes(path) | n.name] AS chain"${repo ? `, repo: "${repo}"` : ''}})\` — custom call chain traces
6. Read source files to confirm root cause

Debugging patterns:
- Error message → query for error text → context on throw sites
- Wrong return value → context on the function → trace callees for data flow
- Intermittent failure → context → look for external calls, async deps
- Performance issue → context → find symbols with many callers (hot paths)
- Recent regression → detect_changes to see what changes affect

Present the root cause analysis with the full call chain.`,
            },
          },
        ],
      };
    }

    if (name === 'impact_analysis') {
      const target = args?.target || '';
      const repo = args?.repo || '';
      const repoPath = repo || '{name}';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Analyze the blast radius of "${target}" before making code changes.

Follow these steps:
1. \`impact({target: "${target}", direction: "upstream"${repo ? `, repo: "${repo}"` : ''}})\` — find what depends on this symbol
2. READ \`gitnexus://repo/${repoPath}/processes\` — check affected execution flows
3. \`detect_changes(${repo ? `{repo: "${repo}"}` : '{}'})\` — map current git changes to affected flows
4. Assess risk and report

Understanding depth:
- d=1: WILL BREAK — direct callers/importers
- d=2: LIKELY AFFECTED — indirect dependencies
- d=3: MAY NEED TESTING — transitive effects

Risk assessment:
- <5 symbols, few processes → LOW
- 5-15 symbols, 2-5 processes → MEDIUM
- >15 symbols or many processes → HIGH
- Critical path (auth, payments) → CRITICAL

Checklist:
- [ ] impact() with direction: "upstream" to find dependents
- [ ] Review d=1 items first (these WILL BREAK)
- [ ] Check high-confidence (>0.8) dependencies
- [ ] Read processes to check affected execution flows
- [ ] detect_changes() for pre-commit check
- [ ] Assess risk level and report

Present a clear risk report with blast radius visualization.`,
            },
          },
        ],
      };
    }

    if (name === 'refactoring') {
      const target = args?.target || '';
      const action = args?.action || 'rename';
      const repo = args?.repo || '';
      const repoPath = repo || '{name}';

      let actionSteps = '';
      if (action === 'rename') {
        actionSteps = `Rename workflow:
1. \`rename({symbol_name: "${target}", new_name: "<new_name>", dry_run: true${repo ? `, repo: "${repo}"` : ''}})\` — preview all edits
2. Review graph edits (high confidence) and ast_search edits (review carefully)
3. If satisfied: \`rename({symbol_name: "${target}", new_name: "<new_name>", dry_run: false${repo ? `, repo: "${repo}"` : ''}})\` — apply edits
4. \`detect_changes(${repo ? `{repo: "${repo}"}` : '{}'})\` — verify only expected files changed
5. Run tests for affected processes`;
      } else if (action === 'extract') {
        actionSteps = `Extract workflow:
1. \`context({name: "${target}"${repo ? `, repo: "${repo}"` : ''}})\` — see all incoming/outgoing refs
2. \`impact({target: "${target}", direction: "upstream"${repo ? `, repo: "${repo}"` : ''}})\` — find all external callers
3. Define new module interface based on the dependency map
4. Extract code, update imports
5. \`detect_changes(${repo ? `{repo: "${repo}"}` : '{}'})\` — verify affected scope
6. Run tests for affected processes`;
      } else {
        actionSteps = `Split workflow:
1. \`context({name: "${target}"${repo ? `, repo: "${repo}"` : ''}})\` — understand all callees
2. Group callees by responsibility
3. \`impact({target: "${target}", direction: "upstream"${repo ? `, repo: "${repo}"` : ''}})\` — map callers to update
4. Create new functions/services
5. Update callers
6. \`detect_changes(${repo ? `{repo: "${repo}"}` : '{}'})\` — verify affected scope
7. Run tests for affected processes`;
      }

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Plan a safe ${action} refactor of "${target}" using the GitNexus knowledge graph.

First, map dependencies:
1. \`impact({target: "${target}", direction: "upstream"${repo ? `, repo: "${repo}"` : ''}})\` — map all dependents
2. \`query({query: "${target}"${repo ? `, repo: "${repo}"` : ''}})\` — find execution flows involving it
3. \`context({name: "${target}"${repo ? `, repo: "${repo}"` : ''}})\` — see all incoming/outgoing refs

Then follow the ${action} steps:
${actionSteps}

Risk rules:
- Many callers (>5) → use rename tool for automated updates
- Cross-area refs → use detect_changes after to verify scope
- String/dynamic refs → query to find them
- External/public API → version and deprecate properly

Update order: interfaces → implementations → callers → tests

Present the refactoring plan with risk assessment.`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await backend.disconnect();
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await backend.disconnect();
    await server.close();
    process.exit(0);
  });
}
