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

/** Extract the repository name from a git URL (HTTPS or SSH). */
export function extractRepoName(url: string): string {
  const cleaned = url.replace(/\/+$/, '');
  const lastSegment = cleaned.split(/[/:]/).pop() || 'unknown';
  return lastSegment.replace(/\.git$/, '');
}

/** Get the clone target directory for a repo name. */
export function getCloneDir(repoName: string): string {
  return path.join(os.homedir(), '.gitnexus', 'repos', repoName);
}

// Cloud metadata hostnames that must never be reachable via user-supplied URLs
const BLOCKED_HOSTNAMES = new Set([
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

  // Block well-known internal hostnames
  if (host === 'localhost' || BLOCKED_HOSTNAMES.has(host)) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 loopback — URL parser strips brackets, so hostname is "::1" not "[::1]"
  if (host === '::1') {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv6 private ranges: ULA (fc00::/7), link-local (fe80::), IPv4-mapped (::ffff:)
  if (
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80') ||
    host.startsWith('::ffff:')
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
  }

  // IPv4 validation — use net.isIP() to catch decimal/hex encoding bypasses
  // (e.g. 2130706433, 0x7f000001 both resolve to 127.0.0.1)
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    const [a, b] = octets;
    if (
      a === 127 ||                             // 127.0.0.0/8 loopback
      a === 10 ||                              // 10.0.0.0/8 private
      (a === 172 && b >= 16 && b <= 31) ||     // 172.16.0.0/12 private
      (a === 192 && b === 168) ||              // 192.168.0.0/16 private
      (a === 169 && b === 254) ||              // 169.254.0.0/16 link-local
      a === 0 ||                               // 0.0.0.0/8
      (a === 100 && b >= 64 && b <= 127) ||    // 100.64.0.0/10 CGN (RFC 6598)
      (a === 198 && (b === 18 || b === 19))    // 198.18.0.0/15 benchmarking
    ) {
      throw new Error('Cloning from private/internal addresses is not allowed');
    }
  }

  // Reject bare numeric IPs that aren't valid dotted-quad — could be decimal/hex encoding
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    throw new Error('Numeric IP encoding is not allowed');
  }
}

export interface CloneProgress {
  phase: 'cloning' | 'pulling';
  message: string;
}

/**
 * Clone or pull a git repository.
 * If targetDir doesn't exist: git clone --depth 1
 * If targetDir exists with .git: git pull --ff-only
 */
export async function cloneOrPull(
  url: string,
  targetDir: string,
  onProgress?: (progress: CloneProgress) => void,
): Promise<string> {
  const exists = await fs.access(path.join(targetDir, '.git')).then(
    () => true,
    () => false,
  );

  if (exists) {
    onProgress?.({ phase: 'pulling', message: 'Pulling latest changes...' });
    await runGit(['pull', '--ff-only'], targetDir);
  } else {
    validateGitUrl(url);
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    onProgress?.({ phase: 'cloning', message: `Cloning ${url}...` });
    await runGit(['clone', '--depth', '1', url, targetDir]);
  }

  return targetDir;
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
        GIT_ASKPASS: '/bin/true',
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
        if (stderr.trim()) console.error(`git ${args[0]} stderr: ${stderr.trim()}`);
        reject(new Error(`git ${args[0]} failed (exit code ${code})`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}
