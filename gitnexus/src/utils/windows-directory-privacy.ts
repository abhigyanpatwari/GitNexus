/**
 * Windows privacy proof for the analyzer identity cache directory.
 *
 * POSIX proves cache privacy with `stat.uid` and `stat.mode`. Windows has no
 * equivalent in Node: `fs.stat` reports a synthetic mode that ignores the
 * access-control list, so the DACL has to be read through the OS. This module
 * reads it with one bounded `powershell.exe` call and decides — in TypeScript,
 * not in the shell script — whether the directory is private to the current
 * user.
 *
 * The decision is made on security identifiers, never on account names: the
 * probe reports the owner SID and the SID of every principal that holds an
 * allowing ACE, so it is unaffected by the machine's UI language. An ACE that
 * only propagates to children still counts, because the cache files created
 * inside the directory inherit it.
 *
 * Everything here fails closed. A probe that cannot run, a directory that
 * cannot be read, a principal that cannot be resolved — each of them means
 * "not private", which disables the persistent cache rather than trusting it.
 */

import { spawnSync } from 'node:child_process';

/** `NT AUTHORITY\SYSTEM`. */
export const WINDOWS_LOCAL_SYSTEM_SID = 'S-1-5-18';
/** `BUILTIN\Administrators`. */
export const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';

/**
 * What the OS reports about one directory's access-control list.
 *
 * `allowedSids` holds every distinct principal that holds an *allowing* ACE,
 * whatever its rights: a read-only grant is still a grant. Deny ACEs are
 * absent — they remove access, so they cannot make a directory public.
 */
export interface WindowsDirectoryAccess {
  /** SID of the account the process runs as. */
  readonly currentUser: string;
  /** SID of the directory owner. */
  readonly owner: string;
  /** SIDs of the principals holding an allowing ACE. */
  readonly allowedSids: readonly string[];
}

/**
 * Whether the directory is private to the current user.
 *
 * The acceptable set is the current user, `SYSTEM` and `Administrators` — the
 * same three principals the issue named. `SYSTEM` and `Administrators` can
 * always read and rewrite any file the user owns, so treating them as
 * untrusted would make the check unsatisfiable on a normal Windows install.
 *
 * The owner is checked as well: an owner may always rewrite the DACL of the
 * object it owns, whatever the DACL says. A directory owned by somebody else
 * is therefore not private even when its DACL only names acceptable
 * principals — that owner could grant themselves access before the next run
 * probes again.
 */
export function isWindowsDirectoryPrivate(access: WindowsDirectoryAccess): boolean {
  if (access.currentUser.length === 0 || access.owner.length === 0) return false;
  const acceptable = acceptableWindowsSids(access.currentUser);
  if (!acceptable.has(access.owner)) return false;
  return access.allowedSids.every((sid) => acceptable.has(sid));
}

function acceptableWindowsSids(currentUser: string): Set<string> {
  return new Set([currentUser, WINDOWS_LOCAL_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]);
}

/**
 * Reads the owner and the allowing ACEs of `directory`.
 *
 * The script resolves every identity reference to its SID, so the result is
 * independent of the machine's UI language. It reports the access-control list
 * as it is stored, which means an ACE that only propagates to children is
 * included — the cache files created inside the directory inherit it.
 */
