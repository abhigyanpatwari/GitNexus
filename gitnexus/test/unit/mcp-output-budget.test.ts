import { describe, expect, it } from 'vitest';
import {
  applyMcpMaxTokens,
  MCP_TRUNCATION_MARKER,
  resolveMcpMaxTokens,
  withoutMcpBudgetArg,
} from '../../src/mcp/output-budget.js';

describe('MCP output budget helpers', () => {
  it('returns the original string byte-for-byte without a configured budget', () => {
    const text = 'alpha😀omega';
    expect(applyMcpMaxTokens(text, undefined)).toBe(text);
  });

  it('uses the complete marker and stays within a one-token budget', () => {
    const text = applyMcpMaxTokens('this response is too long', 1);
    expect(text).toBe(MCP_TRUNCATION_MARKER);
    expect(Buffer.byteLength(text, 'utf8')).toBe(4);
  });

  it('never splits a multi-byte Unicode code point', () => {
    const text = applyMcpMaxTokens('😀😀😀😀', 3);
    expect(text.endsWith(MCP_TRUNCATION_MARKER)).toBe(true);
    expect(text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(12);
  });

  it('rejects malformed environment defaults for budgeted tools', () => {
    expect(() =>
      resolveMcpMaxTokens('query', undefined, {
        GITNEXUS_MCP_DEFAULT_MAX_TOKENS: '1.5',
      }),
    ).toThrow(/positive integer/i);
  });

  it('lets a valid explicit value override a malformed environment default', () => {
    expect(
      resolveMcpMaxTokens(
        'impact',
        { maxTokens: 17 },
        {
          GITNEXUS_MCP_DEFAULT_MAX_TOKENS: 'invalid',
        },
      ),
    ).toBe(17);
  });

  it('ignores the environment default for tools without output budgets', () => {
    expect(
      resolveMcpMaxTokens('cypher', undefined, {
        GITNEXUS_MCP_DEFAULT_MAX_TOKENS: 'invalid',
      }),
    ).toBeUndefined();
  });

  it('removes only the transport-level maxTokens argument', () => {
    const args = { search_query: 'auth', maxTokens: 20, repo: 'app' };
    expect(withoutMcpBudgetArg(args)).toEqual({ search_query: 'auth', repo: 'app' });
    expect(args).toEqual({ search_query: 'auth', maxTokens: 20, repo: 'app' });
  });
});
