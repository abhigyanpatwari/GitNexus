/**
 * MCP server end-to-end startup test.
 *
 * Spawns `node dist/cli/index.js mcp` as a child process, drives the MCP
 * stdio handshake (initialize → initialized → tools/list), and asserts:
 *
 *   - The first JSON-RPC frame arrives within a CI-friendly time budget.
 *   - Every byte the server writes to stdout reassembles into a valid
 *     Content-Length-framed JSON-RPC message — any stray byte fails the
 *     test and is surfaced in the assertion message.
 *   - tools/list reports the GitNexus tool set we expect.
 *
 * This locks in U1 (no stray console.log/warn in MCP-reachable code) and
 * U3 (AsyncLocalStorage stdout sentinel). A regression in either would
 * present as either a non-frame byte on stdout (fail-fast) or a missing
 * frame (timeout).
 *
 * Requires the built dist/. Use `npm run test:integration` (which runs
 * `npm run build` via the pretest:integration hook) or run after
 * `npm run build`.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');

const FIRST_FRAME_BUDGET_MS = process.env.CI ? 15_000 : 5_000;
const TOTAL_BUDGET_MS = process.env.CI ? 30_000 : 10_000;

interface SpawnedServer {
  proc: ChildProcessWithoutNullStreams;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  /** Resolves with the next JSON-RPC message parsed from stdout. */
  nextMessage: () => Promise<unknown>;
  /** Bytes received on stdout that did NOT belong to a frame body. */
  strayStdoutBytes: () => Buffer;
  send: (message: unknown) => void;
  close: () => Promise<void>;
}

/**
 * Spawn the built MCP server and provide a frame-aware reader.
 * The reader strictly parses Content-Length framing; any byte outside
 * a valid header→body window is captured as "stray" so the test can
 * assert the stream is clean.
 */
