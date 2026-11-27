const BUDGETED_TOOLS = new Set(['query', 'context', 'impact']);

export const MCP_TOKEN_ESTIMATE_BYTES = 4;
export const MCP_TRUNCATION_MARKER = '\n…';

/** Required content can't fit the budget; reported as an error, never as a short success. */
export class McpBudgetExceededError extends Error {
  constructor(
    readonly maxTokens: number,
    message = 'Result cannot fit maxTokens. Increase maxTokens or narrow the request.',
  ) {
    super(message);
    this.name = 'McpBudgetExceededError';
  }

  toJSONText(): string {
    const budget = this.maxTokens * MCP_TOKEN_ESTIMATE_BYTES;
    for (const payload of [
      { error: this.message },
      { error: 'Increase maxTokens' },
      { error: true },
    ]) {
      const text = JSON.stringify(payload);
      if (Buffer.byteLength(text, 'utf8') <= budget) return text;
    }
    // Even a one-token budget holds valid JSON. The transport's isError or
    // CLI exit status still signals failure when an error object cannot fit.
    return 'null';
  }
}

function parsePositiveInteger(value: unknown, source: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`${source} must be a positive integer.`);
}

export function resolveMcpMaxTokens(
  toolName: string,
  args: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!BUDGETED_TOOLS.has(toolName)) return undefined;
  if (args?.maxTokens !== undefined) return parsePositiveInteger(args.maxTokens, 'maxTokens');

  const configured = env.GITNEXUS_MCP_DEFAULT_MAX_TOKENS;
  if (configured === undefined || configured.trim() === '') return undefined;
  return parsePositiveInteger(configured, 'GITNEXUS_MCP_DEFAULT_MAX_TOKENS');
}

function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  const codePoints: string[] = [];
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + codePointBytes > maxBytes) break;
    codePoints.push(codePoint);
    bytes += codePointBytes;
  }
  return codePoints.join('');
}

export function applyMcpMaxTokens(text: string, maxTokens: number | undefined): string {
  if (maxTokens === undefined) return text;

  const textBytes = Buffer.byteLength(text, 'utf8');
  if (maxTokens >= Math.ceil(textBytes / MCP_TOKEN_ESTIMATE_BYTES)) return text;

  const maxBytes = maxTokens * MCP_TOKEN_ESTIMATE_BYTES;
  const markerBytes = Buffer.byteLength(MCP_TRUNCATION_MARKER, 'utf8');
  return utf8Prefix(text, Math.max(0, maxBytes - markerBytes)) + MCP_TRUNCATION_MARKER;
}

export function withoutMcpBudgetArg(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args || !Object.prototype.hasOwnProperty.call(args, 'maxTokens')) return args;
  const backendArgs = { ...args };
  delete backendArgs.maxTokens;
  return backendArgs;
}
