import { describe, it, expect, vi, afterEach } from 'vitest';

// Import the function we'll add in the next step
import {
  isAzureProvider,
  isReasoningModel,
  buildRequestUrl,
  validateLLMBaseUrl,
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

describe('callLLM — timeout handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not apply a default timeout when requestTimeoutMs is omitted', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 500,
      temperature: 0,
    });

    expect(timeoutSpy).not.toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeUndefined();
  });

  it('applies an explicit timeout when requestTimeoutMs is provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }], usage: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await callLLM('test', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      maxTokens: 500,
      temperature: 0,
      requestTimeoutMs: 120_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(timeoutSignal);
  });

  it('surfaces a clear timeout error when the request timeout fires', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 500,
        temperature: 0,
        requestTimeoutMs: 120_000,
      }),
    ).rejects.toThrow(
      'LLM request timed out after 120s. Increase --timeout or omit it to disable the request timeout.',
    );
  });

  it('surfaces millisecond timeout durations when the timeout is not a whole second', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 500,
        temperature: 0,
        requestTimeoutMs: 1_500,
      }),
    ).rejects.toThrow(
      'LLM request timed out after 1500ms. Increase --timeout or omit it to disable the request timeout.',
    );
  });

  it('surfaces the same timeout message for timeout-like non-DOM errors', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(new Error('request timed out while waiting for response'));
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 500,
        temperature: 0,
        requestTimeoutMs: 120_000,
      }),
    ).rejects.toThrow(
      'LLM request timed out after 120s. Increase --timeout or omit it to disable the request timeout.',
    );
  });

  it('does not mislabel generic aborted connections as request timeouts', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('connection aborted by server'));
    vi.stubGlobal('fetch', fetchSpy);

    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('test', {
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 500,
        temperature: 0,
        requestTimeoutMs: 120_000,
      }),
    ).rejects.toThrow('connection aborted by server');
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

describe('validateLLMBaseUrl', () => {
  it('allows https:// for any public host', () => {
    expect(() => validateLLMBaseUrl('https://api.openai.com/v1')).not.toThrow();
    expect(() => validateLLMBaseUrl('https://openrouter.ai/api/v1')).not.toThrow();
    expect(() => validateLLMBaseUrl('https://myres.openai.azure.com/openai/v1')).not.toThrow();
  });

  it('allows http:// for localhost', () => {
    expect(() => validateLLMBaseUrl('http://localhost:11434/v1')).not.toThrow();
    expect(() => validateLLMBaseUrl('http://127.0.0.1:11434/v1')).not.toThrow();
    // IPv6 loopback — Node's URL parser preserves brackets in hostname: "[::1]"
    expect(() => validateLLMBaseUrl('http://[::1]:11434/v1')).not.toThrow();
  });

  it('allows http:// for LOCALHOST (uppercase) — lowercased before comparison', () => {
    expect(() => validateLLMBaseUrl('http://LOCALHOST:11434/v1')).not.toThrow();
  });

  it('rejects http:// for non-loopback hosts', () => {
    expect(() => validateLLMBaseUrl('http://evil.example.com/v1')).toThrow('Insecure http://');
    expect(() => validateLLMBaseUrl('http://192.168.1.1/v1')).toThrow('Insecure http://');
    // Private IP ranges
    expect(() => validateLLMBaseUrl('http://10.0.0.1/v1')).toThrow('Insecure http://');
    // AWS/GCP IMDS — should be blocked
    expect(() => validateLLMBaseUrl('http://169.254.169.254/latest/meta-data')).toThrow(
      'Insecure http://',
    );
  });

  it('rejects http:// hostname-spoofing attempts', () => {
    // Full-hostname comparison prevents prefix/suffix attacks
    expect(() => validateLLMBaseUrl('http://localhost.evil.com/v1')).toThrow('Insecure http://');
    expect(() => validateLLMBaseUrl('http://127.0.0.1.evil.com/v1')).toThrow('Insecure http://');
    // Trailing dot — hostname 'localhost.' ≠ 'localhost'
    expect(() => validateLLMBaseUrl('http://localhost./v1')).toThrow('Insecure http://');
  });

  it('rejects http:// non-loopback IPv6 addresses', () => {
    // Link-local IPv6
    expect(() => validateLLMBaseUrl('http://[fe80::1]/v1')).toThrow('Insecure http://');
    // IPv4-mapped IPv6 loopback — bracket-stripped to '::ffff:127.0.0.1' ≠ '::1'
    expect(() => validateLLMBaseUrl('http://[::ffff:127.0.0.1]/v1')).toThrow('Insecure http://');
  });

  it('rejects non-http schemes', () => {
    expect(() => validateLLMBaseUrl('file:///etc/passwd')).toThrow('must use http:// or https://');
    expect(() => validateLLMBaseUrl('javascript:alert(1)')).toThrow('must use http:// or https://');
    expect(() => validateLLMBaseUrl('data:text/plain,evil')).toThrow(
      'must use http:// or https://',
    );
    expect(() => validateLLMBaseUrl('ftp://example.com')).toThrow('must use http:// or https://');
  });

  it('rejects malformed URLs', () => {
    expect(() => validateLLMBaseUrl('not-a-url')).toThrow('Invalid LLM base URL');
    expect(() => validateLLMBaseUrl('')).toThrow('Invalid LLM base URL');
  });

  it('does not include the raw URL in error messages (credential hygiene)', () => {
    // Simulates a URL with an embedded API key
    const urlWithCreds = 'http://192.168.1.1/v1?apikey=sk-secret';
    let msg = '';
    try {
      validateLLMBaseUrl(urlWithCreds);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('sk-secret');
    expect(msg).not.toContain(urlWithCreds);
  });

  it('callLLM rejects an invalid base URL before fetching', async () => {
    const { callLLM } = await import('../../src/core/wiki/llm-client.js');
    await expect(
      callLLM('prompt', {
        apiKey: 'key',
        baseUrl: 'file:///etc/passwd',
        model: 'gpt-4o',
        maxTokens: 100,
        temperature: 0,
      }),
    ).rejects.toThrow('must use http:// or https://');
  });
});