const WINDOWS_ACCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$dir = $env:GITNEXUS_INTERNAL_IDENTITY_CACHE_DIRECTORY
if ([string]::IsNullOrEmpty($dir)) { exit 3 }
$sidType = [System.Security.Principal.SecurityIdentifier]
$dirInfo = [System.IO.DirectoryInfo]::new($dir)
if (-not $dirInfo.Exists) { exit 4 }
if (($dirInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 5 }
$acl = $dirInfo.GetAccessControl()
$owner = $acl.GetOwner($sidType).Value
$allowed = New-Object System.Collections.Generic.List[string]
foreach ($ace in $acl.GetAccessRules($true, $true, $sidType)) {
  if ($ace.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  $sid = $ace.IdentityReference.Value
  if ($sid -and -not $allowed.Contains($sid)) { $allowed.Add($sid) }
}
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$parts = New-Object System.Collections.Generic.List[string]
foreach ($sid in $allowed) { $parts.Add('"' + $sid + '"') }
Write-Output ('{"currentUser":"' + $current + '","owner":"' + $owner + '","allowed":[' + ($parts -join ',') + ']}')
`;

/**
 * Rewrites the directory's access-control list so that only the current user,
 * `SYSTEM` and `Administrators` hold any access to it, and so that children
 * inherit exactly that list.
 *
 * Inheritance is switched off first: an inherited ACE cannot be revoked, so a
 * directory that inherits a permissive rule from its parent can only be made
 * private by protecting it.
 */
const WINDOWS_LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$dir = $env:GITNEXUS_INTERNAL_IDENTITY_CACHE_DIRECTORY
if ([string]::IsNullOrEmpty($dir)) { exit 3 }
$dirInfo = [System.IO.DirectoryInfo]::new($dir)
if (-not $dirInfo.Exists) { exit 4 }
$acl = $dirInfo.GetAccessControl()
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$full = [System.Security.AccessControl.FileSystemRights]::FullControl
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($sid in @($current, 'S-1-5-18', 'S-1-5-32-544')) {
  $sidObject = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sidObject, $full, $inherit, $propagation, $allow)
  [void]$acl.AddAccessRule($rule)
}
$dirInfo.SetAccessControl($acl)
`;

const WINDOWS_DIRECTORY_ENV = 'GITNEXUS_INTERNAL_IDENTITY_CACHE_DIRECTORY';
const WINDOWS_SCRIPT_TIMEOUT_MS = 30_000;

function runWindowsScript(script: string, directory: string): string | null {
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        env: { ...process.env, [WINDOWS_DIRECTORY_ENV]: directory },
        timeout: WINDOWS_SCRIPT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error !== undefined || result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

function parseWindowsDirectoryAccess(stdout: string): WindowsDirectoryAccess | null {
  // The shell may print a warning ahead of the payload; the payload is the
  // last line that starts a JSON object.
  const candidate = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .pop();
  if (candidate === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.currentUser !== 'string' || typeof record.owner !== 'string') return null;
  if (!Array.isArray(record.allowed)) return null;
  const allowed = record.allowed.filter((sid): sid is string => typeof sid === 'string');
  if (allowed.length !== record.allowed.length) return null;
  return { currentUser: record.currentUser, owner: record.owner, allowedSids: allowed };
}

/** Reads the access-control list of `directory`, or `null` when it cannot be read. */
export function readWindowsDirectoryAccess(directory: string): WindowsDirectoryAccess | null {
  const stdout = runWindowsScript(WINDOWS_ACCESS_SCRIPT, directory);
  return stdout === null ? null : parseWindowsDirectoryAccess(stdout);
}

/** Rewrites the access-control list of `directory`; `false` when it cannot be applied. */
export function lockWindowsDirectory(directory: string): boolean {
  const stdout = runWindowsScript(WINDOWS_LOCK_SCRIPT, directory);
  return stdout !== null;
}

type DirectoryAccessReader = (directory: string) => WindowsDirectoryAccess | null;
type DirectoryLocker = (directory: string) => boolean;

let readDirectoryAccess: DirectoryAccessReader = readWindowsDirectoryAccess;
let lockDirectory: DirectoryLocker = lockWindowsDirectory;

const verifiedDirectories = new Map<string, boolean>();

/**
 * Whether `directory` is private to the current user, locking it once if it
 * is not.
 *
 * A directory that other principals could write to may already hold files
 * they planted, so `discard` is called with the directory before the path is
 * trusted again. The answer is memoized for the lifetime of the process: the
 * DACL can only be rewritten by a principal that already has access to it, so
 * re-probing it inside one run adds nothing but latency.
 */
export function ensurePrivateWindowsDirectory(
  directory: string,
  discard?: (directory: string) => void,
): boolean {
  const memoized = verifiedDirectories.get(memoKey(directory));
  if (memoized !== undefined) return memoized;

  let access = readDirectoryAccess(directory);
  if (access !== null && !isWindowsDirectoryPrivate(access)) {
    // The files are only discarded once the directory is locked: a failed lock
    // means the directory stays untrusted, and keeping its contents costs
    // nothing while wiping them would throw the cache away every run.
    if (lockDirectory(directory)) {
      discard?.(directory);
      access = readDirectoryAccess(directory);
    }
  }
  const isPrivate = access !== null && isWindowsDirectoryPrivate(access);
  verifiedDirectories.set(memoKey(directory), isPrivate);
  return isPrivate;
}

function memoKey(directory: string): string {
  return process.platform === 'win32' ? directory.toLowerCase() : directory;
}

/** @internal Test seam for the access-control reader and the lock. */
export function _setWindowsDirectoryPrivacyHooksForTests(
  hooks: {
    read?: DirectoryAccessReader;
    lock?: DirectoryLocker;
  } | null,
): void {
  readDirectoryAccess = hooks?.read ?? readWindowsDirectoryAccess;
  lockDirectory = hooks?.lock ?? lockWindowsDirectory;
  verifiedDirectories.clear();
}
