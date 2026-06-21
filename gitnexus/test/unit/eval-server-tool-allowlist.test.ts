// U8 — the eval-server only dispatches an allowlisted, read-only query surface
// over HTTP. LocalBackend.callTool can also reach write-side / heavier tools
// (rename, shape_check, tool_map, …); the allowlist keeps a stray
// `POST /tool/<name>` from reaching them through the Docker/eval-harness server.

import { describe, it, expect } from 'vitest';
import { EVAL_SERVER_TOOLS } from '../../src/cli/eval-server.js';

describe('EVAL_SERVER_TOOLS allowlist (U8)', () => {
  it('exposes exactly the advertised read-only query surface', () => {
    expect([...EVAL_SERVER_TOOLS].sort()).toEqual([
      'context',
      'cypher',
      'detect_changes',
      'impact',
      'list_repos',
      'query',
    ]);
  });

  it('does NOT expose write-side / unadvertised tools', () => {
    expect(EVAL_SERVER_TOOLS.has('rename')).toBe(false);
    expect(EVAL_SERVER_TOOLS.has('shape_check')).toBe(false);
    expect(EVAL_SERVER_TOOLS.has('tool_map')).toBe(false);
    expect(EVAL_SERVER_TOOLS.has('group_sync')).toBe(false);
    expect(EVAL_SERVER_TOOLS.has('api_impact')).toBe(false);
  });
});
