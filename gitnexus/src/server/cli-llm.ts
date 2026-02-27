/**
 * CLI LLM Integration
 *
 * Spawns claude / codex / gemini CLI as a subprocess and streams parsed events.
 * Used by the /api/llm/chat endpoint to proxy LLM calls through
 * locally installed CLI tools (no API keys needed).
 */

import { spawn, type ChildProcess } from 'child_process';
import { isCLIAvailable, getCleanEnv } from '../lib/cli.js';

export type CLITool = 'claude' | 'codex' | 'gemini';

export interface CLIStreamEvent {
  type: 'text' | 'tool_start' | 'tool_result' | 'error' | 'done';
  content?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: string;
  toolResult?: string;
}

export interface CLIChatRequest {
  messages: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  cliTool?: CLITool;
  /** URL of the GitNexus MCP server (e.g. http://127.0.0.1:4747/api/mcp) */
  mcpServerUrl?: string;
}

/**
 * Detect which CLI tools are available on the system.
 * Cached for 60s (positive) / 10s (negative, user may install mid-session).
 */
let cachedTools: { claude: boolean; codex: boolean; gemini: boolean } | null = null;
let cachedAt = 0;
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;

export function detectCLITools(): { claude: boolean; codex: boolean; gemini: boolean } {
  const now = Date.now();
  if (cachedTools) {
    const hasAny = cachedTools.claude || cachedTools.codex || cachedTools.gemini;
    const ttl = hasAny ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (now - cachedAt < ttl) return cachedTools;
  }
  cachedTools = {
    claude: isCLIAvailable('claude'),
    codex: isCLIAvailable('codex'),
    gemini: isCLIAvailable('gemini'),
  };
  cachedAt = now;
  return cachedTools;
}

/**
 * Build a single prompt string from message history.
 * The last user message is the prompt; prior messages become context.
 */
function buildPrompt(messages: Array<{ role: string; content: string }>): string {
  if (messages.length === 0) return '';
  if (messages.length === 1) return messages[0].content;

  const context = messages.slice(0, -1)
    .map(m => `[${m.role}]: ${m.content}`)
    .join('\n\n');
  const last = messages[messages.length - 1].content;

  return `Previous conversation:\n${context}\n\nCurrent message:\n${last}`;
}

/**
 * Parse a single NDJSON line from claude --output-format stream-json.
 * Returns an array of CLIStreamEvents (a single line can produce multiple events).
 */
function parseClaudeLine(line: string): CLIStreamEvent[] {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  // Skip system events (hooks, init, rate limits)
  if (parsed.type === 'system' || parsed.type === 'rate_limit_event') {
    return [];
  }

  // Incremental streaming text (most common during generation)
  if (parsed.type === 'content_block_delta') {
    if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
      return [{ type: 'text', content: parsed.delta.text }];
    }
    return [];
  }

  // Content block start — tool_use blocks carry name and id
  if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
    return [{
      type: 'tool_start',
      toolName: parsed.content_block.name,
      toolCallId: parsed.content_block.id,
    }];
  }

  // Final result — always includes done; text is only for non-streamed output
  if (parsed.type === 'result') {
    const events: CLIStreamEvent[] = [];
    if (parsed.result && typeof parsed.result === 'string') {
      events.push({ type: 'text', content: parsed.result });
    }
    events.push({ type: 'done' });
    return events;
  }

  // Assistant message — may contain text + tool_use + tool_result blocks
  if (parsed.type === 'assistant' && parsed.message?.content) {
    const events: CLIStreamEvent[] = [];
    for (const block of parsed.message.content) {
      if (block.type === 'text' && block.text) {
        events.push({ type: 'text', content: block.text });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool_start',
          toolName: block.name,
          toolCallId: block.id,
          toolInput: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        });
      } else if (block.type === 'tool_result') {
        events.push({
          type: 'tool_result',
          toolCallId: block.tool_use_id,
          toolResult: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        });
      }
    }
    return events;
  }

  return [];
}

/**
 * Parse a single NDJSON line from gemini -o stream-json.
 * Gemini CLI streams NDJSON with different event types than Claude.
 */
function parseGeminiLine(line: string): CLIStreamEvent[] {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  // Text content from assistant message delta
  if (parsed.type === 'message' && parsed.role === 'assistant' && parsed.delta) {
    return [{ type: 'text', content: parsed.delta }];
  }

  // Tool use start
  if (parsed.type === 'tool_use') {
    return [{
      type: 'tool_start',
      toolName: parsed.name || 'unknown',
      toolCallId: parsed.id,
      toolInput: parsed.input ? (typeof parsed.input === 'string' ? parsed.input : JSON.stringify(parsed.input)) : undefined,
    }];
  }

  // Tool result
  if (parsed.type === 'tool_result') {
    return [{
      type: 'tool_result',
      toolCallId: parsed.tool_use_id || parsed.id,
      toolResult: typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content ?? ''),
    }];
  }

  // Final result — signals completion
  if (parsed.type === 'result') {
    const events: CLIStreamEvent[] = [];
    if (parsed.result && typeof parsed.result === 'string') {
      events.push({ type: 'text', content: parsed.result });
    }
    events.push({ type: 'done' });
    return events;
  }

  return [];
}

