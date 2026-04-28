import { describe, it, expect } from 'vitest';
import { LocalBackend } from '../../../src/mcp/local/local-backend.js';

/**
 * Smoke tests only. Full UID → BFS impact needs an indexed repo and LadybugDB
 * (see integration tests under test/integration/lbug-db project).
 */
describe('LocalBackend.impactByUid', () => {
  it('method exists on LocalBackend', () => {
    const backend = new LocalBackend();
    expect(typeof backend.impactByUid).toBe('function');
  });

  it('returns null when repo is unknown or graph lookup fails', async () => {
    const backend = new LocalBackend();
    await expect(
      backend.impactByUid('nonexistent-repo', 'fake-uid-123', 'upstream', {
        maxDepth: 3,
        relationTypes: ['CALLS', 'IMPORTS'],
        minConfidence: 0,
        includeTests: false,
      }),
    ).resolves.toBeNull();
  });
});
