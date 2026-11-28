import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { faultOf } from '../../src/core/fault-class.js';
import {
  assertMcpReadOnlyToolCall,
  resolveMcpReadOnlyMode,
} from '../../src/mcp/read-only-policy.js';
import {
  assertMcpRefreshToolCall,
  MCP_REFRESH_TOOL,
  resolveMcpRefreshLimits,
  resolveMcpRefreshMode,
} from '../../src/mcp/refresh-policy.js';
import { assertKnownMcpToolArguments } from '../../src/mcp/tool-arguments.js';
import { resolveMcpResponseFilter } from '../../src/mcp/response-filter.js';
import { resolveMcpMaxTokens } from '../../src/mcp/output-budget.js';
import { ImpactBudgetExceededError } from '../../src/mcp/impact-agent-output.js';
import { parseQueryRepositories } from '../../src/mcp/local/multi-repo-query.js';
import { LocalBackend, parseListReposPagination } from '../../src/mcp/local/local-backend.js';
import { createMcpRepositoryPolicy } from '../../src/mcp/repository-policy.js';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('client-input rejections carry the client fault class', () => {
  it('read-only policy rejections', () => {
    for (const [tool, args] of [
      ['rename', { dry_run: false }],
      ['refresh_index', {}],
      ['context', { repo: '@group' }],
      ['impact', { crossDepth: 2 }],
    ] as const) {
      const error = thrown(() => assertMcpReadOnlyToolCall(tool, args, true));
      expect(faultOf(error), tool).toBe('client');
    }
  });

  it('refresh gate rejection', () => {
    expect(faultOf(thrown(() => assertMcpRefreshToolCall(MCP_REFRESH_TOOL, false)))).toBe('client');
  });

  it('unknown tool argument', () => {
    const error = thrown(() => assertKnownMcpToolArguments('cypher', { query: 'x', bogus: 1 }));
    expect(faultOf(error)).toBe('client');
  });

  it('response filter rejections', () => {
    for (const args of [
      { response_sections: ['nope'] },
      { response_sections: ['incoming'], repo: '@group' },
      { response_sections: ['processes'], relationTypes: ['CALLS'] },
    ]) {
      expect(faultOf(thrown(() => resolveMcpResponseFilter('context', args)))).toBe('client');
    }
  });

  it('maxTokens argument, but not the environment default', () => {
    expect(faultOf(thrown(() => resolveMcpMaxTokens('impact', { maxTokens: 0 }, {})))).toBe(
      'client',
    );
    const envError = thrown(() =>
      resolveMcpMaxTokens('impact', {}, { GITNEXUS_MCP_DEFAULT_MAX_TOKENS: 'x' }),
    ) as Error;
    expect(envError.message).toBe('GITNEXUS_MCP_DEFAULT_MAX_TOKENS must be a positive integer.');
    expect(faultOf(envError)).toBeUndefined();
  });

  it('operator configuration errors stay unmarked', () => {
    expect(faultOf(thrown(() => resolveMcpReadOnlyMode({ GITNEXUS_MCP_READ_ONLY: 'x' })))).toBe(
      undefined,
    );
    expect(
      faultOf(thrown(() => resolveMcpRefreshMode({ GITNEXUS_MCP_ENABLE_REFRESH: 'x' }))),
    ).toBeUndefined();
    expect(
      faultOf(thrown(() => resolveMcpRefreshLimits({ GITNEXUS_MCP_REFRESH_MAX_FILES: '-1' }))),
    ).toBeUndefined();
  });

  it('an impact budget error is classified where its budget source is known', () => {
    // The tools/call handler marks it: client for the caller's maxTokens, server
    // for the operator default (see mcp-tool-fault-class.test.ts).
    expect(faultOf(new ImpactBudgetExceededError(1))).toBeUndefined();
  });

  it('multi-repository query selection', () => {
    expect(faultOf(thrown(() => parseQueryRepositories([])))).toBe('client');
    expect(faultOf(thrown(() => parseQueryRepositories(['@group'])))).toBe('client');
  });

  it('list_repos pagination', () => {
    const error = thrown(() =>
      parseListReposPagination({ limit: -1 }, { defaultLimit: 10, maxLimit: 100 }),
    );
    expect((error as Error).message).toContain('list_repos: "limit" must be an integer');
    expect(faultOf(error)).toBe('client');
  });
});

describe('repository policy rejections carry the client fault class', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-fault-policy-'));
    const entries = await Promise.all(
      ['alpha', 'beta'].map(async (name) => {
        const storagePath = path.join(home, name);
        await fs.mkdir(storagePath);
        await fs.writeFile(path.join(storagePath, 'lbug'), '');
        const repoPath = `/repos/${name}`;
        await fs.writeFile(
          path.join(storagePath, 'gitnexus.json'),
          JSON.stringify({ repoPath, storagePath }),
        );
        return {
          name,
          path: repoPath,
          storagePath,
          indexedAt: '2026-01-01',
          lastCommit: 'a'.repeat(40),
        };
      }),
    );
    await fs.writeFile(path.join(home, 'registry.json'), JSON.stringify(entries));
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => fs.rm(home, { recursive: true, force: true }));

  it('hidden repository, group routing, repo arrays and ambiguous defaults', async () => {
    vi.stubEnv('GITNEXUS_HOME', home);
    const backend = Object.assign(new LocalBackend(), {
      callTool: vi.fn().mockResolvedValue({}),
    });
    const single = (
      await createMcpRepositoryPolicy(backend, { GITNEXUS_MCP_ALLOWED_REPOS: 'alpha' })
    ).scopeBackend(backend);
    const both = (
      await createMcpRepositoryPolicy(backend, { GITNEXUS_MCP_ALLOWED_REPOS: 'alpha,beta' })
    ).scopeBackend(backend);

    for (const call of [
      single.callTool('context', { name: 'x', repo: 'beta' }),
      single.callTool('context', { name: 'x', repo: 7 }),
      single.callTool('context', { name: 'x', repo: '@group' }),
      single.callTool('context', { name: 'x', repo: ['alpha'] }),
      single.callTool('group_list', {}),
      both.callTool('context', { name: 'x' }),
    ]) {
      expect(faultOf(await rejected(call))).toBe('client');
    }
    expect(backend.callTool).not.toHaveBeenCalled();
  });
});
