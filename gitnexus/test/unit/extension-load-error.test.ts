import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyBinaryHeader,
  classifyExtensionLoadError,
  diagnoseExtensionLoad,
  extractExtensionPath,
  type ExtensionLoadErrorKind,
} from '../../src/core/lbug/extension-load-error.js';

// Minimal well-formed binary headers per format, for the structural check.
function buildELF(eMachine: number): Buffer {
  const b = Buffer.alloc(64);
  b[0] = 0x7f;
  b[1] = 0x45;
  b[2] = 0x4c;
  b[3] = 0x46; // 0x7F E L F
  b[4] = 2; // 64-bit
  b[5] = 1; // little-endian
  b.writeUInt16LE(eMachine, 18);
  return b;
}
function buildPE(machine: number): Buffer {
  const peOff = 0x80;
  const b = Buffer.alloc(peOff + 8);
  b[0] = 0x4d;
  b[1] = 0x5a; // MZ
  b.writeUInt32LE(peOff, 0x3c);
  b[peOff] = 0x50;
  b[peOff + 1] = 0x45; // PE\0\0
  b.writeUInt16LE(machine, peOff + 4);
  return b;
}
function buildMachO(cpuType: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64 (little-endian file)
  b.writeUInt32LE(cpuType, 4);
  return b;
}
function buildHostValidBinary(): Buffer {
  const arm = process.arch === 'arm64';
  if (process.platform === 'win32') return buildPE(arm ? 0xaa64 : 0x8664);
  if (process.platform === 'linux') return buildELF(arm ? 0xb7 : 0x3e);
  if (process.platform === 'darwin') return buildMachO(arm ? 0x0100000c : 0x01000007);
  return Buffer.alloc(64); // unknown host: classifyBinaryHeader returns 'valid' anyway
}
// Valid MZ, but e_lfanew points far past the bytes we read → header unprovable.
function buildPEBeyondWindow(): Buffer {
  const b = Buffer.alloc(128); // > 0x40 so the MZ check passes
  b[0] = 0x4d;
  b[1] = 0x5a; // MZ
  b.writeUInt32LE(4100, 0x3c); // e_lfanew far beyond the 128-byte buffer
  return b;
}
// Valid MZ and an in-window e_lfanew, but no 'PE\0\0' signature there → corrupt.
function buildPEGarbageSignature(): Buffer {
  const peOff = 0x80;
  const b = Buffer.alloc(peOff + 8);
  b[0] = 0x4d;
  b[1] = 0x5a; // MZ
  b.writeUInt32LE(peOff, 0x3c); // e_lfanew within the buffer, but bytes there stay 0x00
  return b;
}

/**
 * U1 (#2374): the string classifier. The precise en/zh 126 tail gets the definite
 * runtime remedy; other Windows tails (127/5/1114) and the bare wrapper match only
 * lbug's language-independent `Failed to load library` wrapper, so they fall to the
 * HEDGED `missing_dependency` remedy (never a wrong confident instruction); an
 * English corrupt/wrong-arch tail routes to `corrupt_file` first. The structural
 * layer (below) refines corrupt-vs-valid from the binary itself, in any language.
 */