const ALLOWED_TOOLS = new Set<CLITool>(['claude', 'codex', 'gemini']);
const CLI_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Spawn a CLI tool (claude/codex/gemini) and stream parsed events.
 * Returns the child process (caller can kill it to abort).
 */
export function spawnCLIStream(
  request: CLIChatRequest,
  onEvent: (event: CLIStreamEvent) => void,
  onDone: (error?: Error) => void,
): ChildProcess {
  const tool = request.cliTool || 'claude';
  if (!ALLOWED_TOOLS.has(tool)) {
    throw new Error(`Invalid CLI tool: ${tool}`);
  }

  const prompt = buildPrompt(request.messages);

  let args: string[];

  if (tool === 'claude') {
    args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
    ];
    if (request.mcpServerUrl) {
      const mcpConfig = JSON.stringify({
        mcpServers: { gitnexus: { url: request.mcpServerUrl } },
      });
      args.push('--mcp-config', mcpConfig, '--allowedTools', 'mcp__gitnexus__*');
    }
    if (request.systemPrompt) {
      args.push('--system-prompt', request.systemPrompt);
    }
  } else if (tool === 'gemini') {
    // Gemini CLI: text-only streaming, no MCP support
    args = ['-p', prompt, '-o', 'stream-json'];
  } else {
    // codex: '-c' injects MCP server config inline, '--' separates prompt from flags
    args = ['--quiet', '--full-auto'];
    if (request.mcpServerUrl) {
      args.push('-c', `mcp_servers.gitnexus.url="${request.mcpServerUrl}"`);
    }
    args.push('--', prompt);
  }

  const child = spawn(tool, args, {
    env: getCleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });

  // Timeout — kill the child if it takes too long
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, CLI_TIMEOUT_MS);

  let buffer = '';
  let hasStreamedContent = false;
  let doneEmitted = false;

  const emitDone = () => {
    if (!doneEmitted) {
      doneEmitted = true;
      onEvent({ type: 'done' });
    }
  };

  const emitEvents = (events: CLIStreamEvent[]) => {
    // A batch containing 'done' comes from a 'result' line —
    // its text duplicates already-streamed assistant content
    const isResultBatch = events.some(e => e.type === 'done');
    for (const event of events) {
      if (isResultBatch && event.type === 'text' && hasStreamedContent) continue;
      if (event.type === 'done') {
        emitDone();
        continue;
      }
      if (event.type === 'text') hasStreamedContent = true;
      onEvent(event);
    }
  };

  child.stdout?.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (tool === 'claude') {
        const trimmed = line.trim();
        if (trimmed) emitEvents(parseClaudeLine(trimmed));
      } else if (tool === 'gemini') {
        const trimmed = line.trim();
        if (trimmed) emitEvents(parseGeminiLine(trimmed));
      } else {
        // codex outputs plain text — preserve newlines
        if (line) onEvent({ type: 'text', content: line + '\n' });
      }
    }
  });

  // Cap stderr to avoid unbounded memory growth
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    if (stderr.length < 4096) {
      stderr += data.toString();
    }
  });

  // Guard against double onDone (Node emits both 'error' + 'close' on spawn failure)
  let finished = false;

  child.on('close', (code) => {
    clearTimeout(timeout);
    if (finished) return;
    finished = true;

    // Flush remaining buffer
    if (buffer.trim()) {
      if (tool === 'claude') {
        emitEvents(parseClaudeLine(buffer.trim()));
      } else if (tool === 'gemini') {
        emitEvents(parseGeminiLine(buffer.trim()));
      } else {
        onEvent({ type: 'text', content: buffer.trim() });
      }
    }

    if (code !== 0 && code !== null) {
      onEvent({ type: 'error', content: `${tool} exited with code ${code}: ${stderr.slice(0, 300)}` });
    }

    emitDone();

    onDone(code !== 0 && code !== null
      ? new Error(`${tool} exited with code ${code}`)
      : undefined);
  });

  child.on('error', (err) => {
    clearTimeout(timeout);
    if (finished) return;
    finished = true;
    onEvent({ type: 'error', content: err.message });
    emitDone();
    onDone(err);
  });

  return child;
}
