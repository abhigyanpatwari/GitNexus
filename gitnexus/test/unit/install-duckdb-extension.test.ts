import { describe, it, expect, vi } from 'vitest';
import {
  chooseInstallVerb,
  installDuckDbExtension,
  FILE_CORRUPTION_SIGNATURES as installerSignatures,
} from '../../scripts/install-duckdb-extension.mjs';
import { FILE_CORRUPTION_SIGNATURES as classifierSignatures } from '../../src/core/lbug/extension-load-error.js';

const { resolveVendoredFtsPath } = vi.hoisted(() => ({ resolveVendoredFtsPath: vi.fn() }));
vi.mock('../../dist/core/lbug/vendored-extension-path.js', () => ({ resolveVendoredFtsPath }));

/**
 * Offline, network-free regression guard for the install-verb decision (#2374,
 * PR #2375). A revert to unconditional INSTALL or unconditional FORCE INSTALL
 * fails here on any runner — the self-heal e2e is network-gated and can silently
 * skip, so this deterministic unit test is the real guard.
 */

interface RecordingConn {
  query: ReturnType<typeof vi.fn>;
}

/** Injectable connection factory that records the SQL instead of touching lbug. */
const recordingConnect = (): { conn: RecordingConn; dispose: () => Promise<void> } => {
  const conn: RecordingConn = { query: vi.fn(async () => undefined) };
  return { conn, dispose: async () => undefined };
};

describe('chooseInstallVerb (#2374)', () => {
  it.each([
    [
      'IO exception: Failed to load library: /x/libfts.lbug_extension. invalid ELF header',
      'FORCE INSTALL',
    ],
    ['Failed to load library: /x/libfts.lbug_extension. file too short', 'FORCE INSTALL'],
    ['Failed to load library: /x/libfts.dll: not a valid Win32 application', 'FORCE INSTALL'],
    [
      'Binder exception: Extension: fts is an official extension and has not been installed.',
      'INSTALL',
    ],
    ['Failed to load library: /x/libfts: libfoo.so: cannot open shared object file', 'INSTALL'],
    ['some unrelated error', 'INSTALL'],
  ])('maps %j to %s', (loadError, expected) => {
    expect(chooseInstallVerb(loadError)).toBe(expected);
  });

  it('defaults to plain INSTALL when no load error is provided', () => {
    expect(chooseInstallVerb(undefined)).toBe('INSTALL');
  });
});

describe('installDuckDbExtension issues the chosen SQL (#2374)', () => {
  it('issues FORCE INSTALL when the load error indicates file corruption', async () => {
    const factory = recordingConnect();
    await installDuckDbExtension('fts', {
      loadError: 'Failed to load library: /x/libfts.lbug_extension. invalid ELF header',
      connect: () => factory,
    });
    expect(factory.conn.query).toHaveBeenCalledWith('FORCE INSTALL fts');
  });

  it('issues plain INSTALL for a missing extension file', async () => {
    const factory = recordingConnect();
    await installDuckDbExtension('fts', {
      loadError: 'Extension: fts is an official extension and has not been installed.',
      connect: () => factory,
    });
    expect(factory.conn.query).toHaveBeenCalledWith('INSTALL fts');
  });

  it('issues LOAD EXTENSION and never an install verb in verifyOnly mode', async () => {
    const factory = recordingConnect();
    await installDuckDbExtension('fts', { verifyOnly: true, connect: () => factory });
    expect(factory.conn.query).toHaveBeenCalledWith('LOAD EXTENSION fts');
    expect(factory.conn.query.mock.calls.some(([sql]) => String(sql).includes('INSTALL'))).toBe(
      false,
    );
  });

  it('rejects an invalid extension name before opening any connection', async () => {
    const connect = vi.fn();
    await expect(installDuckDbExtension('fts; DROP', { connect })).rejects.toThrow(
      /Invalid DuckDB extension name/,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('verifies the bundled FTS by path without downloading a mutable CDN artifact', async () => {
    resolveVendoredFtsPath.mockReturnValue("/app/owner's copy/libfts.lbug_extension");
    const factory = recordingConnect();
    await installDuckDbExtension('fts', { verifyBundled: true, connect: () => factory });
    expect(factory.conn.query.mock.calls).toEqual([
      ["LOAD EXTENSION '/app/owner''s copy/libfts.lbug_extension'"],
    ]);
  });

  it('fails before connecting when the bundled FTS artifact is missing', async () => {
    resolveVendoredFtsPath.mockReturnValue(null);
    const connect = vi.fn();
    await expect(installDuckDbExtension('fts', { verifyBundled: true, connect })).rejects.toThrow(
      /No packaged FTS artifact/,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects bundled verification for extensions that are not packaged', async () => {
    const connect = vi.fn();
    await expect(
      installDuckDbExtension('vector', { verifyBundled: true, connect }),
    ).rejects.toThrow(/Bundled verification only supports fts/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('propagates a bundled ABI mismatch and closes the scratch connection', async () => {
    resolveVendoredFtsPath.mockReturnValue('/app/libfts.lbug_extension');
    const factory = recordingConnect();
    factory.conn.query.mockRejectedValue(new Error('undefined symbol: ValueVector::setAllNull'));
    const dispose = vi.fn(async () => undefined);
    await expect(
      installDuckDbExtension('fts', {
        verifyBundled: true,
        connect: () => ({ ...factory, dispose }),
      }),
    ).rejects.toThrow(/undefined symbol/);
    expect(factory.conn.query).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe('FILE_CORRUPTION_SIGNATURES parity (#2383 F5b)', () => {
  it('the installer copy stays byte-identical to the classifier copy', () => {
    // The two lists are deliberately duplicated (the .mjs cannot import the .ts).
    // A one-sided edit would desync the FORCE-INSTALL verb from remedy classification;
    // compare source + flags so a change to either regex fails here.
    const describeRegexes = (res: readonly RegExp[]): string[] =>
      res.map((re) => `${re.source}/${re.flags}`);
    expect(describeRegexes(installerSignatures)).toEqual(describeRegexes(classifierSignatures));
  });
});
