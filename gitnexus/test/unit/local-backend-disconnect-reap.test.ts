import { beforeEach, describe, expect, it, vi } from 'vitest';

const { closeLbugMock, reapEmbeddingSidecarMock } = vi.hoisted(() => ({
  closeLbugMock: vi.fn(),
  reapEmbeddingSidecarMock: vi.fn(),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  closeLbug: (...args: unknown[]) => closeLbugMock(...args),
}));

vi.mock('../../src/core/embeddings/embedding-sidecar-client.js', () => ({
  reapEmbeddingSidecar: () => reapEmbeddingSidecarMock(),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

describe('LocalBackend.disconnect sidecar reap', () => {
  beforeEach(() => {
    closeLbugMock.mockReset();
    reapEmbeddingSidecarMock.mockReset();
  });

  it('reaps the sidecar when closeLbug rejects', async () => {
    closeLbugMock.mockRejectedValue(new Error('ladybug close failed'));
    const backend = new LocalBackend();
    await expect(backend.disconnect()).rejects.toThrow('ladybug close failed');
    expect(reapEmbeddingSidecarMock).toHaveBeenCalled();
  });
});
