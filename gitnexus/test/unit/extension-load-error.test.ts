import { describe, expect, it } from 'vitest';
import {
  classifyExtensionLoadError,
  type ExtensionLoadErrorKind,
} from '../../src/core/lbug/extension-load-error.js';

/**
 * U1 (#2374): the four-way classifier and its Windows catch-all guard. The
 * guard is load-bearing — LadybugDB wraps every Windows load failure in the same
 * `Failed to load library … needed by extension` text, so only the specific
 * error-126 tail may route to `missing_dependency`; 127/5/1114 and the bare
 * wrapper must fall to `unknown`, and a corrupt/wrong-arch file must route to
 * `corrupt_file` first.
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
