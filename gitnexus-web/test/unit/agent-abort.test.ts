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
        // Simulate a long-running graph step after abort
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
});
