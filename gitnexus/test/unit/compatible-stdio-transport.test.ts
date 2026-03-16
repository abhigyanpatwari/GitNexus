import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompatibleStdioServerTransport } from '../../src/mcp/compatible-stdio-transport.js';

function onceMessage(transport: CompatibleStdioServerTransport): Promise<any> {
  return new Promise((resolve, reject) => {
    transport.onmessage = (message) => resolve(message);
    transport.onerror = (error) => reject(error);
  });
}

describe('CompatibleStdioServerTransport', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let transport: CompatibleStdioServerTransport;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    transport = new CompatibleStdioServerTransport(stdin, stdout);
  });

  it('parses Content-Length framed initialize requests', async () => {
    await transport.start();
    const messagePromise = onceMessage(transport);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0.1' },
      },
    });

    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);

    await expect(messagePromise).resolves.toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'codex' } },
    });
  });

  it('parses newline-delimited initialize requests', async () => {
    await transport.start();
    const messagePromise = onceMessage(transport);
    stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '0.1' },
      },
    })}\n`);

    await expect(messagePromise).resolves.toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'cursor' } },
    });
  });

  it('responds with Content-Length framing after Content-Length input', async () => {
    await transport.start();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex', version: '0.1' },
      },
    });

    const messagePromise = onceMessage(transport);
    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\n\n${body}`);
    await messagePromise;

    const chunks: Buffer[] = [];
    stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const raw = Buffer.concat(chunks).toString('utf8');

    expect(raw).toMatch(/^Content-Length: \d+\r\n\r\n/);
    expect(raw).toContain('"ok":true');
  });



  it('reports malformed Content-Length headers once without looping forever', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    stdin.write('Content-Length:\r\n\r\n{}');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('recovers after discarding a malformed Content-Length frame', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    stdin.write('Content-Length:\r\n\r\n{}');
    await new Promise((resolve) => setTimeout(resolve, 25));

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'recovery-client', version: '0.1' },
      },
    });
    const messagePromise = onceMessage(transport);
    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);

    await expect(messagePromise).resolves.toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'recovery-client' } },
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // ─── Security hardening regressions ──────────────────────────────

  it('rejects Content-Length values exceeding the buffer cap', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    // 20 MB — exceeds the 10 MB MAX_BUFFER_SIZE
    stdin.write('Content-Length: 20971520\r\n\r\n{}');
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]?.message).toMatch(/exceeds maximum/i);
  });

  it('errors when read buffer exceeds maximum size in newline mode', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    // Send a JSON-starting chunk (triggers newline mode) with no newline,
    // then keep appending until we exceed the 10 MB cap
    const chunkSize = 1024 * 1024; // 1 MB
    const chunk = Buffer.alloc(chunkSize, 0x61); // 'a' repeated
    // First byte must be '{' to trigger newline framing detection
    const first = Buffer.from('{' + 'a'.repeat(chunkSize - 1));
    stdin.write(first);

    for (let i = 0; i < 10; i++) {
      stdin.write(chunk);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(onError).toHaveBeenCalled();
    const hasMaxSizeError = onError.mock.calls.some(
      (call) => call[0] instanceof Error && /maximum size/i.test(call[0].message),
    );
    expect(hasMaxSizeError).toBe(true);
  });

  it('handles many consecutive empty lines without stack overflow', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    // First, seed the framing mode with a valid newline-delimited message
    const seed = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'seed', version: '0.1' },
      },
    });
    const seedPromise = onceMessage(transport);
    stdin.write(seed + '\n');
    await seedPromise;

    // Now send 15K empty lines followed by a real message — this would
    // stack-overflow with the old recursive readNewlineMessage
    const followup = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'notifications/initialized',
      params: {},
    });

    const messagePromise = onceMessage(transport);
    stdin.write('\n'.repeat(15_000) + followup + '\n');

    await expect(messagePromise).resolves.toMatchObject({
      method: 'notifications/initialized',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects send() after transport is closed', async () => {
    await transport.start();
    await transport.close();

    await expect(
      transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    ).rejects.toThrow(/closed/i);
  });

  it('does not detect content-length framing from short ambiguous prefix', async () => {
    await transport.start();
    const onError = vi.fn();
    transport.onerror = onError;

    // Write only "cont" — fewer than 14 bytes, should NOT trigger
    // content-length detection. Transport should wait for more data.
    stdin.write(Buffer.from('cont'));
    await new Promise((resolve) => setTimeout(resolve, 25));

    // No message and no error — transport is waiting for more data
    expect(onError).not.toHaveBeenCalled();
  });

  it('responds with newline framing after newline input', async () => {
    await transport.start();
    const messagePromise = onceMessage(transport);
    stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '0.1' },
      },
    })}\n`);
    await messagePromise;

    const chunks: Buffer[] = [];
    stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const raw = Buffer.concat(chunks).toString('utf8');

    expect(raw).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
  });
});
