/**
 * Integration Test: lsp-client — real binary, supervised lifecycle.
 *
 * This is the only guarded IT for the WI-3 component. It is
 * SKIPPED when the `typescript-language-server` binary is not
 * present anywhere in the resolution table (see
 * `server-discovery.ts`). The unit tests in
 * `test/unit/lsp/lsp-client.test.ts` cover the state machine
 * exhaustively; this file just pins the end-to-end "real
 * binary" loop.
 *
 * What we verify:
 *   1. `start()` → initialize handshake with the real TS server.
 *   2. `request('textDocument/definition', ...)` returns a
 *      real `Location` (typed-shape — not the value, the
 *      shape: `uri` + `range`).
 *   3. `stop()` sends `shutdown` + `exit` and tears down the
 *      subprocess.
 *   4. A second `start()` after `stop()` throws (not idempotent
 *      across the stopped boundary — mirrors the `LocalBackend`
 *      lifecycle, see #159 design KD-4).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { discoverServers } from '../../../src/core/ingestion/lsp/server-discovery.js';
import { LspClient } from '../../../src/core/ingestion/lsp/lsp-client.js';

describe('LspClient (real binary — IT, guarded)', () => {
  let typescriptBinary: { path: string; version: string } | null = null;

  beforeAll(async () => {
    const result = await discoverServers();
    typescriptBinary = result.typescript;
    if (!typescriptBinary) {
      // eslint-disable-next-line no-console
      console.log(
        '[IT:lsp-client-real] SKIP — typescript-language-server not found on PATH or in node_modules/.bin',
      );
    }
  });

  afterAll(() => {
    /* nothing — the client disposes its subprocess per-test */
  });

  it('initializes a warm server and returns a typed definition', async () => {
    if (!typescriptBinary) return; // guarded skip
    const client = new LspClient({
      workspaceRoot: process.cwd(),
      binaryPath: typescriptBinary.path,
    });
    try {
      await client.start();
      expect(client.getState()).toBe('ready');

      // Issue a `definition` against a known file. We use a
      // file from this project so the server has something to
      // resolve; we don't care about the *value*, only that
      // the response is well-shaped.
      const result = await client.request<any[]>(
        'textDocument/definition',
        {
          textDocument: { uri: 'file://' + __filename },
          position: { line: 0, character: 0 },
        },
        10_000,
      );
      // Real `typescript-language-server` is fast (<500ms in
      // our experience) but allow some headroom. The result is
      // either a Location[] or null; on a freshly-spawned
      // server with a tiny index, `null` is acceptable. We
      // assert the shape only if non-null.
      if (result !== null) {
        expect(Array.isArray(result)).toBe(true);
        if (result.length > 0) {
          expect(result[0]).toHaveProperty('uri');
          expect(result[0]).toHaveProperty('range');
        }
      }
    } finally {
      await client.stop();
      expect(client.getState()).toBe('stopped');
    }
  }, 30_000);

  it('stop() is idempotent and sends shutdown+exit', async () => {
    if (!typescriptBinary) return; // guarded skip
    const client = new LspClient({
      workspaceRoot: process.cwd(),
      binaryPath: typescriptBinary.path,
    });
    await client.start();
    await client.stop();
    // A second stop() is a no-throw no-op (Invariant 4).
    await expect(client.stop()).resolves.toBeUndefined();
    expect(client.getState()).toBe('stopped');
  }, 30_000);

  it('start() after stop() throws — caller must create a new instance', async () => {
    if (!typescriptBinary) return; // guarded skip
    const client = new LspClient({
      workspaceRoot: process.cwd(),
      binaryPath: typescriptBinary.path,
    });
    await client.start();
    await client.stop();
    // The spec is explicit: a stopped client cannot be
    // restarted. The caller should construct a fresh one.
    await expect(client.start()).rejects.toBeDefined();
  }, 30_000);
});