describe('classifyExtensionLoadError', () => {
  const kindCases: ReadonlyArray<readonly [string, string, ExtensionLoadErrorKind]> = [
    [
      'Windows 126 (Chinese)',
      'IO exception: Failed to load library: C:\\Users\\someone/.lbdb/extension/0.18.0/win_amd64/fts/libfts.lbug_extension which is needed by extension: fts. Error: 找不到指定的模块。',
      'missing_dependency',
    ],
    [
      'Windows 126 (English)',
      'Failed to load library: libfts.lbug_extension which is needed by extension: fts. Error: The specified module could not be found.',
      'missing_dependency',
    ],
    [
      'Linux missing shared object',
      'IO exception: Failed to load library: libfts.lbug_extension which is needed by extension: fts. Error: libcrypto.so.3: cannot open shared object file: No such file or directory',
      'missing_dependency',
    ],
    [
      'macOS image not found',
      'Failed to load library: Library not loaded: @rpath/libssl.3.dylib ... Reason: image not found',
      'missing_dependency',
    ],
    [
      'missing file (never installed)',
      'Extension "fts" is an official extension and has not been installed.',
      'missing_file',
    ],
    ['corrupt: invalid ELF header', 'Binder exception: invalid ELF header', 'corrupt_file'],
    ['corrupt: file too short', 'IO exception: file too short', 'corrupt_file'],
    [
      'Windows 193 (not a valid Win32 application) → corrupt, not missing_dependency',
      'Failed to load library: libfts.lbug_extension which is needed by extension: fts. Error: %1 is not a valid Win32 application.',
      'corrupt_file',
    ],
    [
      'German 126 (localized) via the language-independent wrapper',
      'Failed to load library: C:\\Users\\x\\.lbdb\\extension\\0.18.0\\win_amd64\\fts\\libfts.lbug_extension which is needed by extension: fts. Error: Das angegebene Modul wurde nicht gefunden.',
      'missing_dependency',
    ],
    [
      'German 193 (corrupt, localized) → hedged (corruption not detectable in German)',
      'Failed to load library: C:\\Users\\x\\.lbdb\\extension\\0.18.0\\win_amd64\\fts\\libfts.lbug_extension which is needed by extension: fts. Error: Die Datei ist keine zulässige Win32-Anwendung.',
      'missing_dependency',
    ],
    [
      'Windows 127 (wrong symbol) → hedged missing_dependency via the wrapper',
      'Failed to load library: libfts.lbug_extension which is needed by extension: fts. Error: The specified procedure could not be found.',
      'missing_dependency',
    ],
    [
      'Windows 5 (access denied / AV lock) → hedged missing_dependency via the wrapper',
      'Failed to load library: libfts.lbug_extension which is needed by extension: fts. Error: Access is denied.',
      'missing_dependency',
    ],
    [
      'bare wrapper, no OS-error tail → hedged missing_dependency',
      'Failed to load library: libfts.lbug_extension which is needed by extension: fts.',
      'missing_dependency',
    ],
    ['unrelated/garbage (no wrapper) → unknown', 'something else entirely went wrong', 'unknown'],
    ['empty → unknown', '', 'unknown'],
  ];

  it.each(kindCases)('classifies %s', (_name, reason, expectedKind) => {
    expect(classifyExtensionLoadError(reason)).toMatchObject({ kind: expectedKind });
  });

  it('nullish reason does not throw and is unknown', () => {
    expect(classifyExtensionLoadError(undefined)).toMatchObject({ kind: 'unknown' });
    expect(classifyExtensionLoadError(null)).toMatchObject({ kind: 'unknown' });
  });

  it('Windows missing-dependency remedy leads with MSVC redist, names OpenSSL, and says reinstall will not help', () => {
    const { remedy } = classifyExtensionLoadError(
      'needed by extension: fts. Error: The specified module could not be found.',
    );
    expect(remedy).toMatch(/Visual C\+\+/);
    expect(remedy).toMatch(/vc_redist\.x64\.exe/);
    expect(remedy).toMatch(/OpenSSL 3/);
    expect(remedy).toMatch(/will NOT help/);
    // Must not resurrect the old, wrong "retry the network install" instruction.
    expect(remedy).not.toMatch(/Retry with network access/i);
  });

  it('hedged fallback remedy points at the OS error and offers both branches (language-independent)', () => {
    // A non-English localized Windows tail we do not enumerate — matched only via
    // lbug's language-independent "Failed to load library" wrapper.
    const { kind, remedy } = classifyExtensionLoadError(
      'Failed to load library: libfts.lbug_extension which is needed by extension: fts. Error: <localized OS message>',
    );
    expect(kind).toBe('missing_dependency');
    expect(remedy).toMatch(/"Error:"/); // tells the user to read their own localized error
    expect(remedy).toMatch(/repair-fts/); // corrupt branch
    expect(remedy).toMatch(/Visual C\+\+|OpenSSL/); // missing-runtime branch
    // Hedged, distinct from the definite 126 remedy — "usually will not help".
    expect(remedy).toMatch(/usually will not help/);
  });

  it('POSIX missing-dependency remedy points at the named library, not a reinstall', () => {
    const { remedy } = classifyExtensionLoadError('libcrypto.so.3: cannot open shared object file');
    expect(remedy).toMatch(/shared library/i);
    expect(remedy).toMatch(/will NOT help/i);
  });

  it('missing-file remedy routes to the network install', () => {
    const { remedy } = classifyExtensionLoadError('has not been installed');
    expect(remedy).toMatch(/--repair-fts|GITNEXUS_LBUG_EXTENSION_INSTALL=auto/);
  });
});

