/**
 * Opt-in MCP index refresh (#3524).
 *
 * `refresh_index` is the one MCP tool that rebuilds an index. It is off unless
 * the operator starting a LOCAL server (`gitnexus mcp`, stdio or `--http`) sets
 * `GITNEXUS_MCP_ENABLE_REFRESH=1`. `gitnexus serve` never passes the flag to
 * `createMCPServer`, so the web/Docker `/api/mcp` surface cannot expose it
 * whatever its environment says. Read-only mode hides and rejects it through
 * the `MCP_READ_ONLY_TOOLS` allowlist, which it is deliberately not part of.
 */

export const MCP_REFRESH_TOOL = 'refresh_index';

/**
 * Repositories whose last index recorded more files than this are refused,
 * because a full rebuild can run for minutes (#3524 measured 377 s for 10,987
 * files). `0` removes the limit.
 */
export const MCP_REFRESH_DEFAULT_MAX_FILES = 5_000;
export const MCP_REFRESH_DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Node fires a longer `setTimeout` after 1 ms, so a larger value would cancel at once. */
const MAX_TIMER_MS = 2_147_483_647;

export function resolveMcpRefreshMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GITNEXUS_MCP_ENABLE_REFRESH?.trim();
  if (value === undefined || value === '' || value === '0') return false;
  if (value === '1') return true;
  throw new Error('GITNEXUS_MCP_ENABLE_REFRESH must be 0 or 1.');
}

function nonNegativeIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { allowZero, max }: { allowZero: boolean; max: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || value > max || (!allowZero && value === 0)) {
    throw new Error(
      `${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer no greater than ${max}; got "${raw}".`,
    );
  }
  return value;
}

export interface McpRefreshLimits {
  /** `0` means no limit. */
  maxFiles: number;
  timeoutMs: number;
}

export function resolveMcpRefreshLimits(env: NodeJS.ProcessEnv = process.env): McpRefreshLimits {
  return {
    maxFiles: nonNegativeIntegerEnv(
      env,
      'GITNEXUS_MCP_REFRESH_MAX_FILES',
      MCP_REFRESH_DEFAULT_MAX_FILES,
      { allowZero: true, max: Number.MAX_SAFE_INTEGER },
    ),
    timeoutMs: nonNegativeIntegerEnv(
      env,
      'GITNEXUS_MCP_REFRESH_TIMEOUT_MS',
      MCP_REFRESH_DEFAULT_TIMEOUT_MS,
      { allowZero: false, max: MAX_TIMER_MS },
    ),
  };
}

/**
 * Dispatch half of the gate. The server lists the tool only when enabled; this
 * keeps an unlisted tool from being called by name.
 */
export function assertMcpRefreshToolCall(toolName: string, refreshEnabled: boolean): void {
  if (toolName === MCP_REFRESH_TOOL && !refreshEnabled) {
    throw new Error(
      `Tool "${MCP_REFRESH_TOOL}" is disabled. Start the local MCP server with GITNEXUS_MCP_ENABLE_REFRESH=1 to enable it, or run \`gitnexus analyze\` in the repository.`,
    );
  }
}
