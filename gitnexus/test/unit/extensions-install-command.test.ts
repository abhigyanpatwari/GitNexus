/**
 * Tests for `gitnexus extensions install [name]` — the explicit, opt-in way to
 * warm an optional LadybugDB extension's on-disk cache (FTS keyword search,
 * VECTOR semantic search) so a later `LOAD EXTENSION` under `load-only`
 * policy finds it without touching the network. installDuckDbExtensionOutOfProcess
 * is mocked wholesale so every outcome is drivable without spawning a real child
 * process or touching the network.
 *
 * Mirrors embeddings-install-command.test.ts: vi.mock the heavy dep, capture
 * cli-message output via the logger, assert on process.exitCode + text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const installMock = vi.fn<(name: string, timeoutMs: number) => Promise<{
  success: boolean;
  timedOut: boolean;
  message: string;
}>>();

vi.mock('../../src/core/lbug/extension-loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/extension-loader.js')>()),
  installDuckDbExtensionOutOfProcess: (name: string, timeoutMs: number) =>
    installMock(name, timeoutMs),
  getExtensionInstallTimeoutMs: () => 15_000,
}));

async function run(name?: string, options: { timeout?: string } = {}) {
  const { _captureLogger } = await import('../../src/core/logger.js');
  const cap = _captureLogger();
  const { extensionsInstallCommand } = await import('../../src/cli/extensions.js');
  await extensionsInstallCommand(name, options);
  return cap;
}

describe('extensionsInstallCommand outcomes', () => {
  beforeEach(() => {
    vi.resetModules();
    installMock.mockReset();
    process.exitCode = undefined;
  });

  it('unknown extension name: cliError + exit 1, never calls installer', async () => {
    const cap = await run('bogus');
    expect(installMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('Unknown extension'))).toBe(
      true,
    );
    cap.restore();
  });

  it('single named extension success: installs only that one, exit unset, ✓ message', async () => {
    installMock.mockResolvedValue({ success: true, timedOut: false, message: 'INSTALL fts completed' });
    const cap = await run('fts');
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith('fts', 15_000);
    expect(process.exitCode).toBeUndefined();
    expect(cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('✓ fts'))).toBe(true);
    cap.restore();
  });

  it('name omitted: installs every known extension', async () => {
    installMock.mockResolvedValue({ success: true, timedOut: false, message: 'ok' });
    await run();
    expect(installMock).toHaveBeenCalledTimes(2);
    const names = installMock.mock.calls.map((c) => c[0]);
    expect(names).toEqual(expect.arrayContaining(['fts', 'VECTOR']));
  });

  it('"all" behaves the same as omitting the name', async () => {
    installMock.mockResolvedValue({ success: true, timedOut: false, message: 'ok' });
    await run('all');
    expect(installMock).toHaveBeenCalledTimes(2);
  });

  it('install failure: cliWarn with the installer message, exit 1', async () => {
    installMock.mockResolvedValue({
      success: false,
      timedOut: true,
      message: 'INSTALL fts timed out after 15000ms',
    });
    const cap = await run('fts');
    expect(process.exitCode).toBe(1);
    expect(
      cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('timed out after 15000ms')),
    ).toBe(true);
    cap.restore();
  });

  it('name is case-insensitive against the known identifiers', async () => {
    installMock.mockResolvedValue({ success: true, timedOut: false, message: 'ok' });
    await run('VeCtOr');
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith('VECTOR', 15_000);
  });

  it('invalid --timeout: cliError + exit 1, never calls installer', async () => {
    const cap = await run('fts', { timeout: 'not-a-number' });
    expect(installMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('--timeout'))).toBe(
      true,
    );
    cap.restore();
  });

  it('explicit --timeout is forwarded to the installer', async () => {
    installMock.mockResolvedValue({ success: true, timedOut: false, message: 'ok' });
    await run('fts', { timeout: '5000' });
    expect(installMock).toHaveBeenCalledWith('fts', 5000);
  });
});
