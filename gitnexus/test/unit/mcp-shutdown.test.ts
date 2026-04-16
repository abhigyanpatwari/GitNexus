import { describe, expect, it } from 'vitest';
import { normalizeShutdownExitCode } from '../../src/mcp/server.js';

describe('normalizeShutdownExitCode', () => {
  it('preserves numeric exit codes', () => {
    expect(normalizeShutdownExitCode(1)).toBe(1);
  });

  it('maps signal names to zero for graceful shutdown', () => {
    expect(normalizeShutdownExitCode('SIGTERM')).toBe(0);
    expect(normalizeShutdownExitCode('SIGINT')).toBe(0);
    expect(normalizeShutdownExitCode(undefined)).toBe(0);
  });
});
