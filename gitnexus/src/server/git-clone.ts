/**
 * Git Clone Utility
 *
 * Shallow-clones repositories into the clone root (getGlobalDir()/repos/{name}/).
 * If already cloned, does git pull instead.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import os from 'node:os';
import { logger } from '../core/logger.js';
import { getGlobalDir } from '../storage/repo-manager.js';
import { sanitizeRepoName, stripUrlCredentials } from '../storage/git.js';
import { validateGitUrl } from '../core/net/url-guard.js';
import {
  assertDirectoryOwnerAndPermissions,
  quarantineAutoSyncPartial,
} from '../core/auto-sync/path-security.js';
import { validateAutoSyncRemoteUrl } from '../core/auto-sync/config.js';

export { validateGitUrl };

/**
 * Root directory for all cloned repositories. Targets must resolve inside this.
 *
 * Sourced from getGlobalDir() so it honors GITNEXUS_HOME — the Docker image sets
 * GITNEXUS_HOME=/data/gitnexus, the persistent volume that also holds the
 * registry and indexes. Without this, clones landed in the container's
 * ephemeral ~/.gitnexus/repos and were lost on container recreation while the
 * registry still pointed at the dead path. Falls back to ~/.gitnexus when the
 * env var is unset (CLI / local installs), matching the prior behavior exactly.
 */
const CLONE_ROOT = path.resolve(path.join(getGlobalDir(), 'repos'));

// A valid git repository name is filesystem-safe: alphanumerics plus `. _ -`.
// Rejecting anything else (including `..`, `/`, `\`, shell metacharacters)
// guarantees getCloneDir(repoName) cannot escape CLONE_ROOT regardless of
// how the caller derived repoName.
export const REPO_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Extract the repository name from a git URL (HTTPS or SSH).
 *
 * Throws if the URL does not yield a filesystem-safe last segment. A name
 * like `..` or `foo/bar` would otherwise let `getCloneDir(name)` escape the
 * clone root via path traversal.
 */
export function extractRepoName(url: string): string {
  let trimmed = url.trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  const withoutGit = trimmed.toLowerCase().endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  const name = withoutGit.split(/[/:]/).filter(Boolean).pop() ?? '';
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name === 'unknown' ||
    name.startsWith('-') ||
    !REPO_NAME_PATTERN.test(name)
  ) {
    throw new Error('Could not extract a valid repository name from URL');
  }
  return name;
}

/**
 * Derive a clone directory name for the web `/api/analyze` boundary.
 *
 * The API historically accepted Azure DevOps and similar URLs whose repo
 * segment contains spaces or other directory-unsafe characters by sanitizing
 * the final segment. Keep that compatibility at the web boundary while leaving
 * `extractRepoName()` strict for internal/security-sensitive callers.
 */
