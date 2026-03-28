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

/**
 * Validate a git URL to prevent SSRF attacks.
 * Only allows https:// and http:// schemes. Blocks private/internal addresses.
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
  if (
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host)
  ) {
    throw new Error('Cloning from private/internal addresses is not allowed');
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
