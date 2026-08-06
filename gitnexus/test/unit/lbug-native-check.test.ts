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
      expect(result.kind).toBe('binary_missing');
      expect(result.message).toContain('missing');
      expect(result.message).toContain('install.js');
      expect(result.message).toContain('trustedDependencies');
      // Every package gitnexus/package.json actually trusts, not just the first —
      // a partial list leaves one unbuilt and the "repair" only half works. Read
      // from the manifest rather than restated, so adding a native package fails
      // here instead of silently shipping stale advice.
      const manifest = JSON.parse(
        await fs.readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'),
      ) as { trustedDependencies: string[] };
      expect(manifest.trustedDependencies.length).toBeGreaterThan(0);
      expect(result.message).toContain(
        `"trustedDependencies": [${manifest.trustedDependencies.map((p) => `"${p}"`).join(', ')}]`,
      );
      for (const pkg of manifest.trustedDependencies) {
        expect(result.message).toContain(`--allow-build=${pkg}`);
      }
      // A `bunx gitnexus@latest …` one-shot has no package.json to edit, so the
      // trustedDependencies advice alone is unactionable for this PR's audience.
      expect(result.message).toContain('bun install -g gitnexus');
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

  // The `<name>-<platform>-<arch>` sub-package layout restorePrebuiltNativeBinary
  // derives is encoded here once, so the two tests that depend on it cannot drift
  // apart — and the negative test below stays honest about WHY it finds nothing.
  async function prebuiltFixture(prefix: string) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const pkgDir = path.join(root, 'node_modules', '@ladybugdb', 'core');
    const subPkgDir = path.join(
      root,
      'node_modules',
      '@ladybugdb',
      `core-${process.platform}-${process.arch}`,
    );
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.mkdir(subPkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), '{"name":"@ladybugdb/core"}');
    await fs.writeFile(path.join(subPkgDir, 'package.json'), '{"name":"sub"}');
    return { root, pkgDir, subPkgDir };
  }

  it('restores a missing lbugjs.node from the prebuilt platform sub-package', async () => {
    // The "install lifecycle script was skipped" case is recoverable without a
    // network fetch: the binary is already on disk in the per-platform optional
    // sub-package and the skipped script only copied it up. Load-bearing for
    // `bunx gitnexus@latest …` — bun skips lifecycle scripts for a bunx fetch,
    // offers no per-invocation opt-in, and re-extracts on every run, so an
    // out-of-band repair cannot survive to the next invocation.
    const { root, pkgDir, subPkgDir } = await prebuiltFixture('lbug-restore-');
    try {
      // A real, loadable binary so the check reaches ok:true rather than
      // stopping at the load probe — this asserts the whole path, not just the copy.
      const realPath = checkLbugNative().binaryPath;
      expect(realPath).toBeDefined();
      await fs.copyFile(realPath!, path.join(subPkgDir, 'lbugjs.node'));

      const result = checkLbugNative(pkgDir);

      expect(result.ok).toBe(true);
      await expect(fs.access(path.join(pkgDir, 'lbugjs.node'))).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('still reports binary_missing when no prebuilt sub-package exists to restore from', async () => {
    // Recovery is best-effort: with nothing to copy, the existing diagnostics
    // must survive verbatim rather than being masked by a failed restore.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-restore-none-'));
    try {
      const pkgDir = path.join(root, 'node_modules', '@ladybugdb', 'core');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(path.join(pkgDir, 'package.json'), '{"name":"@ladybugdb/core"}');
      await fs.writeFile(path.join(pkgDir, 'install.js'), '');

      const result = checkLbugNative(pkgDir);

      expect(result.ok).toBe(false);
      expect(result.kind).toBe('binary_missing');
      expect(result.message).toContain('install.js');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // POSIX-and-non-root only: the trigger is a real EACCES out of copyFileSync.
  // Windows chmod is a no-op on directories and root bypasses the mode bits, so
  // on either the copy would succeed and there would be nothing to assert.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'separates a refused copy from a missing prebuilt (read-only node_modules)',
    async () => {
      // A container image with node_modules baked into a read-only layer: the
      // prebuilt binary is right there and readable, only the copy-up is blocked.
      // The lifecycle-script cause list (trustedDependencies / --allow-build /
      // ignore-scripts) is the wrong remedy — no build-script permission makes a
      // read-only filesystem writable — so it must not be what the user is shown.
      const { root, pkgDir, subPkgDir } = await prebuiltFixture('lbug-restore-ro-');
      try {
        await fs.writeFile(path.join(subPkgDir, 'lbugjs.node'), Buffer.from('prebuilt'));
        await fs.chmod(pkgDir, 0o555);

        const result = checkLbugNative(pkgDir);

        expect(result.ok).toBe(false);
        // Its own kind, not binary_missing: doctor's status line switches on this,
        // and "missing" would contradict the message printed beneath it (#2672).
        expect(result.kind).toBe('binary_unwritable');
        expect(result.message).toContain('permission problem');
        expect(result.message).toContain('IS present in the platform sub-package');
        // The mechanisms may be NAMED (to say they will not help) but must never
        // be PRESCRIBED — no copy-pasteable line that sends the user round the
        // build-script loop again.
        expect(result.message).toContain('NOT help here');
        expect(result.message).not.toContain('"trustedDependencies": [');
        expect(result.message).not.toContain('pnpm --allow-build=');
        expect(result.message).not.toContain('Common causes:');
      } finally {
        // Restore write permission or the tree cannot be removed.
        await fs.chmod(pkgDir, 0o755).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it('returns ok:false when lbugjs.node exists but is unloadable (zero-byte)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lbug-check-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'lbugjs.node'), Buffer.alloc(0));

      const result = checkLbugNative(tmpDir);

      expect(result.ok).toBe(false);
      // Present but unloadable — doctor must not call this "missing" (#2672).
      expect(result.kind).toBe('load_failed');
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
        expect(result.kind).toBe('load_failed');
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
