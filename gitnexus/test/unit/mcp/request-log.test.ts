/**
 * Tests for the MCP request log (issue #1351 PoC).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveLogPath,
  appendRequestLog,
  instrumented,
  type RequestLogEntry,
} from '../../../src/mcp/request-log.js';

describe('resolveLogPath', () => {
  it('returns the configured absolute path when env var is set', () => {
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: '/tmp/custom.log' })).toBe('/tmp/custom.log');
  });

  it('returns null when env var disables logging', () => {
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: 'off' })).toBeNull();
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: 'OFF' })).toBeNull();
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: 'false' })).toBeNull();
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: '0' })).toBeNull();
  });

  it('returns null (disabled) when env var is unset or empty (opt-in default)', () => {
    expect(resolveLogPath({})).toBeNull();
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: '' })).toBeNull();
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: '   ' })).toBeNull();
  });

  it('returns the default log path for affirmative boolean values', () => {
    const expected = path.join(os.homedir(), '.gitnexus', 'mcp-requests.log');
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: 'on' })).toBe(expected);
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: 'ON' })).toBe(expected);
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: 'true' })).toBe(expected);
    expect(resolveLogPath({ GITNEXUS_MCP_REQUEST_LOG: '1' })).toBe(expected);
  });
});

describe('appendRequestLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-mcp-log-'));
    logPath = path.join(tmpDir, 'nested', 'requests.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends one JSONL entry and creates the parent directory', async () => {
    const entry: RequestLogEntry = {
      ts: '2026-05-10T18:00:00Z',
      tool: 'impact',
      durationMs: 42,
      resultBytes: 1234,
      error: null,
    };
    await appendRequestLog(entry, logPath);
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(entry);
  });

  it('appends multiple entries one per line', async () => {
    const base: RequestLogEntry = {
      ts: '2026-05-10T18:00:00Z',
      tool: 'query',
      durationMs: 10,
      resultBytes: 5,
      error: null,
    };
    await appendRequestLog(base, logPath);
    await appendRequestLog({ ...base, tool: 'context', durationMs: 20 }, logPath);
    await appendRequestLog({ ...base, tool: 'impact', error: 'boom' }, logPath);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).tool).toBe('query');
    expect(JSON.parse(lines[1]!).tool).toBe('context');
    expect(JSON.parse(lines[2]!).error).toBe('boom');
  });

  it('is a no-op when path is null (logging disabled)', async () => {
    await appendRequestLog(
      { ts: 't', tool: 'x', durationMs: 0, resultBytes: 0, error: null },
      null,
    );
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('does not throw when the destination is unwritable', async () => {
    // Use a path inside a non-existent root that mkdir can't create.
    await expect(
      appendRequestLog(
        { ts: 't', tool: 'x', durationMs: 0, resultBytes: 0, error: null },
        '/proc/0/nope/cannot-write.log',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('instrumented', () => {
  let tmpDir: string;
  let logPath: string;
  const prevEnv = process.env['GITNEXUS_MCP_REQUEST_LOG'];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-mcp-instrumented-'));
    logPath = path.join(tmpDir, 'requests.log');
    process.env['GITNEXUS_MCP_REQUEST_LOG'] = logPath;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env['GITNEXUS_MCP_REQUEST_LOG'];
    else process.env['GITNEXUS_MCP_REQUEST_LOG'] = prevEnv;
  });

  it('logs success calls with durationMs and resultBytes', async () => {
    const result = await instrumented('impact', async () => 'hello world');
    expect(result).toBe('hello world');

    // Logger writes are fire-and-forget — give the loop a tick.
    await new Promise((r) => setTimeout(r, 30));

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as RequestLogEntry;
    expect(entry.tool).toBe('impact');
    expect(entry.error).toBeNull();
    expect(entry.resultBytes).toBe(Buffer.byteLength('hello world'));
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('logs error calls with the message and rethrows', async () => {
    await expect(
      instrumented('cypher', async () => {
        throw new Error('parse error');
      }),
    ).rejects.toThrow('parse error');

    await new Promise((r) => setTimeout(r, 30));

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as RequestLogEntry;
    expect(entry.tool).toBe('cypher');
    expect(entry.error).toBe('parse error');
    expect(entry.resultBytes).toBe(0);
  });

  it('honours a custom resultBytesOf to size text-only payloads', async () => {
    type Envelope = { content: Array<{ text: string }> };
    const envelope: Envelope = { content: [{ text: 'just-this-bit' }] };
    await instrumented(
      'context',
      async () => envelope,
      (r) => Buffer.byteLength(r.content[0]!.text, 'utf8'),
    );

    await new Promise((r) => setTimeout(r, 30));

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]!) as RequestLogEntry;
    expect(entry.resultBytes).toBe(Buffer.byteLength('just-this-bit', 'utf8'));
  });

  it('is a no-op writer when env says off (still returns the result)', async () => {
    process.env['GITNEXUS_MCP_REQUEST_LOG'] = 'off';
    const result = await instrumented('impact', async () => 42);
    expect(result).toBe(42);
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