export function extractWebRepoName(url: string): string {
  let trimmed = url.trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  const withoutGit = trimmed.toLowerCase().endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  const rawName = withoutGit.split(/[/:]/).filter(Boolean).pop() ?? '';
  const safeName = sanitizeRepoName(rawName);
  if (!rawName || safeName === 'unknown') {
    throw new Error('Could not extract a valid repository name from URL');
  }
  return safeName;
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

export interface CloneProgress {
  phase: 'cloning' | 'pulling';
  message: string;
}

export interface CloneOrPullOptions {
  token?: string;
  allowedCloneRoot?: string;
  expectedRepoName?: string;
  quarantineRoot?: string;
  allowAutoSyncSsh?: boolean;
  timeoutMs?: number;
  branch?: string;
  overwriteLocalChanges?: boolean;
  runGitForTest?: typeof runGit;
}

type RunGitOptions = {
  token?: string;
  url?: string;
  timeoutMs?: number;
  timeoutKillGraceMs?: number;
  spawnForTest?: typeof spawn;
};

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
/**
 * Detect Azure DevOps URLs — both self-hosted (via AZURE_DEVOPS_URL env)
 * and cloud (dev.azure.com / *.visualstudio.com).
 *
 * Self-hosted Azure DevOps Server instances use arbitrary hostnames
 * (e.g. `http://tfs.corp.example/Collection/Project/_git/Repo`), so the
 * function checks `AZURE_DEVOPS_URL` first. Cloud addresses are a
 * hardcoded fallback so PAT injection works out-of-the-box for
 * dev.azure.com without extra configuration.
 */
export function isAzureDevOpsUrl(url: string): boolean {
  try {
    // Strip a single trailing dot: `dev.azure.com.` is a valid absolute FQDN
    // that resolves to the same host, so it must match too.
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');

    // Self-hosted: match against the configured base URL.
    const configuredBase = process.env.AZURE_DEVOPS_URL;
    if (configuredBase) {
      try {
        const baseHost = new URL(configuredBase).hostname.toLowerCase().replace(/\.$/, '');
        if (host === baseHost) return true;
      } catch {
        /* invalid AZURE_DEVOPS_URL — fall through to cloud check */
      }
    }

    // Cloud fallback.
    return host === 'dev.azure.com' || host.endsWith('.visualstudio.com');
  } catch {
    return false;
  }
}

/**
 * One-time startup warning when AZURE_DEVOPS_URL is configured over cleartext
 * http:// — the Azure DevOps PAT would then be sent unencrypted on every
 * clone. Self-hosted instances that only serve http are still supported (we
 * do not refuse), but operators rarely read request-time logs, so surface it
 * at boot too. Call once from server startup.
 */
export function warnIfInsecureAzureConfig(): void {
  const base = process.env.AZURE_DEVOPS_URL;
  if (!base) return;
  try {
    if (new URL(base).protocol === 'http:') {
      logger.warn(
        'AZURE_DEVOPS_URL is configured over cleartext http:// — the Azure DevOps PAT will be sent unencrypted. Prefer https:// where your instance supports it.',
      );
    }
  } catch {
    /* invalid AZURE_DEVOPS_URL — isAzureDevOpsUrl already tolerates this */
  }
}

export function buildCloneArgs(url: string, targetDir: string): string[] {
  return ['clone', '--depth', '1', '--', url, targetDir];
}

export function buildBranchCloneArgs(url: string, targetDir: string, branch: string): string[] {
  return ['clone', '--depth', '1', '--branch', branch, '--', url, targetDir];
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
export async function getRemoteOriginUrl(cwd: string, timeoutMs?: number): Promise<string | null> {
  try {
    const stdout = await runGit(['config', '--get', 'remote.origin.url'], cwd, { timeoutMs });
    return stdout.trim() || null;
  } catch (error) {
    if ((error as Error).message.includes('timed out')) throw error;
    return null;
  }
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
  timeoutMs?: number,
): Promise<void> {
  const remoteUrl = await getRemoteOriginUrl(targetDir, timeoutMs);
  if (remoteUrl === null) {
    throw new Error(`Existing clone at ${targetDir} has no remote.origin — refusing to pull`);
  }
  if (normalizeGitUrlForCompare(remoteUrl) !== normalizeGitUrlForCompare(requestedUrl)) {
    throw new Error(
      // Both URLs are echoed to the API caller and the server log, and either
      // can carry `https://user:token@` userinfo — strip it here too (#2914).
      `Existing clone at ${targetDir} has remote ${stripUrlCredentials(remoteUrl)}, ` +
        `not the requested URL ${stripUrlCredentials(requestedUrl)}`,
    );
  }
}

/**
 * Clone or pull a git repository.
 *
 * If targetDir doesn't exist: git clone --depth 1, adding `--branch <branch>`
 * when one is requested.
 *
 * If targetDir exists with .git, its remote.origin is verified against the
 * requested URL first, and then:
 *   - without `options.branch`: git pull --ff-only, which updates whichever
 *     branch is already checked out
 *   - with `options.branch`: fetch that ref, then
 *     `checkout -B <branch> origin/<branch>` — so the requested branch, not the
 *     one already checked out, is what ends up in the working tree. Refuses a
 *     dirty tree unless `overwriteLocalChanges` is set.
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
  options?: CloneOrPullOptions,
): Promise<string> {
  // Containment barrier — inline with the canonical path.relative idiom so
  // CodeQL recognizes the sanitizer at every following filesystem and
  // subprocess sink. The same `safeTarget` is used for every downstream
  // path operation — no reassignment that the analyzer could lose track of.
  //
  // The lexical check runs before filesystem creation; realpath and symlink
  // checks below run before pull/clone and again after clone completes.
  const cloneRoot = path.resolve(options?.allowedCloneRoot ?? CLONE_ROOT);
  const expectedRepoName = options?.expectedRepoName;
  if (expectedRepoName !== undefined && expectedRepoName !== extractRepoName(url)) {
    throw new Error(`Clone target repo name ${expectedRepoName} does not match requested URL`);
  }

  const safeTarget = path.resolve(targetDir);
  if (expectedRepoName !== undefined && path.basename(safeTarget) !== expectedRepoName) {
    throw new Error(`Clone target basename must match repository name ${expectedRepoName}`);
  }

  const rel = path.relative(cloneRoot, safeTarget);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Clone target must be a subdirectory of ${cloneRoot}`);
  }

  // Always validate the requested URL — the prior shape only ran this in
  // the code path where the repo was cloned. Now it runs unconditionally,
  // preventing SSRF / blocked-host bypasses even when targetDir already exists.
  if (options?.allowAutoSyncSsh) validateAutoSyncRemoteUrl(url);
  else validateGitUrl(url);
  await fs.mkdir(cloneRoot, { recursive: true });
  if (options?.allowedCloneRoot) {
    await assertDirectoryOwnerAndPermissions(cloneRoot);
  }
  await assertNoSymlinkPath(cloneRoot, safeTarget, Boolean(options?.allowedCloneRoot));
  await fs.mkdir(path.dirname(safeTarget), { recursive: true });
  await assertNoSymlinkPath(cloneRoot, safeTarget, Boolean(options?.allowedCloneRoot));
  await assertPreRealpathContainment(cloneRoot, safeTarget);

  const exists = await fs.access(path.join(safeTarget, '.git')).then(
    () => true,
    () => false,
  );

  const targetExists = await fs.access(safeTarget).then(
    () => true,
    () => false,
  );

  if (exists) {
    if (options?.allowedCloneRoot) {
      await assertNoSymlinkPath(cloneRoot, path.join(safeTarget, '.git'), true);
    }
    await assertPostRealpathContainment(cloneRoot, safeTarget);
    // Confirm the existing clone is actually the same repository the caller
    // requested. Without this check, a pull would silently succeed against
    // whatever remote the dir was originally cloned from.
    await assertRemoteMatchesRequestedUrl(safeTarget, url, options?.timeoutMs);
    onProgress?.({ phase: 'pulling', message: 'Pulling latest changes...' });
    const runGitImpl = options?.runGitForTest ?? runGit;
    if (options?.branch) {
      if (!options.overwriteLocalChanges) {
        const status = await runGitImpl(['status', '--porcelain'], safeTarget, {
          token: options?.token,
          url,
          timeoutMs: options?.timeoutMs,
        });
        if (status.trim()) {
          throw new Error(
            `Refusing to update ${safeTarget}: local changes detected. Set overwrite_local_changes: true to overwrite them.`,
          );
        }
      }
      await runGitImpl(
        [
          'fetch',
          '--depth',
          '1',
          'origin',
          `refs/heads/${options.branch}:refs/remotes/origin/${options.branch}`,
        ],
        safeTarget,
        {
          token: options?.token,
          url,
          timeoutMs: options?.timeoutMs,
        },
      );
      await runGitImpl(
        [
          'checkout',
          ...(options.overwriteLocalChanges ? ['--force'] : []),
          '-B',
          options.branch,
          `origin/${options.branch}`,
        ],
        safeTarget,
        {
          token: options?.token,
          url,
          timeoutMs: options?.timeoutMs,
        },
      );
      if (options.overwriteLocalChanges) {
        // `checkout --force` rewrites tracked files only, so untracked sources
        // left by an operator or an earlier branch survive and then get indexed
        // as if they were part of the remote commit. Deliberately no `-x`/`-X`:
        // ignored paths must survive, and `-e /.gitnexus` is belt-and-braces
        // because `.git/info/exclude` is skipped on a read-only storage mount
        // and a freshly cloned repo may not have been analyzed yet at all.
        await runGitImpl(['clean', '--force', '-d', '-e', '/.gitnexus'], safeTarget, {
          token: options?.token,
          url,
          timeoutMs: options?.timeoutMs,
        });
      }
    } else {
      await runGitImpl(['pull', '--ff-only'], safeTarget, {
        token: options?.token,
        url,
        timeoutMs: options?.timeoutMs,
      });
    }
  } else {
    if (targetExists && (await fs.readdir(safeTarget)).length > 0) {
      throw new Error(`Clone target already exists but is not a git repository: ${safeTarget}`);
    }
    onProgress?.({ phase: 'cloning', message: `Cloning ${url}...` });
    try {
      const runGitImpl = options?.runGitForTest ?? runGit;
      const cloneArgs = options?.branch
        ? buildBranchCloneArgs(url, safeTarget, options.branch)
        : buildCloneArgs(url, safeTarget);
      await runGitImpl(cloneArgs, undefined, {
        token: options?.token,
        url,
        timeoutMs: options?.timeoutMs,
      });
      await assertPostRealpathContainment(cloneRoot, safeTarget);
    } catch (err: unknown) {
      if (options?.quarantineRoot) {
        const partialExists = await fs.access(safeTarget).then(
          () => true,
          () => false,
        );
        if (partialExists) {
          try {
            await quarantineAutoSyncPartial(safeTarget, options.quarantineRoot);
          } catch (quarantineError) {
            throw new AggregateError(
              [err, quarantineError],
              `Clone failed and partial checkout could not be quarantined: ${safeTarget}`,
            );
          }
        }
      }
      throw err;
    }
  }

  return safeTarget;
}

async function assertPreRealpathContainment(root: string, target: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const realParent = await fs.realpath(path.dirname(target));
  const parentRel = path.relative(realRoot, realParent);
  if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) {
    throw new Error(`Clone target parent must resolve inside ${root}`);
  }
}

async function assertPostRealpathContainment(root: string, target: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  const rel = path.relative(realRoot, realTarget);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Clone target must resolve inside ${root}`);
  }
}

async function assertNoSymlinkPath(
  root: string,
  target: string,
  verifyOwnership = false,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) return;
  let current = resolvedRoot;
  for (const segment of relativeTarget.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlink in clone target path: ${current}`);
    }
    if (verifyOwnership) await assertDirectoryOwnerAndPermissions(current);
  }
}

/**
 * Hosts the per-request GitHub PAT may be sent to. Exported so the
 * /api/analyze boundary check and this injection-site check share one
 * allowlist (they must agree, or a token accepted by the API could be
 * silently dropped — or worse — at injection).
 */
export const GITHUB_TOKEN_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);

/**
 * Resolve at most ONE git credential for a clone/pull, by server-side policy
 * keyed on the clone host against a fixed allowlist (never a free-form user
 * toggle):
 *   1. a per-request GitHub PAT — only for hosts in GITHUB_TOKEN_HOSTS;
 *   2. else the server's AZURE_DEVOPS_PAT — only for Azure DevOps hosts;
 *   3. else none.
 * The two host sets are disjoint, so at most one credential ever applies; the
 * GitHub token taking precedence is deterministic for the pathological case
 * where AZURE_DEVOPS_URL is itself configured to a github.com host. Returns
 * the base64 of the Basic-auth `user:secret` pair, or undefined.
 *
 * Security note (re CodeQL js/user-controlled-bypass): the clone URL is
 * user-controlled and selects WHICH credential applies, but it cannot
 * redirect a credential to an arbitrary host — the host is matched against
 * fixed server-side allowlists (GITHUB_TOKEN_HOSTS, isAzureDevOpsUrl's
 * dev.azure.com/*.visualstudio.com/configured AZURE_DEVOPS_URL), and the
 * emitted header is host-scoped (buildExtraHeaderKey). A URL outside the
 * allowlists yields no credential. The selection is therefore server-policy,
 * not a bypass the user can steer.
 */
function resolveGitCredential(options?: { token?: string; url?: string }): string | undefined {
  const url = options?.url;
  if (!url) return undefined;

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  // 1. Per-request GitHub PAT — github.com only (mirrors the /api/analyze
  //    host-bind so the user's token is never sent off github.com).
  if (options.token && GITHUB_TOKEN_HOSTS.has(host)) {
    return Buffer.from(`x-access-token:${options.token}`).toString('base64');
  }

  // 2. Server-configured Azure DevOps PAT — Azure hosts only.
  const azurePat = process.env.AZURE_DEVOPS_PAT;
  if (azurePat && isAzureDevOpsUrl(url)) {
    return Buffer.from(`:${azurePat}`).toString('base64');
  }

  return undefined;
}

/**
 * Build the host-scoped git config key `http.<origin+path>.extraHeader` from
 * the raw clone URL, so the Authorization header is attached only to the
 * intended origin (and its clone sub-requests like /info/refs), never a
 * redirect target. Derived from the SAME raw URL git clones from — not the
 * normalize-for-compare form, which strips `.git` and would desync the key
 * from the wire URL and silently disable the header. Userinfo/query/fragment
 * are dropped (not part of git's URL match) and control characters stripped
 * (git rejects a newline in a config key outright).
 */
function buildExtraHeaderKey(url: string): string | undefined {
  let scoped: string;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    scoped = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
  scoped = scoped.replace(/[\r\n\0]/g, '');
  return `http.${scoped}.extraHeader`;
}

/**
 * Warn (do not block) when a credential is about to be sent over cleartext
 * http://. Base64 is encoding, not encryption, so an on-path observer can
 * read the PAT. We keep http:// working for self-hosted Azure DevOps Server.
 */
function warnIfCleartextCredential(url?: string): void {
  if (!url) return;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') {
      logger.warn(
        `Sending a git credential over cleartext http:// (${u.host}) — base64 is not encryption. Prefer https:// where the host supports it.`,
      );
    }
  } catch {
    /* resolver already validated the URL */
  }
}

