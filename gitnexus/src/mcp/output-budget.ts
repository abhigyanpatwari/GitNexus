const BUDGETED_TOOLS = new Set(['query', 'context', 'impact']);

export const MCP_TOKEN_ESTIMATE_BYTES = 4;
export const MCP_TRUNCATION_MARKER = '\n…';

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