function spawnMcpServer(): SpawnedServer {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Avoid adding indexed repos noise to the test.
    GITNEXUS_HOME: path.join(REPO_ROOT, 'test', 'integration', 'mcp', '.tmp-home'),
    // Be deterministic across machines.
    NODE_OPTIONS: '',
  };

  const proc = spawn(process.execPath, [DIST_CLI, 'mcp'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stray: Buffer[] = [];
  const messageQueue: unknown[] = [];
  const waiters: Array<(msg: unknown) => void> = [];

  let buffer = Buffer.alloc(0);
  // Parser state machine for Content-Length framing.
  // 0 = expecting header, 1 = reading body of length `expected`.
  let state: 0 | 1 = 0;
  let expected = 0;

  const HEADER_END = Buffer.from('\r\n\r\n', 'utf8');

  function pushMessage(msg: unknown) {
    if (waiters.length > 0) {
      const w = waiters.shift()!;
      w(msg);
    } else {
      messageQueue.push(msg);
    }
  }

  function tryParse() {
    while (true) {
      if (state === 0) {
        const hdrEnd = buffer.indexOf(HEADER_END);
        if (hdrEnd === -1) return;
        const header = buffer.subarray(0, hdrEnd).toString('utf8');
        // Anything before the Content-Length: line (e.g. random bytes) is stray.
        // Strict: the header MUST start with "Content-Length:" (case-insensitive).
        const m = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
        if (!m) {
          stray.push(buffer.subarray(0, hdrEnd + HEADER_END.length));
          buffer = buffer.subarray(hdrEnd + HEADER_END.length);
          continue;
        }
        // If there's text between buffer start and the header line, it's stray
        // unless the entire header parsed cleanly with no preamble.
        const headerStart = header.search(/Content-Length:/i);
        if (headerStart > 0) {
          stray.push(buffer.subarray(0, headerStart));
          buffer = buffer.subarray(headerStart);
          continue;
        }
        expected = parseInt(m[1], 10);
        buffer = buffer.subarray(hdrEnd + HEADER_END.length);
        state = 1;
      }
      if (state === 1) {
        if (buffer.length < expected) return;
        const bodyBuf = buffer.subarray(0, expected);
        buffer = buffer.subarray(expected);
        state = 0;
        try {
          pushMessage(JSON.parse(bodyBuf.toString('utf8')));
        } catch (err) {
          // Body that doesn't parse as JSON is a fatal protocol error.
          stray.push(bodyBuf);
        }
      }
    }
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    buffer = Buffer.concat([buffer, chunk]);
    tryParse();
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  return {
    proc,
    stdoutChunks,
    stderrChunks,
    nextMessage: () =>
      new Promise<unknown>((resolve, reject) => {
        if (messageQueue.length > 0) {
          resolve(messageQueue.shift());
          return;
        }
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for JSON-RPC message. stderr so far:\n${Buffer.concat(stderrChunks).toString('utf8')}`,
            ),
          );
        }, TOTAL_BUDGET_MS);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      }),
    strayStdoutBytes: () => {
      // Include any leftover unparsed buffer.
      const tail = state === 0 ? buffer : Buffer.alloc(0);
      return Buffer.concat([...stray, tail]);
    },
    send: (message: unknown) => {
      const body = JSON.stringify(message);
      const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
      proc.stdin.write(frame);
    },
    close: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.stdin.end();
      // Give the server a moment to clean up; force-kill if it hangs.
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 2000);
        proc.on('close', () => {
          clearTimeout(killer);
          resolve();
        });
      });
    },
  };
}

describe('MCP server end-to-end startup', () => {
  it('preserves JSON-RPC stdout discipline through initialize + tools/list + tools/call', async () => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(
        `dist/cli/index.js missing — run \`npm run build\` first (or use \`npm run test:integration\` which builds via pretest:integration).`,
      );
    }

    const server = spawnMcpServer();
    try {
      // initialize handshake
      const startedAt = Date.now();
      server.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'gitnexus-startup-test', version: '0.0.0' },
        },
      });

      const initResponse = (await server.nextMessage()) as {
        jsonrpc: string;
        id: number;
        result?: { protocolVersion: string; serverInfo: { name: string } };
        error?: unknown;
      };
      const firstFrameAt = Date.now();

      expect(initResponse.jsonrpc).toBe('2.0');
      expect(initResponse.id).toBe(1);
      expect(initResponse.error).toBeUndefined();
      expect(initResponse.result).toBeDefined();
      expect(initResponse.result!.serverInfo.name).toMatch(/gitnexus/i);
      expect(firstFrameAt - startedAt).toBeLessThan(FIRST_FRAME_BUDGET_MS);

      // initialized notification (no response expected)
      server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // tools/list
      server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const toolsResponse = (await server.nextMessage()) as {
        jsonrpc: string;
        id: number;
        result?: { tools: Array<{ name: string }> };
      };

      expect(toolsResponse.id).toBe(2);
      expect(toolsResponse.result).toBeDefined();
      const toolNames = (toolsResponse.result!.tools ?? []).map((t) => t.name);
      // The published GitNexus tool set. Adjust if the surface changes.
      const expectedTools = [
        'list_repos',
        'query',
        'context',
        'impact',
        'detect_changes',
        'rename',
      ];
      for (const t of expectedTools) {
        expect(toolNames).toContain(t);
      }

      // tools/call list_repos — proves the paginated { repositories, pagination }
      // shape survives the real request → backend.callTool → JSON.stringify →
      // content[0].text serialization path (#2119), independent of repo count.
      server.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_repos', arguments: { limit: 5 } },
      });
      const callResponse = (await server.nextMessage()) as {
        id: number;
        result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      };
      expect(callResponse.id).toBe(3);
      expect(callResponse.result?.isError).not.toBe(true);
      const callText = callResponse.result!.content![0].text;
      // The server appends a non-JSON next-step hint after the JSON payload.
      // Extract the leading JSON object with a string-aware brace scan so a repo
      // path containing braces can never truncate the parse (more robust than
      // splitting on the hint's separator).
      const jsonStart = callText.indexOf('{');
      let depth = 0;
      let inStr = false;
      let esc = false;
      let jsonEnd = callText.length;
      for (let i = jsonStart; i < callText.length; i++) {
        const ch = callText[i];
        if (esc) {
          esc = false;
        } else if (ch === '\\') {
          esc = true;
        } else if (ch === '"') {
          inStr = !inStr;
        } else if (!inStr && ch === '{') {
          depth++;
        } else if (!inStr && ch === '}' && --depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
      const payload = JSON.parse(callText.slice(jsonStart, jsonEnd));
      expect(Array.isArray(payload.repositories)).toBe(true);
      expect(typeof payload.pagination.total).toBe('number');
      expect(payload.pagination.limit).toBe(5);
      expect(payload.pagination.offset).toBe(0);
      expect(payload.repositories.length).toBeLessThanOrEqual(5);

      // The headline assertion: every byte the server emitted on stdout
      // must reassemble into a valid JSON-RPC frame. Any leftover is a
      // protocol-corruption regression.
      const stray = server.strayStdoutBytes();
      if (stray.length > 0) {
        const stderr = Buffer.concat(server.stderrChunks).toString('utf8');
        throw new Error(
          `Stdout contained ${stray.length} bytes outside JSON-RPC framing — protocol corruption regression.\nStray bytes (utf8): ${JSON.stringify(stray.toString('utf8'))}\nStderr from server:\n${stderr}`,
        );
      }
    } finally {
      await server.close();
    }
  }, 60_000);
});

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('MCP lifecycle operation timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

const initializeMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gitnexus-lifecycle-test', version: '0.0.0' },
  },
};

