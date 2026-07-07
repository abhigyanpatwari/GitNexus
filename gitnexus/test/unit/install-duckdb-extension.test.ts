import { describe, it, expect, vi } from 'vitest';
import {
  chooseInstallVerb,
  installDuckDbExtension,
  FILE_CORRUPTION_SIGNATURES as installerSignatures,
} from '../../scripts/install-duckdb-extension.mjs';
import { FILE_CORRUPTION_SIGNATURES as classifierSignatures } from '../../src/core/lbug/extension-load-error.js';

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
