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
import type { LoggerCapture } from '../../src/core/logger.js';

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

async function withInstallCapture(
  options: { cuda?: boolean; force?: boolean } = {},
  assert: (cap: LoggerCapture) => void | Promise<void>,
): Promise<void> {
  const { _captureLogger } = await import('../../src/core/logger.js');
  const cap = _captureLogger();
  try {
    const { embeddingsInstallCommand } = await import('../../src/cli/embeddings.js');
    await embeddingsInstallCommand(options);
    await assert(cap);
  } finally {
    cap.restore();
  }
}

describe('embeddingsInstallCommand outcomes (#2372)', () => {
  beforeEach(() => {
    vi.resetModules();
    resolveEmbeddingRuntimeMock.mockReset();
    isPrefixRuntimeLoadableMock.mockReset().mockReturnValue(true);
    installEmbeddingRuntimeMock.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
  });

  it('refuses to spawn npm on darwin/x64', async () => {
    const orig = { platform: process.platform, arch: process.arch };
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    resolveEmbeddingRuntimeMock.mockReturnValue(null);
    try {
      await withInstallCapture({}, (cap) => {
        expect(installEmbeddingRuntimeMock).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(cap.records().some((r) => r.recoveryHint === 'local-embedding-unsupported')).toBe(
          true,
        );
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: orig.platform, configurable: true });
      Object.defineProperty(process, 'arch', { value: orig.arch, configurable: true });
    }
  });

  it('package-sourced --force still installs so prefix overrides refresh', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValue({ source: 'package' });
    await withInstallCapture({ force: true }, () => {
      expect(installEmbeddingRuntimeMock).toHaveBeenCalledTimes(1);
    });
  });

  it('already-installed package source without --force: no install, "nothing to do"', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValue({ source: 'package' });
    await withInstallCapture({}, (cap) => {
      expect(installEmbeddingRuntimeMock).not.toHaveBeenCalled();
      expect(
        cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('nothing to do')),
      ).toBe(true);
    });
  });

  it('post-check resolves nothing: exit 1 and the ✗ message', async () => {
    // First call (pre-check) not package, so it installs; post-check returns null.
    resolveEmbeddingRuntimeMock.mockReturnValueOnce(null).mockReturnValueOnce(null);
    await withInstallCapture({}, (cap) => {
      expect(installEmbeddingRuntimeMock).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      expect(
        cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('does not resolve')),
      ).toBe(true);
    });
  });

  it('post-check runtime-prefix + loadable: unqualified ✓, exit unset', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValueOnce(null).mockReturnValueOnce({
      source: 'runtime-prefix',
    });
    isPrefixRuntimeLoadableMock.mockReturnValue(true);
    await withInstallCapture({}, (cap) => {
      expect(process.exitCode).toBeUndefined();
      expect(cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('✓'))).toBe(
        true,
      );
    });
  });

  it('post-check runtime-prefix + not loadable: capability warning, no false ✓, exit unset', async () => {
    resolveEmbeddingRuntimeMock.mockReturnValueOnce(null).mockReturnValueOnce({
      source: 'runtime-prefix',
    });
    isPrefixRuntimeLoadableMock.mockReturnValue(false);
    await withInstallCapture({}, (cap) => {
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
    });
  });
});
