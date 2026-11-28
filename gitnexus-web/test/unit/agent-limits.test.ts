import { describe, expect, it, vi } from 'vitest';
import {
  streamAgentResponse,
  toRecursionLimit,
  extractMessageUsage,
} from '../../src/core/llm/agent';
import type { AgentStreamChunk } from '../../src/core/llm/types';

type MockAgent = Parameters<typeof streamAgentResponse>[0];

function makeAiChunk(opts: {
  id?: string;
  content?: string;
  usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  response_metadata?: Record<string, unknown>;
  tool_calls?: unknown[];
}) {
  return {
    _getType: () => 'ai',
    id: opts.id,
    content: opts.content ?? '',
    tool_calls: opts.tool_calls ?? [],
    usage_metadata: opts.usage_metadata,
    response_metadata: opts.response_metadata,
  };
}

describe('toRecursionLimit', () => {
  it('defaults to 17 for 8 iterations when omitted', () => {
    expect(toRecursionLimit()).toBe(17);
    expect(toRecursionLimit(undefined)).toBe(17);
    expect(toRecursionLimit(Number.NaN)).toBe(17);
  });

  it('maps iterations to 2 * iterations + 1 within [1, 50]', () => {
    expect(toRecursionLimit(1)).toBe(3);
    expect(toRecursionLimit(8)).toBe(17);
    expect(toRecursionLimit(20)).toBe(41);
    expect(toRecursionLimit(50)).toBe(101);
  });

  it('defaults non-positive values and clamps upper out-of-range values', () => {
    expect(toRecursionLimit(0)).toBe(17);
    expect(toRecursionLimit(-5)).toBe(17);
    expect(toRecursionLimit(200)).toBe(101);
  });
});