describe('MCP stdio process lifecycle', () => {
  it.each(['before', 'after'] as const)('exits cleanly on EOF %s the handshake', async (when) => {
    const server = spawnMcpServer();
    try {
      if (when === 'after') {
        server.send(initializeMessage);
        expect(await server.nextMessage()).toMatchObject({ id: 1, result: {} });
      }
      const exited = once(server.proc, 'exit');
      server.proc.stdin.end();
      expect(await within(exited, TOTAL_BUDGET_MS)).toEqual([0, null]);
    } finally {
      await server.close();
    }
  });

  it('keeps a second MCP client usable when the first client disconnects', async () => {
    const first = spawnMcpServer();
    const second = spawnMcpServer();
    try {
      first.send(initializeMessage);
      second.send(initializeMessage);
      expect(await first.nextMessage()).toMatchObject({ id: 1, result: {} });
      expect(await second.nextMessage()).toMatchObject({ id: 1, result: {} });
      const firstExited = once(first.proc, 'exit');
      first.proc.stdin.end();
      expect(await within(firstExited, TOTAL_BUDGET_MS)).toEqual([0, null]);
      second.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
      expect(await second.nextMessage()).toMatchObject({ id: 2, result: {} });
    } finally {
      await first.close();
      await second.close();
    }
  });

  // A FIFO lets the client keep stdin open independently of the launching
  // parent. ChildProcess.stdin would close automatically when that parent dies,
  // accidentally testing EOF again. Windows has no mkfifo; unit tests cover its
  // unchanged-PPID / missing-parent liveness probe instead.
  it.skipIf(process.platform === 'win32')(
    'exits when its parent dies even if stdin stays open',
    async () => {
      const home = fs.mkdtempSync(path.join(tmpdir(), 'gitnexus-parent-exit-'));
      const fifo = path.join(home, 'stdin');
      execFileSync('mkfifo', [fifo]);
      const fd = fs.openSync(fifo, fs.constants.O_RDWR);
      const parent = spawn(
        process.execPath,
        [
          '-e',
          `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [process.argv[1], 'mcp'], { stdio: [0, 1, 2] });
      process.send({ pid: child.pid });
      setInterval(() => {}, 1000);
    `,
          DIST_CLI,
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, GITNEXUS_HOME: home, NODE_OPTIONS: '' },
          stdio: [fd, 'pipe', 'pipe', 'ipc'],
        },
      );
      let serverPid: number | undefined;
      let output = '';
      let errors = '';
      parent.stdout!.setEncoding('utf8');
      parent.stdout!.on('data', (chunk: string) => {
        output += chunk;
      });
      parent.stderr!.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      try {
        const [message] = await within(once(parent, 'message'), TOTAL_BUDGET_MS);
        serverPid = (message as { pid: number }).pid;
        fs.writeSync(fd, JSON.stringify(initializeMessage) + '\n');
        await expect.poll(() => output, { timeout: FIRST_FRAME_BUDGET_MS }).toContain('"id":1');
        expect(JSON.parse(output.trim())).toMatchObject({ id: 1, result: {} });

        // A live, idle parent must not be mistaken for a disconnected client.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        expect(parent.stdout!.readableEnded).toBe(false);
        output = '';
        fs.writeSync(fd, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
        await expect.poll(() => output, { timeout: FIRST_FRAME_BUDGET_MS }).toContain('"id":2');

        const parentExited = once(parent, 'exit');
        parent.kill('SIGKILL');
        await within(parentExited, TOTAL_BUDGET_MS);
        await expect
          .poll(() => parent.stdout!.readableEnded, { timeout: TOTAL_BUDGET_MS, message: errors })
          .toBe(true);
        expect(errors).not.toMatch(/uncaughtException|unhandledRejection/);
      } finally {
        if (!parent.stdout!.readableEnded && serverPid !== undefined) {
          try {
            process.kill(serverPid, 'SIGKILL');
          } catch {
            /* already exited */
          }
        }
        if (parent.exitCode === null && parent.signalCode === null) {
          const exited = once(parent, 'exit');
          parent.kill('SIGKILL');
          await within(exited, TOTAL_BUDGET_MS);
        }
        fs.closeSync(fd);
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
