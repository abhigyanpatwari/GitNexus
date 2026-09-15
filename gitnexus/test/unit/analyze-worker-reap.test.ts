import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reapEmbeddingSidecarMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/embeddings/embedding-sidecar-client.js', () => ({
  reapEmbeddingSidecar: () => reapEmbeddingSidecarMock(),
}));

describe('analyze-worker exitReapingSidecar', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reapEmbeddingSidecarMock.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('reaps the sidecar before process.exit on cancel-before-start', async () => {
    await import('../../src/server/analyze-worker.js');
    process.emit('message', { type: 'cancel' });
    await vi.waitFor(() => {
      expect(reapEmbeddingSidecarMock).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
    const reapOrder = reapEmbeddingSidecarMock.mock.invocationCallOrder[0];
    const exitOrder = exitSpy.mock.invocationCallOrder[0];
    expect(reapOrder).toBeLessThan(exitOrder);
  });
});