describe('extractMessageUsage', () => {
  it('extracts LangChain usage_metadata', () => {
    expect(
      extractMessageUsage({
        usage_metadata: { input_tokens: 120, output_tokens: 45, total_tokens: 165 },
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    });
  });

  it('extracts OpenAI-style response_metadata.tokenUsage', () => {
    expect(
      extractMessageUsage({
        response_metadata: {
          tokenUsage: { promptTokens: 80, completionTokens: 20 },
        },
      }),
    ).toEqual({
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
  });

  it('returns null when usage is absent or zero', () => {
    expect(extractMessageUsage(null)).toBeNull();
    expect(extractMessageUsage({})).toBeNull();
    expect(
      extractMessageUsage({
        usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      }),
    ).toBeNull();
  });
});

describe('streamAgentResponse limits and token tracking', () => {
  it('passes computed recursionLimit to agent.stream', async () => {
    let capturedConfig: Record<string, unknown> | undefined;
    const fakeAgent = {
      stream: vi.fn(async (_input: unknown, config: Record<string, unknown>) => {
        capturedConfig = config;
        return (async function* () {
          yield ['messages', [makeAiChunk({ id: 'ai-1', content: 'hi' }), {}]];
        })();
      }),
    } as unknown as MockAgent;

    const chunks: AgentStreamChunk[] = [];
    for await (const chunk of streamAgentResponse(fakeAgent, [{ role: 'user', content: 'hello' }], {
      maxIterations: 12,
    })) {
      chunks.push(chunk);
    }

    expect(capturedConfig?.recursionLimit).toBe(25);
    expect(chunks.at(-1)).toEqual({ type: 'done', historyMessages: undefined });
  });

  it('deduplicates usage between messages and values snapshots and sums across turns', async () => {
    const fakeAgent = {
      stream: vi.fn(async () => {
        return (async function* () {
          yield [
            'messages',
            [
              makeAiChunk({
                id: 'ai-1',
                content: 'Thinking...',
                usage_metadata: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
              }),
              {},
            ],
          ];
          yield [
            'messages',
            [
              makeAiChunk({
                id: 'ai-1',
                content: '',
                usage_metadata: { input_tokens: 100, output_tokens: 25, total_tokens: 125 },
              }),
              {},
            ],
          ];
          yield [
            'values',
            {
              messages: [
                { _getType: () => 'human', content: 'hello' },
                makeAiChunk({
                  id: 'ai-1',
                  content: 'Thinking...',
                  usage_metadata: { input_tokens: 100, output_tokens: 25, total_tokens: 125 },
                }),
              ],
            },
          ];
          yield [
            'messages',
            [
              makeAiChunk({
                id: 'ai-2',
                content: 'Answer',
                usage_metadata: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
              }),
              {},
            ],
          ];
        })();
      }),
    } as unknown as MockAgent;

    const chunks: AgentStreamChunk[] = [];
    for await (const chunk of streamAgentResponse(fakeAgent, [
      { role: 'user', content: 'hello' },
    ])) {
      chunks.push(chunk);
    }

    const doneChunk = chunks.find((c) => c.type === 'done');
    expect(doneChunk).toEqual({
      type: 'done',
      historyMessages: undefined,
      usage: {
        inputTokens: 140,
        outputTokens: 45,
        totalTokens: 185,
      },
    });
  });

  it('gracefully halts and yields budget_exceeded when cumulative tokens exceed tokenBudget', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fakeAgent = {
      stream: vi.fn(async (_input: unknown, config: { signal?: AbortSignal }) => {
        capturedSignal = config.signal;
        return (async function* () {
          yield [
            'messages',
            [
              makeAiChunk({
                id: 'ai-1',
                content: 'step 1',
                usage_metadata: { input_tokens: 80, output_tokens: 30, total_tokens: 110 },
              }),
              {},
            ],
          ];
          yield [
            'messages',
            [
              makeAiChunk({
                id: 'ai-2',
                content: 'step 2',
                usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
              }),
              {},
            ],
          ];
          yield ['messages', [makeAiChunk({ id: 'ai-3', content: 'should not be yielded' }), {}]];
        })();
      }),
    } as unknown as MockAgent;

    const userController = new AbortController();
    const chunks: AgentStreamChunk[] = [];
    for await (const chunk of streamAgentResponse(
      fakeAgent,
      [{ role: 'user', content: 'explain architecture' }],
      { signal: userController.signal, tokenBudget: 200 },
    )) {
      chunks.push(chunk);
    }

    expect(capturedSignal?.aborted).toBe(true);
    expect(userController.signal.aborted).toBe(false);
    expect(chunks.some((c) => c.type === 'cancelled')).toBe(false);
    expect(chunks.at(-1)).toEqual({
      type: 'budget_exceeded',
      reason: 'token_budget',
      limit: 200,
      usage: {
        inputTokens: 180,
        outputTokens: 80,
        totalTokens: 260,
      },
    });
  });

  it('yields cancelled instead of budget_exceeded when user aborts during a budgeted run', async () => {
    const userController = new AbortController();
    const fakeAgent = {
      stream: vi.fn(async (_input: unknown, config: { signal?: AbortSignal }) => {
        return (async function* () {
          yield [
            'messages',
            [
              makeAiChunk({
                id: 'ai-1',
                content: 'partial',
                usage_metadata: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
              }),
              {},
            ],
          ];
          userController.abort();
          if (config.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
        })();
      }),
    } as unknown as MockAgent;

    const chunks: AgentStreamChunk[] = [];
    for await (const chunk of streamAgentResponse(fakeAgent, [{ role: 'user', content: 'hello' }], {
      signal: userController.signal,
      tokenBudget: 500,
    })) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toEqual({ type: 'cancelled' });
  });

  it('yields budget_exceeded when LangGraph throws recursion limit error', async () => {
    const fakeAgent = {
      stream: vi.fn(async () => {
        return (async function* () {
          yield [
            'messages',
            [
              makeAiChunk({
                id: 'ai-1',
                content: 'searching',
                usage_metadata: { input_tokens: 90, output_tokens: 30, total_tokens: 120 },
              }),
              {},
            ],
          ];
          const err = new Error('Recursion limit of 17 reached without hitting a stop condition');
          Object.assign(err, { lc_error_code: 'GRAPH_RECURSION_LIMIT' });
          throw err;
        })();
      }),
    } as unknown as MockAgent;

    const chunks: AgentStreamChunk[] = [];
    for await (const chunk of streamAgentResponse(
      fakeAgent,
      [{ role: 'user', content: 'deep trace' }],
      { maxIterations: 8 },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toEqual({
      type: 'budget_exceeded',
      reason: 'max_iterations',
      limit: 8,
      usage: {
        inputTokens: 90,
        outputTokens: 30,
        totalTokens: 120,
      },
    });
  });

  it('completes without stopping and flags usageUnavailable when a budgeted stream emits text with no usage metadata', async () => {
    const fakeAgent = {
      stream: vi.fn(async () => {
        return (async function* () {
          yield [
            'messages',
            [
              makeAiChunk({
                id: 'ai-1',
                content: 'Response without provider token metadata',
              }),
              {},
            ],
          ];
          yield [
            'values',
            {
              messages: [
                { _getType: () => 'human', content: 'explain architecture' },
                makeAiChunk({
                  id: 'ai-1',
                  content: 'Response without provider token metadata',
                }),
              ],
            },
          ];
        })();
      }),
    } as unknown as MockAgent;

    const userController = new AbortController();
    const chunks: AgentStreamChunk[] = [];
    for await (const chunk of streamAgentResponse(
      fakeAgent,
      [{ role: 'user', content: 'explain architecture' }],
      { signal: userController.signal, tokenBudget: 50 },
    )) {
      chunks.push(chunk);
    }

    expect(userController.signal.aborted).toBe(false);
    expect(chunks).toEqual([
      { type: 'reasoning', reasoning: 'Response without provider token metadata' },
      { type: 'done', historyMessages: undefined, usageUnavailable: true },
    ]);
  });
});
