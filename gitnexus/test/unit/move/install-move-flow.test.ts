import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireInstallLock,
  downloadToFile,
  expectedSha,
  getMoveFlowInstallConfig,
  installMoveFlow,
  moveFlowInstallLockWaitMs,
  powershellExpandArchiveInvocation,
  reportedMoveFlowVersion,
  settleMoveFlowCleanup,
  sha256File,
  verifyArchiveChecksum,
} from '../../../src/core/move/install.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('move-flow installer', () => {
  const assetName = 'move-flow-v2.0.0-x86_64-unknown-linux-gnu.zip';

  function writeArchive(contents = 'verified move-flow archive'): string {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-checksum-'));
    tempRoots.push(root);
    const archive = path.join(root, assetName);
    writeFileSync(archive, contents);
    return archive;
  }

  it('accepts only an exact asset entry whose checksum matches', async () => {
    const archive = writeArchive();
    const digest = await sha256File(archive);
    const sums = `${digest.toUpperCase()}  ${assetName}\n`;

    expect(expectedSha(sums, assetName)).toBe(digest);
    await expect(verifyArchiveChecksum(sums, assetName, archive)).resolves.toEqual({
      status: 'match',
      expected: digest,
      actual: digest,
    });
    expect(expectedSha(`SHA256 (${assetName}) = ${digest.toUpperCase()}`, assetName)).toBe(digest);
    expect(expectedSha(`${digest}  prefixed-${assetName}`, assetName)).toBeNull();
  });

  it('rejects a checksum mismatch', async () => {
    const archive = writeArchive('tampered archive');
    const expected = '0'.repeat(64);
    const actual = await sha256File(archive);

    await expect(
      verifyArchiveChecksum(`${expected}  ${assetName}`, assetName, archive),
    ).resolves.toEqual({ status: 'mismatch', expected, actual });
  });

  it('rejects a mid-download response error and removes the partial file', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-download-'));
    tempRoots.push(root);
    const destination = path.join(root, 'move-flow.zip');
    const get = vi.fn((_url, _options, onResponse) => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = vi.fn((error?: Error) => {
        if (error) request.emit('error', error);
        return request;
      });
      queueMicrotask(() => {
        const response = new PassThrough() as IncomingMessage;
        response.statusCode = 200;
        response.headers = {};
        onResponse(response);
        response.write('partial archive');
        response.destroy(new Error('connection reset during download'));
      });
      return request;
    });

    await expect(
      downloadToFile('https://example.test/move-flow.zip', destination, 1_000, get),
    ).rejects.toThrow('connection reset during download');
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.partial`)).toBe(false);
  });

  it('passes PowerShell paths as environment data instead of command source', () => {
    const archive = `C:\\temp\\move flow's "archive".zip`;
    const destination = `C:\\temp\\destination's folder`;
    const invocation = powershellExpandArchiveInvocation(archive, destination);
    const command = invocation.args.join(' ');

    expect(command).toContain('$env:GITNEXUS_MOVE_FLOW_ARCHIVE_PATH');
    expect(command).toContain('$env:GITNEXUS_MOVE_FLOW_DESTINATION_PATH');
    expect(command).not.toContain(archive);
    expect(command).not.toContain(destination);
    expect(invocation.env.GITNEXUS_MOVE_FLOW_ARCHIVE_PATH).toBe(archive);
    expect(invocation.env.GITNEXUS_MOVE_FLOW_DESTINATION_PATH).toBe(destination);
  });

  it('uses an artifact-identified versioned user cache', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-home-'));
    tempRoots.push(root);
    const config = await getMoveFlowInstallConfig({
      ...process.env,
      GITNEXUS_HOME: root,
      GITNEXUS_MOVE_FLOW_COMPAT: '1',
    });

    expect(config).not.toBeNull();
    expect(config?.installDir.startsWith(path.join(root, 'tools', 'move-flow', '2.0.0'))).toBe(
      true,
    );
    expect(path.basename(config?.installDir ?? '')).toMatch(
      /^(linux-x64|linux-arm64|darwin-arm64|darwin-x64|win32-x64)-[0-9a-f]{12}$/,
    );
    if (process.platform === 'linux') expect(config?.releaseTarget).toContain('compat');
  });

  it('keeps install waiters alive beyond the full download budget', () => {
    expect(moveFlowInstallLockWaitMs(30_000)).toBe(120_000);
    expect(moveFlowInstallLockWaitMs(90_000)).toBe(240_000);
  });

  it('matches the reported semantic version exactly', () => {
    expect(reportedMoveFlowVersion('move-flow 2.0.0')).toBe('2.0.0');
    expect(reportedMoveFlowVersion('move-flow 12.0.0')).not.toBe('2.0.0');
  });

  it.each([
    ['GITNEXUS_MOVE_FLOW_VERSION', '../escape'],
    ['GITNEXUS_MOVE_FLOW_TAG', '../../outside'],
    ['GITNEXUS_MOVE_FLOW_REPO', 'owner/repo/extra'],
  ])('rejects unsafe release coordinate %s', async (key, value) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-invalid-config-'));
    tempRoots.push(root);
    const env = {
      ...process.env,
      // Cross-platform CI disables automatic provisioning globally; this case
      // must still reach release-coordinate validation.
      GITNEXUS_SKIP_MOVE_FLOW: '0',
      GITNEXUS_MOVE_FLOW_DIR: root,
      [key]: value,
    };

    await expect(getMoveFlowInstallConfig(env)).rejects.toThrow('invalid move-flow');
    await expect(installMoveFlow(env)).resolves.toMatchObject({ status: 'failed' });
    expect(existsSync(path.join(root, 'escape'))).toBe(false);
  });

  it.each(['GITNEXUS_SKIP_MOVE_FLOW', 'GITNEXUS_SKIP_OPTIONAL_GRAMMARS'] as const)(
    '%s=1 returns a structured skip result without touching the network',
    async (flag) => {
      const env = {
        ...process.env,
        GITNEXUS_SKIP_MOVE_FLOW: '0',
        GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '0',
        [flag]: '1',
      };
      await expect(installMoveFlow(env)).resolves.toMatchObject({
        status: 'skipped',
        message: expect.stringContaining(flag),
      });
    },
  );

  it('serializes concurrent installers and transfers lock ownership safely', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-lock-'));
    tempRoots.push(root);
    const lockPath = path.join(root, 'move-flow.install.lock');
    const options = { waitTimeoutMs: 2_000, leaseMs: 500, heartbeatMs: 20, retryMs: 10 };
    const releaseFirst = await acquireInstallLock(lockPath, options);
    let secondAcquired = false;
    const second = acquireInstallLock(lockPath, options).then((release) => {
      secondAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(secondAcquired).toBe(false);
    await releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    await releaseSecond();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('removes a lock when writing its ownership token fails', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-lock-write-'));
    tempRoots.push(root);
    const lockPath = path.join(root, 'move-flow.install.lock');
    const handle = {
      writeFile: vi.fn(async () => {
        throw new Error('simulated disk failure');
      }),
      close: vi.fn(async () => {}),
    } as unknown as FileHandle;
    const removeLock = vi.fn(async (file: string) => {
      rmSync(file, { force: true });
    });

    await expect(
      acquireInstallLock(
        lockPath,
        { waitTimeoutMs: 100 },
        {
          openLock: async () => {
            writeFileSync(lockPath, '');
            return handle;
          },
          removeLock,
        },
      ),
    ).rejects.toThrow('simulated disk failure');
    expect(handle.close).toHaveBeenCalledOnce();
    expect(removeLock).toHaveBeenCalledWith(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reclaims a stable malformed lock after its lease expires', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-lock-stale-'));
    tempRoots.push(root);
    const lockPath = path.join(root, 'move-flow.install.lock');
    writeFileSync(lockPath, 'not-json');
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockPath, old, old);

    const release = await acquireInstallLock(lockPath, {
      waitTimeoutMs: 1_000,
      leaseMs: 50,
      heartbeatMs: 10,
      retryMs: 5,
    });
    expect(existsSync(lockPath)).toBe(true);
    await release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('runs lock release even when another cleanup task rejects', async () => {
    const release = vi.fn(async () => {});
    await expect(
      settleMoveFlowCleanup(async () => {
        throw new Error('simulated temp cleanup failure');
      }, release),
    ).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });
});
