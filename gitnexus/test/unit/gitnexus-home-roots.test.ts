import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

/**
 * Regression guard: the clone root (git-clone.ts), upload root (upload-paths.ts),
 * and server-mapping file (embeddings/server-mapping.ts) must follow
 * GITNEXUS_HOME, not the bare home directory.
 *
 * The Docker image sets GITNEXUS_HOME=/data/gitnexus — the persistent volume
 * that also holds the registry and indexes. Before this fix these three roots
 * used os.homedir() directly, so clones/uploads landed in the container's
 * ephemeral ~/.gitnexus and were lost on container recreation while the
 * registry (which honors GITNEXUS_HOME) still pointed at the dead path.
 *
 * The roots are module-level constants resolved at import time from
 * getGlobalDir(), so each case sets the env var, resets the module registry,
 * and re-imports under the new value.
 */
describe('GITNEXUS_HOME path roots', () => {
  const savedHome = process.env.GITNEXUS_HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    vi.resetModules();
  });

  // customHome is only needed by the GITNEXUS_HOME-set cases below; the two
  // fallback cases manage their own (or no) temp dir, so its lifecycle lives in
  // this nested block rather than a shared beforeEach.
  describe('with GITNEXUS_HOME set', () => {
    // mkdtemp (not a fixed os.tmpdir() name) so a co-located process cannot
    // pre-create or symlink the path before our writes land
    // (CodeQL js/insecure-temporary-file).
    let customHome: string;

    beforeEach(async () => {
      customHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-home-roots-'));
    });

    afterEach(async () => {
      await fs.rm(customHome, { recursive: true, force: true });
    });

    it('clone root follows GITNEXUS_HOME', async () => {
      process.env.GITNEXUS_HOME = customHome;
      vi.resetModules();
      const { getCloneDir } = await import('../../src/server/git-clone.js');
      expect(getCloneDir('my-repo')).toBe(path.resolve(customHome, 'repos', 'my-repo'));
    });

    it('upload root follows GITNEXUS_HOME', async () => {
      process.env.GITNEXUS_HOME = customHome;
      vi.resetModules();
      const { UPLOAD_ROOT, getUploadDir } = await import('../../src/server/upload-paths.js');
      expect(UPLOAD_ROOT).toBe(path.resolve(customHome, 'uploads'));
      expect(getUploadDir('my-repo')).toBe(path.resolve(customHome, 'uploads', 'my-repo'));
    });

    it('server-mapping file is read from GITNEXUS_HOME', async () => {
      process.env.GITNEXUS_HOME = customHome;
      await fs.writeFile(
        path.join(customHome, 'server-mapping.json'),
        JSON.stringify({ 'my-repo': 'payments-service' }),
        'utf-8',
      );
      vi.resetModules();
      const { readServerMapping } = await import('../../src/core/embeddings/server-mapping.js');
      expect(await readServerMapping('my-repo')).toBe('payments-service');
    });
  });

  it('falls back to ~/.gitnexus when GITNEXUS_HOME is unset', async () => {
    delete process.env.GITNEXUS_HOME;
    vi.resetModules();
    const { getCloneDir } = await import('../../src/server/git-clone.js');
    const { UPLOAD_ROOT } = await import('../../src/server/upload-paths.js');
    expect(getCloneDir('my-repo')).toBe(
      path.resolve(os.homedir(), '.gitnexus', 'repos', 'my-repo'),
    );
    expect(UPLOAD_ROOT).toBe(path.resolve(os.homedir(), '.gitnexus', 'uploads'));
  });

  it('server-mapping falls back to ~/.gitnexus when GITNEXUS_HOME is unset', async () => {
    // os.homedir() honors $HOME (and $USERPROFILE on Windows), so redirect the
    // home dir to a tmp path to exercise the real fallback (getGlobalDir() ->
    // ~/.gitnexus) without writing into the developer's actual
    // ~/.gitnexus/server-mapping.json.
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-fallback-home-'));
    const savedProcessHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.GITNEXUS_HOME;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      await fs.mkdir(path.join(fakeHome, '.gitnexus'), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, '.gitnexus', 'server-mapping.json'),
        JSON.stringify({ 'my-repo': 'fallback-service' }),
        'utf-8',
      );
      vi.resetModules();
      const { readServerMapping } = await import('../../src/core/embeddings/server-mapping.js');
      expect(await readServerMapping('my-repo')).toBe('fallback-service');
    } finally {
      if (savedProcessHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedProcessHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});
