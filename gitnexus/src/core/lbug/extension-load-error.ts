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
 * `classifyExtensionLoadError` is pure string logic — no `@ladybugdb/core`
 * import, no filesystem — which keeps `native-check.ts` free of a static lbug
 * dependency. `diagnoseExtensionLoad` layers a LANGUAGE-INDEPENDENT structural
 * check on top: it pulls the extension's file path out of lbug's own (English)
 * wrapper and inspects the binary header directly (PE/ELF/Mach-O magic +
 * architecture), so corrupt-vs-valid is decided by the file itself, not by the
 * localized OS error tail. It reads the file (node:fs core module only, still no
 * lbug) and never throws — any read failure degrades to the string classifier.
 */
import { closeSync, openSync, readSync } from 'node:fs';

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
const MISSING_FILE_SIGNATURES: readonly RegExp[] = [
  /has not been installed/i,
  /not been installed/i,
];

/**
 * On-disk file corruption / wrong-platform. FORCE INSTALL re-downloads.
 * Kept byte-identical to `FILE_CORRUPTION_SIGNATURES` in
 * scripts/install-duckdb-extension.mjs (that `.mjs` cannot import this `.ts`;
 * the duplication is deliberate — the two serve different call sites). Note
 * `/not a valid/i` already covers Windows error 193 ("is not a valid Win32
 * application"), so a truncated Windows download is caught here, before the
 * missing-dependency branch.
 */
