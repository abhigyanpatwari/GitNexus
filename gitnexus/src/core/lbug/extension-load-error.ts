/**
 * Classify a LadybugDB `LOAD EXTENSION` failure into one of four actionable
 * classes and produce an accurate, literal-English remedy.
 *
 * Background (#2374): PR #2375 made the real LadybugDB LOAD error visible
 * (instead of a false "not pre-installed" message). The rc.4 reproduction then
 * showed the remaining defect — on Windows the extension file downloads and
 * INSTALLs fine, but `LoadLibrary` fails with error 126 ("the specified module
 * could not be found" / `找不到指定的模块`) because the extension dynamically
 * imports OpenSSL 3 / MSVC 14 DLLs that ship nowhere. For that class, telling
 * the user to reinstall/redownload is wrong — the file is fine; a *runtime
 * dependency* is missing. This module decides which class an error is so each
 * surface (doctor, --repair-fts, the analyze degrade warning, and
 * ftsDegradedWarning) can emit the right remedy instead of a one-size-fits-all
 * "reinstall over the network".
 *
 * Pure string logic — no `@ladybugdb/core` import, no filesystem, no
 * `process.platform` dependency. A Windows error is classified the same on any
 * host (the error text, not the running OS, carries the signal), which keeps
 * `native-check.ts` free of a static lbug dependency and lets every consumer
 * (`extension-loader`, `native-check`, `fts-indexes`, `run-analyze`, `doctor`)
 * import it safely.
 */

export type ExtensionLoadErrorKind =
  | 'missing_file'
  | 'corrupt_file'
  | 'missing_dependency'
  | 'unknown';

export interface ExtensionLoadDiagnosis {
  readonly kind: ExtensionLoadErrorKind;
  /** Actionable, literal-English remedy suited to the class. */
  readonly remedy: string;
}

/** LadybugDB says the extension file was never installed. INSTALL can heal it. */
const MISSING_FILE_SIGNATURES: readonly RegExp[] = [/has not been installed/i, /not been installed/i];

/**
 * On-disk file corruption / wrong-platform. FORCE INSTALL re-downloads.
 * Kept byte-identical to `FILE_CORRUPTION_SIGNATURES` in
 * scripts/install-duckdb-extension.mjs (that `.mjs` cannot import this `.ts`;
 * the duplication is deliberate — the two serve different call sites). Note
 * `/not a valid/i` already covers Windows error 193 ("is not a valid Win32
 * application"), so a truncated Windows download is caught here, before the
 * missing-dependency branch.
 */
const FILE_CORRUPTION_SIGNATURES: readonly RegExp[] = [
  /invalid elf/i,
  /file too short/i,
  /not a valid/i,
  /bad magic/i,
  /wrong architecture/i,
  /mach-o/i,
  /truncat/i,
];

/**
 * A *transitive dependency* of the extension is missing — the file loaded far
 * enough to be found, but a library it needs is absent. Reinstalling the
 * extension is a no-op for this class.
 *
 * WINDOWS CATCH-ALL GUARD (adversarial review): LadybugDB wraps *every* Windows
 * load failure in `Failed to load library … which is needed by extension`, so
 * that generic wrapper must NOT be sufficient — otherwise error 127 (wrong
 * OpenSSL minor / unresolved procedure), 5 (AV/permission lock), and 1114
 * (dependency DllMain failure) would all be mislabeled `missing_dependency` and
 * told to install a runtime, the opposite of their real fix. We key strictly on
 * the specific error-126 tail. Linux/macOS loaders name the missing library
 * directly, so their signals are unambiguous.
 *
 * Limitation: a non-UTF-8/mojibake rendering of the Chinese 126 text won't
 * match; those fall through to `unknown` (a safe generic remedy), never to a
 * wrong "reinstall" instruction.
 */
const WINDOWS_MISSING_DEPENDENCY_SIGNATURES: readonly RegExp[] = [
  /找不到指定的模块/,
  /specified module could not be found/i,
];
const POSIX_MISSING_DEPENDENCY_SIGNATURES: readonly RegExp[] = [
  /cannot open shared object file/i, // Linux ld.so
  /image not found/i, // macOS dyld
  /library not loaded/i, // macOS dyld
];

const MISSING_FILE_REMEDY =
  'The FTS extension is not installed. Re-run with network access and ' +
  'GITNEXUS_LBUG_EXTENSION_INSTALL=auto (or `gitnexus analyze --repair-fts`) to download it.';

const CORRUPT_FILE_REMEDY =
  'The FTS extension file is present but unreadable (corrupt, truncated, or built for another ' +
  'platform). Re-download it with network access and GITNEXUS_LBUG_EXTENSION_INSTALL=auto ' +
  '(`gitnexus analyze --repair-fts`).';

// MSVC-first per DuckDB's canonical answer for this exact error; OpenSSL second.
const WINDOWS_MISSING_DEPENDENCY_REMEDY =
  'The FTS extension is present but a required runtime library is missing (Windows error 126). ' +
  'Reinstalling the extension will NOT help. Install the Microsoft Visual C++ 2015-2022 ' +
  'Redistributable (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe; if the error ' +
  'persists, the extension also needs OpenSSL 3 (libcrypto-3-x64.dll / libssl-3-x64.dll) on the ' +
  'DLL search path.';

const POSIX_MISSING_DEPENDENCY_REMEDY =
  'The FTS extension is present but a shared library it depends on could not be loaded (named in ' +
  'the error above). Reinstalling the extension will NOT help — install that library or add it to ' +
  'your loader search path.';

const UNKNOWN_REMEDY =
  'The FTS extension failed to load for an unrecognized reason. Run `gitnexus doctor` for live ' +
  'FTS status and verify the extension file and platform.';

const matchesAny = (reason: string, signatures: readonly RegExp[]): boolean =>
  signatures.some((re) => re.test(reason));

/**
 * Classify a collapsed LadybugDB LOAD error. Order is most-specific-first and is
 * load-bearing: corrupt-file is tested before missing-dependency so a truncated
 * Windows download (error 193, matched by `/not a valid/i`) routes to
 * FORCE-reinstall rather than to the runtime-install remedy.
 */
export function classifyExtensionLoadError(reason: string | undefined | null): ExtensionLoadDiagnosis {
  const text = reason ?? '';
  if (matchesAny(text, MISSING_FILE_SIGNATURES)) {
    return { kind: 'missing_file', remedy: MISSING_FILE_REMEDY };
  }
  if (matchesAny(text, FILE_CORRUPTION_SIGNATURES)) {
    return { kind: 'corrupt_file', remedy: CORRUPT_FILE_REMEDY };
  }
  if (matchesAny(text, WINDOWS_MISSING_DEPENDENCY_SIGNATURES)) {
    return { kind: 'missing_dependency', remedy: WINDOWS_MISSING_DEPENDENCY_REMEDY };
  }
  if (matchesAny(text, POSIX_MISSING_DEPENDENCY_SIGNATURES)) {
    return { kind: 'missing_dependency', remedy: POSIX_MISSING_DEPENDENCY_REMEDY };
  }
  return { kind: 'unknown', remedy: UNKNOWN_REMEDY };
}
