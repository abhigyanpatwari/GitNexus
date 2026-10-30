import { afterEach, describe, expect, it, vi } from 'vitest';

import { callLLM, type LLMConfig } from '../../src/core/wiki/llm-client.js';

const config: LLMConfig = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  maxTokens: 16_384,
  temperature: 0,
};

function jsonResponse(choice: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [choice], usage: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(chunks: Array<{ content?: string; finish_reason: string | null }>): Response {
  const lines = chunks.map(
    ({ content, finish_reason }) =>
      `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {}, finish_reason }] })}\n\n`,
  );
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode([...lines, 'data: [DONE]\n\n'].join('')));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const LIMIT_ERROR =
  'LLM response stopped at the completion token limit (16384, finish_reason "length") and is incomplete.';

describe('callLLM — responses cut off by the completion limit', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a non-streaming answer that stopped at the limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          message: { content: '| col | col |\n| --- | -' },
          finish_reason: 'length',
        }),
      ),
    );

    await expect(callLLM('prompt', config)).rejects.toThrow(LIMIT_ERROR);
  });

  it('names the limit when reasoning used it all and no answer came back', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ message: { content: '' }, finish_reason: 'length' })),
    );

    await expect(callLLM('prompt', config)).rejects.toThrow(LIMIT_ERROR);
  });

  it('rejects a streamed answer that stopped at the limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          { content: '# Module\n\n| col | col |\n', finish_reason: null },
          { content: '| --- | -', finish_reason: 'length' },
        ]),
      ),
    );
    const onChunk = vi.fn();

    await expect(callLLM('prompt', config, undefined, { onChunk })).rejects.toThrow(LIMIT_ERROR);
    expect(onChunk).toHaveBeenCalled();
  });

  it('keeps answers that finished on their own', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ message: { content: 'done' }, finish_reason: 'stop' }),
        )
        .mockResolvedValueOnce(
          sseResponse([
            { content: 'do', finish_reason: null },
            { content: 'ne', finish_reason: 'stop' },
          ]),
        ),
    );

    await expect(callLLM('prompt', config)).resolves.toMatchObject({ content: 'done' });
    await expect(
      callLLM('prompt', config, undefined, { onChunk: () => {} }),
    ).resolves.toMatchObject({ content: 'done' });
  });
});