// Exported so a parity test can assert this stays byte-identical to the copy in
// scripts/install-duckdb-extension.mjs (that `.mjs` cannot import this `.ts`), #2383 F5b.
export const FILE_CORRUPTION_SIGNATURES: readonly RegExp[] = [
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
 * Localized Windows tails we do not enumerate (French, German, Japanese, …) and
 * mojibake renderings of the Chinese text won't match here — but they still
 * carry lbug's language-independent `Failed to load library` wrapper, so they
 * are caught by the hedged fallback (LOAD_FAILURE_WRAPPER) with a non-committal
 * remedy, never a wrong confident "reinstall" instruction.
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

/**
 * LadybugDB's own English wrapper for a dlopen/LoadLibrary failure
 * (extension.cpp: `Failed to load library: {path} which is needed by extension:
 * {name}`). It is emitted for EVERY extension load failure regardless of the OS
 * display language — the only localized part is the OS-error tail after it. So
 * it is the language-independent fallback signal once the specific tails miss: a
 * French/German/Japanese Windows 126 has a localized tail we cannot enumerate,
 * but it still carries this wrapper. See HEDGED_LOAD_FAILURE_REMEDY.
 */
const LOAD_FAILURE_WRAPPER = /failed to load library/i;

const MISSING_FILE_REMEDY =
  'The FTS extension is not installed. Re-run with network access and ' +
  'GITNEXUS_LBUG_EXTENSION_INSTALL=auto (or `gitnexus analyze --repair-fts`) to download it.';

const CORRUPT_FILE_REMEDY =
  'The FTS extension file is present but unreadable (corrupt, truncated, or built for another ' +
  'platform). Re-download it with network access and GITNEXUS_LBUG_EXTENSION_INSTALL=auto ' +
  '(`gitnexus analyze --repair-fts`).';

// Single source of truth for the VC++ runtime-install pointer, shared by the
// Windows-126 and structural missing-dependency remedies so the name/URL cannot
// drift between them (#2383 F5).
const VC_REDIST_INSTALL_HINT =
  'the Microsoft Visual C++ 2015-2022 Redistributable (x64) from ' +
  'https://aka.ms/vs/17/release/vc_redist.x64.exe';

// MSVC-first per DuckDB's canonical answer for this exact error; OpenSSL second.
const WINDOWS_MISSING_DEPENDENCY_REMEDY =
  'The FTS extension is present but a required runtime library is missing (Windows error 126). ' +
  'Reinstalling the extension will NOT help. Install ' +
  VC_REDIST_INSTALL_HINT +
  '; if the error persists, the extension also needs OpenSSL 3 ' +
  '(libcrypto-3-x64.dll / libssl-3-x64.dll) on the DLL search path.';

const POSIX_MISSING_DEPENDENCY_REMEDY =
  'The FTS extension is present but a shared library it depends on could not be loaded (named in ' +
  'the error above). Reinstalling the extension will NOT help — install that library or add it to ' +
  'your loader search path.';

// Language-independent fallback: we know the extension failed to load, but the
// OS-error tail is in a locale we did not enumerate, so we cannot say which class
// it is. Hedge honestly — point at the user's own localized error and give both
// branches — rather than confidently prescribing the wrong single fix. The clean
// long-term fix is upstream: have LadybugDB include the numeric GetLastError/errno
// in the message (as it already does elsewhere), so this becomes a code match.
const HEDGED_LOAD_FAILURE_REMEDY =
  'The FTS extension file was found but could not be loaded — see the "Error:" text above (shown ' +
  "in your system's language). Reinstalling usually will not help. If it names a missing module or " +
  'library, install the required runtime (on Windows: the Microsoft Visual C++ 2015-2022 ' +
  'Redistributable x64 and OpenSSL 3); if it names a corrupt or invalid file, run ' +
  '`gitnexus analyze --repair-fts` to re-download.';

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
export function classifyExtensionLoadError(
  reason: string | undefined | null,
): ExtensionLoadDiagnosis {
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
  // Language-independent fallback: the extension demonstrably failed to load
  // (lbug's English wrapper is present) but the localized OS tail matched no
  // specific class. Treat as a dependency/runtime load failure with a hedged
  // remedy — strictly better than the generic `unknown` for non-English hosts,
  // and it never prescribes the wrong fix.
  if (LOAD_FAILURE_WRAPPER.test(text)) {
    return { kind: 'missing_dependency', remedy: HEDGED_LOAD_FAILURE_REMEDY };
  }
  return { kind: 'unknown', remedy: UNKNOWN_REMEDY };
}

// ── Language-independent structural layer ────────────────────────────────────

/** Well-formedness of the extension binary for the host platform + arch. */
export type ExtensionBinaryState = 'absent' | 'corrupt' | 'valid' | 'indeterminate';

const STRUCTURAL_MISSING_DEPENDENCY_REMEDY =
  'The FTS extension file is valid, so the failure is a missing or incompatible runtime dependency, ' +
  'not the extension itself — reinstalling will NOT help. On Windows, install ' +
  VC_REDIST_INSTALL_HINT +
  ' and ensure OpenSSL 3 is available; on Linux/macOS install the shared library named in the error above.';

/**
 * Pull the extension file path out of lbug's load error. lbug's wrapper is
 * English regardless of OS language — `Failed to load library: {path} which is
 * needed by extension: {name}` (real lbug), or the quoted `Failed to load
 * library '{path}': {reason}` variant — so the path is recoverable in any locale.
 * Only paths ending in `.lbug_extension` are accepted, so a regex misfire can
 * never point the inspector at an arbitrary file.
 */
export function extractExtensionPath(reason: string | undefined | null): string | null {
  const text = reason ?? '';
  const m = /failed to load library:?\s*['"]?(.+?\.lbug_extension)/i.exec(text);
  const path = m?.[1]?.trim();
  return path && path.length > 0 ? path : null;
}

/** Node `process.arch` → PE `Machine`. Undefined for arches we don't map. */
const PE_MACHINE: Readonly<Record<string, number>> = { x64: 0x8664, arm64: 0xaa64 };
/** Node `process.arch` → ELF `e_machine`. */
const ELF_MACHINE: Readonly<Record<string, number>> = { x64: 0x3e, arm64: 0xb7 };
/** Node `process.arch` → Mach-O `cputype`. */
const MACHO_CPUTYPE: Readonly<Record<string, number>> = { x64: 0x01000007, arm64: 0x0100000c };

/**
 * A structural verdict on a binary header. `indeterminate` means the probe could
 * not prove validity OR corruption from what it read (e.g. the PE header sits past
 * the BINARY_HEADER_BYTES window) — the caller defers to the string classifier
 * rather than assert a false verdict.
 */
type HeaderVerdict = 'valid' | 'corrupt' | 'indeterminate';

function classifyPE(buf: Buffer, bytesRead: number, arch: string): HeaderVerdict {
  if (bytesRead < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return 'corrupt'; // 'MZ'
  const peOffset = buf.readUInt32LE(0x3c);
  // The PE header (e_lfanew) points beyond what we read. A large-DOS-stub VALID PE
  // and a garbage e_lfanew are indistinguishable from here, so don't claim 'corrupt'
  // — defer to the loader's own report (#2383 F1-secondary).
  if (peOffset + 6 > bytesRead) return 'indeterminate';
  const isPE =
    buf[peOffset] === 0x50 &&
    buf[peOffset + 1] === 0x45 &&
    buf[peOffset + 2] === 0 &&
    buf[peOffset + 3] === 0;
  if (!isPE) return 'corrupt';
  const expected = PE_MACHINE[arch];
  if (expected === undefined) return 'valid'; // arch we don't map: don't claim corrupt
  return buf.readUInt16LE(peOffset + 4) === expected ? 'valid' : 'corrupt';
}

function classifyELF(buf: Buffer, bytesRead: number, arch: string): HeaderVerdict {
  if (bytesRead < 20) return 'corrupt';
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return 'corrupt'; // 0x7F ELF
  const littleEndian = buf[5] === 1; // EI_DATA
  const eMachine = littleEndian ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
  const expected = ELF_MACHINE[arch];
  if (expected === undefined) return 'valid';
  return eMachine === expected ? 'valid' : 'corrupt';
}

function classifyMachO(buf: Buffer, bytesRead: number, arch: string): HeaderVerdict {
  if (bytesRead < 8) return 'corrupt';
  const magicLE = buf.readUInt32LE(0);
  const magicBE = buf.readUInt32BE(0);
  // Universal ("fat") binary — assume it carries the host slice.
  if (magicBE === 0xcafebabe || magicLE === 0xcafebabe) return 'valid';
  const thin = magicLE === 0xfeedfacf || magicLE === 0xfeedface;
  const thinSwapped = magicBE === 0xfeedfacf || magicBE === 0xfeedface;
  if (!thin && !thinSwapped) return 'corrupt';
  const cpuType = thin ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const expected = MACHO_CPUTYPE[arch];
  if (expected === undefined) return 'valid';
  return cpuType === expected ? 'valid' : 'corrupt';
}

/**
 * Decide whether a binary header is a well-formed shared library for the given
 * platform + architecture — using only the file's structure, no localized text.
 * Pure and injectable (platform/arch as params) so every format+arch combination
 * is unit-testable regardless of the host it runs on.
 */
export function classifyBinaryHeader(
  buf: Buffer,
  bytesRead: number,
  platform: NodeJS.Platform,
  arch: string,
): HeaderVerdict {
  if (platform === 'win32') return classifyPE(buf, bytesRead, arch);
  if (platform === 'linux') return classifyELF(buf, bytesRead, arch);
  if (platform === 'darwin') return classifyMachO(buf, bytesRead, arch);
  return 'valid'; // unknown host: never claim corrupt
}

const BINARY_HEADER_BYTES = 4096;

/**
 * Best-effort language-independent inspection of the extension file. Reads the
 * header and classifies it; never throws — a missing file is `absent`, an
 * unreadable one is `indeterminate`.
 */
export function inspectExtensionBinary(
  extensionPath: string | null | undefined,
): ExtensionBinaryState {
  if (!extensionPath) return 'indeterminate';
  let fd: number;
  try {
    fd = openSync(extensionPath, 'r');
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'indeterminate';
  }
  try {
    const buf = Buffer.alloc(BINARY_HEADER_BYTES);
    const bytesRead = readSync(fd, buf, 0, BINARY_HEADER_BYTES, 0);
    return classifyBinaryHeader(buf, bytesRead, process.platform, process.arch);
  } catch {
    return 'indeterminate';
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* closing the probe fd must never surface */
    }
  }
}

/**
 * Diagnose a LadybugDB load failure, preferring a LANGUAGE-INDEPENDENT structural
 * check of the extension binary over the localized error text:
 *   - file absent             → missing_file
 *   - present but malformed    → corrupt_file       (bad magic / wrong architecture)
 *   - present and well-formed   → missing_dependency (a valid binary the loader rejected)
 * The path comes from lbug's own English wrapper, so this holds in any OS display
 * language. When the file cannot be located or read, it falls back to the string
 * classifier (which still carries the language-independent hedged fallback). This
 * is the entry point every surface should call.
 */
export function diagnoseExtensionLoad(reason: string | undefined | null): ExtensionLoadDiagnosis {
  const text = reason ?? '';
  const stringResult = classifyExtensionLoadError(text);
  const fileState = inspectExtensionBinary(extractExtensionPath(text));

  if (fileState === 'corrupt') {
    return { kind: 'corrupt_file', remedy: CORRUPT_FILE_REMEDY };
  }
  if (fileState === 'valid') {
    // The structural probe only inspects the first BINARY_HEADER_BYTES, so a file
    // truncated AFTER its header still reads 'valid'. When the loader itself reported
    // corruption (e.g. "file too short" / Windows error 193 "not a valid Win32
    // application"), that whole-file verdict is stronger evidence than an intact-looking
    // header — honor it and route to re-download, not a runtime-dependency install (#2383
    // F1). Localized corrupt tails classify as hedged missing_dependency (not
    // corrupt_file), so they still fall through to the dependency remedy below.
    if (stringResult.kind === 'corrupt_file') {
      return stringResult;
    }
    // A structurally sound binary that still failed to load ⇒ a dependency/runtime
    // problem, decided WITHOUT the localized tail. Keep the string classifier's
    // sharper remedy when it recognized the specific case (e.g. English 126).
    const remedy =
      stringResult.kind === 'missing_dependency'
        ? stringResult.remedy
        : STRUCTURAL_MISSING_DEPENDENCY_REMEDY;
    return { kind: 'missing_dependency', remedy };
  }
  // 'absent' or 'indeterminate' → no positive structural evidence, so defer to the
  // string classifier. Note a real never-installed extension has NO path in its
  // reason (lbug says "has not been installed"), so it lands here via
  // 'indeterminate' and the string classifier reports missing_file correctly; a
  // path that lbug named but that is now gone (stale/racy) is better judged by
  // what lbug actually reported than by re-deriving from disk.
  return stringResult;
}
