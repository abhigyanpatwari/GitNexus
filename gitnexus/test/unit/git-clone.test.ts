import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';

// The logger is a Proxy with no `set` trap, so vi.spyOn can't patch it.
// Mock the module and expose `warn` as a countable spy (other levels no-op).
const warnSpy = vi.fn();
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnSpy(...args),
    error: () => {},
    trace: () => {},
    fatal: () => {},
  },
}));

import {
  extractRepoName,
  extractWebRepoName,
  getCloneDir,
  validateGitUrl,
  cloneOrPull,
  buildCloneArgs,
  buildBranchCloneArgs,
  buildGitEnv,
  normalizeGitUrlForCompare,
  assertRemoteMatchesRequestedUrl,
  isAzureDevOpsUrl,
  warnIfInsecureAzureConfig,
  runGitForTest,
} from '../../src/server/git-clone.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { getRemoteOriginUrl } from '../../src/storage/git.js';
import { getGlobalDir } from '../../src/storage/repo-manager.js';

// CLONE_ROOT now derives from getGlobalDir() (GITNEXUS_HOME || ~/.gitnexus), so
// assertions must mirror that derivation rather than hardcoding ~/.gitnexus —
// otherwise an ambient GITNEXUS_HOME (e.g. a CI runner that sets it) makes the
// "direct child of the clone root" assertions fail. We call getGlobalDir()
// directly (the same function production CLONE_ROOT uses) so the test cannot
// drift from production if that derivation ever changes. Computed at module
// load, the same point CLONE_ROOT is frozen, so the two always agree.
const EXPECTED_CLONE_ROOT = path.resolve(path.join(getGlobalDir(), 'repos'));

