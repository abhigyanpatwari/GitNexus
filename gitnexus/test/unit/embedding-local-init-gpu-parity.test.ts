/**
 * #3685: a GPU embedding device must produce the same vectors as CPU, or init
 * falls back to CPU. transformers.js is mocked, so no ONNX runtime is loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakePipeline = ReturnType<typeof vi.fn> & { dispose: ReturnType<typeof vi.fn> };

const { state } = vi.hoisted(() => ({
  state: {
    vectors: {} as Record<string, number[]>,
    failDevice: null as string | null,
    created: [] as { device: string; pipe: unknown }[],
  },
}));

const makePipeline = (device: string): FakePipeline => {
  const pipe = vi.fn(async (texts: string[]) => {
    const vec = state.vectors[device];
    return {
      data: Float32Array.from(texts.flatMap(() => vec)),
      dims: [texts.length, vec.length],
    };
  }) as FakePipeline;
  pipe.dispose = vi.fn(async () => {});
  return pipe;
};

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async (_task: string, _model: string, opts: { device: string }) => {
    if (opts.device === state.failDevice) throw new Error(`cannot load ${opts.device}`);
    const pipe = makePipeline(opts.device);
    state.created.push({ device: opts.device, pipe });
    return pipe;
  }),
  env: { allowLocalModels: true, cacheDir: '', remoteHost: '' },
}));

vi.mock('../../src/core/embeddings/runtime-support.js', () => ({
  getLocalEmbeddingRuntimeBlocker: () => null,
  getMissingLocalEmbeddingStackMessage: () => null,
}));
vi.mock('../../src/core/embeddings/runtime-install.js', () => ({
  ensureEmbeddingStackResolvable: () => {},
}));
vi.mock('../../src/core/embeddings/onnxruntime-common-resolver.js', () => ({
  ensureOnnxRuntimeCommonResolvable: () => {},
}));
vi.mock('../../src/core/embeddings/onnxruntime-node-resolver.js', () => ({
  ensureOnnxRuntimeNodeMatchesSystem: () => {},
  isEffectiveCudaAvailable: () => false,
}));

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../src/core/logger.js', () => ({
  logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const load = () => import('../../src/core/embeddings/embedding-local-init.js');
const created = (device: string) =>
  state.created.filter((c) => c.device === device).map((c) => c.pipe as FakePipeline);

beforeEach(() => {
  vi.resetModules();
  warn.mockClear();
  state.created = [];
  state.failDevice = null;
  state.vectors = { cpu: [1, 0, 0], dml: [1, 0, 0], cuda: [1, 0, 0] };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('initLocalEmbedder GPU parity check (#3685)', () => {
  it('keeps DirectML when its vectors match CPU and releases the probe CPU pipeline', async () => {
    const mod = await load();
    const embedder = await mod.initLocalEmbedder(undefined, {}, 'dml');

    expect(mod.getCurrentDevice()).toBe('dml');
    expect(embedder).toBe(created('dml')[0]);
    expect(created('cpu')).toHaveLength(1);
    expect(created('cpu')[0].dispose).toHaveBeenCalledTimes(1);
    expect(created('dml')[0].dispose).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to CPU with a warning when DirectML vectors disagree', async () => {
    state.vectors.dml = [0.37, 0.93, 0];
    const mod = await load();
    const embedder = await mod.initLocalEmbedder(undefined, {}, 'dml');

    expect(mod.getCurrentDevice()).toBe('cpu');
    expect(embedder).toBe(created('cpu')[0]);
    expect(created('cpu')).toHaveLength(1);
    expect(created('dml')[0].dispose).toHaveBeenCalledTimes(1);
    expect(created('cpu')[0].dispose).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ device: 'dml' });
    expect(warn.mock.calls[0][0].minCosine).toBeCloseTo(0.37, 2);

    const [vec] = await mod.localEmbedBatch(['some code']);
    expect(Array.from(vec)).toEqual([1, 0, 0]);
  });

  it('applies the same check to CUDA', async () => {
    state.vectors.cuda = [0, 1, 0];
    const mod = await load();
    await mod.initLocalEmbedder(undefined, {}, 'cuda');
    expect(mod.getCurrentDevice()).toBe('cpu');
  });

  it('keeps the GPU device when the CPU comparison cannot run', async () => {
    state.failDevice = 'cpu';
    const mod = await load();
    await mod.initLocalEmbedder(undefined, {}, 'dml');

    expect(mod.getCurrentDevice()).toBe('dml');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ device: 'dml', err: 'cannot load cpu' });
  });

  it('does not probe when CPU is the requested device', async () => {
    const mod = await load();
    await mod.initLocalEmbedder(undefined, {}, 'cpu');

    expect(mod.getCurrentDevice()).toBe('cpu');
    expect(state.created).toHaveLength(1);
  });

  it('accepts small numeric differences below the tolerance', async () => {
    state.vectors.dml = [1, 0.001, 0];
    const mod = await load();
    await mod.initLocalEmbedder(undefined, {}, 'dml');
    expect(mod.getCurrentDevice()).toBe('dml');
    expect(mod.GPU_PARITY_MIN_COSINE).toBeGreaterThan(0.9);
  });
});
