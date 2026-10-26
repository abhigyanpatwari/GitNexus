const BUDGETED_TOOLS = new Set(['query', 'context', 'impact']);

export const MCP_TOKEN_ESTIMATE_BYTES = 4;
export const MCP_TRUNCATION_MARKER = '\n…';

const QUERY_CONTENT_BYTES = 16_000;
const QUERY_SYMBOL_CONTENT_BYTES = 4_000;

/** Bound source text, not graph evidence. Omitted source remains addressable by uid/path. */
export function formatMcpQueryResult(
  result: Record<string, unknown>,
  hint: string,
  maxTokens: number | undefined,
): string {
  const contentBytes =
    maxTokens === undefined ? QUERY_CONTENT_BYTES : maxTokens * MCP_TOKEN_ESTIMATE_BYTES;
  const symbolBytes = maxTokens === undefined ? QUERY_SYMBOL_CONTENT_BYTES : contentBytes;
  let remaining = contentBytes;
  let omitted = 0;
  const response = { ...result };
  for (const section of ['process_symbols', 'definitions']) {
    const rows = result[section];
    if (!Array.isArray(rows)) continue;
    response[section] = rows.map((row: unknown) => {
      if (
        row === null ||
        typeof row !== 'object' ||
        !('content' in row) ||
        typeof row.content !== 'string'
      ) {
        return row;
      }
      // Length is a cheap lower bound: don't serialize an entire file just to reject it.
      const limit = Math.min(symbolBytes, remaining);
      const bytes =
        row.content.length > limit ? Infinity : Buffer.byteLength(JSON.stringify(row.content));
      if (bytes <= limit) {
        remaining -= bytes;
        return row;
      }
      omitted++;
      const { content: _content, ...identity } = row;
      return { ...identity, content_omitted: true };
    });
  }
  if (omitted > 0) {
    response.content_budget = { max_bytes: contentBytes, max_symbol_bytes: symbolBytes, omitted };
  }
  // Keep the guidance inside JSON so persisted tool output can be parsed directly.
  response.next =
    hint.replace(/^\n\n---\n/, '') +
    (omitted > 0
      ? ' Source marked content_omitted is still available: use context({uid: "<id>", include_content: true}) for a symbol, or read_file with a bounded line range for large declarations and files. Keep the same repo.'
      : '');
  return JSON.stringify(response);
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