/**
 * The language-independent structural layer: it decides corrupt-vs-valid from the
 * binary's own header (PE/ELF/Mach-O magic + architecture), never from a localized
 * OS-error string.
 */
describe('classifyBinaryHeader', () => {
  const cases: ReadonlyArray<
    readonly [string, Buffer, NodeJS.Platform, string, 'valid' | 'corrupt' | 'indeterminate']
  > = [
    ['linux x64 valid ELF', buildELF(0x3e), 'linux', 'x64', 'valid'],
    ['linux arm64 valid ELF', buildELF(0xb7), 'linux', 'arm64', 'valid'],
    ['linux: arm64 ELF on x64 host → corrupt', buildELF(0xb7), 'linux', 'x64', 'corrupt'],
    [
      'linux: non-ELF bytes → corrupt',
      Buffer.from('this is definitely not an ELF binary'),
      'linux',
      'x64',
      'corrupt',
    ],
    ['win x64 valid PE', buildPE(0x8664), 'win32', 'x64', 'valid'],
    ['win: arm64 PE on x64 host → corrupt', buildPE(0xaa64), 'win32', 'x64', 'corrupt'],
    ['win: ELF file on a Windows host → corrupt', buildELF(0x3e), 'win32', 'x64', 'corrupt'],
    ['darwin x64 valid Mach-O', buildMachO(0x01000007), 'darwin', 'x64', 'valid'],
    ['darwin arm64 valid Mach-O', buildMachO(0x0100000c), 'darwin', 'arm64', 'valid'],
    [
      'darwin: x86_64 Mach-O on arm64 host → corrupt',
      buildMachO(0x01000007),
      'darwin',
      'arm64',
      'corrupt',
    ],
    [
      'unknown host → valid (never claim corrupt)',
      Buffer.from('whatever'),
      'sunos' as NodeJS.Platform,
      'x64',
      'valid',
    ],
    // #2383 F1-secondary: a valid PE whose header sits past the read window is not
    // provably corrupt — return indeterminate so the caller defers to the loader.
    [
      'win: PE header beyond read window → indeterminate',
      buildPEBeyondWindow(),
      'win32',
      'x64',
      'indeterminate',
    ],
    // Arch we don't map on a known platform: never claim corrupt (documents KTD5).
    ['linux: valid ELF, unmapped arch → valid', buildELF(0x3e), 'linux', 'mips', 'valid'],
    // Valid MZ but garbage where PE\0\0 should be, within the window → genuinely corrupt.
    [
      'win: valid MZ but no PE signature → corrupt',
      buildPEGarbageSignature(),
      'win32',
      'x64',
      'corrupt',
    ],
  ];

  it.each(cases)('%s', (_name, buf, platform, arch, expected) => {
    expect(classifyBinaryHeader(buf, buf.length, platform, arch)).toBe(expected);
  });
});

