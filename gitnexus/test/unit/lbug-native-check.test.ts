import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { checkLbugNative, glibcTooOldMessage } from '../../src/core/lbug/native-check.js';

describe('checkLbugNative', () => {
  it('returns ok:true when the real @ladybugdb/core binary is present', () => {
    const result = checkLbugNative();
    expect(result.ok).toBe(true);
    expect(result.binaryPath).toBeDefined();
    expect(result.message).toBeUndefined();
  });

  it('returns ok:false with repair instructions when lbugjs.node is missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'install.js'), '');

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('missing');
      expect(result.message).toContain('install.js');
      expect(result.message).toContain('trustedDependencies');
      expect(result.message).toContain('ignore-scripts');
      expect(result.message).toContain('--allow-build=@ladybugdb/core');
      expect(result.message).toContain('pnpm add -g --allow-build=@ladybugdb/core');
      const allowBuildIdx = result.message!.indexOf('--allow-build=@ladybugdb/core');
      const dlxIdx = result.message!.indexOf('dlx gitnexus');
      expect(allowBuildIdx).toBeGreaterThanOrEqual(0);
      expect(dlxIdx).toBeGreaterThan(allowBuildIdx);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns ok:false when lbugjs.node exists but is unloadable (zero-byte)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), Buffer.alloc(0));

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('failed to load');
      expect(result.message).toContain('install.js');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns ok:false when lbugjs.node is truncated (loader crashes with a signal)', async () => {
    // A partially written .node (valid header, missing pages) SIGBUSes dlopen — a
    // signal, not a catchable throw. The out-of-process probe must observe the
    // crash and report it, instead of the whole process dying with exit 135 (#2441).
    const realPath = checkLbugNative().binaryPath;
    expect(realPath).toBeDefined();
    const truncated = (await fs.readFile(realPath!)).subarray(0, 300_000);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'install.js'), '');
      await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), truncated);

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(false);
      expect(result.message).toContain('failed to load');
      expect(result.message).toContain('install.js');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not prescribe a reinstall when the host glibc is too old (#2672)', async () => {
    // The generic failure text ("truncated / ABI mismatch / re-run install.js")
    // is actively wrong for this class: the reinstall re-downloads the identical
    // prebuilt binary and fails identically. Guard the whole assembled message,
    // not just the helper, so the branch stays wired into checkLbugNative.
    const message = glibcTooOldMessage(
      "Error: /lib64/libc.so.6: version `GLIBC_2.34' not found (required by " +
        '/usr/lib/node_modules/gitnexus/node_modules/@ladybugdb/core/lbugjs.node)',
    );

    expect(message).toContain('glibc 2.34 or newer');
    expect(message).toContain('will NOT help');
    expect(message).not.toContain('install.js');
    expect(message).not.toContain('trustedDependencies');
    expect(message).not.toContain('--allow-build');
  });

  // POSIX-only: the fake "node" is a shebang script, which Windows cannot exec.
  // The real Windows path has no glibc, so this class cannot occur there anyway.
  it.skipIf(process.platform === 'win32')(
    'checkLbugNative routes a glibc load failure to that message, not the reinstall text',
    async () => {
      // Proves the branch is WIRED, not merely present: the probe child is
      // replaced by a script that emits the loader error the #2672 reporter saw.
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-glibc-'));
      const originalExecPath = process.execPath;
      try {
        await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), Buffer.from('content-irrelevant'));
        await fs.writeFile(path.join(tmpDir, 'install.js'), '');
        const fakeNode = path.join(tmpDir, 'fake-node');
        await fs.writeFile(
          fakeNode,
          '#!/bin/sh\n' +
            'echo "Error: /lib64/libc.so.6: version \\`GLIBC_2.34\' not found' +
            ' (required by /x/@ladybugdb/core/lbugjs.node)" >&2\n' +
            'exit 1\n',
        );
        await fs.chmod(fakeNode, 0o755);
        process.execPath = fakeNode;

        const result = checkLbugNative(tmpDir);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('glibc 2.34 or newer');
        expect(result.message).toContain('will NOT help');
        expect(result.message).not.toContain('install.js');
      } finally {
        process.execPath = originalExecPath;
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it('names this host glibc alongside the required one', () => {
    const message = glibcTooOldMessage("version `GLIBC_2.34' not found");
    // Never pin the runner's own glibc — assert the line is populated either way.
    expect(message).toMatch(/this host: (glibc \d+\.\d+|glibc version could not be determined)/);
  });

  const requiredVersionCases: ReadonlyArray<readonly [string, string, string]> = [
    ['reports the single required version', "version `GLIBC_2.34' not found", '2.34'],
    [
      'reports the highest of several required versions',
      "version `GLIBC_2.29' not found\nversion `GLIBC_2.34' not found",
      '2.34',
    ],
    [
      'orders versions numerically, not lexically',
      "version `GLIBC_2.9' not found\nversion `GLIBC_2.34' not found",
      '2.34',
    ],
  ];

  it.each(requiredVersionCases)('%s', (_name, stderr, expected) => {
    expect(glibcTooOldMessage(stderr)).toContain(`glibc ${expected} or newer`);
  });

  const nonGlibcCases: ReadonlyArray<readonly [string, string]> = [
    ['an unrelated loader error', 'Error: invalid ELF header'],
    ['empty stderr', ''],
    ['a GLIBC token with no not-found line', 'linked against GLIBC_2.34 successfully'],
  ];

  it.each(nonGlibcCases)('returns null for %s, leaving the generic message', (_name, stderr) => {
    expect(glibcTooOldMessage(stderr)).toBeNull();
  });

  it('returns ok:true when the load probe cannot be spawned (inconclusive, not a broken binary)', async () => {
    // The binary is present, but the child probe cannot launch — a sandbox that
    // forbids subprocesses, or a non-Node execPath. We could not test the binary,
    // so a healthy one must not be condemned; the command's own load stays
    // authoritative. (Binary content is irrelevant here — the probe never runs.)
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    const originalExecPath = process.execPath;
    try {
      await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), Buffer.from('content-irrelevant'));
      await fs.writeFile(path.join(tmpDir, 'install.js'), '');
      process.execPath = path.join(tmpDir, 'definitely-not-node');

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(true);
      expect(result.message).toBeUndefined();
    } finally {
      process.execPath = originalExecPath;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