async function mkControlledRoot(prefix: string): Promise<string> {
  const base = path.join(process.cwd(), '.tmp-test');
  await fs.mkdir(base, { recursive: true });
  return fs.realpath(await fs.mkdtemp(path.join(base, prefix)));
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`));
    });
    proc.on('error', reject);
  });
}

describe('git-clone', () => {
  describe('extractRepoName', () => {
    it('extracts name from HTTPS URL', () => {
      expect(extractRepoName('https://github.com/user/my-repo.git')).toBe('my-repo');
    });

    it('extracts name from HTTPS URL without .git suffix', () => {
      expect(extractRepoName('https://github.com/user/my-repo')).toBe('my-repo');
    });

    it('extracts name from SSH URL', () => {
      expect(extractRepoName('git@github.com:user/my-repo.git')).toBe('my-repo');
    });

    it('handles trailing slashes', () => {
      expect(extractRepoName('https://github.com/user/my-repo/')).toBe('my-repo');
    });

    it('handles nested paths', () => {
      expect(extractRepoName('https://gitlab.com/group/subgroup/repo.git')).toBe('repo');
    });

    it('rejects URLs whose last segment is "..": prevents getCloneDir traversal escape', () => {
      // Without the safe-name pattern, a URL ending in `/..` would yield
      // `getCloneDir('..')` = `~/.gitnexus/repos/..` = `~/.gitnexus/`, breaking
      // out of the intended clone root.
      expect(() => extractRepoName('https://github.com/owner/repo:..')).toThrow(
        'valid repository name',
      );
      expect(() => extractRepoName('https://example.com/foo:..')).toThrow('valid repository name');
    });

    it('rejects URLs that yield a single dot', () => {
      expect(() => extractRepoName('https://example.com/foo:.')).toThrow('valid repository name');
    });

    it('rejects empty input', () => {
      expect(() => extractRepoName('')).toThrow('valid repository name');
    });

    it('handles many trailing slashes without polynomial-time blowup', () => {
      // Pathological input the previous /\\/+$/ regex was flagged for
      // (CodeQL js/polynomial-redos). The string-loop replacement is O(n).
      const url = 'https://example.com/repo' + '/'.repeat(10000);
      const start = performance.now();
      expect(extractRepoName(url)).toBe('repo');
      const elapsedMs = performance.now() - start;
      // Threshold of 500ms is intentionally loose to absorb slow CI runners
      // while still catching a true polynomial regression (which would take
      // multiple seconds on 10k slashes).
      expect(elapsedMs).toBeLessThan(500);
    });

    it('rejects leading dashes to prevent argument injection', () => {
      expect(() => extractRepoName('https://github.com/user/--upload-pack=payload.git')).toThrow(
        'valid repository name',
      );
      expect(() => extractRepoName('https://github.com/user/-repo')).toThrow(
        'valid repository name',
      );
    });

    it('rejects unsafe directory characters instead of sanitizing them', () => {
      expect(() => extractRepoName('https://github.com/user/repo<tag>.git')).toThrow(
        'valid repository name',
      );
    });

    it('rejects shell metacharacters in URL segments', () => {
      // The split on /[/:]/ does not split on backslashes or other shell chars,
      // so a name like `repo;rm -rf /` must fail instead of being rewritten.
      expect(() => extractRepoName('https://example.com/foo:repo;rm')).toThrow(
        'valid repository name',
      );
      expect(() => extractRepoName('https://example.com/foo:repo$x')).toThrow(
        'valid repository name',
      );
    });

    it('rejects whitespace and backslashes', () => {
      expect(() => extractRepoName('https://example.com/foo:repo name')).toThrow(
        'valid repository name',
      );
      expect(() => extractRepoName('https://example.com/foo:repo\\name')).toThrow(
        'valid repository name',
      );
    });
  });

  describe('getCloneDir', () => {
    it('returns path under the clone root (getGlobalDir()/repos/)', () => {
      const dir = getCloneDir('my-repo');
      expect(dir).toBe(path.join(EXPECTED_CLONE_ROOT, 'my-repo'));
    });

    it('rejects ".." to prevent path-traversal escape from the clone root', () => {
      expect(() => getCloneDir('..')).toThrow('Invalid repository name');
      expect(() => getCloneDir('.')).toThrow('Invalid repository name');
      expect(() => getCloneDir('')).toThrow('Invalid repository name');
    });

    it('rejects names containing path separators', () => {
      expect(() => getCloneDir('foo/bar')).toThrow('Invalid repository name');
      expect(() => getCloneDir('foo\\bar')).toThrow('Invalid repository name');
    });

    it('returned path is always a direct child of the clone root', () => {
      const cloneRoot = EXPECTED_CLONE_ROOT;
      const dir = getCloneDir('my-repo');
      const rel = path.relative(cloneRoot, path.resolve(dir));
      // path.relative from the parent to the child must be just the child name —
      // no .. and no path separators inside.
      expect(rel).toBe('my-repo');
    });
  });

  describe('validateGitUrl', () => {
    it('allows valid HTTPS GitHub URLs', () => {
      expect(() => validateGitUrl('https://github.com/user/repo.git')).not.toThrow();
      expect(() => validateGitUrl('https://github.com/user/repo')).not.toThrow();
    });

    it('allows valid HTTP URLs', () => {
      expect(() => validateGitUrl('http://gitlab.com/user/repo.git')).not.toThrow();
    });

    it('rejects query strings and fragments instead of reinterpreting clone remotes', () => {
      expect(() => validateGitUrl('https://github.com/user/repo.git?ref=main')).toThrow(
        'must not include query strings or fragments',
      );
      expect(() => validateGitUrl('https://github.com/user/repo.git#main')).toThrow(
        'must not include query strings or fragments',
      );
    });

    it('blocks SSH protocol', () => {
      expect(() => validateGitUrl('ssh://git@github.com/user/repo.git')).toThrow(
        'Only https:// and http://',
      );
    });

    it('blocks file:// protocol', () => {
      expect(() => validateGitUrl('file:///etc/passwd')).toThrow('Only https:// and http://');
    });

    it('blocks IPv4 loopback', () => {
      expect(() => validateGitUrl('http://127.0.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://127.255.0.1/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv6 loopback ::1', () => {
      // Node URL parser strips brackets: hostname is "::1" not "[::1]"
      expect(() => validateGitUrl('http://[::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv4 private ranges (10.x, 172.16-31.x, 192.168.x)', () => {
      expect(() => validateGitUrl('http://10.0.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://172.16.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://172.31.255.255/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://192.168.1.1/repo.git')).toThrow('private/internal');
    });

    it('blocks link-local addresses', () => {
      expect(() => validateGitUrl('http://169.254.1.1/repo.git')).toThrow('private/internal');
    });

    it('blocks cloud metadata hostname', () => {
      expect(() => validateGitUrl('http://metadata.google.internal/repo')).toThrow(
        'private/internal',
      );
      expect(() => validateGitUrl('http://metadata.azure.com/repo')).toThrow('private/internal');
    });

    it('blocks IPv6 ULA (fc/fd)', () => {
      expect(() => validateGitUrl('http://[fc00::1]/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://[fd12::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv6 link-local (fe80)', () => {
      expect(() => validateGitUrl('http://[fe80::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv4-mapped IPv6', () => {
      expect(() => validateGitUrl('http://[::ffff:127.0.0.1]/repo.git')).toThrow(
        'private/internal',
      );
    });

    it('blocks IPv4-compatible IPv6 (RFC 4291 deprecated, ::w.x.y.z)', () => {
      // Node's URL parser collapses ::127.0.0.1 to ::7f00:1 — no ::ffff: marker,
      // but still routable to 127.0.0.1 on most stacks.
      expect(() => validateGitUrl('http://[::127.0.0.1]/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://[::7f00:1]/repo.git')).toThrow('private/internal');
      // 169.254.169.254 (cloud metadata) embedded as IPv4-compatible
      expect(() => validateGitUrl('http://[::a9fe:a9fe]/repo.git')).toThrow('private/internal');
    });

    it('blocks IPv4-compatible IPv6 in expanded / zero-padded forms', () => {
      // The compressed-form check above relies on the WHATWG URL parser
      // normalising fully-expanded inputs to ::xxxx[:yyyy]. These cases pin
      // that assumption: if a future Node release stops collapsing them, a
      // bypass would silently re-open without these tests catching it.
      expect(() => validateGitUrl('http://[0:0:0:0:0:0:7f00:1]/repo.git')).toThrow(
        'private/internal',
      );
      expect(() =>
        validateGitUrl('http://[0000:0000:0000:0000:0000:0000:7f00:0001]/repo.git'),
      ).toThrow('private/internal');
      // Mixed notation: trailing IPv4 quad in an otherwise expanded address.
      expect(() => validateGitUrl('http://[0:0:0:0:0:0:127.0.0.1]/repo.git')).toThrow(
        'private/internal',
      );
    });

    it('blocks NAT64 well-known prefix (64:ff9b::/96)', () => {
      // 64:ff9b::7f00:1 → 127.0.0.1 via NAT64 translation
      expect(() => validateGitUrl('http://[64:ff9b::7f00:1]/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://[64:ff9b::a9fe:a9fe]/repo.git')).toThrow(
        'private/internal',
      );
      // RFC 8215 local NAT64 prefix
      expect(() => validateGitUrl('http://[64:ff9b:1::1]/repo.git')).toThrow('private/internal');
    });

    it('blocks NAT64 with embedded RFC1918 addresses', () => {
      // The startsWith('64:ff9b:') check covers any embedded IPv4. These
      // explicit RFC1918 architectures document SSRF coverage for the full private
      // IPv4 surface — not just loopback and cloud metadata.
      expect(() => validateGitUrl('http://[64:ff9b::a00:1]/repo.git')).toThrow('private/internal'); // 10.0.0.1
      expect(() => validateGitUrl('http://[64:ff9b::ac10:1]/repo.git')).toThrow('private/internal'); // 172.16.0.1
      expect(() => validateGitUrl('http://[64:ff9b::c0a8:101]/repo.git')).toThrow(
        'private/internal',
      ); // 192.168.1.1
    });

    it('blocks 6to4 prefix (2002::/16, RFC 3056)', () => {
      // 6to4 encodes an IPv4 address in bits 17-48, so 2002:WWXX:YYZZ::*
      // routes to W.X.Y.Z on 6to4-capable stacks. The protocol is deprecated
      // (RFC 7526), so the entire 2002::/16 block is defensively rejected.
      expect(() => validateGitUrl('http://[2002:7f00:1::1]/repo.git')).toThrow('private/internal'); // 127.0.0.1
      expect(() => validateGitUrl('http://[2002:a9fe:a9fe::1]/repo.git')).toThrow(
        'private/internal',
      ); // 169.254.169.254
      expect(() => validateGitUrl('http://[2002:c0a8:101::1]/repo.git')).toThrow(
        'private/internal',
      ); // 192.168.1.1
    });

    it('does not block valid public IPs (IPv4 and IPv6)', () => {
      expect(() => validateGitUrl('https://140.82.121.4/repo.git')).not.toThrow();
      // Regression guard against over-blocking legitimate public IPv6.
      // Cloudflare DNS (2606:4700::/32) and Google DNS (2001:4860::/32) —
      // chosen because their prefixes don't collide with any block above.
      expect(() => validateGitUrl('https://[2606:4700:4700::1111]/repo.git')).not.toThrow();
      expect(() => validateGitUrl('https://[2001:4860:4860::8888]/repo.git')).not.toThrow();
      // A public address that merely contains a `ffff` hextet is not IPv4-mapped.
      expect(() => validateGitUrl('https://[2001:4860:ffff::1]/repo.git')).not.toThrow();
    });

    it('blocks CGN range (100.64.0.0/10)', () => {
      expect(() => validateGitUrl('http://100.64.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://100.127.255.255/repo.git')).toThrow('private/internal');
    });

    it('blocks benchmarking range (198.18.0.0/15)', () => {
      expect(() => validateGitUrl('http://198.18.0.1/repo.git')).toThrow('private/internal');
      expect(() => validateGitUrl('http://198.19.255.255/repo.git')).toThrow('private/internal');
    });

    it('blocks numeric decimal IP encoding', () => {
      expect(() => validateGitUrl('http://2130706433/repo.git')).toThrow('private/internal');
    });

    it('blocks hex IP encoding', () => {
      expect(() => validateGitUrl('http://0x7f000001/repo.git')).toThrow('private/internal');
    });

    it('blocks 0.0.0.0', () => {
      expect(() => validateGitUrl('http://0.0.0.0/repo.git')).toThrow('private/internal');
    });
  });

  describe('buildCloneArgs', () => {
    // Closes the test-coverage gap that PR #1325 review (HIGH finding 1)
    // identified for CodeQL js/second-order-command-line-injection alerts
    // #166/#167. The barrier these tests guard is the `--` separator that
    // prevents an option-like URL from being parsed by git as a flag.
    it('places `--` before the URL', () => {
      const args = buildCloneArgs('https://github.com/owner/repo.git', '/safe/target');
      const dashDashIdx = args.indexOf('--');
      const urlIdx = args.indexOf('https://github.com/owner/repo.git');
      expect(dashDashIdx).toBeGreaterThan(-1);
      expect(urlIdx).toBeGreaterThan(dashDashIdx);
    });

    it('treats an option-like URL as a positional argument, not a flag', () => {
      // The exact mitigation for second-order-command-line-injection: a URL
      // beginning with `--` must appear after the `--` separator so git
      // refuses to interpret it as `--upload-pack=evil`.
      const args = buildCloneArgs('--upload-pack=evil', '/safe/target');
      const dashDashIdx = args.indexOf('--');
      const urlIdx = args.indexOf('--upload-pack=evil');
      expect(dashDashIdx).toBeGreaterThan(-1);
      expect(urlIdx).toBeGreaterThan(dashDashIdx);
      // And targetDir comes after URL, also positional.
      expect(args.indexOf('/safe/target')).toBeGreaterThan(urlIdx);
    });

    it('preserves --depth 1 for shallow clones', () => {
      const args = buildCloneArgs('https://github.com/owner/repo.git', '/safe/target');
      const depthIdx = args.indexOf('--depth');
      expect(depthIdx).toBeGreaterThan(-1);
      expect(args[depthIdx + 1]).toBe('1');
      // --depth must be before the `--` separator (it's an option, not a positional).
      expect(depthIdx).toBeLessThan(args.indexOf('--'));
    });

    it('never embeds a token in argv: credentials travel through env, not URL', () => {
      // buildCloneArgs is URL-only; the credential must travel through env
      // (buildGitEnv) so it cannot appear in `ps auxww` or in command logs.
      const args = buildCloneArgs('https://github.com/owner/repo.git', '/safe/target');
      // No credential material in argv — assert on the credential markers
      // directly rather than substring-matching the host (which CodeQL flags
      // as incomplete URL sanitization, js/incomplete-url-substring).
      expect(args.some((a) => a.includes('ghp_'))).toBe(false);
      expect(args.some((a) => a.toLowerCase().includes('authorization'))).toBe(false);
      expect(args.some((a) => a.includes('extraHeader'))).toBe(false);
    });

    it('adds --branch before the URL separator for branch-specific clones', () => {
      const args = buildBranchCloneArgs('git@github.com:owner/repo.git', '/safe/target', 'develop');
      expect(args).toEqual([
        'clone',
        '--depth',
        '1',
        '--branch',
        'develop',
        '--',
        'git@github.com:owner/repo.git',
        '/safe/target',
      ]);
    });
  });

  describe('buildGitEnv — managed git environment', () => {
    // The token MUST travel via GIT_CONFIG_* env vars (git ≥2.31), not via
    // argv or URL. This keeps it out of `ps`, shell history, and stderr.

    it('passes through base env and sets prompt-suppression env vars', () => {
      const env = buildGitEnv({ FOO: 'bar' });
      expect(env.FOO).toBe('bar');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.GIT_ASKPASS).toBeDefined();
    });

    it('scrubs inherited git trace vars that would log the Authorization header', () => {
      const env = buildGitEnv({
        GIT_TRACE: '1',
        GIT_TRACE_CURL: '1',
        GIT_TRACE_PACKET: '1',
        GIT_CURL_VERBOSE: '1',
      });
      expect(env.GIT_TRACE).toBeUndefined();
      expect(env.GIT_TRACE_CURL).toBeUndefined();
      expect(env.GIT_TRACE_PACKET).toBeUndefined();
      expect(env.GIT_CURL_VERBOSE).toBeUndefined();
    });

    it('disables repository hooks even when no token is provided', () => {
      const env = buildGitEnv({});
      expect(env.GIT_CONFIG_COUNT).toBe('1');
      expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
      expect(env.GIT_CONFIG_VALUE_0).toBe(os.devNull);
    });

    it('only disables repository hooks when token is empty string', () => {
      const env = buildGitEnv({}, { token: '' });
      expect(env.GIT_CONFIG_COUNT).toBe('1');
      expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
      expect(env.GIT_CONFIG_VALUE_0).toBe(os.devNull);
    });

    it('injects a host-scoped Basic-auth header when a github.com token is provided', () => {
      const env = buildGitEnv({}, { token: 'ghp_secret123', url: 'https://github.com/owner/repo' });
      expect(env.GIT_CONFIG_COUNT).toBe('2');
      // Host-scoped key: the header attaches only to this origin's requests.
      expect(env.GIT_CONFIG_KEY_1).toBe('http.https://github.com/owner/repo.extraHeader');
      const expected =
        'Authorization: Basic ' + Buffer.from('x-access-token:ghp_secret123').toString('base64');
      expect(env.GIT_CONFIG_VALUE_1).toBe(expected);
    });

    it('does not inject a token for a non-github host (defense-in-depth host bind)', () => {
      const env = buildGitEnv({}, { token: 'ghp_secret123', url: 'https://gitlab.com/owner/repo' });
      expect(env.GIT_CONFIG_COUNT).toBe('1');
    });

    it('never includes the raw token value in any env entry', () => {
      // Defence-in-depth: token must only appear inside the base64 of the
      // Authorization header, never as a plain substring of any env var.
      const token = 'ghp_uniqueRawSecret_98765';
      const env = buildGitEnv({ EXISTING: 'value' }, { token, url: 'https://github.com/o/r' });
      for (const [key, value] of Object.entries(env)) {
        if (key === 'GIT_CONFIG_VALUE_1') continue;
        expect(String(value)).not.toContain(token);
      }
    });

    it('injects the server Azure PAT (host-scoped) for an Azure URL', () => {
      const prev = process.env.AZURE_DEVOPS_PAT;
      process.env.AZURE_DEVOPS_PAT = 'azure-pat-xyz';
      try {
        const env = buildGitEnv({}, { url: 'https://dev.azure.com/org/proj/_git/repo' });
        expect(env.GIT_CONFIG_COUNT).toBe('2');
        expect(env.GIT_CONFIG_KEY_1).toBe(
          'http.https://dev.azure.com/org/proj/_git/repo.extraHeader',
        );
        const expected = 'Authorization: Basic ' + Buffer.from(':azure-pat-xyz').toString('base64');
        expect(env.GIT_CONFIG_VALUE_1).toBe(expected);
      } finally {
        if (prev === undefined) delete process.env.AZURE_DEVOPS_PAT;
        else process.env.AZURE_DEVOPS_PAT = prev;
      }
    });

    it('emits EXACTLY ONE header when a github token and an Azure PAT could both apply', () => {
      // A token only injects for github.com (where isAzureDevOpsUrl is false),
      // so the two never collide — guard the resolver directly anyway.
      const prev = process.env.AZURE_DEVOPS_PAT;
      process.env.AZURE_DEVOPS_PAT = 'azure-pat-xyz';
      try {
        const env = buildGitEnv({}, { token: 'ghp_secret123', url: 'https://github.com/o/r' });
        expect(env.GIT_CONFIG_COUNT).toBe('2');
        expect(env.GIT_CONFIG_VALUE_2).toBeUndefined();
        for (const value of Object.values(env)) {
          expect(String(value)).not.toContain('azure-pat-xyz');
        }
      } finally {
        if (prev === undefined) delete process.env.AZURE_DEVOPS_PAT;
        else process.env.AZURE_DEVOPS_PAT = prev;
      }
    });

    it('appends after an existing GIT_CONFIG_COUNT instead of overwriting it', () => {
      const env = buildGitEnv(
        { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.sslVerify', GIT_CONFIG_VALUE_0: 'true' },
        { token: 'ghp_secret123', url: 'https://github.com/o/r' },
      );
      expect(env.GIT_CONFIG_COUNT).toBe('3');
      // Operator's pre-existing config is preserved at index 0.
      expect(env.GIT_CONFIG_KEY_0).toBe('http.sslVerify');
      expect(env.GIT_CONFIG_VALUE_0).toBe('true');
      expect(env.GIT_CONFIG_KEY_1).toBe('core.hooksPath');
      expect(env.GIT_CONFIG_VALUE_1).toBe(os.devNull);
      expect(env.GIT_CONFIG_KEY_2).toBe('http.https://github.com/o/r.extraHeader');
      expect(env.GIT_CONFIG_VALUE_2).toContain('Authorization: Basic ');
    });

    it('overrides an inherited hooks path with the managed safe value', () => {
      const env = buildGitEnv({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '/tmp/untrusted-hooks',
      });
      expect(env.GIT_CONFIG_COUNT).toBe('2');
      expect(env.GIT_CONFIG_KEY_1).toBe('core.hooksPath');
      expect(env.GIT_CONFIG_VALUE_1).toBe(os.devNull);
    });

    it('does not execute hooks from an existing repository', async () => {
      if (process.platform === 'win32') return;
      const root = await mkControlledRoot('gitnexus-managed-git-');
      const marker = path.join(root, 'hook-ran');
      try {
        await runGit(['init', '--initial-branch=main'], root);
        await runGit(['config', 'user.email', 'test@example.com'], root);
        await runGit(['config', 'user.name', 'GitNexus Test'], root);
        await fs.writeFile(path.join(root, 'README.md'), 'test\n');
        await runGit(['add', 'README.md'], root);
        await runGit(['commit', '-m', 'initial'], root);
        const hook = path.join(root, '.git', 'hooks', 'post-checkout');
        await fs.writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
        await fs.chmod(hook, 0o700);

        await runGitForTest(['checkout', '-b', 'next'], root);

        await expect(fs.access(marker)).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('strips control characters from the config key (no key injection)', () => {
      const env = buildGitEnv(
        {},
        { token: 'ghp_secret123', url: 'https://github.com/o/r%0Anewline' },
      );
      const key = env.GIT_CONFIG_KEY_1 ?? '';
      expect(key).not.toContain('\n');
      expect(key).not.toContain('\r');
    });
  });

  describe('cloneOrPull — containment barrier', () => {
    // Closes the test-coverage gap that PR #1325 review (HIGH finding 1)
    // identified for CodeQL js/path-injection alerts #176/#177/#178. The
    // barrier these tests guard is the path.relative containment check at
    // the entry of cloneOrPull, which must reject any targetDir not strictly
    // inside CLONE_ROOT before any filesystem or subprocess sink.
    //
    // These tests do NOT mock spawn — the barrier throws synchronously
    // before git is invoked, so the rejection is observable directly.
    const cloneRoot = EXPECTED_CLONE_ROOT;

    it('rejects an absolute target outside CLONE_ROOT', async () => {
      await expect(cloneOrPull('https://github.com/a/b.git', '/etc/passwd')).rejects.toThrow(
        'Clone target must be a subdirectory',
      );
    });

    it('rejects CLONE_ROOT itself (the rel === "" branch)', async () => {
      await expect(cloneOrPull('https://github.com/a/b.git', cloneRoot)).rejects.toThrow(
        'Clone target must be a subdirectory',
      );
    });

    it('rejects a parent-directory traversal attempt', async () => {
      await expect(
        cloneOrPull('https://github.com/a/b.git', path.join(cloneRoot, '..', 'escape')),
      ).rejects.toThrow('Clone target must be a subdirectory');
    });

    it('rejects a sibling directory with a common prefix (CLONE_ROOT-evil)', async () => {
      // Classic startsWith(root + sep) pitfall: '/x/repos' does not catch
      // '/x/repos-evil/...'. The path.relative idiom does, and the test
      // documents that property at the cloneOrPull boundary.
      await expect(cloneOrPull('https://github.com/a/b.git', cloneRoot + '-evil')).rejects.toThrow(
        'Clone target must be a subdirectory',
      );
    });

    // Closes the SSRF-bypass vector that Codex's adversarial review on
    // PR #1325 surfaced: validateGitUrl was only called in the clone
    // branch. An attacker URL that shared a basename with an existing
    // clone would skip the SSRF check entirely on the pull path.
    //
    // The barrier-pass-but-validateGitUrl-throw case here works because
    // cloneOrPull validates the URL after the containment check and before
    // the existence probe, so the rejection fires regardless of whether
    // the target dir exists on disk.
    it('rejects URLs that fail validateGitUrl even when the target shape is valid', async () => {
      const fakeTarget = path.join(cloneRoot, 'name-that-does-not-exist');
      await expect(cloneOrPull('http://127.0.0.1/repo.git', fakeTarget)).rejects.toThrow(
        'private/internal',
      );
      await expect(cloneOrPull('http://localhost/repo.git', fakeTarget)).rejects.toThrow(
        'private/internal',
      );
      await expect(cloneOrPull('file:///etc/passwd', fakeTarget)).rejects.toThrow(
        'Only https:// and http://',
      );
    });

    it('keeps regular cloneOrPull restricted to http and https URLs', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      try {
        await expect(
          cloneOrPull('git@github.com:owner/repo.git', path.join(root, 'repo'), undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
          }),
        ).rejects.toThrow('Invalid URL');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('creates missing nested parents before checking controlled clone containment', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const target = path.join(root, 'github.com', 'owner', 'repo');
      const runGitForTest = vi.fn(async () => {
        await fs.mkdir(path.join(target, '.git'), { recursive: true });
        return '';
      });
      try {
        await expect(
          cloneOrPull('git@github.com:owner/repo', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
            allowAutoSyncSsh: true,
            runGitForTest,
          }),
        ).resolves.toBe(target);

        expect(runGitForTest).toHaveBeenCalledOnce();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('allows auto-sync SSH SCP clone URLs with a per-repo timeout', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const target = path.join(root, 'repo');
      const runGitForTest = vi.fn(async () => {
        await fs.mkdir(target);
        return '';
      });
      try {
        await expect(
          cloneOrPull('git@gitlab.com:group/subgroup/repo.git', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
            allowAutoSyncSsh: true,
            timeoutMs: 10_000,
            branch: 'develop',
            runGitForTest,
          }),
        ).resolves.toBe(target);

        expect(runGitForTest).toHaveBeenCalledWith(
          [
            'clone',
            '--depth',
            '1',
            '--branch',
            'develop',
            '--',
            'git@gitlab.com:group/subgroup/repo.git',
            target,
          ],
          undefined,
          { token: undefined, url: 'git@gitlab.com:group/subgroup/repo.git', timeoutMs: 10_000 },
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('allows an explicitly controlled auto-sync clone root outside the default root', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      try {
        const target = path.join(root, 'repo');
        await expect(
          cloneOrPull('http://127.0.0.1/repo.git', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
          }),
        ).rejects.toThrow('private/internal');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('rejects controlled-root target names that do not match the remote repo name', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      try {
        await expect(
          cloneOrPull('https://example.com/team/repo.git', path.join(root, 'other'), undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
          }),
        ).rejects.toThrow('basename must match');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('rejects symlink children before clone or pull', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const outside = await mkControlledRoot('gitnexus-outside-');
      try {
        await fs.symlink(outside, path.join(root, 'repo'));
        await expect(
          cloneOrPull('https://example.com/team/repo.git', path.join(root, 'repo'), undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
          }),
        ).rejects.toThrow('symlink');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('rejects writable existing directories below a controlled clone root', async () => {
      if (process.platform === 'win32') return;
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const namespace = path.join(root, 'team');
      try {
        await fs.mkdir(namespace);
        await fs.chmod(namespace, 0o777);
        await expect(
          cloneOrPull(
            'https://example.com/team/repo.git',
            path.join(namespace, 'repo'),
            undefined,
            {
              allowedCloneRoot: root,
              expectedRepoName: 'repo',
            },
          ),
        ).rejects.toThrow('world-writable');
      } finally {
        await fs.chmod(namespace, 0o700).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('rejects writable .git metadata in an existing controlled clone', async () => {
      if (process.platform === 'win32') return;
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const target = path.join(root, 'repo');
      const gitDir = path.join(target, '.git');
      try {
        await fs.mkdir(gitDir, { recursive: true });
        await fs.chmod(gitDir, 0o777);
        await expect(
          cloneOrPull('https://example.com/team/repo.git', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
          }),
        ).rejects.toThrow('world-writable');
      } finally {
        await fs.chmod(gitDir, 0o700).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('rejects symlinked .git metadata in an existing controlled clone', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const outside = await mkControlledRoot('gitnexus-outside-git-dir-');
      const target = path.join(root, 'repo');
      try {
        await fs.mkdir(target);
        await fs.symlink(outside, path.join(target, '.git'));
        await expect(
          cloneOrPull('https://example.com/team/repo.git', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
          }),
        ).rejects.toThrow('symlink');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('rejects existing clones whose remote origin mismatches the requested URL', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const target = path.join(root, 'repo');
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('git', ['init'], { cwd: root, stdio: 'ignore' });
          proc.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`git init ${code}`)),
          );
          proc.on('error', reject);
        });
        await fs.rename(path.join(root, '.git'), path.join(target, '.git')).catch(async () => {
          await fs.mkdir(target);
          await fs.rename(path.join(root, '.git'), path.join(target, '.git'));
        });
        await fs.writeFile(
          path.join(target, '.git', 'config'),
          [
            '[remote "origin"]',
            '\turl = https://example.com/other/repo.git',
            '\tfetch = +refs/heads/*:refs/remotes/origin/*',
            '',
          ].join('\n'),
        );

        await expect(
          cloneOrPull('https://example.com/team/repo.git', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
          }),
        ).rejects.toThrow('not the requested URL');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('switches a shallow single-branch clone to a fallback branch', async () => {
      const root = await mkControlledRoot('gitnexus-shallow-fallback-');
      const source = path.join(root, 'source');
      const remote = path.join(root, 'remote.git');
      const target = path.join(root, 'repo');
      const remoteUrl = 'git@github.com:team/repo.git';
      const gitConfig = path.join(root, 'gitconfig');
      const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
      const previousNoSystemConfig = process.env.GIT_CONFIG_NOSYSTEM;

      try {
        await runGit(['init', '--bare', remote], root);
        await runGit(['init', '--initial-branch=master', source], root);
        await runGit(['config', 'user.email', 'test@example.com'], source);
        await runGit(['config', 'user.name', 'GitNexus Test'], source);
        await fs.writeFile(path.join(source, 'branch.txt'), 'master\n');
        await runGit(['add', 'branch.txt'], source);
        await runGit(['commit', '-m', 'master'], source);
        await runGit(['checkout', '-b', 'main'], source);
        await fs.writeFile(path.join(source, 'branch.txt'), 'main\n');
        await runGit(['commit', '-am', 'main'], source);
        await runGit(['remote', 'add', 'origin', `file://${remote}`], source);
        await runGit(['push', 'origin', 'master', 'main'], source);

        await fs.writeFile(
          gitConfig,
          `[protocol "file"]\n\tallow = always\n[url "file://${remote}"]\n\tinsteadOf = ${remoteUrl}\n`,
        );
        process.env.GIT_CONFIG_GLOBAL = gitConfig;
        process.env.GIT_CONFIG_NOSYSTEM = '1';

        await runGit(['clone', '--depth', '1', '--branch', 'master', remoteUrl, target], root);
        await expect(
          runGit(['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], target),
        ).rejects.toThrow();
        await expect(runGit(['rev-parse', '--is-shallow-repository'], target)).resolves.toBe(
          'true\n',
        );

        await fs.writeFile(path.join(target, 'branch.txt'), 'local changes\n');
        await expect(
          cloneOrPull(remoteUrl, target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
            allowAutoSyncSsh: true,
            branch: 'main',
          }),
        ).rejects.toThrow();
        await expect(fs.readFile(path.join(target, 'branch.txt'), 'utf8')).resolves.toBe(
          'local changes\n',
        );

        await cloneOrPull(remoteUrl, target, undefined, {
          allowedCloneRoot: root,
          expectedRepoName: 'repo',
          allowAutoSyncSsh: true,
          branch: 'main',
          overwriteLocalChanges: true,
        });

        await expect(runGit(['branch', '--show-current'], target)).resolves.toBe('main\n');
        await expect(fs.readFile(path.join(target, 'branch.txt'), 'utf8')).resolves.toBe('main\n');
        await expect(runGit(['rev-parse', 'main'], target)).resolves.toBe(
          await runGit(['rev-parse', 'origin/main'], target),
        );
      } finally {
        if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
        if (previousNoSystemConfig === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
        else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystemConfig;
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('clones into a pre-existing empty target directory', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const target = path.join(root, 'repo');
      const runGitForTest = vi.fn(async () => '');
      try {
        await fs.mkdir(target);
        await expect(
          cloneOrPull('https://example.com/team/repo.git', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
            runGitForTest,
          }),
        ).resolves.toBe(target);
        expect(runGitForTest).toHaveBeenCalled();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('quarantines partial auto-sync clone output on clone failure', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const quarantineRoot = path.join(root, 'quarantine');
      const target = path.join(root, 'repo');
      try {
        await expect(
          cloneOrPull('https://example.com/team/repo.git', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
            quarantineRoot,
            runGitForTest: async () => {
              await fs.mkdir(target);
              await fs.writeFile(path.join(target, 'partial.txt'), 'partial', 'utf-8');
              throw new Error('git clone failed (exit code 128)');
            },
          }),
        ).rejects.toThrow('git clone failed');

        const entries = await fs.readdir(quarantineRoot);
        expect(
          entries.some((entry) => entry.startsWith('auto-sync-') && entry.endsWith('-repo')),
        ).toBe(true);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('does not quarantine an existing non-git directory on clone failure', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      const quarantineRoot = path.join(root, 'quarantine');
      const target = path.join(root, 'repo');
      try {
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, 'user-file.txt'), 'keep me', 'utf-8');

        await expect(
          cloneOrPull('https://example.com/team/repo.git', target, undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
            quarantineRoot,
          }),
        ).rejects.toThrow('already exists but is not a git repository');

        await expect(fs.readFile(path.join(target, 'user-file.txt'), 'utf-8')).resolves.toBe(
          'keep me',
        );
        await expect(fs.access(quarantineRoot)).rejects.toThrow();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('rejects controlled clone roots with unsafe permissions inside cloneOrPull', async () => {
      const root = await mkControlledRoot('gitnexus-controlled-root-');
      try {
        await fs.chmod(root, 0o777);
        await expect(
          cloneOrPull('https://example.com/team/repo.git', path.join(root, 'repo'), undefined, {
            allowedCloneRoot: root,
            expectedRepoName: 'repo',
          }),
        ).rejects.toThrow('world-writable');
      } finally {
        await fs.chmod(root, 0o700).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('isAzureDevOpsUrl', () => {
    it('recognizes dev.azure.com (cloud)', () => {
      expect(isAzureDevOpsUrl('https://dev.azure.com/org/project/_git/repo')).toBe(true);
    });

    it('recognizes *.visualstudio.com (cloud legacy)', () => {
      expect(isAzureDevOpsUrl('https://myorg.visualstudio.com/project/_git/repo')).toBe(true);
    });

    it('returns false for github.com', () => {
      expect(isAzureDevOpsUrl('https://github.com/user/repo')).toBe(false);
    });

    it('returns false for gitlab.com', () => {
      expect(isAzureDevOpsUrl('https://gitlab.com/user/repo')).toBe(false);
    });

    it('returns false for invalid URL', () => {
      expect(isAzureDevOpsUrl('not-a-url')).toBe(false);
    });

    it('normalizes a trailing-dot FQDN (dev.azure.com.)', () => {
      expect(isAzureDevOpsUrl('https://dev.azure.com./org/proj/_git/repo')).toBe(true);
      expect(isAzureDevOpsUrl('https://myorg.visualstudio.com./project/_git/repo')).toBe(true);
    });

    it('does not over-match a lookalike host with a trailing label', () => {
      expect(isAzureDevOpsUrl('https://dev.azure.com.evil.com/org/proj/_git/repo')).toBe(false);
      expect(isAzureDevOpsUrl('https://evilvisualstudio.com/project/_git/repo')).toBe(false);
    });

    it('recognizes a self-hosted host configured via AZURE_DEVOPS_URL', () => {
      const prev = process.env.AZURE_DEVOPS_URL;
      try {
        process.env.AZURE_DEVOPS_URL = 'http://tfs.corp.example';
        expect(isAzureDevOpsUrl('http://tfs.corp.example/Coll/Proj/_git/Repo')).toBe(true);
        expect(isAzureDevOpsUrl('https://other.host.example/Coll/Proj/_git/Repo')).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.AZURE_DEVOPS_URL;
        else process.env.AZURE_DEVOPS_URL = prev;
      }
    });

    it('falls through to the cloud check when AZURE_DEVOPS_URL is invalid', () => {
      const prev = process.env.AZURE_DEVOPS_URL;
      try {
        process.env.AZURE_DEVOPS_URL = 'not-a-url';
        expect(isAzureDevOpsUrl('https://dev.azure.com/org/proj/_git/repo')).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.AZURE_DEVOPS_URL;
        else process.env.AZURE_DEVOPS_URL = prev;
      }
    });
  });

  describe('cleartext-credential warnings', () => {
    it('warns when injecting a credential over cleartext http://', () => {
      warnSpy.mockClear();
      buildGitEnv({}, { token: 'ghp_x', url: 'http://github.com/o/r' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when injecting over https://', () => {
      warnSpy.mockClear();
      buildGitEnv({}, { token: 'ghp_x', url: 'https://github.com/o/r' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn over http:// when no credential is injected', () => {
      warnSpy.mockClear();
      // gitlab host is not in the token allowlist and no Azure PAT is set,
      // so nothing is injected — and nothing is warned about.
      buildGitEnv({}, { token: 'ghp_x', url: 'http://gitlab.com/o/r' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warnIfInsecureAzureConfig warns for http AZURE_DEVOPS_URL, not https', () => {
      const prev = process.env.AZURE_DEVOPS_URL;
      warnSpy.mockClear();
      try {
        process.env.AZURE_DEVOPS_URL = 'http://tfs.corp.example';
        warnIfInsecureAzureConfig();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockClear();
        process.env.AZURE_DEVOPS_URL = 'https://tfs.corp.example';
        warnIfInsecureAzureConfig();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        if (prev === undefined) delete process.env.AZURE_DEVOPS_URL;
        else process.env.AZURE_DEVOPS_URL = prev;
      }
    });
  });

  describe('extractRepoName — Azure DevOps URLs', () => {
    it('extracts name from self-hosted Azure DevOps URL', () => {
      expect(
        extractRepoName('http://azuredevops.example.com/DefaultCollection/MyProject/_git/MyRepo'),
      ).toBe('MyRepo');
    });

    it('extracts name from dev.azure.com URL', () => {
      expect(extractRepoName('https://dev.azure.com/org/project/_git/myrepo')).toBe('myrepo');
    });

    it('extracts name from visualstudio.com URL', () => {
      expect(extractRepoName('https://myorg.visualstudio.com/project/_git/myrepo')).toBe('myrepo');
    });
  });

  describe('extractWebRepoName — API clone compatibility', () => {
    it('sanitizes repo names with spaces and unsafe directory characters at the web boundary', () => {
      expect(extractWebRepoName('https://dev.azure.com/org/project/_git/My Repo With Spaces')).toBe(
        'My_Repo_With_Spaces',
      );
      expect(extractWebRepoName('https://example.com/team/repo$name.git')).toBe('repo_name');
    });

    it('keeps Windows reserved names from becoming clone directories', () => {
      expect(() => extractWebRepoName('https://example.com/team/CON.git')).toThrow(
        'valid repository name',
      );
      expect(() => extractWebRepoName('https://example.com/team/NUL.txt')).toThrow(
        'valid repository name',
      );
    });

    it('leaves strict extractRepoName behavior unchanged for internal callers', () => {
      expect(() => extractRepoName('https://example.com/team/repo$name.git')).toThrow(
        'valid repository name',
      );
    });
  });

  describe('validateGitUrl — Azure DevOps URLs', () => {
    it('allows self-hosted Azure DevOps Server URLs', () => {
      expect(() =>
        validateGitUrl('http://azuredevops.example.com/DefaultCollection/Project/_git/Repo'),
      ).not.toThrow();
    });

    it('allows dev.azure.com URLs', () => {
      expect(() => validateGitUrl('https://dev.azure.com/org/project/_git/repo')).not.toThrow();
    });
  });

  describe('normalizeGitUrlForCompare', () => {
    it('strips trailing .git', () => {
      expect(normalizeGitUrlForCompare('https://github.com/owner/repo.git')).toBe(
        normalizeGitUrlForCompare('https://github.com/owner/repo'),
      );
    });

    it('strips trailing slashes', () => {
      expect(normalizeGitUrlForCompare('https://github.com/owner/repo/')).toBe(
        normalizeGitUrlForCompare('https://github.com/owner/repo'),
      );
      expect(normalizeGitUrlForCompare('https://github.com/owner/repo///')).toBe(
        normalizeGitUrlForCompare('https://github.com/owner/repo'),
      );
    });

    it('lowercases the hostname but preserves path case', () => {
      expect(normalizeGitUrlForCompare('https://GitHub.com/owner/Repo.git')).toBe(
        normalizeGitUrlForCompare('https://github.com/owner/Repo'),
      );
      // Different path case → distinct repos (hosts treat path as case-sensitive on the wire)
      expect(normalizeGitUrlForCompare('https://github.com/owner/repo')).not.toBe(
        normalizeGitUrlForCompare('https://github.com/owner/REPO'),
      );
    });

    it('strips default ports', () => {
      expect(normalizeGitUrlForCompare('https://github.com:443/owner/repo')).toBe(
        normalizeGitUrlForCompare('https://github.com/owner/repo'),
      );
      expect(normalizeGitUrlForCompare('http://github.com:80/owner/repo')).toBe(
        normalizeGitUrlForCompare('http://github.com/owner/repo'),
      );
    });

    it('preserves non-default ports', () => {
      expect(normalizeGitUrlForCompare('https://git.corp:8443/owner/repo')).not.toBe(
        normalizeGitUrlForCompare('https://git.corp/owner/repo'),
      );
    });

    it('strips userinfo (basic auth) so equivalent URLs compare equal', () => {
      expect(normalizeGitUrlForCompare('https://user:pass@github.com/owner/repo.git')).toBe(
        normalizeGitUrlForCompare('https://github.com/owner/repo'),
      );
    });

    it('treats different hosts as distinct', () => {
      expect(normalizeGitUrlForCompare('https://github.com/owner/repo')).not.toBe(
        normalizeGitUrlForCompare('https://gitlab.com/owner/repo'),
      );
    });

    it('treats different paths on the same host as distinct', () => {
      expect(normalizeGitUrlForCompare('https://github.com/owner/repo')).not.toBe(
        normalizeGitUrlForCompare('https://github.com/attacker/repo'),
      );
    });
  });

  describe('assertRemoteMatchesRequestedUrl', () => {
    // Closes the wrong-repo silent-analysis vector that Codex's adversarial
    // review on PR #1325 surfaced. Tests use a tmpdir-based fixture
    // (anywhere on disk — independent of CLONE_ROOT) so the helper can be
    // exercised without polluting the user's actual clone root.
    let fixtureDir: string;

    beforeAll(async () => {
      fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-remote-match-'));
      // git init + set remote.origin.url. We can't call git init via runGit
      // since it's private; spawn directly.
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('git', ['init', '--quiet'], { cwd: fixtureDir, stdio: 'ignore' });
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`git init exit ${code}`)),
        );
        proc.on('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          'git',
          ['config', 'remote.origin.url', 'https://github.com/legitorg/myproject.git'],
          { cwd: fixtureDir, stdio: 'ignore' },
        );
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`git config exit ${code}`)),
        );
        proc.on('error', reject);
      });
    });

    afterAll(async () => {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    });

    it('accepts the requested URL when it matches the configured remote', async () => {
      await expect(
        assertRemoteMatchesRequestedUrl(fixtureDir, 'https://github.com/legitorg/myproject.git'),
      ).resolves.toBeUndefined();
    });

    it('accepts equivalent forms (with/without .git, trailing slash, default port)', async () => {
      await expect(
        assertRemoteMatchesRequestedUrl(fixtureDir, 'https://github.com/legitorg/myproject'),
      ).resolves.toBeUndefined();
      await expect(
        assertRemoteMatchesRequestedUrl(fixtureDir, 'https://github.com/legitorg/myproject/'),
      ).resolves.toBeUndefined();
      await expect(
        assertRemoteMatchesRequestedUrl(
          fixtureDir,
          'https://github.com:443/legitorg/myproject.git',
        ),
      ).resolves.toBeUndefined();
    });

    // The exact wrong-repo vector from Codex's review:
    //   existing clone → github.com/legitorg/myproject
    //   request URL    → gitlab.example/attacker/myproject
    // Both share the basename 'myproject'. Without this check, the pull
    // would succeed and analysis would return wrong-repo data.
    it('rejects a different host with the same basename', async () => {
      await expect(
        assertRemoteMatchesRequestedUrl(
          fixtureDir,
          'https://gitlab.example/attacker/myproject.git',
        ),
      ).rejects.toThrow('not the requested URL');
    });

    it('rejects a different owner on the same host', async () => {
      await expect(
        assertRemoteMatchesRequestedUrl(fixtureDir, 'https://github.com/attacker/myproject.git'),
      ).rejects.toThrow('not the requested URL');
    });

    it('rejects when the directory has no remote.origin', async () => {
      const noRemoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-no-remote-'));
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn('git', ['init', '--quiet'], { cwd: noRemoteDir, stdio: 'ignore' });
          proc.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`git init exit ${code}`)),
          );
          proc.on('error', reject);
        });
        await expect(
          assertRemoteMatchesRequestedUrl(noRemoteDir, 'https://github.com/owner/repo.git'),
        ).rejects.toThrow('no remote.origin');
      } finally {
        await fs.rm(noRemoteDir, { recursive: true, force: true });
      }
    });
  });

  describe('getRemoteOriginUrl', () => {
    it('returns null for a directory that is not a git repository', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-not-git-'));
      try {
        const result = await getRemoteOriginUrl(tmp);
        expect(result).toBeNull();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('runGit timeout', () => {
    it('rejects after SIGKILL even when the child never closes', async () => {
      vi.useFakeTimers();
      try {
        const child = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        const spawnForTest = vi.fn(() => child) as unknown as typeof spawn;

        const promise = runGitForTest(['clone'], undefined, {
          timeoutMs: 20,
          timeoutKillGraceMs: 20,
          spawnForTest,
        });

        await vi.advanceTimersByTimeAsync(25);
        let settled = false;
        promise
          .catch(() => {})
          .finally(() => {
            settled = true;
          });
        await vi.runAllTicks();
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(25);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        await expect(promise).rejects.toThrow('timed out after 20ms');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
