/**
 * Git Clone Utility
 *
 * Shallow-clones repositories into ~/.gitnexus/repos/{name}/.
 * If already cloned, does git pull instead.
 */

import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { isIP } from 'net';
import { logger } from '../core/logger.js';
import { parseRepoNameFromUrl } from '../storage/git.js';

/** Root directory for all cloned repositories. Targets must resolve inside this. */
const CLONE_ROOT = path.resolve(path.join(os.homedir(), '.gitnexus', 'repos'));

// A valid git repository name is filesystem-safe: alphanumerics plus `. _ -`.
// Rejecting anything else (including `..`, `/`, `\`, shell metacharacters)
// guarantees getCloneDir(repoName) cannot escape CLONE_ROOT regardless of
// how the caller derived repoName.
const REPO_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Extract the repository name from a git URL (HTTPS or SSH).
 *
 * Throws if the URL does not yield a filesystem-safe last segment. A name
 * like `..` or `foo/bar` would otherwise let `getCloneDir(name)` escape the
 * clone root via path traversal.
 */
export function extractRepoName(url: string): string {
  const name = parseRepoNameFromUrl(url);
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name === 'unknown' ||
    !REPO_NAME_PATTERN.test(name)
  ) {
    throw new Error('Could not extract a valid repository name from URL');
  }
  return name;
}

/** Get the clone target directory for a repo name. */
export function getCloneDir(repoName: string): string {
  // Re-validate at the boundary even though extractRepoName already checked —
  // callers may pass a repoName from another source (test fixtures, scripts).
  if (!repoName || repoName === '.' || repoName === '..' || !REPO_NAME_PATTERN.test(repoName)) {
    throw new Error('Invalid repository name');
  }
  return path.join(CLONE_ROOT, repoName);
}

// Cloud metadata hostnames that must never be reachable via user-supplied URLs
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.internal',
]);

/**
 * Validate a git URL to prevent SSRF attacks.
 * Only allows https:// and http:// schemes. Blocks private/internal addresses,
 * IPv6 private ranges, cloud metadata hostnames, and numeric IP encodings.
 */
