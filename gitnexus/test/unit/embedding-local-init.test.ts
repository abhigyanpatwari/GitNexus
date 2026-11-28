import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pipeline, warn, cudaAvailable } = vi.hoisted(() => ({
  pipeline: vi.fn(),
  warn: vi.fn(),
  cudaAvailable: vi.fn(() => false),
}));

vi.mock('@huggingface/transformers', () => ({ pipeline, env: {} }));
vi.mock('../../src/core/embeddings/runtime-support.js', () => ({
  getLocalEmbeddingRuntimeBlocker: () => null,
  getMissingLocalEmbeddingStackMessage: () => null,
}));
vi.mock('../../src/core/embeddings/runtime-install.js', () => ({
  ensureEmbeddingStackResolvable: vi.fn(),
}));
vi.mock('../../src/core/embeddings/onnxruntime-common-resolver.js', () => ({
  ensureOnnxRuntimeCommonResolvable: vi.fn(),
}));
vi.mock('../../src/core/embeddings/onnxruntime-node-resolver.js', () => ({
  ensureOnnxRuntimeNodeMatchesSystem: vi.fn(),
  isEffectiveCudaAvailable: cudaAvailable,
}));
vi.mock('../../src/core/embeddings/hf-env.js', () => ({
  applyHfEnvOverrides: vi.fn(),
  isHfDownloadFailure: () => false,
  withHfDownloadRetry: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('../../src/core/embeddings/config.js', () => ({
  resolveEmbeddingConfig: (config: object) => ({
    modelId: 'test/model',
    dimensions: 3,
    threads: 2,
    device: 'auto',
    ...config,
  }),
}));
vi.mock('../../src/core/logger.js', () => ({ logger: { warn, info: vi.fn() } }));

const hostPlatform = process.platform;
const result = (data = [1, 0, 0, 0, 1, 0]) => ({ data: Float32Array.from(data), dims: [2, 3] });
const embedder = () =>
  Object.assign(vi.fn().mockResolvedValue(result()), {
    dispose: vi.fn().mockResolvedValue(undefined),
  });

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  cudaAvailable.mockReturnValue(false);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
});

describe('local DirectML initialization', () => {
  it('checks the same texts/options on both backends, retains DML and releases the CPU reference', async () => {
    const dml = embedder();
    const cpu = embedder();
    pipeline.mockResolvedValueOnce(dml).mockResolvedValueOnce(cpu);
    const local = await import('../../src/core/embeddings/embedding-local-init.js');
    await expect(local.initLocalEmbedder(undefined, {}, 'dml')).resolves.toBe(dml);
    expect(local.getCurrentDevice()).toBe('dml');
    expect(cpu.mock.calls[0]).toEqual(dml.mock.calls[0]);
    expect(cpu.mock.calls[0][1]).toEqual({ pooling: 'mean', normalize: true });
    expect(pipeline.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ device: 'dml', dtype: 'fp32' }),
      expect.objectContaining({ device: 'cpu', dtype: 'fp32' }),
    ]);
    expect(cpu.dispose).toHaveBeenCalledOnce();
    expect(dml.dispose).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['different vectors', 'non-finite vectors', 'inference error'])(
    'warns and reuses the CPU reference after %s',
    async (failure) => {
      const dml = embedder();
      const cpu = embedder();
      if (failure === 'inference error')
        dml.mockRejectedValueOnce(new Error('DML execution failed'));
      else
        dml.mockResolvedValueOnce(
          result(failure === 'different vectors' ? [0, 0, 1, 0, 0, 1] : [NaN, 0, 0, 0, 1, 0]),
        );
      pipeline.mockResolvedValueOnce(dml).mockResolvedValueOnce(cpu);
      const onWarning = vi.fn();
      const local = await import('../../src/core/embeddings/embedding-local-init.js');
      await expect(local.initLocalEmbedder(undefined, {}, 'dml', onWarning)).resolves.toBe(cpu);
      expect(local.getCurrentDevice()).toBe('cpu');
      expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('falling back to CPU'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('DirectML embedding validation failed'),
      );
      expect(dml.dispose).toHaveBeenCalledOnce();
      expect(cpu.dispose).not.toHaveBeenCalled();
      expect(pipeline).toHaveBeenCalledTimes(2);
      await local.localEmbedBatch(['real code']);
      expect(cpu).toHaveBeenLastCalledWith(['real code'], { pooling: 'mean', normalize: true });
      await expect(local.initLocalEmbedder()).resolves.toBe(cpu);
      expect(pipeline).toHaveBeenCalledTimes(2);
    },
  );

  it('falls back without retaining the DML session when a CPU reference cannot load', async () => {
    const dml = embedder();
    const cpu = embedder();
    pipeline
      .mockResolvedValueOnce(dml)
      .mockRejectedValueOnce(new Error('CPU init failed'))
      .mockResolvedValueOnce(cpu);
    const local = await import('../../src/core/embeddings/embedding-local-init.js');
    await expect(local.initLocalEmbedder(undefined, {}, 'dml')).resolves.toBe(cpu);
    expect(local.getCurrentDevice()).toBe('cpu');
    expect(dml.dispose).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CPU reference probe'));
  });

  it('validates automatically selected DirectML on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const dml = embedder();
    const cpu = embedder();
    pipeline.mockResolvedValueOnce(dml).mockResolvedValueOnce(cpu);
    const local = await import('../../src/core/embeddings/embedding-local-init.js');
    await local.initLocalEmbedder();
    expect(pipeline.mock.calls[0][2].device).toBe('dml');
    expect(cpu).toHaveBeenCalledOnce();
  });

  it('does not publish the candidate while a shared initialization is still validating', async () => {
    const dml = embedder();
    const cpu = embedder();
    let finishProbe!: (value: ReturnType<typeof result>) => void;
    cpu.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    pipeline.mockResolvedValueOnce(dml).mockResolvedValueOnce(cpu);
    const local = await import('../../src/core/embeddings/embedding-local-init.js');
    const first = local.initLocalEmbedder(undefined, {}, 'dml');
    const second = local.initLocalEmbedder(undefined, {}, 'dml');
    await vi.waitFor(() => expect(cpu).toHaveBeenCalledOnce());
    expect(local.getCurrentDevice()).toBeNull();
    await expect(local.localEmbedBatch(['not ready'])).rejects.toThrow('not initialized');
    finishProbe(result());
    await expect(first).resolves.toBe(dml);
    await expect(second).resolves.toBe(dml);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('disposes both probe sessions if CPU inference fails before retrying CPU initialization', async () => {
    const dml = embedder();
    const cpuReference = embedder();
    const fallback = embedder();
    cpuReference.mockRejectedValueOnce(new Error('CPU inference failed'));
    pipeline
      .mockResolvedValueOnce(dml)
      .mockResolvedValueOnce(cpuReference)
      .mockResolvedValueOnce(fallback);
    const local = await import('../../src/core/embeddings/embedding-local-init.js');
    await expect(local.initLocalEmbedder(undefined, {}, 'dml')).resolves.toBe(fallback);
    expect(dml.dispose).toHaveBeenCalledOnce();
    expect(cpuReference.dispose).toHaveBeenCalledOnce();
    expect(fallback.dispose).not.toHaveBeenCalled();
  });

  it('falls back to the CPU reference when CUDA disagrees', async () => {
    const gpu = embedder().mockResolvedValue(result([0, 0, 1, 0, 0, 1]));
    const cpu = embedder();
    pipeline.mockResolvedValueOnce(gpu).mockResolvedValueOnce(cpu);
    const local = await import('../../src/core/embeddings/embedding-local-init.js');
    await expect(local.initLocalEmbedder(undefined, {}, 'cuda')).resolves.toBe(cpu);
    expect(local.getCurrentDevice()).toBe('cpu');
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CUDA embedding validation failed'));
  });

  it('keeps CUDA with a warning when the CPU reference is unavailable', async () => {
    const gpu = embedder();
    pipeline.mockResolvedValueOnce(gpu).mockRejectedValueOnce(new Error('CPU unavailable'));
    const local = await import('../../src/core/embeddings/embedding-local-init.js');
    await expect(local.initLocalEmbedder(undefined, {}, 'cuda')).resolves.toBe(gpu);
    expect(local.getCurrentDevice()).toBe('cuda');
    expect(gpu.dispose).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('keeping CUDA'));
  });

  it.each(['cpu', 'wasm'] as const)('does not add CPU reference work for %s', async (device) => {
    const selected = embedder();
    pipeline.mockResolvedValueOnce(selected);
    const local = await import('../../src/core/embeddings/embedding-local-init.js');
    await expect(local.initLocalEmbedder(undefined, {}, device)).resolves.toBe(selected);
    expect(local.getCurrentDevice()).toBe(device);
    expect(pipeline).toHaveBeenCalledOnce();
    expect(selected).not.toHaveBeenCalled();
    expect(selected.dispose).not.toHaveBeenCalled();
  });
});
