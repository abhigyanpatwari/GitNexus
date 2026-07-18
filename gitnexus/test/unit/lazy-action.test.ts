import { describe, expect, it, vi } from 'vitest';
import { createAnalyzerLbugLazyAction, createLazyAction } from '../../src/cli/lazy-action.js';

const { checkLbugNativeMock } = vi.hoisted(() => ({
  checkLbugNativeMock: vi.fn(() => ({ ok: true })),
}));

vi.mock('../../src/core/lbug/native-check.js', () => ({
  checkLbugNative: checkLbugNativeMock,
}));

describe('createLazyAction', () => {
  it('does not import target module until invoked', async () => {
    const loader = vi.fn(async () => ({
      run: vi.fn(async () => 'ok'),
    }));

    const action = createLazyAction(loader, 'run');

    expect(loader).not.toHaveBeenCalled();
    await expect(action('arg-1')).resolves.toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when export is not a function', async () => {
    const action = createLazyAction(async () => ({ notAFunction: 'string-value' }), 'notAFunction');
    await expect(action()).rejects.toThrow('notAFunction');
  });
});

describe('createLbugLazyAction', () => {
  it('fails before importing the target module when LadybugDB native cannot load', async () => {
    checkLbugNativeMock.mockReturnValueOnce({
      ok: false,
      message:
        'LadybugDB native binary (lbugjs.node) exists but failed to load:\n' + '  dlopen failed',
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
    const loader = vi.fn(async () => ({
      run: vi.fn(async () => 'ok'),
    }));

    try {
      const { createLbugLazyAction } = await import('../../src/cli/lazy-action.js');
      const action = createLbugLazyAction(loader, 'run');

      await expect(action('arg-1')).resolves.toBeUndefined();

      expect(loader).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('LadybugDB native binary (lbugjs.node) exists but failed to load:'),
      );
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = undefined;
    }
  });
});

describe('createAnalyzerLbugLazyAction', () => {
  it('captures identity before probing native code or importing the analyzer graph', async () => {
    const events: string[] = [];
    const receipt = { schemaVersion: 4 };
    const run = vi.fn(async () => undefined);
    const identityLoader = vi.fn(async () => {
      events.push('identity-module');
      return {
        captureAnalyzerIdentityBeforeLoad: async (_url: string, loader: () => Promise<unknown>) => {
          events.push('receipt-captured');
          const loaded = await loader();
          return { runnerIdentity: receipt, loaded };
        },
      };
    });
    const analyzerLoader = vi.fn(async () => {
      events.push('analyzer-module');
      return { run };
    });
    const action = createAnalyzerLbugLazyAction(
      identityLoader as never,
      analyzerLoader,
      'run',
      'file:///fixture/dist/cli/index.js',
    );

    await action('repo', { force: true });

    expect(events).toEqual(['identity-module', 'receipt-captured', 'analyzer-module']);
    expect(run).toHaveBeenCalledWith(receipt, 'repo', { force: true });
  });
});
