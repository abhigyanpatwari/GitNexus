import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const raceLoss = vi.hoisted(() => ({
  publish: async (): Promise<void> => {},
}));

vi.mock('../../../src/core/move/install-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/move/install-lock.js')>();
  return {
    ...actual,
    acquireInstallLock: async () => {
      await raceLoss.publish();
      throw new Error('timed out waiting for another move-flow installation');
    },
  };
});

const { getMoveFlowInstallConfig, installMoveFlow } =
  await import('../../../src/core/move/install.js');

describe('move-flow installer concurrent-publish recovery', () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'move-flow-recovery-'));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    raceLoss.publish = async () => {};
  });

  it.skipIf(process.platform === 'win32')(
    'returns the concurrently published cache instead of failed',
    async () => {
      const env: NodeJS.ProcessEnv = { GITNEXUS_MOVE_FLOW_DIR: cacheRoot };
      const config = await getMoveFlowInstallConfig(env);
      if (!config) throw new Error('expected a supported move-flow install target');

      raceLoss.publish = async () => {
        await mkdir(config.installDir, { recursive: true });
        const script = `#!/bin/sh\necho "move-flow ${config.version}"\n`;
        await writeFile(config.binaryPath, script);
        await chmod(config.binaryPath, 0o755);
        const binarySha256 = createHash('sha256').update(script).digest('hex');
        await writeFile(
          config.metadataPath,
          JSON.stringify({
            schemaVersion: 1,
            version: config.version,
            repository: config.repository,
            tag: config.tag,
            assetName: config.assetName,
            archiveSha256: 'unused',
            binarySha256,
          }),
        );
      };

      const result = await installMoveFlow(env);
      expect(result.status).toBe('available');
      expect(result.binary?.binaryPath).toBe(config.binaryPath);
      expect(result.binary?.version).toBe(config.version);
    },
  );

  it('still reports failed when no valid cache exists', async () => {
    const result = await installMoveFlow({ GITNEXUS_MOVE_FLOW_DIR: cacheRoot });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('timed out waiting');
  });
});
