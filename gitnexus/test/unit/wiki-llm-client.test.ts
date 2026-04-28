import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the function we'll add in the next step
import {
  isAzureProvider,
  isReasoningModel,
  buildRequestUrl,
} from '../../src/core/wiki/llm-client.js';

describe('isAzureProvider', () => {
  it('returns true for .openai.azure.com URLs', () => {
    expect(isAzureProvider('https://myresource.openai.azure.com/openai/v1')).toBe(true);
  });

  it('returns true for .services.ai.azure.com URLs', () => {
    expect(isAzureProvider('https://myresource.services.ai.azure.com/openai/v1')).toBe(true);
  });

  it('returns false for openai.com', () => {
    expect(isAzureProvider('https://api.openai.com/v1')).toBe(false);
  });

  it('returns false for openrouter', () => {
    expect(isAzureProvider('https://openrouter.ai/api/v1')).toBe(false);
  });

  it('returns false for spoofed URLs containing azure hostname as subdomain', () => {
    expect(isAzureProvider('https://myresource.openai.azure.com.evil.com/v1')).toBe(false);
  });
});

describe('isReasoningModel', () => {
  it('detects o1 model', () => {
    expect(isReasoningModel('o1')).toBe(true);
    expect(isReasoningModel('o1-mini')).toBe(true);
  });

  it('detects o3 model', () => {
    expect(isReasoningModel('o3')).toBe(true);
    expect(isReasoningModel('o3-mini')).toBe(true);
  });

  it('detects o4-mini', () => {
    expect(isReasoningModel('o4-mini')).toBe(true);
  });

  it('returns false for bare o4 (not a known reasoning model)', () => {
    expect(isReasoningModel('o4')).toBe(false);
  });

  it('returns false for gpt-4o', () => {
    expect(isReasoningModel('gpt-4o')).toBe(false);
  });

  it('returns false for minimax', () => {
    expect(isReasoningModel('minimax/minimax-m2.5')).toBe(false);
  });

  it('respects explicit override', () => {
    expect(isReasoningModel('my-azure-deployment', true)).toBe(true);
    expect(isReasoningModel('o1', false)).toBe(false);
  });
});

describe('buildRequestUrl', () => {
  it('appends /chat/completions to plain base URL', () => {
    expect(buildRequestUrl('https://api.openai.com/v1', undefined)).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('strips trailing slash before appending', () => {
    expect(buildRequestUrl('https://api.openai.com/v1/', undefined)).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('appends api-version query param when provided', () => {
    expect(
      buildRequestUrl('https://myres.openai.azure.com/openai/deployments/dep1', '2024-10-21'),
    ).toBe(
      'https://myres.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21',
    );
  });

  it('does not append api-version when undefined', () => {
    expect(buildRequestUrl('https://myres.openai.azure.com/openai/v1', undefined)).toBe(
      'https://myres.openai.azure.com/openai/v1/chat/completions',
    );
  });
});

describe('callLLM — auth header', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses Authorization: Bearer for non-Azure endpoints', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 100,
      temperature: 0,
    });

    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
    expect((init.headers as any)['api-key']).toBeUndefined();
  });

  it('uses api-key header for Azure endpoints', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'azure-key-123',
      baseUrl: 'https://myres.openai.azure.com/openai/deployments/my-dep',
      model: 'my-dep',
      maxTokens: 100,
      temperature: 0,
      provider: 'azure',
      apiVersion: '2024-10-21',
    });

    const [url, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toContain('?api-version=2024-10-21');
    expect((init.headers as any)['api-key']).toBe('azure-key-123');
    expect(init.headers['Authorization']).toBeUndefined();
  });

  it('auto-detects Azure from URL when no provider field set', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'azure-key-auto',
      baseUrl: 'https://myres.openai.azure.com/openai/v1',
      model: 'my-deployment',
      maxTokens: 100,
      temperature: 0,
      // no provider field — should auto-detect from URL
    });

    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect((init.headers as any)['api-key']).toBe('azure-key-auto');
    expect(init.headers['Authorization']).toBeUndefined();
  });
});

describe('callLLM — reasoning model params', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses max_completion_tokens and strips temperature for reasoning models', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'o3-mini',
      maxTokens: 500,
      temperature: 0,
    });

    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    const body = JSON.parse(init.body as string);
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('uses max_completion_tokens and temperature for non-reasoning models', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 500,
      temperature: 0.5,
    });

    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    const body = JSON.parse(init.body as string);
    expect(body.max_completion_tokens).toBe(500);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.5);
  });
});

describe('callLLM — Azure content_filter error', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws a clear error when Azure returns content_filter 400', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'content_filter', message: 'Prompt triggered policy' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'azure-key',
        baseUrl: 'https://myres.openai.azure.com/openai/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
        provider: 'azure',
      }),
    ).rejects.toThrow('content filter');
  });

  it('does not throw Azure content filter error for non-Azure providers', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"error": {"code": "content_filter", "message": "Filtered"}}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).rejects.toThrow('LLM API error (400)');
  });
});

describe('readSSEStream — content_filter handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws a clear error when finish_reason is content_filter', async () => {
    const streamContent = [
      'data: {"choices":[{"delta":{"content":"partial "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(streamContent));
        controller.close();
      },
    });

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');

    await expect(
      callLLM(
        'test',
        {
          apiKey: 'azure-key',
          baseUrl: 'https://myres.openai.azure.com/openai/v1',
          model: 'gpt-4o',
          maxTokens: 100,
          temperature: 0,
          provider: 'azure',
        },
        undefined,
        { onChunk: () => {} },
      ),
    ).rejects.toThrow('content filter');
  });
});
