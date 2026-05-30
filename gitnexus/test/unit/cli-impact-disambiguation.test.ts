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
});
