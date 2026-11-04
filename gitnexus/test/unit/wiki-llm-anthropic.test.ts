/**
 * The 'anthropic' wiki provider talks to the Anthropic Messages API directly
 * (#3413): x-api-key auth, a top-level system prompt, max_tokens, and the
 * Messages streaming events, through the same SSE reader as the
 * OpenAI-compatible providers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  callLLM,
  type LLMConfig,
} from '../../src/core/wiki/llm-client.js';

const config: LLMConfig = {
  apiKey: 'sk-ant-test',
  baseUrl: ANTHROPIC_BASE_URL,
  model: ANTHROPIC_DEFAULT_MODEL,
  maxTokens: 4096,
  temperature: 0,
  provider: 'anthropic',
  maxAttempts: 1,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: unknown[]): Response {
  const text = events
    .map(
      (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split mid-event so the reader has to carry a partial line over.
        const cut = Math.floor(text.length / 2);
        controller.enqueue(encoder.encode(text.slice(0, cut)));
        controller.enqueue(encoder.encode(text.slice(cut)));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function stubFetch(response: Response) {
  const fetchSpy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function sentRequest(fetchSpy: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchSpy.mock.calls[0] as [
    string,
    RequestInit & { headers: Record<string, string> },
  ];
  return { url, headers: init.headers, body: JSON.parse(init.body as string) };
}

const messageStart = {
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
};
const textDelta = (index: number, text: string) => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'text_delta', text },
});
const messageDelta = (stopReason: string) => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason },
  usage: { output_tokens: 12 },
});

describe('resolveLLMConfig — anthropic provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function resolveWithEmptySavedConfig(overrides: Partial<LLMConfig>) {
    vi.spyOn(await import('../../src/storage/repo-manager.js'), 'loadCLIConfig').mockResolvedValue(
      {},
    );
    const { resolveLLMConfig } = await import('../../src/core/wiki/llm-client.js');
    return resolveLLMConfig(overrides);
  }

  it('defaults to the Anthropic endpoint, the default model and ANTHROPIC_API_KEY', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-env-key');
    vi.stubEnv('GITNEXUS_API_KEY', 'gitnexus-env-key');
    vi.stubEnv('GITNEXUS_LLM_BASE_URL', '');
    vi.stubEnv('GITNEXUS_MODEL', '');

    const resolved = await resolveWithEmptySavedConfig({ provider: 'anthropic' });

    expect(resolved).toMatchObject({
      provider: 'anthropic',
      apiKey: 'anthropic-env-key',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-opus-5-5',
    });
  });

  it('falls back to GITNEXUS_API_KEY but never to OPENAI_API_KEY', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'openai-env-key');
    vi.stubEnv('GITNEXUS_API_KEY', '');

    expect((await resolveWithEmptySavedConfig({ provider: 'anthropic' })).apiKey).toBe('');

    vi.stubEnv('GITNEXUS_API_KEY', 'gitnexus-env-key');
    expect((await resolveWithEmptySavedConfig({ provider: 'anthropic' })).apiKey).toBe(
      'gitnexus-env-key',
    );
  });
});

describe('callLLM — anthropic provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a Messages API request: x-api-key, version header, top-level system, max_tokens', async () => {
    const fetchSpy = stubFetch(
      jsonResponse({
        content: [{ type: 'text', text: '# Page' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    );

    await callLLM('Document this module', config, 'You write wiki pages.');

    const { url, headers, body } = sentRequest(fetchSpy);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(headers.Authorization).toBeUndefined();
    expect(body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 4096,
      system: 'You write wiki pages.',
      messages: [{ role: 'user', content: 'Document this module' }],
    });
  });

  it('honours a base URL override with a trailing slash', async () => {
    const fetchSpy = stubFetch(
      jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );

    await callLLM('p', { ...config, baseUrl: 'https://llm-proxy.example.com/anthropic/v1/' });

    expect(sentRequest(fetchSpy).url).toBe('https://llm-proxy.example.com/anthropic/v1/messages');
  });

  it('returns only the text blocks of a response that also carries thinking', async () => {
    stubFetch(
      jsonResponse({
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '# Module\n\n' },
          { type: 'text', text: 'Body.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 120, output_tokens: 45 },
      }),
    );

    await expect(callLLM('p', config)).resolves.toEqual({
      content: '# Module\n\nBody.',
      promptTokens: 120,
      completionTokens: 45,
    });
  });

  it('rejects a response cut off at max_tokens', async () => {
    stubFetch(
      jsonResponse({
        content: [{ type: 'text', text: '| a | b |\n| -' }],
        stop_reason: 'max_tokens',
      }),
    );

    await expect(callLLM('p', config)).rejects.toThrow(
      'LLM response stopped at the completion token limit (4096, stop_reason "max_tokens") and is incomplete.',
    );
  });

  it('rejects a refusal instead of writing it as a page', async () => {
    stubFetch(jsonResponse({ content: [], stop_reason: 'refusal' }));

    await expect(callLLM('p', config)).rejects.toThrow('stop_reason "refusal"');
  });

  it.each([false, true])('rejects context-window truncation (streaming: %s)', async (streaming) => {
    stubFetch(
      streaming
        ? sseResponse([
            messageStart,
            textDelta(0, 'Incomplete page'),
            messageDelta('model_context_window_exceeded'),
            { type: 'message_stop' },
          ])
        : jsonResponse({
            content: [{ type: 'text', text: 'Incomplete page' }],
            stop_reason: 'model_context_window_exceeded',
          }),
    );

    await expect(
      callLLM('p', config, undefined, { onChunk: streaming ? vi.fn() : undefined }),
    ).rejects.toThrow('stop_reason "model_context_window_exceeded"');
  });

  it('does not forward the API key or prompt to a redirect target', async () => {
    const receivedKeys: unknown[] = [];
    const target = createServer((request, response) => {
      receivedKeys.push(request.headers['x-api-key']);
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          content: [{ type: 'text', text: 'redirected' }],
          stop_reason: 'end_turn',
        }),
      );
    });
    const endpoint = createServer((request, response) => {
      request.resume();
      response.writeHead(307, {
        Location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/messages`,
      });
      response.end();
    });
    try {
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
      const result = await callLLM('private source code', {
        ...config,
        baseUrl: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`,
      }).catch((error: unknown) => error);

      expect(receivedKeys).toEqual([]);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('307');
    } finally {
      await Promise.all(
        [target, endpoint].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
    }
  });

  it('converts image parts and refuses video', async () => {
    const fetchSpy = stubFetch(
      jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );

    await callLLM(
      [
        { type: 'text', text: 'Describe these.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        { type: 'image_url', image_url: { url: 'https://example.com/diagram.png' } },
      ],
      config,
    );

    expect(sentRequest(fetchSpy).body.messages[0].content).toEqual([
      { type: 'text', text: 'Describe these.' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      },
      { type: 'image', source: { type: 'url', url: 'https://example.com/diagram.png' } },
    ]);

    await expect(
      callLLM([{ type: 'video_url', video_url: { url: 'https://example.com/demo.mp4' } }], config),
    ).rejects.toThrow('does not accept video input');
    await expect(
      callLLM(
        [{ type: 'image_url', image_url: { url: 'http://example.com/diagram.png' } }],
        config,
      ),
    ).rejects.toThrow('accepts images as https:// URLs');
  });
});

describe('callLLM — anthropic streaming', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])(
    'rejects EOF without message_stop (stop reason received: %s)',
    async (hasStopReason) => {
      stubFetch(
        sseResponse([
          messageStart,
          textDelta(0, 'Incomplete page'),
          ...(hasStopReason ? [messageDelta('end_turn')] : []),
        ]),
      );

      await expect(callLLM('p', config, undefined, { onChunk: vi.fn() })).rejects.toThrow(
        'message_stop',
      );
    },
  );

  it('cancels and unlocks a response when a stream error interrupts reading', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
          ),
        );
      },
      cancel,
    });
    stubFetch(new Response(body));

    await expect(callLLM('p', config, undefined, { onChunk: vi.fn() })).rejects.toThrow(
      'Overloaded',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('accepts SSE data fields without optional whitespace', async () => {
    const events = [
      messageStart,
      textDelta(0, 'Complete page'),
      messageDelta('end_turn'),
      { type: 'message_stop' },
    ];
    stubFetch(
      new Response(events.map((event) => `data:${JSON.stringify(event)}\r\n\r\n`).join('')),
    );

    await expect(callLLM('p', config, undefined, { onChunk: vi.fn() })).resolves.toEqual({
      content: 'Complete page',
    });
  });

  it('finishes at message_stop without waiting for the server to close the connection', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const events = [
          textDelta(0, 'Complete page'),
          messageDelta('end_turn'),
          { type: 'message_stop' },
        ];
        controller.enqueue(
          new TextEncoder().encode(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          ),
        );
      },
      cancel,
    });
    stubFetch(new Response(body));

    await expect(callLLM('p', config, undefined, { onChunk: vi.fn() })).resolves.toEqual({
      content: 'Complete page',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  }, 1000);

  it('streams the text deltas and skips thinking deltas', async () => {
    const fetchSpy = stubFetch(
      sseResponse([
        messageStart,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'plan' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'ping' },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        textDelta(1, '# Module'),
        textDelta(1, '\n\nBody.'),
        { type: 'content_block_stop', index: 1 },
        messageDelta('end_turn'),
        { type: 'message_stop' },
      ]),
    );
    const progress: number[] = [];

    const result = await callLLM('p', config, undefined, { onChunk: (n) => progress.push(n) });

    expect(result.content).toBe('# Module\n\nBody.');
    expect(progress).toEqual([8, 15]);
    expect(sentRequest(fetchSpy).body.stream).toBe(true);
  });

  it('rejects a stream that stops at max_tokens', async () => {
    stubFetch(
      sseResponse([messageStart, textDelta(0, '| a | b |\n| -'), messageDelta('max_tokens')]),
    );

    await expect(callLLM('p', config, undefined, { onChunk: () => {} })).rejects.toThrow(
      'stop_reason "max_tokens"',
    );
  });

  it('rejects a stream that ends in a refusal', async () => {
    stubFetch(sseResponse([messageStart, messageDelta('refusal')]));

    await expect(callLLM('p', config, undefined, { onChunk: () => {} })).rejects.toThrow(
      'stop_reason "refusal"',
    );
  });

  it('surfaces an error event sent mid-stream', async () => {
    stubFetch(
      sseResponse([
        messageStart,
        textDelta(0, 'partial'),
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ]),
    );

    await expect(callLLM('p', config, undefined, { onChunk: () => {} })).rejects.toThrow(
      'LLM API error mid-stream: overloaded_error: Overloaded',
    );
  });
});