describe('extractExtensionPath', () => {
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    [
      'real lbug wrapper (Windows, spaces + mixed separators)',
      'Failed to load library: C:\\Users\\a b\\.lbdb\\extension\\0.18.0\\win_amd64\\fts\\libfts.lbug_extension which is needed by extension: fts. Error: x',
      'C:\\Users\\a b\\.lbdb\\extension\\0.18.0\\win_amd64\\fts\\libfts.lbug_extension',
    ],
    [
      'quoted variant',
      "Failed to load library '/home/u/.lbdb/extension/0.18.0/linux_amd64/fts/libfts.lbug_extension': invalid ELF header",
      '/home/u/.lbdb/extension/0.18.0/linux_amd64/fts/libfts.lbug_extension',
    ],
    ['no path (never installed)', 'Extension "fts" ... has not been installed.', null],
    ['no .lbug_extension token', 'some unrelated error', null],
  ];

  it.each(cases)('%s', (_name, reason, expected) => {
    expect(extractExtensionPath(reason)).toBe(expected);
  });
});

describe('diagnoseExtensionLoad (structural, language-independent)', () => {
  it('a valid host binary that still failed to load → missing_dependency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-diag-valid-'));
    const file = join(dir, 'libfts.lbug_extension');
    writeFileSync(file, buildHostValidBinary());
    try {
      // A localized tail we do NOT enumerate — structural check decides it anyway.
      const reason = `Failed to load library: ${file} which is needed by extension: fts. Error: <localized>`;
      expect(diagnoseExtensionLoad(reason)).toMatchObject({ kind: 'missing_dependency' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a header-valid file the loader calls "file too short" → corrupt_file, not missing_dependency (#2383 F1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-diag-trunc-'));
    const file = join(dir, 'libfts.lbug_extension');
    // Intact host header, but the loader reports a body-truncated download.
    writeFileSync(file, buildHostValidBinary());
    try {
      const reason = `Failed to load library: ${file} which is needed by extension: fts. Error: file too short`;
      expect(diagnoseExtensionLoad(reason)).toMatchObject({ kind: 'corrupt_file' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a header-valid file the loader calls "not a valid Win32 application" (error 193) → corrupt_file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-diag-win193-'));
    const file = join(dir, 'libfts.lbug_extension');
    writeFileSync(file, buildHostValidBinary());
    try {
      const reason = `Failed to load library: ${file} which is needed by extension: fts. Error: %1 is not a valid Win32 application.`;
      expect(diagnoseExtensionLoad(reason)).toMatchObject({ kind: 'corrupt_file' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a valid file with an unrecognized loader tail → structural remedy carrying the shared VC++ hint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-diag-struct-'));
    const file = join(dir, 'libfts.lbug_extension');
    writeFileSync(file, buildHostValidBinary());
    try {
      // Wrapper present (so the path extracts) with a tail that maps to neither
      // corrupt_file nor missing_dependency — exercises the STRUCTURAL remedy branch,
      // and asserts it carries the same vc_redist URL as the Windows-126 remedy (#2383 F5).
      const reason = `Failed to load library: ${file}. has not been installed`;
      const { kind, remedy } = diagnoseExtensionLoad(reason);
      expect(kind).toBe('missing_dependency');
      expect(remedy).toMatch(/vc_redist\.x64\.exe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a malformed host binary → corrupt_file regardless of the (localized) error text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ext-diag-corrupt-'));
    const file = join(dir, 'libfts.lbug_extension');
    writeFileSync(file, Buffer.from('not a shared library'));
    try {
      const reason = `Failed to load library: ${file} which is needed by extension: fts. Error: Die Datei ist beschädigt.`;
      expect(diagnoseExtensionLoad(reason)).toMatchObject({ kind: 'corrupt_file' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no readable file → falls back to the string classifier', () => {
    // No path in the reason (never installed) → string classifier → missing_file.
    expect(
      diagnoseExtensionLoad('Extension "fts" is an official extension and has not been installed.'),
    ).toMatchObject({ kind: 'missing_file' });
    // Path present but absent on disk → defer to the string classifier (hedged here).
    expect(
      diagnoseExtensionLoad(
        'Failed to load library: /nope/libfts.lbug_extension which is needed by extension: fts. Error: xyz',
      ),
    ).toMatchObject({ kind: 'missing_dependency' });
  });
});
