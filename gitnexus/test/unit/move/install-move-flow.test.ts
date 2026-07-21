import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadToFile,
  expectedSha,
  sha256File,
  verifyArchiveChecksum,
} from '../../../src/core/move/artifact-download.js';
import {
  acquireInstallLock,
  moveFlowInstallLockWaitMs,
} from '../../../src/core/move/install-lock.js';
import {
  findCachedMoveFlowBinary,
  getMoveFlowInstallConfig,
  installMoveFlow,
  powershellExpandArchiveInvocation,
  reportedMoveFlowVersion,
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

  it('rejects a checksum manifest that omits the selected asset', async () => {
    const archive = writeArchive();
    await expect(
      verifyArchiveChecksum(`${'0'.repeat(64)}  another-asset.zip`, assetName, archive),
    ).resolves.toEqual({ status: 'missing' });
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

  it('settles the response pipeline before cleaning up a request error after headers', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-request-race-'));
    tempRoots.push(root);
    const destination = path.join(root, 'move-flow.zip');
    let response!: PassThrough & IncomingMessage;
    const get = vi.fn((_url, _options, onResponse) => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = vi.fn();
      queueMicrotask(() => {
        response = new PassThrough() as PassThrough & IncomingMessage;
        response.statusCode = 200;
        response.headers = {};
        onResponse(response);
        response.write('partial archive');
        request.emit('error', new Error('request failed after headers'));
        request.emit('close');
      });
      return request;
    });

    await expect(
      downloadToFile('https://example.test/move-flow.zip', destination, 1_000, get),
    ).rejects.toThrow('request failed after headers');
    expect(response.destroyed).toBe(true);
    expect(get).toHaveBeenCalledOnce();
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.partial`)).toBe(false);
  });

  it.each([
    ['declared', { 'content-length': '17' }],
    ['streamed', {}],
  ])('rejects %s downloads that exceed the byte limit', async (kind, headers) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-download-limit-'));
    tempRoots.push(root);
    const destination = path.join(root, 'move-flow.zip');
    let response!: PassThrough & IncomingMessage;
    const get = vi.fn((_url, _options, onResponse) => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = vi.fn();
      queueMicrotask(() => {
        response = new PassThrough() as PassThrough & IncomingMessage;
        response.statusCode = 200;
        response.headers = headers;
        onResponse(response);
        response.end('sixteen-byte-body');
      });
      return request;
    });

    await expect(
      downloadToFile('https://example.test/move-flow.zip', destination, 1_000, get, 8),
    ).rejects.toThrow('download exceeds 8 bytes');
    if (kind === 'declared') expect(response.destroyed).toBe(true);
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.partial`)).toBe(false);
  });

  it('retries transient HTTP failures within the same deadline', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-download-retry-'));
    tempRoots.push(root);
    const destination = path.join(root, 'move-flow.zip');
    let attempt = 0;
    const get = vi.fn((_url, _options, onResponse) => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = vi.fn((error?: Error) => {
        if (error) request.emit('error', error);
        return request;
      });
      queueMicrotask(() => {
        const response = new PassThrough() as IncomingMessage;
        response.statusCode = attempt++ === 0 ? 503 : 200;
        response.headers = {};
        onResponse(response);
        response.end(response.statusCode === 200 ? 'verified archive' : undefined);
        request.emit('close');
      });
      return request;
    });

    await expect(
      downloadToFile('https://example.test/move-flow.zip', destination, 1_000, get),
    ).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);
    expect(readFileSync(destination, 'utf8')).toBe('verified archive');
  });

  it('rejects redirects that downgrade HTTPS', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-download-redirect-'));
    tempRoots.push(root);
    const destination = path.join(root, 'move-flow.zip');
    const get = vi.fn((_url, _options, onResponse) => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = vi.fn();
      queueMicrotask(() => {
        const response = new PassThrough() as IncomingMessage;
        response.statusCode = 302;
        response.headers = { location: 'http://example.test/insecure.zip' };
        onResponse(response);
        request.emit('close');
      });
      return request;
    });

    await expect(
      downloadToFile('https://example.test/move-flow.zip', destination, 1_000, get),
    ).rejects.toThrow('refusing non-HTTPS redirect');
    expect(get).toHaveBeenCalledOnce();
  });

  it('rejects an initial non-HTTPS artifact URL before opening a request', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-download-http-'));
    tempRoots.push(root);
    const get = vi.fn();

    await expect(
      downloadToFile(
        'http://example.test/move-flow.zip',
        path.join(root, 'move-flow.zip'),
        1_000,
        get,
      ),
    ).rejects.toThrow('downloads require HTTPS');
    expect(get).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a hash-valid cache whose execute bit was lost',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-non-executable-'));
      tempRoots.push(root);
      const env = {
        ...process.env,
        GITNEXUS_HOME: root,
        GITNEXUS_SKIP_MOVE_FLOW: '0',
      };
      const config = await getMoveFlowInstallConfig(env);
      expect(config).not.toBeNull();
      if (!config) throw new Error('expected a supported platform');
      mkdirSync(config.installDir, { recursive: true });
      writeFileSync(config.binaryPath, 'cached move-flow');
      chmodSync(config.binaryPath, 0o644);
      writeFileSync(
        config.metadataPath,
        JSON.stringify({
          version: config.version,
          repository: config.repository,
          tag: config.tag,
          assetName: config.assetName,
          binarySha256: await sha256File(config.binaryPath),
        }),
      );

      await expect(findCachedMoveFlowBinary(env)).resolves.toBeNull();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'returns the verified descriptor for a live verified cache',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-valid-cache-'));
      tempRoots.push(root);
      const env = { ...process.env, GITNEXUS_HOME: root, GITNEXUS_SKIP_MOVE_FLOW: '0' };
      const config = await getMoveFlowInstallConfig(env);
      if (!config) throw new Error('expected a supported platform');
      mkdirSync(config.installDir, { recursive: true });
      writeFileSync(config.binaryPath, '#!/bin/sh\nprintf "move-flow 2.0.0\\n"\n');
      chmodSync(config.binaryPath, 0o755);
      writeFileSync(
        config.metadataPath,
        JSON.stringify({
          schemaVersion: 1,
          version: config.version,
          repository: config.repository,
          tag: config.tag,
          assetName: config.assetName,
          archiveSha256: '0'.repeat(64),
          binarySha256: await sha256File(config.binaryPath),
        }),
      );

      await expect(findCachedMoveFlowBinary(env)).resolves.toMatchObject({
        binaryPath: config.binaryPath,
        version: '2.0.0',
      });
    },
  );

  it.skipIf(process.platform === 'win32')('rejects a symlinked cached binary', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-symlink-cache-'));
    tempRoots.push(root);
    const env = { ...process.env, GITNEXUS_HOME: root, GITNEXUS_SKIP_MOVE_FLOW: '0' };
    const config = await getMoveFlowInstallConfig(env);
    if (!config) throw new Error('expected a supported platform');
    mkdirSync(config.installDir, { recursive: true });
    const target = path.join(root, 'move-flow-target');
    writeFileSync(target, '#!/bin/sh\nprintf "move-flow 2.0.0\\n"\n');
    chmodSync(target, 0o755);
    symlinkSync(target, config.binaryPath);
    writeFileSync(
      config.metadataPath,
      JSON.stringify({
        schemaVersion: 1,
        version: config.version,
        repository: config.repository,
        tag: config.tag,
        assetName: config.assetName,
        archiveSha256: '0'.repeat(64),
        binarySha256: await sha256File(target),
      }),
    );

    await expect(findCachedMoveFlowBinary(env)).resolves.toBeNull();
  });

  it('rejects oversized cache metadata before parsing it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-move-flow-large-metadata-'));
    tempRoots.push(root);
    const env = { ...process.env, GITNEXUS_HOME: root, GITNEXUS_SKIP_MOVE_FLOW: '0' };
    const config = await getMoveFlowInstallConfig(env);
    if (!config) throw new Error('expected a supported platform');
    mkdirSync(config.installDir, { recursive: true });
    writeFileSync(config.metadataPath, 'x'.repeat(65 * 1024));

    await expect(findCachedMoveFlowBinary(env)).resolves.toBeNull();
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

  it('keeps compatible release coordinates dynamic', async () => {
    const config = await getMoveFlowInstallConfig({
      ...process.env,
      GITNEXUS_MOVE_FLOW_VERSION: '2.7.9',
      GITNEXUS_MOVE_FLOW_REPO: 'example/move-flow',
      GITNEXUS_MOVE_FLOW_TAG: 'release-2.7.9',
    });

    expect(config).toMatchObject({
      version: '2.7.9',
      repository: 'example/move-flow',
      tag: 'release-2.7.9',
    });
  });

  it('rejects an incompatible configured major before downloading', async () => {
    await expect(
      getMoveFlowInstallConfig({ ...process.env, GITNEXUS_MOVE_FLOW_VERSION: '3.0.0' }),
    ).rejects.toThrow('unsupported move-flow major version');
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
});