/**
 * Build the spawn env for managed `git` commands. Suppresses credential
 * prompts, disables repository hooks, and injects at most one host-scoped
 * Authorization header via the `GIT_CONFIG_*` env protocol (git ≥2.31).
 * Managed settings append after any existing GIT_CONFIG_COUNT. Exported for
 * unit tests.
 */
export function buildGitEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: { token?: string; url?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    // Prevent git from prompting for credentials (hangs the process)
    GIT_TERMINAL_PROMPT: '0',
    // Ensure no credential helper tries to open a GUI prompt
    GIT_ASKPASS: process.platform === 'win32' ? 'echo' : '/bin/true',
    // Scrub git's HTTP/transport trace vars: if inherited from the parent
    // process they dump every request header — including the injected
    // Authorization header — to stderr, which runGit captures and logs.
    // `undefined` makes child_process omit the key from the child env.
    GIT_TRACE: undefined,
    GIT_TRACE_CURL: undefined,
    GIT_TRACE_PACKET: undefined,
    GIT_CURL_VERBOSE: undefined,
  };

  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
  let next = Number.isInteger(existing) && existing > 0 ? existing : 0;
  env[`GIT_CONFIG_KEY_${next}`] = 'core.hooksPath';
  env[`GIT_CONFIG_VALUE_${next}`] = os.devNull;
  next += 1;

  const credential = resolveGitCredential(options);
  const key = options?.url ? buildExtraHeaderKey(options.url) : undefined;
  if (credential && key) {
    env[`GIT_CONFIG_KEY_${next}`] = key;
    env[`GIT_CONFIG_VALUE_${next}`] = `Authorization: Basic ${credential}`;
    next += 1;
    warnIfCleartextCredential(options?.url);
  }
  env.GIT_CONFIG_COUNT = String(next);

  return env;
}

