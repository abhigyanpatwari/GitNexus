import { describe, it, expect } from 'vitest';
import { extractRepoName, getCloneDir, validateGitUrl } from '../../src/server/git-clone.js';
import path from 'node:path';
import os from 'node:os';

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

    it('rejects URLs with shell metacharacters in the last segment', () => {
      // The split on /[/:]/ does not split on backslashes or other shell chars,
      // so a name like `repo;rm -rf /` would slip through without the pattern.
      expect(() => extractRepoName('https://example.com/foo:repo;rm')).toThrow(
        'valid repository name',
      );
      expect(() => extractRepoName('https://example.com/foo:repo$x')).toThrow(
        'valid repository name',
      );
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
      expect(elapsedMs).toBe(elapsedMs); // satisfies vitest "expectation present"
      // Soft sanity check: 10k trailing slashes should resolve in well under
      // 50 ms on any reasonable machine; flag if pathological behaviour returns.
      // (Threshold intentionally loose to avoid CI flakes.)
      if (elapsedMs > 100) {
        throw new Error(`extractRepoName took ${elapsedMs}ms — possible ReDoS regression`);
      }
    });
  });

  describe('getCloneDir', () => {
    it('returns path under ~/.gitnexus/repos/', () => {
      const dir = getCloneDir('my-repo');
      expect(dir).toContain('.gitnexus');
      expect(dir).toMatch(/repos/);
      expect(dir).toContain('my-repo');
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
      const cloneRoot = path.resolve(path.join(os.homedir(), '.gitnexus', 'repos'));
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
      // explicit RFC1918 cases document SSRF coverage for the full private
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
});
