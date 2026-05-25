import { describe, expect, it } from 'vitest';
import { streamAgentResponse, type AgentMessage } from '../../src/core/llm/agent';

describe('streamAgentResponse abort', () => {
  const userMessage: AgentMessage[] = [{ role: 'user', content: 'hello' }];

  it('yields cancelled when the LangGraph stream throws AbortError', async () => {
    const agent = {
      stream: async () => {
        throw new DOMException('The operation was aborted', 'AbortError');
      },
    };

    const chunks = [];
    for await (const chunk of streamAgentResponse(agent as any, userMessage, {
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ type: 'cancelled' }]);
  });

  it('yields cancelled when the abort signal is set mid-stream', async () => {
    const controller = new AbortController();
    const agent = {
      stream: async function* () {
        yield ['values', { messages: [] }];
        controller.abort();
        for (let i = 0; i < 100; i++) {
          yield ['messages', [{ _getType: () => 'ai', content: 'still going' }]];
        }
      },
    };

    const chunks = [];
    for await (const chunk of streamAgentResponse(agent as any, userMessage, {
      signal: controller.signal,
    })) {
      chunks.push(chunk);
      if (chunk.type === 'cancelled') break;
    }

    expect(chunks.some((c) => c.type === 'cancelled')).toBe(true);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
  });

  it('passes AbortSignal to agent.stream config', async () => {
    const controller = new AbortController();
    let capturedConfig: Record<string, unknown> | undefined;

    const agent = {
      stream: async (_input: unknown, config: Record<string, unknown>) => {
        capturedConfig = config;
        throw new DOMException('aborted', 'AbortError');
      },
    };

    for await (const _chunk of streamAgentResponse(agent as any, userMessage, {
      signal: controller.signal,
    })) {
      // drain
    }

    expect(capturedConfig?.signal).toBe(controller.signal);
  });

  it('does not treat unrelated errors mentioning abort as cancellation', async () => {
    const agent = {
      stream: async () => {
        throw new Error('Cannot abort the current transaction');
      },
    };

    const chunks = [];
    for await (const chunk of streamAgentResponse(agent as any, userMessage)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'error', error: 'Cannot abort the current transaction' },
    ]);
  });
});