export function validateGitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('Only https:// and http:// git URLs are allowed');
  }

  const host = parsed.hostname.toLowerCase();

  // Block known dangerous hostnames (cloud metadata services)
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Strip IPv6 brackets if present (URL parser behavior varies across Node versions)
  let normalizedHost = host;
  if (host.startsWith('[') && host.endsWith(']')) {
    normalizedHost = host.slice(1, -1);
  }

  // Check if this is an IPv6 address
  // Use manual colon detection as fallback since isIP may return 0 for some
  // normalized IPv6 forms (e.g. ::ffff:7f00:1)
  const isIPv6 = isIP(normalizedHost) === 6 || normalizedHost.includes(':');
  if (isIPv6) {
    assertNotPrivateIPv6(normalizedHost);
    return;
  }

  // Check if this is an IPv4 address (including numeric encodings)
  if (isIP(normalizedHost) === 4) {
    assertNotPrivateIPv4(normalizedHost);
    return;
  }

  // For non-IP hostnames, check for numeric IP tricks
  // Decimal encoding: 2130706433 = 127.0.0.1
  // Hex encoding: 0x7f000001 = 127.0.0.1
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Standard IPv4 regex checks for dotted notation
  if (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    host === '0.0.0.0' ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^198\.1[89]\./.test(host)
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

function assertNotPrivateIPv6(ip: string): void {
  // Expand common compressed forms for comparison
  const lower = ip.toLowerCase();

  // IPv6 loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Unspecified address
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 Unique Local Address (fc00::/7 = fc and fd prefixes)
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 link-local (fe80::/10)
  if (
    lower.startsWith('fe80') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:hex:hex)
  // Node may normalize ::ffff:127.0.0.1 to ::ffff:7f00:1
  if (lower.startsWith('::ffff:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // Also catch the expanded form: 0:0:0:0:0:ffff:
  if (lower.includes(':ffff:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv4-compatible IPv6 (RFC 4291 § 2.5.5.1, deprecated form: ::w.x.y.z).
  // Node's URL parser collapses http://[::127.0.0.1]/ to "::7f00:1" — the IPv4
  // is hidden in the last 32 bits without the ::ffff: marker, so the check
  // above misses it. The form is still routable to the embedded IPv4 on most
  // network stacks, so any address compressed to ::xxxx[:yyyy] must be blocked.
  if (/^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(lower)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // NAT64 well-known prefix (RFC 6052 § 2.1: 64:ff9b::/96, plus the local
  // 64:ff9b:1::/48 from RFC 8215). Maps any IPv4 address — including private
  // ranges — into IPv6, so a host with NAT64 can reach the embedded IPv4 via
  // e.g. 64:ff9b::7f00:1 → 127.0.0.1.
  // The check intentionally covers the full 64:ff9b::/32 block (broader than
  // the two cited ranges): IANA reserves it for IPv4-IPv6 translation, so
  // blocking the whole prefix is defensively sound and prevents a narrower
  // CIDR check from quietly re-opening the bypass for 64:ff9b:1::/48 or any
  // future translation assignment.
  if (lower.startsWith('64:ff9b:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // 6to4 (RFC 3056, 2002::/16). Encodes an IPv4 address in bits 17-48, so
  // 2002:7f00:0001::1 routes to 127.0.0.1 on 6to4-capable stacks. The
  // protocol was deprecated by RFC 7526 and the public relay anycast
  // (192.88.99.1) has been retired, so broad-blocking the prefix has near-
  // zero false-positive cost while closing the IPv4-embedded bypass.
  // Teredo (2001::/32) embeds IPv4 obfuscated by XOR; precise blocking is
  // impractical and is out of scope here.
  if (lower.startsWith('2002:')) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

function assertNotPrivateIPv4(ip: string): void {
  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  if (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }
}

export interface CloneProgress {
  phase: 'cloning' | 'pulling';
  message: string;
}

/**
 * Build the `git clone` argument list for a given URL and target directory.
 *
 * The `--` separator is non-negotiable: it stops git from parsing a URL that
 * starts with `--` (e.g. `--upload-pack=evil`) as an option flag, which would
 * otherwise execute an attacker-chosen subprocess (CodeQL
 * js/second-order-command-line-injection, alerts #166/#167).
 *
 * Exported so the separator placement is testable without mocking spawn.
 */
export function buildCloneArgs(url: string, targetDir: string): string[] {
  return ['clone', '--depth', '1', '--', url, targetDir];
}

/**
 * Normalize a git URL into a comparable form.
 *
 * Two URLs are considered the same repository when their normalized forms
 * are identical: lowercased hostname, no trailing `.git`, no trailing
 * slashes on the path, default port stripped. Path comparison stays
 * case-sensitive because that's how Git hosts treat the path component on
 * the wire (case-folding GitHub's web UI is a separate convenience).
 *
 * Returns the original input if URL parsing fails — the caller can still
 * compare with the literal string for non-URL forms (e.g. SSH `git@host:`).
 */
export function normalizeGitUrlForCompare(url: string): string {
  // Strip trailing slashes and a trailing `.git` for both URL and SSH forms.
  let trimmed = url;
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '/') {
    trimmed = trimmed.slice(0, -1);
  }
  if (trimmed.endsWith('.git')) trimmed = trimmed.slice(0, -4);

  try {
    const parsed = new URL(trimmed);
    parsed.hostname = parsed.hostname.toLowerCase();
    // strip default ports
    if (
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    ) {
      parsed.port = '';
    }
    // Strip credentials — never material to repo identity, and including
    // them would let two equivalent URLs (with/without basic auth) compare
    // unequal.
    parsed.username = '';
    parsed.password = '';
    // Recompose without trailing slash on the path.
    let pathname = parsed.pathname;
    while (pathname.length > 1 && pathname[pathname.length - 1] === '/') {
      pathname = pathname.slice(0, -1);
    }
    parsed.pathname = pathname;
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}`;
  } catch {
    // Non-URL forms (e.g. `git@github.com:owner/repo`) — return the trimmed
    // form lowercased on the hostname-ish prefix. SSH-form normalization
    // is best-effort; exact-string compare is sufficient for the threat
    // model (mismatched origins still differ at the literal level).
    return trimmed.toLowerCase();
  }
}

/**
 * Read `remote.origin.url` from an existing clone using `git config --get`.
 *
 * Returns `null` if the config key is absent, the spawn fails, or the
 * directory isn't a git repository. The caller decides what a missing
 * remote means for its threat model — for cloneOrPull, a missing remote
 * on an existing clone is treated as a refuse-to-pull condition.
 */
export function getRemoteOriginUrl(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * Verify that an existing clone's `remote.origin.url` matches the requested
 * URL (after normalization). Throws on mismatch or missing remote.
 *
 * Closes the wrong-repo silent-analysis vector that Codex's adversarial
 * review on PR #1325 surfaced: clone dirs are keyed by URL basename, so a
 * request for `https://gitlab.example/attacker/repo.git` would otherwise
 * collide with an existing `~/.gitnexus/repos/repo` cloned from a different
 * origin and `git pull --ff-only` would silently succeed against the wrong
 * remote.
 *
 * Exported so the comparison logic is testable in isolation against any
 * tmpdir-based fixture, without needing to populate CLONE_ROOT.
 */
export async function assertRemoteMatchesRequestedUrl(
  targetDir: string,
  requestedUrl: string,
): Promise<void> {
  const remoteUrl = await getRemoteOriginUrl(targetDir);
  if (remoteUrl === null) {
    throw new Error(`Existing clone at ${targetDir} has no remote.origin — refusing to pull`);
  }
  if (normalizeGitUrlForCompare(remoteUrl) !== normalizeGitUrlForCompare(requestedUrl)) {
    throw new Error(
      `Existing clone at ${targetDir} has remote ${remoteUrl}, not the requested URL ${requestedUrl}`,
    );
  }
}

/**
 * Clone or pull a git repository.
 * If targetDir doesn't exist: git clone --depth 1
 * If targetDir exists with .git: git pull --ff-only (after verifying the
 * existing clone's remote.origin matches the requested URL).
 *
 * Security:
 *   - targetDir must resolve inside CLONE_ROOT (~/.gitnexus/repos/). The
 *     path.relative containment barrier below is the inline canonical idiom
 *     CodeQL's js/path-injection sanitizer recognizes.
 *   - validateGitUrl runs unconditionally on the requested URL — both the
 *     clone path and the pull path. An earlier shape only validated on the
 *     clone branch; an existing clone with the same basename let an
 *     attacker's URL skip the SSRF / scheme / private-IP checks (Codex
 *     adversarial review on PR #1325).
 *   - When the target already has `.git`, the existing clone's
 *     remote.origin.url is fetched and compared (normalized) to the
 *     requested URL. Refuses to pull if they differ — this closes the
 *     wrong-repo silent-analysis vector where two URLs sharing a basename
 *     would collide on the same on-disk clone dir.
 *   - The git URL is passed after a `--` separator so a value beginning with
 *     `--` (e.g. `--upload-pack=evil`) cannot be interpreted as a git option
 *     (CodeQL js/second-order-command-line-injection).
 */
export async function cloneOrPull(
  url: string,
  targetDir: string,
  onProgress?: (progress: CloneProgress) => void,
): Promise<string> {
  // Containment barrier — inline with the canonical path.relative idiom so
  // CodeQL recognizes the sanitizer at every following filesystem and
  // subprocess sink. The same `safeTarget` is used for every downstream
  // path operation — no reassignment that the analyzer could lose track of.
  //
  // Limitation: this is a lexical containment check, not a realpath check.
  // If an attacker can place a symlink under CLONE_ROOT pointing outside it,
  // the lexical check passes but the clone lands at the symlink target. That
  // requires pre-existing local write access to CLONE_ROOT, so the threat
  // model considers it out of scope; CodeQL js/path-injection accepts the
  // lexical form. Tracked as a follow-up if defense-in-depth is needed.
  const safeTarget = path.resolve(targetDir);
  const rel = path.relative(CLONE_ROOT, safeTarget);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Clone target must be a subdirectory of ${CLONE_ROOT}`);
  }

  // Always validate the requested URL — the prior shape only ran this in
  // the code path where the repo was cloned. Now it runs unconditionally,
  // preventing SSRF / blocked-host bypasses even when targetDir already exists.
  validateGitUrl(url);

  const exists = await fs.access(path.join(safeTarget, '.git')).then(
    () => true,
    () => false,
  );

  if (exists) {
    // Confirm the existing clone is actually the same repository the caller
    // requested. Without this check, a pull would silently succeed against
    // whatever remote the dir was originally cloned from.
    await assertRemoteMatchesRequestedUrl(safeTarget, url);
    onProgress?.({ phase: 'pulling', message: 'Pulling latest changes...' });
    await runGit(['pull', '--ff-only'], safeTarget);
  } else {
    await fs.mkdir(path.dirname(safeTarget), { recursive: true });
    onProgress?.({ phase: 'cloning', message: `Cloning ${url}...` });
    await runGit(buildCloneArgs(url, safeTarget));
  }

  return safeTarget;
}

function runGit(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Prevent git from prompting for credentials (hangs the process)
        GIT_TERMINAL_PROMPT: '0',
        // Ensure no credential helper tries to open a GUI prompt
        GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/true',
      },
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        // Log full stderr internally but don't expose it to API callers (SSRF mitigation)
        if (stderr.trim()) logger.error(`git ${args[0]} stderr: ${stderr.trim()}`);
        reject(new Error(`git ${args[0]} failed (exit code ${code})`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}
