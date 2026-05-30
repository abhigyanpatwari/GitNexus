/**
 * Unit Tests: CLI `impact` disambiguation flag wiring (#1907)
 *
 * The CLI `impact` command gained --uid / --file / --kind so that, when impact
 * reports an `ambiguous` target, users can follow the "disambiguate" guidance
 * straight from the terminal (previously only the MCP tool accepted these).
 * These tests pin that impactCommand forwards the flags to
 * callTool('impact', …) under the backend's parameter names
 * (target_uid / file_path / kind) — the same names the MCP impact tool uses.
 *
 * The LocalBackend is fully mocked: this isolates the CLI option → tool param
 * mapping from any graph/DB behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callTool, init } = vi.hoisted(() => ({
  callTool: vi.fn(),
  init: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = init;
    callTool = callTool;
  },
  // U4: impactCommand imports VALID_NODE_LABELS to soft-validate --kind.
  VALID_NODE_LABELS: new Set(['Function', 'Class', 'Interface', 'Method', 'Constructor']),
}));

// impactCommand prints its result via fs.writeSync(fd 1, …). Silence that so
// the assertion-only test does not write JSON to the runner's stdout. tool.ts
// uses only writeSync from node:fs, so a full mock is safe here (matches the
// pattern in tool-direct-cli.test.ts).
vi.mock('node:fs', () => ({
  writeSync: vi.fn(),
}));

import { impactCommand } from '../../src/cli/tool.js';

describe('CLI impact disambiguation flags (#1907)', () => {
  beforeEach(() => {
    callTool.mockReset();
    callTool.mockResolvedValue({ status: 'found', impactedCount: 0 });
  });

  it('forwards --uid/--file/--kind as target_uid/file_path/kind', async () => {
    await impactCommand('get_embeddings', {
      direction: 'upstream',
      uid: 'Function:isma/scripts/ingest_md_file.py:get_embeddings',
      file: 'isma/scripts/ingest_md_file.py',
      kind: 'Function',
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      'impact',
      expect.objectContaining({
        target: 'get_embeddings',
        target_uid: 'Function:isma/scripts/ingest_md_file.py:get_embeddings',
        file_path: 'isma/scripts/ingest_md_file.py',
        kind: 'Function',
        direction: 'upstream',
      }),
    );
  });

  it('leaves disambiguation params undefined when no flags are supplied', async () => {
    await impactCommand('AuthService', { direction: 'upstream' });

    expect(callTool).toHaveBeenCalledTimes(1);
    const params = callTool.mock.calls[0][1] as Record<string, unknown>;
    expect(params.target).toBe('AuthService');
    expect(params.target_uid).toBeUndefined();
    expect(params.file_path).toBeUndefined();
    expect(params.kind).toBeUndefined();
  });

  // U1 (#1914 review F1): impact's positional target is now optional, so a uid
  // alone resolves — parity with `context [name]`.
  it('resolves uid-only with no positional target (parity with context)', async () => {
    await impactCommand(undefined, {
      direction: 'upstream',
      uid: 'Function:src/auth.ts:login',
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    const params = callTool.mock.calls[0][1] as Record<string, unknown>;
    expect(params.target_uid).toBe('Function:src/auth.ts:login');
    expect(params.target).toBeUndefined();
  });

  it('errors when neither a target nor a uid is provided', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(impactCommand(undefined, {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(callTool).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('rejects a --prefixed uid value (a flag swallowed by Commander) without forwarding it', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(impactCommand(undefined, { uid: '--file' })).rejects.toThrow('process.exit');
    expect(callTool).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  // U4 (#1914 review F3): an unknown --kind warns to stderr but still resolves.
  it('warns on an unknown --kind but still forwards the request', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await impactCommand('login', { kind: 'Funktion', direction: 'upstream' });

    expect(callTool).toHaveBeenCalledTimes(1);
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).toContain('Funktion');
    expect(stderr).toContain('not a known symbol kind');

    stderrSpy.mockRestore();
  });

  it('does not warn for a known --kind', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await impactCommand('login', { kind: 'Function', direction: 'upstream' });

    expect(callTool).toHaveBeenCalledTimes(1);
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).not.toContain('not a known symbol kind');

    stderrSpy.mockRestore();
  });
});