// `options` carries the inputs the credential resolver needs: a per-request
// GitHub `token` and the clone `url`. buildGitEnv injects at most ONE
// host-scoped Authorization header (GitHub PAT for github.com, else the
// server's AZURE_DEVOPS_PAT for Azure hosts) via the GIT_CONFIG_* protocol —
// never in argv. See resolveGitCredential / buildExtraHeaderKey.
export function runGit(args: string[], cwd?: string, options?: RunGitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const spawnGit = options?.spawnForTest ?? spawn;
    const proc = spawnGit('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildGitEnv(process.env, options),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };
    const timer =
      options?.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            proc.kill('SIGTERM');
            killTimer = setTimeout(() => {
              proc.kill('SIGKILL');
              finish(() =>
                reject(new Error(`git ${args[0]} timed out after ${options.timeoutMs}ms`)),
              );
            }, options.timeoutKillGraceMs ?? 1_000);
          }, options.timeoutMs)
        : undefined;
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });

    proc.on('close', (code) => {
      if (timedOut) {
        finish(() => reject(new Error(`git ${args[0]} timed out after ${options?.timeoutMs}ms`)));
        return;
      }
      if (code === 0) finish(() => resolve(stdout));
      else {
        // Log full stderr internally but don't expose it to API callers (SSRF mitigation)
        if (stderr.trim()) logger.error(`git ${args[0]} stderr: ${stderr.trim()}`);
        finish(() => reject(new Error(`git ${args[0]} failed (exit code ${code})`)));
      }
    });

    proc.on('error', (err) => {
      finish(() => reject(new Error(`Failed to spawn git: ${err.message}`)));
    });
  });
}

export const runGitForTest = runGit;
