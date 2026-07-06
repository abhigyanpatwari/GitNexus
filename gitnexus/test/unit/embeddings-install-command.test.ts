/**
 * Tests for `gitnexus embeddings install` (#2372). The command must be truthful
 * about outcomes: exit non-zero when the post-install check fails, and never
 * print an unqualified ✓ for a prefix install this Node cannot load (no
 * module.registerHooks). runtime-install is mocked wholesale so all four
 * outcomes are drivable without spawning npm.
 *
 * Mirrors the analyze-local-embedding-error harness: vi.mock the heavy deps,
 * capture logger records, assert on process.exitCode + recoveryHint/msg.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveEmbeddingRuntimeMock = vi.fn<() => { source: string } | null>();
const isPrefixRuntimeLoadableMock = vi.fn(() => true);
const installEmbeddingRuntimeMock = vi.fn(async () => undefined);

vi.mock('../../src/core/embeddings/runtime-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/embeddings/runtime-install.js')>()),
  resolveEmbeddingRuntime: () => resolveEmbeddingRuntimeMock(),
  isPrefixRuntimeLoadable: () => isPrefixRuntimeLoadableMock(),
  installEmbeddingRuntime: (opts?: unknown) => installEmbeddingRuntimeMock(opts),
  getEmbeddingRuntimeDir: () => '/fake/embedding-runtime',
  getEmbeddingStackSpecs: () => ({ '@huggingface/transformers': '^4.1.0' }),
}));

async function run(options: { cuda?: boolean; force?: boolean } = {}) {
  const { _captureLogger } = await import('../../src/core/logger.js');
  const cap = _captureLogger();
  const { embeddingsInstallCommand } = await import('../../src/cli/embeddings.js');
  await embeddingsInstallCommand(options);
  return cap;
}

describe('embeddingsInstallCommand outcomes (#2372)', () => {
  beforeEach(() => {
    vi.resetModules();
    resolveEmbeddingRuntimeMock.mockReset();
    isPrefixRuntimeLoadableMock.mockReset().mockReturnValue(true);
    installEmbeddingRuntimeMock.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
  });

  it('already-installed package source without --force: no install, "nothing to do"', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValue({ source: 'package' });
    const cap = await run();
    expect(installEmbeddingRuntimeMock).not.toHaveBeenCalled();
    expect(
      cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('nothing to do')),
    ).toBe(true);
    cap.restore();
  });

  it('post-check resolves nothing: exit 1 and the ✗ message', async () => {
    // First call (pre-check) not package, so it installs; post-check returns null.
    resolveEmbeddingRuntimeMock.mockReturnValueOnce(null).mockReturnValueOnce(null);
    const cap = await run();
    expect(installEmbeddingRuntimeMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(
      cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('does not resolve')),
    ).toBe(true);
    cap.restore();
  });

  it('post-check runtime-prefix + loadable: unqualified ✓, exit unset', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValueOnce(null).mockReturnValueOnce({
      source: 'runtime-prefix',
    });
    isPrefixRuntimeLoadableMock.mockReturnValue(true);
    const cap = await run();
    expect(process.exitCode).toBeUndefined();
    expect(cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('✓'))).toBe(true);
    cap.restore();
  });

  it('post-check runtime-prefix + not loadable: capability warning, no false ✓, exit unset', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValueOnce(null).mockReturnValueOnce({
      source: 'runtime-prefix',
    });
    isPrefixRuntimeLoadableMock.mockReturnValue(false);
    const cap = await run();
    // install itself succeeded, so exit code stays unset...
    expect(process.exitCode).toBeUndefined();
    const records = cap.records();
    // ...but the message names the capability requirement, not an unqualified ✓.
    expect(
      records.some((r) => typeof r.msg === 'string' && r.msg.includes('module.registerHooks')),
    ).toBe(true);
    expect(records.some((r) => typeof r.msg === 'string' && r.msg.includes('is ready'))).toBe(
      false,
    );
    cap.restore();
  });
});
